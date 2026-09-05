import { resolvePhone, selectIncoming } from './identity.mjs';
import { deliverOne } from './delivery.mjs';

// Dependency injection allows lifecycle tests without initializing a real socket.
export function createBridgeRuntime({ config, store, auth, makeWASocket, jidNormalizedUser,
  makeCacheableSignalKeyStore, DisconnectReason, logger, onStop = () => {}, output = console,
  now = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, fetcher = fetch }) {
  let socket;
  let ready = false;
  let stopped = false;
  let restarting = false;
  let reconnectCount = 0;
  let activatedAt = Infinity;
  let draining = false;
  let incomingChain = Promise.resolve();
  let reconnectTimer;
  let pairRequested = false;
  const groupCache = new Map();

  function stop(code) {
    if (stopped) return;
    stopped = true;
    ready = false;
    timers.clearTimeout(reconnectTimer);
    timers.clearInterval(queueTimer);
    output.error(`Titanium bridge stopped: ${code}. No account was logged out or deleted.`);
    socket?.end(new Error('bridge_stopped'));
    // Do not close SQLite while an in-flight delivery can still commit its result.
    onStop(code);
  }

  async function startSocket() {
    if (stopped) return;
    ready = false;
    restarting = false;
    const current = makeWASocket({
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys, logger) },
      logger, markOnlineOnConnect: false, syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async key => store.outgoingMessage(key),
      cachedGroupMetadata: async jid => {
        const cached = groupCache.get(jid);
        return cached && cached.expires > now() ? cached.metadata : undefined;
      },
      connectTimeoutMs: 30_000,
    });
    socket = current;
    let connectionEpoch = 0;
    const identity = {
      normalizeJid: jidNormalizedUser,
      lookupPhoneForLid: jid => current.signalRepository.lidMapping.getPNForLID(jid),
    };
    current.ev.on('groups.update', updates => {
      for (const update of updates) if (update.id) groupCache.delete(update.id);
    });
    current.ev.on('group-participants.update', update => groupCache.delete(update.id));
    current.ev.on('creds.update', update => {
      if (stopped || current !== socket) return;
      auth.saveCreds(update).catch(() => stop('auth_persistence_failed'));
    });
    current.ev.on('connection.update', update => {
      void (async () => {
        if (stopped || current !== socket) return;
        const epoch = update.connection ? ++connectionEpoch : connectionEpoch;
        if (update.isNewLogin === true) {
          output.info('Titanium bridge pairing accepted; awaiting connection restart.');
        }
        if (update.qr && !auth.state.creds.registered && !pairRequested) {
          if (!config.allowPairing) { stop('pairing_required'); return; }
          pairRequested = true;
          const code = await current.requestPairingCode(config.botNumber);
          output.info(`Titanium linked-device pairing code: ${code}`);
        }
        if (update.connection === 'open') {
          const self = await resolvePhone(current.user?.id || auth.state.creds.me?.id,
            auth.state.creds.me?.id, identity);
          if (stopped || current !== socket || epoch !== connectionEpoch) return;
          if (self !== config.botNumber) { stop('unexpected_or_unresolved_account'); return; }
          store.bindAccount(self);
          activatedAt = store.activate(now());
          ready = true;
          reconnectCount = 0;
          output.info('Titanium bridge connected to the configured account; only allowlisted fresh messages are eligible.');
        }
        if (update.connection === 'close') {
          ready = false;
          const code = update.lastDisconnect?.error?.output?.statusCode;
          const safeStatus = Number.isSafeInteger(code) ? code : 'unknown';
          output.info(`Titanium bridge connection closed: status=${safeStatus}; registered=${auth.state.creds.registered === true}.`);
          if ([DisconnectReason.loggedOut, DisconnectReason.forbidden, DisconnectReason.connectionReplaced,
            DisconnectReason.badSession, DisconnectReason.multideviceMismatch].includes(code)) {
            stop('session_requires_owner_attention'); return;
          }
          if (restarting) return;
          restarting = true;
          reconnectCount += 1;
          if (reconnectCount > 10) { stop('reconnect_limit_reached'); return; }
          const delay = code === DisconnectReason.restartRequired ? 1000 : Math.min(60_000, 2000 * 2 ** (reconnectCount - 1));
          reconnectTimer = timers.setTimeout(() => startSocket().catch(() => stop('socket_start_failed')), delay);
        }
      })().catch(() => stop('connection_handler_failed'));
    });
    current.ev.on('messages.upsert', event => {
      if (!ready || stopped || current !== socket) return;
      incomingChain = incomingChain.then(async () => {
        for (const message of event.messages) {
          if (!ready || stopped || current !== socket) break;
          const incoming = await selectIncoming(message, event, config, identity, now(), activatedAt);
          if (incoming && ready && !stopped && current === socket) store.enqueue(incoming);
        }
      }).catch(() => stop('incoming_persistence_failed'));
    });
  }

  const queueTimer = timers.setInterval(() => {
    if (!ready || stopped || draining) return;
    draining = true;
    void (async () => {
      const row = store.next(now());
      if (!row) return;
      await deliverOne(store, row, config, {
        now, fetcher,
        sendReply: async (jid, text, messageId) => {
          if (!ready || stopped) throw new Error('not_connected');
          if (config.allowedGroups.has(jid)) {
            const cached = groupCache.get(jid);
            if (!cached || cached.expires <= now()) {
              groupCache.set(jid, { metadata: await socket.groupMetadata(jid), expires: now() + 300_000 });
            }
          }
          await socket.sendMessage(jid, { text, linkPreview: null }, { messageId });
        },
      });
    })().catch(() => stop('queue_failed')).finally(() => { draining = false; });
  }, 1000);
  return { start: startSocket, stop, status: () => ({ ready, stopped, reconnectCount }) };
}
