import { createHash } from 'node:crypto';
import { boundedPlainText, withAbortSignal } from './group-privacy.mjs';

const RETRY_MS = 24 * 60 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const PN = /^[1-9]\d{7,14}@s\.whatsapp\.net$/;
const STATUS = new Map([[2, 'server_ack'], [3, 'delivered'], [4, 'read'], [5, 'read']]);
function safeCode(value) { const code = String(value ?? ''); return /^\d{3}$/.test(code) ? code : 'unknown'; }
function failure(code, definitelyNotSent = false) {
  return Object.assign(new Error(code), { code, ...(definitelyNotSent ? { definitelyNotSent: true } : {}) });
}

// Only new, explicitly approved private outbox sends enter this store. Historical
// queue outcomes never create transport rows or trigger recovery/re-sending.
export function createPrivateOutboxTransport({ store, config, proto, generateWAMessage,
  normalizeJid, authorize, recordUpdate, now = Date.now }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS private_outbox_transport (
    message_id TEXT PRIMARY KEY,account_number TEXT NOT NULL,recipient_number TEXT NOT NULL,
    destination_jid TEXT NOT NULL,aliases_json TEXT NOT NULL,content_hash TEXT NOT NULL,
    message_proto BLOB,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,attempted_at INTEGER,
    server_ack_at INTEGER,delivered_at INTEGER,read_at INTEGER,error_at INTEGER,error_code TEXT);
    CREATE INDEX IF NOT EXISTS private_outbox_transport_expiry ON private_outbox_transport(expires_at);`);
  const waiters = new Map();
  function cleanup() { db.prepare('UPDATE private_outbox_transport SET message_proto=NULL WHERE expires_at<=? AND message_proto IS NOT NULL').run(now()); }
  cleanup();
  function rowFor(id) { return typeof id === 'string' && ID.test(id) ? db.prepare('SELECT * FROM private_outbox_transport WHERE message_id=?').get(id) : undefined; }
  function canonical(value) {
    if (typeof value !== 'string' || !/^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(value)) return null;
    const jid = normalizeJid(value);
    return typeof jid === 'string' && /^\d+@(?:s\.whatsapp\.net|lid)$/.test(jid) ? jid : null;
  }
  function evidence(row) {
    if (row.read_at != null) return { status: 'read', at: row.read_at };
    if (row.delivered_at != null) return { status: 'delivered', at: row.delivered_at };
    if (row.error_at != null) return { status: 'error', at: row.error_at, errorCode: row.error_code };
    if (row.server_ack_at != null) return { status: 'server_ack', at: row.server_ack_at };
    return null;
  }
  async function validOrigin(row, jid, socket, isCurrent) {
    const alias = canonical(jid);
    if (!row || row.account_number !== config.botNumber || row.attempted_at == null || !isCurrent()
      || !alias || !JSON.parse(row.aliases_json).includes(alias)) return false;
    if (alias.endsWith('@lid')) {
      const mapped = await socket.signalRepository.lidMapping.getPNForLID(alias);
      if (canonical(mapped) !== `${row.recipient_number}@s.whatsapp.net`) return false;
    }
    return isCurrent() && config.allowedNumbers.has(row.recipient_number) && row.recipient_number !== config.botNumber
      && await authorize(row.recipient_number) && isCurrent();
  }
  async function update(id, jid, status, errorCode, socket, isCurrent, participant) {
    const row = rowFor(id);
    if (!await validOrigin(row, jid, socket, isCurrent)) return;
    if (participant && !await validOrigin(row, participant, socket, isCurrent)) return;
    const at = now(), column = { server_ack: 'server_ack_at', delivered: 'delivered_at', read: 'read_at', error: 'error_at' }[status];
    if (!column) return;
    // Duplicate and out-of-order events preserve the first timestamp of each
    // independent evidence type. A late error cannot erase delivery/read proof.
    db.prepare(`UPDATE private_outbox_transport SET ${column}=COALESCE(${column},?)${status === 'error' ? ',error_code=COALESCE(error_code,?)' : ''} WHERE message_id=?`)
      .run(...(status === 'error' ? [at, safeCode(errorCode), id] : [at, id]));
    recordUpdate({ messageId: id, to: `${row.recipient_number}@s.whatsapp.net`, status, at,
      ...(status === 'error' ? { errorCode: safeCode(errorCode) } : {}) });
    const result = evidence(rowFor(id));
    if (result) waiters.get(id)?.(result);
  }
  function attach(socket, isCurrent) {
    const onAck = node => {
      if (node?.tag !== 'ack' || node.attrs?.class !== 'message' || !isCurrent()) return;
      // rc14 positive server ACKs do not necessarily emit messages.update.
      // Never trust an ID alone: ACK.from must match the stored destination.
      void update(node.attrs.id, node.attrs.from, node.attrs.error ? 'error' : 'server_ack', node.attrs.error, socket, isCurrent, node.attrs.participant).catch(() => {});
    };
    const onUpdates = updates => {
      if (!Array.isArray(updates) || !isCurrent()) return;
      for (const item of updates) {
        if (item?.key?.fromMe !== true) continue;
        const status = item.update?.status === 0 ? 'error' : STATUS.get(item.update?.status);
        if (status) void update(item.key.id, item.key.remoteJid, status, item.update?.messageStubParameters?.[0], socket, isCurrent, item.key.participant).catch(() => {});
      }
    };
    socket.ws?.on('CB:ack,class:message', onAck);
    socket.ev.on('messages.update', onUpdates);
    return () => { socket.ws?.off?.('CB:ack,class:message', onAck); socket.ev.off?.('messages.update', onUpdates); };
  }
  async function aliasesFor(number, socket) {
    const pn = `${number}@s.whatsapp.net`, aliases = [pn];
    const lid = canonical(await socket.signalRepository.lidMapping.getLIDForPN(pn));
    if (lid) {
      if (!lid.endsWith('@lid') || canonical(await socket.signalRepository.lidMapping.getPNForLID(lid)) !== pn) throw failure('transport_preflight_rejected', true);
      aliases.push(lid);
    }
    const self = [socket.user?.id, socket.authState?.creds.me?.id, socket.authState?.creds.me?.lid].map(canonical).filter(Boolean);
    if (aliases.some(alias => self.includes(alias))) throw failure('transport_preflight_rejected', true);
    return aliases;
  }
  async function send({ to, text, messageId, signal }, { socket, isCurrent }) {
    cleanup();
    if (!PN.test(to || '') || !ID.test(messageId || '') || !signal || signal.aborted || !isCurrent()
      || typeof text !== 'string' || !text || text !== boundedPlainText(text)) throw failure('transport_preflight_rejected', true);
    const number = to.slice(0, -'@s.whatsapp.net'.length);
    if (number === config.botNumber || !config.allowedNumbers.has(number) || !await authorize(number)) throw failure('transport_preflight_rejected', true);
    // Never perform another relay for a recorded ID, including ambiguous/crashed
    // attempts. A later receipt can improve its evidence without a new send.
    if (rowFor(messageId)) throw failure('transport_already_attempted');
    let aliases, destination, content;
    try {
      aliases = await withAbortSignal(() => aliasesFor(number, socket), signal);
      destination = aliases.find(jid => jid.endsWith('@lid')) || to;
      if (typeof socket.getUSyncDevices !== 'function') throw failure('recipient_devices_unavailable', true);
      let devices = await withAbortSignal(() => socket.getUSyncDevices([destination], false, false), signal);
      // First-contact USync can learn an alias that did not exist before the
      // lookup. Persist that verified alias, not a stale PN-only snapshot.
      aliases = await withAbortSignal(() => aliasesFor(number, socket), signal);
      const learnedDestination = aliases.find(jid => jid.endsWith('@lid')) || to;
      if (learnedDestination !== destination) {
        destination = learnedDestination;
        devices = await withAbortSignal(() => socket.getUSyncDevices([destination], false, false), signal);
        aliases = await withAbortSignal(() => aliasesFor(number, socket), signal);
        if ((aliases.find(jid => jid.endsWith('@lid')) || to) !== destination) throw failure('transport_preflight_rejected', true);
      }
      const targetDevices = Array.isArray(devices) ? devices.filter(device => aliases.includes(canonical(device?.jid))) : [];
      if (!targetDevices.length) throw failure('recipient_devices_unavailable', true);
      if (!isCurrent() || signal.aborted || !config.allowedNumbers.has(number) || !await authorize(number)) throw failure('transport_preflight_rejected', true);
      const full = await generateWAMessage(destination, { text, linkPreview: null }, {
        userJid: socket.user?.id || socket.authState?.creds.me?.id, messageId, timestamp: new Date(now()),
      });
      if (full?.key?.id !== messageId || full.key.remoteJid !== destination || !full.message) throw failure('transport_preflight_rejected', true);
      content = proto.Message.encode(full.message).finish();
      if (!content.byteLength || content.byteLength > 24_000) throw failure('transport_preflight_rejected', true);
    } catch (error) {
      if (error?.definitelyNotSent) throw error;
      throw failure('transport_preflight_rejected', true);
    }
    const active = await authorize(number);
    const at = now();
    if (!active || !isCurrent() || signal.aborted || !config.allowedNumbers.has(number) || number === config.botNumber) throw failure('transport_preflight_rejected', true);
    db.prepare('INSERT INTO private_outbox_transport(message_id,account_number,recipient_number,destination_jid,aliases_json,content_hash,message_proto,created_at,expires_at,attempted_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(messageId, config.botNumber, number, destination, JSON.stringify(aliases), createHash('sha256').update(content).digest('hex'), content, at, at + RETRY_MS, null);
    let timer, onAbort;
    const acknowledgement = new Promise((resolve, reject) => {
      waiters.set(messageId, result => result.status === 'error' ? reject(failure('whatsapp_rejected')) : resolve(result));
      onAbort = () => reject(failure('transport_ack_unknown'));
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onAbort, 12_000);
    });
    acknowledgement.catch(() => {});
    // Install waiter before relay, as ACK may precede relay's promise resolution.
    try {
      await withAbortSignal(() => {
        if (!isCurrent() || signal.aborted || !config.allowedNumbers.has(number) || number === config.botNumber) throw failure('transport_preflight_rejected', true);
        db.prepare('UPDATE private_outbox_transport SET attempted_at=? WHERE message_id=? AND attempted_at IS NULL').run(now(), messageId);
        return socket.relayMessage(destination, proto.Message.decode(content), { messageId });
      }, signal);
      return await acknowledgement;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort); waiters.delete(messageId);
      // Attach a rejection handler even if relay itself failed before the wait.
      acknowledgement.catch(() => {});
    }
  }
  async function getMessage(key, { socket, isCurrent }) {
    // This authorizes the durable fallback only. Baileys' unchanged five-minute
    // native retry cache handles same-message protocol retries under the original
    // send authorization; it can run before getMessage and is not a new command.
    cleanup();
    const row = rowFor(key?.id);
    if (!row || key?.fromMe !== true || row.expires_at <= now() || !row.message_proto
      || row.error_at != null || !await validOrigin(row, key.remoteJid, socket, isCurrent)) return undefined;
    if (key.participant && !await validOrigin(row, key.participant, socket, isCurrent)) return undefined;
    return proto.Message.decode(row.message_proto);
  }
  return { send, attach, getMessage, isTracked: id => !!rowFor(id) };
}
