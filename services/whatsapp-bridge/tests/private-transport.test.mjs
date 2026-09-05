import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { proto, generateWAMessage, jidNormalizedUser } from 'baileys';
import { createPrivateOutboxTransport } from '../src/private-transport.mjs';

const bot = '12025550109', phone = '12025550101', pn = `${phone}@s.whatsapp.net`, lid = '999999999991@lid';
const id = 'TITANIUMOUT_SYNTHETIC';
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { mapped = false } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let clock = 1_800_000_000_000, active = true, current = true, reverse = pn;
  const events = [], sent = [], queries = [];
  const config = { botNumber: bot, allowedNumbers: new Set([phone]) };
  const socket = { user: { id: `${bot}:9@s.whatsapp.net` }, authState: { creds: { me: { id: `${bot}:9@s.whatsapp.net`, lid: '999999999999@lid' } } },
    ev: new EventEmitter(), ws: new EventEmitter(), signalRepository: { lidMapping: {
      getLIDForPN: async () => mapped ? lid : null, getPNForLID: async () => reverse,
    } }, getUSyncDevices: async (jids, cache, excludeZero) => { queries.push({ jids, cache, excludeZero }); return [{ jid: `${mapped ? '999999999991' : phone}:0@${mapped ? 'lid' : 's.whatsapp.net'}` }]; },
    relayMessage: async (to, content, options) => { sent.push({ to, content, ...options }); socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', from: to, id: options.messageId } }); },
  };
  const options = { store: { db }, config, proto, generateWAMessage, normalizeJid: jidNormalizedUser,
    authorize: async () => active, recordUpdate: event => events.push(event), now: () => clock };
  const transport = createPrivateOutboxTransport(options);
  const isCurrent = () => current;
  const detach = transport.attach(socket, isCurrent); t.after(detach);
  const message = signal => ({ to: pn, text: 'نص اصطناعي دقيق\nSynthetic only', messageId: id, signal });
  return { db, options, config, socket, transport, events, sent, queries, isCurrent,
    send: signal => transport.send(message(signal), { socket, isCurrent }),
    get: key => transport.getMessage({ fromMe: true, id, remoteJid: pn, ...key }, { socket, isCurrent }),
    row: () => db.prepare('SELECT * FROM private_outbox_transport WHERE message_id=?').get(id),
    active: value => { active = value; }, current: value => { current = value; }, reverse: value => { reverse = value; }, tick: ms => { clock += ms; } };
}

test('real raw positive ACK is required and exact proto is persisted before relay with canonical evidence', async t => {
  const f = fixture(t, { mapped: true });
  const relay = f.socket.relayMessage;
  f.socket.relayMessage = async (...args) => {
    const stored = f.row(); assert.ok(stored.message_proto); assert.equal(stored.attempted_at, stored.created_at);
    assert.deepEqual(Buffer.from(stored.message_proto), Buffer.from(proto.Message.encode(args[1]).finish()));
    return relay(...args);
  };
  assert.equal((await f.send(new AbortController().signal)).status, 'server_ack');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].to, lid);
  assert.deepEqual(f.queries, [{ jids: [lid], cache: false, excludeZero: false }]);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].to, pn); assert.equal(f.events[0].status, 'server_ack');
  assert.ok(f.row().server_ack_at); assert.equal(f.row().delivered_at, null);
});

test('relay resolve, wrong-ID/chat/group/self/missing ACK origin never prove acceptance', async t => {
  const f = fixture(t); const controller = new AbortController();
  f.socket.relayMessage = async (to, content, options) => { f.sent.push({ to, content, ...options }); };
  let settled = false; const sending = f.send(controller.signal).finally(() => { settled = true; }); sending.catch(() => {});
  await flush(); await flush(); assert.equal(f.sent.length, 1); assert.equal(settled, false);
  for (const attrs of [{ from: pn, id: 'wrong' }, { from: `${bot}@s.whatsapp.net`, id }, { from: '12345@g.us', id }, { id }, { from: '12025550102@s.whatsapp.net', id }]) {
    f.socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', ...attrs } });
  }
  await flush(); assert.equal(f.events.length, 0); assert.equal(settled, false);
  controller.abort(); await assert.rejects(sending, error => error.code === 'transport_ack_unknown');
  assert.equal(f.row().server_ack_at, null);
});

test('early raw error while relay remains pending is handled without unhandled rejection or success', async t => {
  const f = fixture(t); let finishRelay;
  const unhandled = []; const listener = error => unhandled.push(error); process.on('unhandledRejection', listener); t.after(() => process.off('unhandledRejection', listener));
  f.socket.relayMessage = async () => {
    f.socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', from: pn, id, error: '463' } });
    return new Promise(resolve => { finishRelay = resolve; });
  };
  const sending = f.send(new AbortController().signal); sending.catch(() => {});
  await flush(); await flush(); assert.equal(f.row().error_code, '463'); assert.deepEqual(unhandled, []);
  finishRelay(); await assert.rejects(sending, error => error.code === 'whatsapp_rejected');
  assert.equal(f.row().server_ack_at, null); assert.equal(f.events[0].status, 'error');
});

test('late delivery/read/error records independent evidence after timeout without a second relay', async t => {
  const f = fixture(t, { mapped: true }); const controller = new AbortController();
  f.socket.relayMessage = async (...args) => { f.sent.push(args); };
  const sending = f.send(controller.signal); sending.catch(() => {}); await flush(); controller.abort(); await assert.rejects(sending);
  for (const status of [3, 4, 2, 0, 3]) {
    f.tick(1); f.socket.ev.emit('messages.update', [{ key: { id, remoteJid: lid, fromMe: true }, update: { status, messageStubParameters: ['479'] } }]); await flush();
  }
  const row = f.row(); assert.ok(row.delivered_at); assert.ok(row.read_at); assert.ok(row.error_at); assert.equal(row.error_code, '479');
  assert.ok(row.read_at > row.delivered_at); assert.equal(f.sent.length, 1);
  await assert.rejects(f.send(new AbortController().signal), error => error.code === 'transport_already_attempted');
});

test('zero devices, own devices only and unverified LID mapping fail before any relay', async t => {
  for (const change of [f => { f.socket.getUSyncDevices = async () => []; }, f => { f.socket.getUSyncDevices = async () => [{ jid: `${bot}@s.whatsapp.net` }]; }, f => f.reverse('12025550102@s.whatsapp.net')]) {
    const f = fixture(t, { mapped: true }); change(f);
    await assert.rejects(f.send(new AbortController().signal), error => error.definitelyNotSent === true);
    assert.equal(f.sent.length, 0); assert.equal(f.row(), undefined);
  }
});

test('aborted or revoked preflight never submits even after asynchronous device lookup', async t => {
  const f = fixture(t); const controller = new AbortController(); let resolveDevices;
  f.socket.getUSyncDevices = async () => new Promise(resolve => { resolveDevices = resolve; });
  const sending = f.send(controller.signal); sending.catch(() => {}); await flush(); f.active(false); resolveDevices([{ jid: pn }]);
  await assert.rejects(sending, error => error.definitelyNotSent === true); assert.equal(f.row(), undefined);
  controller.abort(); await assert.rejects(f.send(controller.signal), error => error.definitelyNotSent === true); assert.equal(f.sent.length, 0);
});

test('durable exact-message retry lookup survives helper restart for verified PN/LID only', async t => {
  const f = fixture(t, { mapped: true }); await f.send(new AbortController().signal);
  const restarted = createPrivateOutboxTransport(f.options);
  for (const remoteJid of [pn, lid]) {
    const restored = await restarted.getMessage({ id, remoteJid, fromMe: true }, { socket: f.socket, isCurrent: f.isCurrent });
    assert.deepEqual(Buffer.from(proto.Message.encode(restored).finish()), Buffer.from(proto.Message.encode(f.sent[0].content).finish()));
  }
  for (const key of [{ id: 'UNKNOWN' }, { remoteJid: '12025550102@s.whatsapp.net' }, { remoteJid: '12345@g.us' }, { fromMe: false }, { fromMe: undefined }, { participant: '12025550102@s.whatsapp.net' }]) assert.equal(await f.get(key), undefined);
  f.reverse('12025550102@s.whatsapp.net'); assert.equal(await f.get({ remoteJid: lid }), undefined); f.reverse(pn);
  f.active(false); assert.equal(await f.get({}), undefined); f.active(true);
  f.config.botNumber = '12025550108'; assert.equal(await f.get({}), undefined); f.config.botNumber = bot;
  f.tick(24 * 60 * 60_000); assert.equal(await f.get({}), undefined); assert.equal(f.row().message_proto, null);
  assert.equal(f.sent.length, 1);
});

test('untrusted fromMe false, old socket, and mismatched aliases cannot forge delivery evidence', async t => {
  const f = fixture(t, { mapped: true }); await f.send(new AbortController().signal); const initial = f.events.length;
  f.socket.ev.emit('messages.update', [{ key: { id, remoteJid: pn, participant: '12025550102@s.whatsapp.net', fromMe: true }, update: { status: 4 } }]);
  f.socket.ev.emit('messages.update', [{ key: { id, remoteJid: lid, fromMe: false }, update: { status: 4 } }]);
  f.reverse('12025550102@s.whatsapp.net'); f.socket.ev.emit('messages.update', [{ key: { id, remoteJid: lid, fromMe: true }, update: { status: 4 } }]); await flush();
  f.reverse(pn); f.current(false); f.socket.ev.emit('messages.update', [{ key: { id, remoteJid: pn, fromMe: true }, update: { status: 4 } }]); await flush();
  assert.equal(f.events.length, initial); assert.equal(f.row().read_at, null);
});

test('first-contact device query can learn a verified LID before persistence and relay', async t => {
  const f = fixture(t); let learned = false;
  f.socket.signalRepository.lidMapping.getLIDForPN = async () => learned ? lid : null;
  f.socket.getUSyncDevices = async jids => {
    f.queries.push(jids[0]); learned = true;
    return [{ jid: jids[0] }];
  };
  assert.equal((await f.send(new AbortController().signal)).status, 'server_ack');
  assert.deepEqual(f.queries, [pn, lid]); assert.equal(f.sent[0].to, lid);
  assert.deepEqual(JSON.parse(f.row().aliases_json), [pn, lid]);
  assert.ok(await f.get({ remoteJid: lid }));
});

test('connection or allowlist revoked during final asynchronous authorization cannot reach relay', async t => {
  for (const revoke of [f => f.current(false), f => f.config.allowedNumbers.clear()]) {
    const f = fixture(t); let checks = 0;
    const options = { ...f.options, authorize: async () => { if (++checks === 3) revoke(f); return true; } };
    const transport = createPrivateOutboxTransport(options);
    await assert.rejects(transport.send({ to: pn, text: 'Synthetic', messageId: id, signal: new AbortController().signal }, { socket: f.socket, isCurrent: f.isCurrent }), error => error.definitelyNotSent === true);
    assert.equal(checks, 3); assert.equal(f.sent.length, 0); assert.equal(f.row(), undefined);
  }
});

test('unknown raw errors are sanitized and no message/session data enters evidence', async t => {
  const f = fixture(t);
  f.socket.relayMessage = async () => { f.socket.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', from: pn, id, error: 'SYNTHETIC_SECRET_ERROR' } }); };
  await assert.rejects(f.send(new AbortController().signal));
  assert.equal(f.events[0].errorCode, 'unknown'); assert.doesNotMatch(JSON.stringify(f.events), /SYNTHETIC_SECRET|conversation|messageSecret|نص/);
});
