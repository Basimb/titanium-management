import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as baileys from 'baileys';
import pino from 'pino';
import { openStore, createAuthState } from '../src/store.mjs';
import { createBridgeRuntime } from '../src/runtime.mjs';

const clock = 1_800_000_000_000;
const botNumber = '15551234568';
const member = '15551234567';
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(t, { paired = true, ownNumber = botNumber, allowPairing = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'titanium-bridge-runtime-test-'));
  const store = openStore(directory);
  const logger = pino({ level: 'silent' });
  const auth = createAuthState(store, baileys);
  auth.state.creds.registered = paired;
  if (paired) auth.state.creds.me = { id: `${ownNumber}:9@s.whatsapp.net`, name: 'Synthetic test account' };
  const sockets = [];
  const stopped = [];
  const output = [];
  const timerJobs = [];
  const intervals = [];
  const config = { botNumber, allowPairing, allowedNumbers: new Set([member]), allowedGroups: new Set(),
    key: 'ab'.repeat(32), backendUrl: 'https://example.com/api/whatsapp/team-chat' };
  const timers = {
    setTimeout(fn, delay) { const job = { fn, delay, cleared: false }; timerJobs.push(job); return job; },
    clearTimeout(job) { if (job) job.cleared = true; },
    setInterval(fn, delay) { const job = { fn, delay, cleared: false }; intervals.push(job); return job; },
    clearInterval(job) { if (job) job.cleared = true; },
  };
  const runtime = createBridgeRuntime({
    ...baileys, config, store, auth, logger, now: () => clock, timers,
    makeWASocket(options) {
      // Never call the actual Baileys factory. Every network-capable method is mocked.
      const socket = { options, ev: new EventEmitter(), authState: options.auth, pairCalls: [], endCalls: 0,
        get user() { return options.auth.creds.me; },
        signalRepository: { lidMapping: { getPNForLID: async () => null } },
        async requestPairingCode(number) { this.pairCalls.push(number); return 'TESTCODE'; },
        end() { this.endCalls += 1; },
        async groupMetadata() { throw new Error('Unexpected group request'); },
        async sendMessage() { throw new Error('Unexpected outgoing message'); },
      };
      sockets.push(socket);
      return socket;
    },
    fetcher: async () => { throw new Error('External requests are forbidden in runtime tests'); },
    onStop: reason => stopped.push(reason),
    output: { info: message => output.push(message), error: message => output.push(message) },
  });
  t.after(() => {
    runtime.stop('service_shutdown');
    store.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('titanium-bridge-runtime-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { store, auth, sockets, stopped, output, timerJobs, intervals, runtime };
}

test('installed Baileys exports and real auth serialization are compatible without a socket', async t => {
  for (const name of ['default', 'initAuthCreds', 'jidNormalizedUser', 'makeCacheableSignalKeyStore']) {
    assert.equal(typeof baileys[name], 'function');
  }
  assert.equal(baileys.jidNormalizedUser(`${member}:17@s.whatsapp.net`), `${member}@s.whatsapp.net`);
  const h = harness(t);
  await h.auth.saveCreds();
  await h.auth.state.keys.set({ tctoken: { fake: Buffer.from([1, 2, 3]) },
    'app-state-sync-key': { fake: { keyData: Buffer.from([4, 5, 6]) } },
    'lid-mapping': { fake: `${member}@s.whatsapp.net` }, 'device-list': { fake: ['0', '1'] } });
  const reloaded = createAuthState(h.store, baileys);
  assert.ok(Buffer.isBuffer(reloaded.state.creds.noiseKey.private));
  assert.deepEqual((await reloaded.state.keys.get('tctoken', ['fake'])).fake, Buffer.from([1, 2, 3]));
  assert.deepEqual((await reloaded.state.keys.get('app-state-sync-key', ['fake'])).fake.keyData, Buffer.from([4, 5, 6]));
  assert.equal(h.sockets.length, 0);
});

test('only open plus verified actual account marks runtime ready', async t => {
  const h = harness(t);
  await h.runtime.start();
  assert.equal(h.runtime.status().ready, false);
  const socket = h.sockets[0];
  assert.equal(socket.options.syncFullHistory, false);
  assert.equal(socket.options.shouldSyncHistoryMessage({}), false);
  assert.equal(socket.options.markOnlineOnConnect, false);
  socket.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, true);
  assert.deepEqual(h.stopped, []);
});

test('wrong actual account stops without logging out/deleting auth or processing messages', async t => {
  const h = harness(t, { ownNumber: member });
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, false);
  assert.deepEqual(h.stopped, ['unexpected_or_unresolved_account']);
  assert.equal(h.sockets[0].endCalls, 1);
  assert.ok(h.store.authGet('creds', 'current'));
});

test('authorized fresh pairing emits one code and reuses saved auth on required restart', async t => {
  const h = harness(t, { paired: false, allowPairing: true });
  await h.runtime.start();
  const first = h.sockets[0];
  first.ev.emit('connection.update', { qr: 'synthetic-not-a-real-qr' });
  first.ev.emit('connection.update', { qr: 'synthetic-not-a-real-qr-again' });
  await flush();
  assert.deepEqual(first.pairCalls, [botNumber]);
  assert.equal(h.output.filter(message => message.includes('TESTCODE')).length, 1);
  first.ev.emit('creds.update', { registered: true, me: { id: `${botNumber}:5@s.whatsapp.net`, name: 'Synthetic' } });
  first.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: baileys.DisconnectReason.restartRequired } } } });
  await flush();
  assert.equal(h.timerJobs.length, 1);
  assert.equal(h.timerJobs[0].delay, 1000);
  await h.timerJobs[0].fn();
  const second = h.sockets[1];
  assert.equal(second.authState.creds.registered, true);
  second.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, true);
  assert.deepEqual(second.pairCalls, []);
  first.ev.emit('creds.update', { me: { id: `${member}@s.whatsapp.net` } });
  await flush();
  assert.equal(h.auth.state.creds.me.id, `${botNumber}:5@s.whatsapp.net`);
});

test('missing pairing authorization and logged-out sessions stop for owner attention', async t => {
  const h = harness(t, { paired: false });
  await h.runtime.start();
  h.sockets[0].ev.emit('connection.update', { qr: 'synthetic' });
  await flush();
  assert.deepEqual(h.stopped, ['pairing_required']);
  assert.deepEqual(h.sockets[0].pairCalls, []);
  const h2 = harness(t);
  await h2.runtime.start();
  h2.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: baileys.DisconnectReason.loggedOut } } } });
  await flush();
  assert.deepEqual(h2.stopped, ['session_requires_owner_attention']);
  assert.equal(h2.timerJobs.length, 0);
});

test('transient reconnect schedules one retry and later old socket events are ignored', async t => {
  const h = harness(t);
  await h.runtime.start();
  const first = h.sockets[0];
  const close = { connection: 'close', lastDisconnect: { error: { output: { statusCode: baileys.DisconnectReason.connectionLost } } } };
  first.ev.emit('connection.update', close);
  first.ev.emit('connection.update', close);
  await flush();
  assert.equal(h.timerJobs.length, 1);
  assert.equal(h.timerJobs[0].delay, 2000);
  await h.timerJobs[0].fn();
  first.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, false);
  h.sockets[1].ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(h.runtime.status().ready, true);
});

test('close arriving during asynchronous self-check cannot accidentally re-enable processing', async t => {
  const h = harness(t);
  await h.runtime.start();
  const socket = h.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' });
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  await flush();
  assert.equal(h.runtime.status().ready, false);
});
