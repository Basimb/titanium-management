import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSecretaryOutboxPreview, confirmSecretaryOutboxPreview, createSecretaryOutboxJobs,
  getSecretaryOutboxRecipients, getSecretaryOutboxStatus, migrateSecretaryOutbox, SecretaryOutboxError,
} from "../lib/secretary-outbox.ts";

const actor = { id: "basem", name: "باسم تجريبي", role: "admin", active: 1 };
const member = { id: "a", name: "محمود", role: "member", active: 1 };
const origin = { senderNumber: "12025550103", groupId: null };
const baseContacts = [{ userId: "basem", number: "12025550103" }, { userId: "a", number: "12025550101" }, { userId: "b", number: "12025550102" }];
function fixture(t, options = {}) {
  const db = options.database || new DatabaseSync(":memory:");
  if (!options.database) t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER);
    INSERT INTO users VALUES ('basem','باسم تجريبي','admin',1),('a','محمود','member',1),('b','ليلى','member',1),
      ('off','معطل','member',0),('unmapped','بلا رقم','member',1),('fake-admin','مدير آخر','admin',1);`);
  let clock = 1_000_000, config = { enabled: true, contacts: baseContacts.map(contact => ({ ...contact })) }, sequence = 0;
  const preview = (extra = {}) => createSecretaryOutboxPreview(db, { actor, origin, sourceMessageId: `source-${++sequence}`, text: "جمعة مباركة لكل الفريق", recipientIds: "all-team", ...extra }, config, { now: clock });
  const confirm = (p, extra = {}) => confirmSecretaryOutboxPreview(db, { actor, origin, batchId: p.batchId, confirmationMessageId: `confirm-${++sequence}`, ...extra }, config, { now: clock });
  return { db, preview, confirm, jobs: (extra = {}) => createSecretaryOutboxJobs({ db, config: () => config, now: () => clock, ...extra }),
    status: () => getSecretaryOutboxStatus(db, { actor, origin }, config),
    config: value => { config = value; }, get cfg() { return config; }, get now() { return clock; }, tick: value => { clock += value; } };
}
const denied = (fn, code) => assert.throws(fn, error => error instanceof SecretaryOutboxError && error.code === code);
const rows = f => f.db.prepare("SELECT * FROM secretary_outbox_deliveries ORDER BY recipient_id").all();
const noSend = async () => assert.fail("must not send");

test("preview freezes canonical exact text and names but creates no sendable delivery", async t => {
  const f = fixture(t); const p = f.preview({ text: "  *مرحبا*\r\n\r\n\r\n\r\nالفريق\u202e  " });
  assert.equal(p.state, "preview"); assert.equal(p.text, "*مرحبا*\n\n\nالفريق");
  assert.deepEqual(new Set(p.recipients.map(row => row.userId)), new Set(["a", "b"]));
  assert.equal(p.expiresAt, f.now + 600_000); assert.doesNotMatch(JSON.stringify(p), /1202555|phone|requester/);
  assert.equal(rows(f).length, 0); assert.equal((await f.jobs().deliverNext(noSend)).status, "idle");
  assert.equal(f.status(), null);
});

test("only exact active uniquely mapped members are directory recipients", t => {
  const f = fixture(t);
  assert.deepEqual(new Set(getSecretaryOutboxRecipients(f.db, f.cfg).map(row => row.userId)), new Set(["a", "b"]));
  f.config({ enabled: true, contacts: [...baseContacts, { userId: "a", number: "12025550109" }, { userId: "off", number: "12025550104" }, { userId: "fake-admin", number: "12025550105" }] });
  const recipients = getSecretaryOutboxRecipients(f.db, f.cfg); assert.deepEqual(recipients.map(row => row.userId), ["b"]);
  assert.doesNotMatch(JSON.stringify(recipients), /1202555/);
});

test("group, self-recipient, spoofed identity and non-owner requests cannot preview", t => {
  const f = fixture(t);
  denied(() => f.preview({ origin: { ...origin, groupId: "123@g.us" } }), "owner_private_only");
  denied(() => f.preview({ actor: member, origin: { senderNumber: "12025550101", groupId: null } }), "owner_private_only");
  denied(() => f.preview({ actor: { ...actor, name: "مزور" } }), "owner_unavailable");
  denied(() => f.preview({ origin: { senderNumber: "12025550101", groupId: null } }), "owner_unavailable");
  denied(() => f.preview({ actor: { ...actor, role: "member" } }), "owner_unavailable");
  denied(() => f.preview({ recipientIds: ["basem"] }), "recipient_unavailable");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM secretary_outbox_batches").get().n, 0);
});

test("malformed, empty and duplicate selections fail before a sendable queue exists", t => {
  const f = fixture(t);
  for (const change of [{ text: "" }, { text: "x".repeat(4001) }, { recipientIds: [] }, { recipientIds: ["a", "a"] }, { recipientIds: ["unknown"] }]) assert.throws(() => f.preview(change), SecretaryOutboxError);
  assert.equal(rows(f).length, 0);
});

test("idempotent source and reversed selection order keep one frozen batch; changed payload is denied", t => {
  const f = fixture(t);
  const p = f.preview({ sourceMessageId: "same-source", recipientIds: ["a", "b"] });
  const duplicate = f.preview({ sourceMessageId: "same-source", recipientIds: ["b", "a"] });
  assert.equal(duplicate.batchId, p.batchId); assert.deepEqual(duplicate.recipients, p.recipients);
  denied(() => f.preview({ sourceMessageId: "same-source", recipientIds: ["a", "b"], text: "نص مختلف" }), "changed_event");
  denied(() => f.preview({ sourceMessageId: "same-source", recipientIds: ["a"] }), "changed_event");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM secretary_outbox_batches").get().n, 1);
});

test("confirmation atomically queues once with durable per-recipient message IDs", t => {
  const f = fixture(t); const p = f.preview();
  const confirmed = f.confirm(p, { confirmationMessageId: "accepted-confirmation" });
  assert.equal(confirmed.state, "queued"); assert.equal(confirmed.recipientCount, 2); assert.equal(confirmed.pendingCount, 2);
  assert.equal(f.confirm(p, { confirmationMessageId: "accepted-confirmation" }).pendingCount, 2);
  assert.equal(f.confirm(p, { confirmationMessageId: "another-confirmation" }).pendingCount, 2);
  assert.equal(rows(f).length, 2); assert.equal(new Set(rows(f).map(row => row.message_id)).size, 2);
  assert.ok(rows(f).every(row => /^3EB0[A-F0-9]{36}$/.test(row.message_id)));
  assert.doesNotMatch(JSON.stringify(confirmed), /1202555|phone/);
});

test("new delivery and owner-report IDs use the established native format and stay fixed across replay", t => {
  const f = fixture(t), ids = [];
  for (let i = 0; i < 4; i++) {
    const sourceMessageId = `native-format-${i}`, p = f.preview({ sourceMessageId });
    const receiptId = f.db.prepare("SELECT receipt_message_id FROM secretary_outbox_batches WHERE id=?").get(p.batchId).receipt_message_id;
    assert.match(receiptId, /^3EB0[A-F0-9]{36}$/);
    assert.equal(f.preview({ sourceMessageId }).batchId, p.batchId);
    f.confirm(p, { confirmationMessageId: `native-confirm-${i}` });
    const before = rows(f).map(row => ({ ...row }));
    f.confirm(p, { confirmationMessageId: `native-confirm-${i}` });
    f.confirm(p, { confirmationMessageId: `native-confirm-duplicate-${i}` });
    f.preview({ sourceMessageId });
    assert.deepEqual(rows(f).map(row => ({ ...row })), before);
    assert.equal(f.db.prepare("SELECT receipt_message_id FROM secretary_outbox_batches WHERE id=?").get(p.batchId).receipt_message_id, receiptId);
    ids.push(receiptId, ...before.filter(row => row.batch_id === p.batchId).map(row => row.message_id));
  }
  assert.equal(ids.length, 12); assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => /^3EB0[A-F0-9]{36}$/.test(id)));
});

test("legacy queued and attempted IDs survive migration and replay with their exact evidence bindings", t => {
  const f = fixture(t), sourceMessageId = "legacy-id-source", p = f.preview({ sourceMessageId });
  const receiptId = "TITANIUMOUTSUMMARY" + p.batchId.toUpperCase();
  f.db.prepare("UPDATE secretary_outbox_batches SET receipt_message_id=? WHERE id=?").run(receiptId, p.batchId);
  f.confirm(p);
  for (const row of rows(f)) f.db.prepare("UPDATE secretary_outbox_deliveries SET message_id=? WHERE id=?").run("TITANIUMOUT" + row.id.toUpperCase(), row.id);
  f.db.prepare("UPDATE secretary_outbox_deliveries SET state='uncertain',sending_at=?,finished_at=? WHERE recipient_id='a'").run(f.now, f.now);
  f.db.prepare("UPDATE secretary_outbox_batches SET receipt_state='uncertain',receipt_sending_at=? WHERE id=?").run(f.now, p.batchId);
  const before = rows(f).map(row => ({ ...row }));
  const batchBefore = { ...f.db.prepare("SELECT * FROM secretary_outbox_batches WHERE id=?").get(p.batchId) };
  migrateSecretaryOutbox(f.db); f.preview({ sourceMessageId }); f.confirm(p);
  const jobs = f.jobs(), attempted = before.find(row => row.recipient_id === "a"), queued = before.find(row => row.recipient_id === "b");
  assert.deepEqual(jobs.getTransportBinding(attempted.message_id), { messageId: attempted.message_id, to: "12025550101@s.whatsapp.net", kind: "delivery" });
  assert.equal(jobs.getTransportBinding(queued.message_id), null);
  assert.equal(jobs.recordTransportUpdate({ messageId: attempted.message_id, to: "12025550101@s.whatsapp.net", status: "server_ack", at: f.now }).status, "recorded");
  assert.deepEqual(jobs.getTransportBinding(receiptId), { messageId: receiptId, to: "12025550103@s.whatsapp.net", kind: "receipt" });
  assert.equal(jobs.recordTransportUpdate({ messageId: receiptId, to: "12025550103@s.whatsapp.net", status: "read", at: f.now }).status, "recorded");
  assert.deepEqual(rows(f).map(row => ({ ...row })), before);
  assert.deepEqual({ ...f.db.prepare("SELECT * FROM secretary_outbox_batches WHERE id=?").get(p.batchId) }, batchBefore);
  assert.equal(f.status().acceptedCount, 1); assert.equal(f.status().readCount, 0);
});

test("one source event is not its own approval; confirmation cannot approve another batch twice", t => {
  const f = fixture(t); const first = f.preview({ sourceMessageId: "original" });
  denied(() => f.confirm(first, { confirmationMessageId: "original" }), "confirmation_required");
  f.confirm(first, { confirmationMessageId: "once" });
  const second = f.preview(); denied(() => f.confirm(second, { confirmationMessageId: "once" }), "reused_confirmation");
  assert.equal(rows(f).length, 2);
});

test("expired unconfirmed previews never queue or notify the owner", async t => {
  const f = fixture(t); const p = f.preview(); f.tick(600_000);
  denied(() => f.confirm(p), "expired"); assert.equal((await f.jobs().deliverNext(noSend)).status, "idle");
  assert.equal(rows(f).length, 0); assert.equal(f.status(), null);
});

test("changed recipient or requester identity invalidates exact preview before confirmation", t => {
  const f = fixture(t); const p = f.preview();
  f.config({ enabled: true, contacts: baseContacts.map(row => row.userId === "a" ? { ...row, number: "12025550109" } : row) });
  denied(() => f.confirm(p), "stale_recipients");
  f.config({ enabled: true, contacts: baseContacts }); f.db.exec("UPDATE users SET active=0 WHERE id='b'");
  denied(() => f.confirm(p), "stale_recipients");
  f.db.exec("UPDATE users SET active=1 WHERE id='b'; UPDATE users SET role='member' WHERE id='basem'");
  denied(() => f.confirm(p), "owner_unavailable"); assert.equal(rows(f).length, 0);
});

test("newly registered staff are not silently added after the exact preview", t => {
  const f = fixture(t); const p = f.preview();
  f.config({ enabled: true, contacts: [...baseContacts, { userId: "unmapped", number: "12025550109" }] });
  f.confirm(p); assert.deepEqual(rows(f).map(row => row.recipient_id), ["a", "b"]);
});

test("each recipient gets the same exact preview text privately and owner receives one honest completion", async t => {
  const f = fixture(t), p = f.preview({ text: "نص دقيق\n*للجميع*" }); f.confirm(p);
  const jobs = f.jobs(), sent = [];
  const send = async message => { assert.equal(f.db.isTransaction, false); assert.ok(message.signal instanceof AbortSignal); sent.push(message); };
  assert.equal((await jobs.deliverNext(send)).status, "submitted"); assert.equal((await jobs.deliverNext(send)).status, "submitted");
  assert.equal((await jobs.deliverNext(send)).status, "submitted"); assert.equal((await jobs.deliverNext(noSend)).status, "idle");
  assert.deepEqual(new Set(sent.slice(0, 2).map(row => row.to)), new Set(["12025550101@s.whatsapp.net", "12025550102@s.whatsapp.net"]));
  assert.ok(sent.slice(0, 2).every(row => row.text === p.text)); assert.ok(sent.every(row => !row.to.endsWith("@g.us")));
  assert.equal(sent[2].to, "12025550103@s.whatsapp.net"); assert.match(sent[2].text, /خادم واتساب: 0 من 2/); assert.match(sent[2].text, /لا يؤكد وصول الرسالة أو قراءتها/);
  assert.match(sent[2].text, /محمود: سُلّمت للنقل/); assert.match(sent[2].text, /ليلى: سُلّمت للنقل/); assert.ok(sent[2].text.length <= 4000);
  assert.equal(f.status().state, "submitted"); assert.equal(f.status().acceptedCount, 0); assert.equal(f.status().submittedCount, 2);
});

test("recipient remap after confirmation fails safely and completion reports the failure without retry", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] }));
  f.config({ enabled: true, contacts: baseContacts.map(row => row.userId === "a" ? { ...row, number: "12025550109" } : row) });
  const jobs = f.jobs(); assert.equal((await jobs.deliverNext(noSend)).status, "failed");
  let receipt; assert.equal((await jobs.deliverNext(async message => { receipt = message; })).status, "submitted");
  assert.equal(receipt.to, "12025550103@s.whatsapp.net"); assert.match(receipt.text, /تعذّر الإرسال: 1/);
  assert.match(receipt.text, /محمود: تعذّر الإرسال/);
  assert.equal((await jobs.deliverNext(noSend)).status, "idle"); assert.equal(f.status().failedCount, 1);
});

test("swapped phone mappings never redirect a queued message to another employee", async t => {
  const f = fixture(t); f.confirm(f.preview());
  f.config({ enabled: true, contacts: [baseContacts[0], { userId: "a", number: "12025550102" }, { userId: "b", number: "12025550101" }] });
  const jobs = f.jobs(); assert.equal((await jobs.deliverNext(noSend)).status, "failed"); assert.equal((await jobs.deliverNext(noSend)).status, "failed");
  assert.equal(f.status().failedCount, 2);
});

test("disabled recipient and revoked owner stop queued work and never leak a completion", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); f.db.exec("UPDATE users SET active=0 WHERE id='a'");
  const jobs = f.jobs(); assert.equal((await jobs.deliverNext(noSend)).status, "failed");
  f.db.exec("UPDATE users SET active=0 WHERE id='basem'"); assert.equal((await jobs.deliverNext(noSend)).status, "failed");
  assert.equal((await jobs.deliverNext(noSend)).status, "idle"); denied(() => f.status(), "owner_unavailable");
});

test("configuration is rechecked immediately after claim and before any send callback", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); let reads = 0;
  const jobs = f.jobs({ config: () => ({ ...f.cfg, enabled: ++reads === 1 }) });
  assert.equal((await jobs.deliverNext(noSend)).status, "failed"); assert.equal(rows(f)[0].state, "failed");
});

test("transport rejection is an honest uncertain terminal result, never a silent retry", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs(); let sends = 0;
  const result = await jobs.deliverNext(async () => { sends++; throw Error("SECRET transport exception with private phone"); });
  assert.deepEqual(result, { status: "uncertain" }); assert.equal(rows(f)[0].state, "uncertain");
  let receipt; await jobs.deliverNext(async message => { receipt = message; });
  assert.match(receipt.text, /النتيجة غير مؤكدة: 1/); assert.equal(sends, 1);
  assert.equal((await jobs.deliverNext(noSend)).status, "idle"); assert.doesNotMatch(JSON.stringify(result), /SECRET|phone/);
});

test("deadline aborts an unresponsive sender and late success cannot change uncertain status", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs({ timeoutMs: 5 });
  let complete, signal;
  const result = await jobs.deliverNext(message => { signal = message.signal; return new Promise(resolve => { complete = resolve; }); });
  assert.equal(result.status, "uncertain"); assert.equal(signal.aborted, true);
  complete(); await Promise.resolve(); assert.equal(rows(f)[0].state, "uncertain");
});

test("interrupted sending leases become uncertain without being sent again", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] }));
  f.db.prepare("UPDATE secretary_outbox_deliveries SET state='sending',sending_at=?").run(f.now); f.tick(60_000);
  const sent = []; const jobs = f.jobs(); assert.equal((await jobs.deliverNext(async message => { sent.push(message); })).status, "submitted");
  assert.equal(rows(f)[0].state, "uncertain"); assert.equal(sent.length, 1); assert.equal(sent[0].to, "12025550103@s.whatsapp.net");
  assert.equal((await jobs.deliverNext(noSend)).status, "idle");
});

test("completion receipt interrupted after starting is also never resent", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs();
  await jobs.deliverNext(async () => {});
  f.db.prepare("UPDATE secretary_outbox_batches SET receipt_state='sending',receipt_sending_at=?").run(f.now); f.tick(60_000);
  assert.equal((await jobs.deliverNext(noSend)).status, "idle");
  assert.equal(f.db.prepare("SELECT receipt_state FROM secretary_outbox_batches").get().receipt_state, "uncertain");
});

test("independent workers and SQLite handles claim one send once while awaiting transport", async t => {
  const folder = mkdtempSync(path.join(tmpdir(), "titanium-outbox-test-")), filename = path.join(folder, "synthetic.sqlite");
  const first = new DatabaseSync(filename), second = new DatabaseSync(filename);
  t.after(() => { second.close(); first.close(); for (const file of readdirSync(folder)) unlinkSync(path.join(folder, file)); rmdirSync(folder); });
  const f = fixture(t, { database: first }); f.confirm(f.preview({ recipientIds: ["a"] }));
  const one = f.jobs(), two = createSecretaryOutboxJobs({ db: second, config: f.cfg, now: () => f.now });
  let complete, sends = 0;
  const inFlight = one.deliverNext(() => { sends++; return new Promise(resolve => { complete = resolve; }); });
  assert.equal((await two.deliverNext(noSend)).status, "idle"); assert.equal((await one.deliverNext(noSend)).status, "idle");
  complete(); assert.equal((await inFlight).status, "submitted"); assert.equal(sends, 1);
});

test("outer rollback and failed queue insertion leave no partial delivery batch", t => {
  const f = fixture(t); migrateSecretaryOutbox(f.db);
  f.db.exec("BEGIN IMMEDIATE"); const p = f.preview(); f.confirm(p); assert.equal(f.db.isTransaction, true); f.db.exec("ROLLBACK");
  assert.equal(rows(f).length, 0); assert.equal(f.db.prepare("SELECT count(*) AS n FROM secretary_outbox_batches").get().n, 0);
  const next = f.preview(); f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON secretary_outbox_deliveries WHEN NEW.recipient_id='b' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => f.confirm(next), /synthetic failure/); assert.equal(rows(f).length, 0);
  assert.equal(f.db.prepare("SELECT state FROM secretary_outbox_batches").get().state, "preview");
});

test("workers never send inside an uncommitted transaction or while disabled", async t => {
  const f = fixture(t); const jobs = f.jobs(); assert.equal((await jobs.deliverNext(noSend)).status, "idle");
  const p = f.preview(); f.db.exec("BEGIN IMMEDIATE"); f.confirm(p);
  assert.equal((await jobs.deliverNext(noSend)).status, "idle"); f.db.exec("ROLLBACK");
  f.config({ ...f.cfg, enabled: false }); denied(() => f.preview(), "disabled");
  assert.equal((await jobs.deliverNext(noSend)).status, "idle");
});

test("frozen delivery rows cannot be rewritten to a different registered recipient", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] }));
  f.db.exec("UPDATE secretary_outbox_deliveries SET recipient_id='b',recipient_name='ليلى',recipient_phone='12025550102'");
  assert.equal((await f.jobs().deliverNext(noSend)).status, "failed");
});

test("safe status excludes previews and rejects non-owner or group access", t => {
  const f = fixture(t); f.preview(); assert.equal(f.status(), null);
  const p = f.preview({ recipientIds: ["a"] }); f.confirm(p); const status = f.status();
  assert.equal(status.batchId, p.batchId); assert.equal(status.state, "queued"); assert.equal(status.pendingCount, 1);
  assert.doesNotMatch(JSON.stringify(status), /1202555|جمعة|phone/);
  denied(() => getSecretaryOutboxStatus(f.db, { actor: member, origin: { senderNumber: "12025550101" } }, f.cfg), "owner_private_only");
  denied(() => getSecretaryOutboxStatus(f.db, { actor, origin: { ...origin, groupId: "123@g.us" } }, f.cfg), "owner_private_only");
});

test("owner phone remap before delivery cancels queued messages and never reroutes the receipt", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] }));
  f.config({ enabled: true, contacts: baseContacts.map(contact => contact.userId === "basem" ? { ...contact, number: "12025550109" } : contact) });
  const jobs = f.jobs(); assert.equal((await jobs.deliverNext(noSend)).status, "failed");
  assert.equal((await jobs.deliverNext(noSend)).status, "failed"); assert.equal((await jobs.deliverNext(noSend)).status, "idle");
  assert.equal(rows(f)[0].state, "failed");
});

test("over-20 all-team preview is rejected instead of silently omitting staff", t => {
  const f = fixture(t), contacts = [...baseContacts];
  for (let i = 0; i < 19; i++) {
    f.db.prepare("INSERT INTO users VALUES (?,?,'member',1)").run(`extra-${i}`, `موظف ${i}`);
    contacts.push({ userId: `extra-${i}`, number: `1202556${String(i).padStart(4, "0")}` });
  }
  f.config({ enabled: true, contacts }); denied(() => f.preview(), "too_many_recipients");
  assert.equal(rows(f).length, 0);
});

test("confirmed batches are limited to ten per hour and duplicate confirmation stays idempotent", t => {
  const f = fixture(t); let first;
  for (let i = 0; i < 10; i++) { const p = f.preview({ recipientIds: ["a"] }); if (!first) first = p; f.confirm(p); }
  const blocked = f.preview({ recipientIds: ["a"] }); denied(() => f.confirm(blocked), "outbox_limit");
  assert.equal(rows(f).length, 10); assert.equal(f.confirm(first).pendingCount, 1);
  f.tick(60 * 60_000); const next = f.preview({ recipientIds: ["a"] }); f.confirm(next); assert.equal(rows(f).length, 11);
});

test("queued backlog is bounded across hourly quota windows", t => {
  const f = fixture(t), contacts = [...baseContacts];
  for (let i = 0; i < 18; i++) {
    f.db.prepare("INSERT INTO users VALUES (?,?,'member',1)").run(`extra-${i}`, `موظف ${i}`);
    contacts.push({ userId: `extra-${i}`, number: `1202556${String(i).padStart(4, "0")}` });
  }
  f.config({ enabled: true, contacts });
  for (let i = 0; i < 10; i++) f.confirm(f.preview());
  assert.equal(rows(f).length, 200); f.tick(60 * 60_000);
  denied(() => f.confirm(f.preview({ recipientIds: ["a"] })), "outbox_limit"); assert.equal(rows(f).length, 200);
});

test("callback success and even a returned ACK label never create server acknowledgment evidence", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] }));
  const jobs = f.jobs(); assert.equal((await jobs.deliverNext(async () => ({ status: "server_ack", at: f.now }))).status, "submitted");
  assert.equal(rows(f)[0].state, "submitted"); assert.equal(rows(f)[0].outcome_code, "transport_submitted");
  const status = f.status(); assert.equal(status.acceptedCount, 0); assert.equal(status.deliveredCount, 0); assert.equal(status.readCount, 0); assert.equal(status.submittedCount, 1);
  assert.deepEqual(status.recipients[0].evidence, { serverAckAt: null, deliveredAt: null, readAt: null, errorAt: null, errorCode: null });
});

test("unknown, not-started, unconfirmed and forged-destination transport events are ignored", async t => {
  const f = fixture(t), p = f.preview({ recipientIds: ["a"] }); const jobs = f.jobs();
  const receiptId = f.db.prepare("SELECT receipt_message_id FROM secretary_outbox_batches").get().receipt_message_id;
  assert.equal(jobs.getTransportBinding(receiptId), null);
  assert.equal(jobs.recordTransportUpdate({ messageId: receiptId, to: "12025550103@s.whatsapp.net", status: "read", at: f.now }).status, "ignored");
  f.confirm(p); const id = rows(f)[0].message_id;
  assert.equal(jobs.getTransportBinding(id), null);
  assert.equal(jobs.recordTransportUpdate({ messageId: id, to: "12025550101@s.whatsapp.net", status: "server_ack", at: f.now }).status, "ignored");
  await jobs.deliverNext(async () => {});
  for (const to of ["12025550102@s.whatsapp.net", "12025550101", "+12025550101@s.whatsapp.net", "12025550101@lid", "123@g.us"]) {
    assert.equal(jobs.recordTransportUpdate({ messageId: id, to, status: "read", at: f.now }).status, "ignored");
  }
  assert.equal(jobs.recordTransportUpdate({ messageId: "unknown", to: "12025550101@s.whatsapp.net", status: "read", at: f.now }).status, "ignored");
  assert.equal(f.db.prepare("SELECT count(*) n FROM secretary_outbox_transport").get().n, 0);
});

test("real ACK received during sending survives callback completion and no read or delivery is invented", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs();
  await jobs.deliverNext(async message => {
    assert.deepEqual(jobs.getTransportBinding(message.messageId), { messageId: message.messageId, to: message.to, kind: "delivery" });
    assert.deepEqual(jobs.recordTransportUpdate({ messageId: message.messageId, to: message.to, status: "server_ack", at: f.now }), { status: "recorded", evidenceStatus: "server_ack" });
  });
  const status = f.status(); assert.equal(status.acceptedCount, 1); assert.equal(status.deliveredCount, 0); assert.equal(status.readCount, 0);
  assert.equal(status.recipients[0].state, "server_ack"); assert.equal(status.recipients[0].submissionState, "submitted"); assert.equal(status.recipients[0].evidence.serverAckAt, f.now);
});

test("late read after uncertain changes evidence only and cannot enqueue, retry or notify", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] }));
  f.db.exec("UPDATE secretary_outbox_batches SET receipt_state=NULL"); const jobs = f.jobs(); let message;
  assert.equal((await jobs.deliverNext(async value => { message = value; throw Error("unknown relay result"); })).status, "uncertain");
  const before = { ...rows(f)[0] }; f.tick(1000);
  assert.equal(jobs.recordTransportUpdate({ messageId: message.messageId, to: message.to, status: "read", at: f.now }).evidenceStatus, "read");
  assert.deepEqual({ ...rows(f)[0] }, before); assert.equal(f.db.prepare("SELECT receipt_state FROM secretary_outbox_batches").get().receipt_state, null);
  const status = f.status(); assert.equal(status.acceptedCount, 1); assert.equal(status.deliveredCount, 1); assert.equal(status.readCount, 1); assert.equal(status.recipients[0].submissionState, "uncertain");
  assert.equal(status.recipients[0].evidence.serverAckAt, null); assert.equal(status.recipients[0].evidence.deliveredAt, null);
  assert.equal((await jobs.deliverNext(noSend)).status, "idle"); assert.equal(rows(f).length, 1);
});

test("out-of-order ACK/error and duplicate events never downgrade read evidence", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs(); await jobs.deliverNext(async () => {});
  const id = rows(f)[0].message_id, to = "12025550101@s.whatsapp.net"; f.tick(2000);
  jobs.recordTransportUpdate({ messageId: id, to, status: "read", at: f.now });
  for (const status of ["server_ack", "error", "delivered", "read", "server_ack"]) {
    assert.equal(jobs.recordTransportUpdate({ messageId: id, to, status, at: f.now - 1000, ...(status === "error" ? { errorCode: "SECRET 12025550101 raw provider message" } : {}) }).evidenceStatus, "read");
  }
  const result = f.status(); assert.equal(result.recipients[0].state, "read"); assert.equal(result.acceptedCount, 1); assert.equal(result.readCount, 1);
  assert.equal(result.recipients[0].evidence.errorCode, "transport_error"); assert.doesNotMatch(JSON.stringify(result), /SECRET|12025550101|raw provider/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM secretary_outbox_transport").get().n, 1);
});

test("legacy sent and uncertain rows remain unchanged and never count as ACK without new evidence", async t => {
  const f = fixture(t); f.confirm(f.preview());
  f.db.prepare("UPDATE secretary_outbox_deliveries SET state=CASE recipient_id WHEN 'a' THEN 'sent' ELSE 'uncertain' END,sending_at=?,finished_at=?,outcome_code='accepted'").run(f.now, f.now);
  f.db.exec("UPDATE secretary_outbox_batches SET state='uncertain',receipt_state='sent'; DROP TABLE secretary_outbox_transport");
  const before = rows(f).map(row => ({ ...row })); migrateSecretaryOutbox(f.db); const jobs = f.jobs();
  const result = f.status(); assert.equal(result.acceptedCount, 0); assert.equal(result.submittedCount, 1); assert.equal(result.uncertainCount, 1);
  const legacy = result.recipients.find(row => row.userId === "a"); assert.equal(legacy.state, "submitted"); assert.equal(legacy.legacySubmission, true);
  assert.deepEqual(rows(f).map(row => ({ ...row })), before); assert.equal((await jobs.deliverNext(noSend)).status, "idle");
});

test("confirmed preflight failure is failed, not uncertain, and cannot acquire later forged proof", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs();
  const error = Object.assign(Error("private details must not escape"), { definitelyNotSent: true, code: "recipient_devices_unavailable" });
  assert.equal((await jobs.deliverNext(async () => { throw error; })).status, "failed");
  const row = rows(f)[0]; assert.equal(row.state, "failed"); assert.equal(row.outcome_code, "transport_preflight_rejected"); assert.equal(jobs.getTransportBinding(row.message_id), null);
  assert.equal(jobs.recordTransportUpdate({ messageId: row.message_id, to: "12025550101@s.whatsapp.net", status: "server_ack", at: f.now }).status, "ignored");
});

test("owner completion receipt proof never promotes staff delivery or reading", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs(); await jobs.deliverNext(async () => {});
  await jobs.deliverNext(async message => {
    assert.equal(jobs.getTransportBinding(message.messageId).kind, "receipt");
    assert.equal(jobs.recordTransportUpdate({ messageId: message.messageId, to: "12025550101@s.whatsapp.net", status: "read", at: f.now }).status, "ignored");
    assert.equal(jobs.recordTransportUpdate({ messageId: message.messageId, to: message.to, status: "read", at: f.now }).status, "recorded");
  });
  assert.equal(f.status().acceptedCount, 0); assert.equal(f.status().deliveredCount, 0); assert.equal(f.status().readCount, 0); assert.equal((await jobs.deliverNext(noSend)).status, "idle");
});

test("a remapped current phone cannot receive old-message proof and tampered frozen rows fail closed", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs(); await jobs.deliverNext(async () => {}); const id = rows(f)[0].message_id;
  f.config({ ...f.cfg, contacts: baseContacts.map(contact => contact.userId === "a" ? { ...contact, number: "12025550109" } : contact) });
  assert.equal(jobs.recordTransportUpdate({ messageId: id, to: "12025550109@s.whatsapp.net", status: "read", at: f.now }).status, "ignored");
  assert.equal(jobs.recordTransportUpdate({ messageId: id, to: "12025550101@s.whatsapp.net", status: "delivered", at: f.now }).status, "recorded");
  f.db.exec("UPDATE secretary_outbox_deliveries SET recipient_phone='12025550109'"); assert.equal(jobs.getTransportBinding(id), null);
  assert.equal(jobs.recordTransportUpdate({ messageId: id, to: "12025550109@s.whatsapp.net", status: "read", at: f.now }).status, "ignored");
});

test("invalid evidence times/status/extra fields do not persist and metadata participates in outer rollback", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] })); const jobs = f.jobs(); await jobs.deliverNext(async () => {});
  const base = { messageId: rows(f)[0].message_id, to: "12025550101@s.whatsapp.net", status: "server_ack", at: f.now };
  for (const extra of [{ at: f.now + 300001 }, { at: f.now - 1001 }, { at: NaN }, { status: "sent" }, { extra: "override" }]) assert.equal(jobs.recordTransportUpdate({ ...base, ...extra }).status, "ignored");
  f.db.exec("BEGIN IMMEDIATE"); assert.equal(jobs.recordTransportUpdate(base).status, "recorded"); f.db.exec("ROLLBACK");
  assert.equal(f.db.prepare("SELECT count(*) n FROM secretary_outbox_transport").get().n, 0); assert.equal(f.status().acceptedCount, 0);
});
