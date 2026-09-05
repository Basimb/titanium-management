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

test("confirmation atomically queues once with deterministic per-recipient message IDs", t => {
  const f = fixture(t); const p = f.preview();
  const confirmed = f.confirm(p, { confirmationMessageId: "accepted-confirmation" });
  assert.equal(confirmed.state, "queued"); assert.equal(confirmed.recipientCount, 2); assert.equal(confirmed.pendingCount, 2);
  assert.equal(f.confirm(p, { confirmationMessageId: "accepted-confirmation" }).pendingCount, 2);
  assert.equal(f.confirm(p, { confirmationMessageId: "another-confirmation" }).pendingCount, 2);
  assert.equal(rows(f).length, 2); assert.equal(new Set(rows(f).map(row => row.message_id)).size, 2);
  assert.ok(rows(f).every(row => /^TITANIUMOUT[A-F0-9]+$/.test(row.message_id)));
  assert.doesNotMatch(JSON.stringify(confirmed), /1202555|phone/);
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
  assert.equal((await jobs.deliverNext(send)).status, "sent"); assert.equal((await jobs.deliverNext(send)).status, "sent");
  assert.equal((await jobs.deliverNext(send)).status, "sent"); assert.equal((await jobs.deliverNext(noSend)).status, "idle");
  assert.deepEqual(new Set(sent.slice(0, 2).map(row => row.to)), new Set(["12025550101@s.whatsapp.net", "12025550102@s.whatsapp.net"]));
  assert.ok(sent.slice(0, 2).every(row => row.text === p.text)); assert.ok(sent.every(row => !row.to.endsWith("@g.us")));
  assert.equal(sent[2].to, "12025550103@s.whatsapp.net"); assert.match(sent[2].text, /قُبل الإرسال.*2 من 2/); assert.match(sent[2].text, /لا يؤكد وصول الرسالة أو قراءتها/);
  assert.match(sent[2].text, /محمود: قُبل الإرسال/); assert.match(sent[2].text, /ليلى: قُبل الإرسال/); assert.ok(sent[2].text.length <= 4000);
  assert.equal(f.status().state, "sent"); assert.equal(f.status().acceptedCount, 2);
});

test("recipient remap after confirmation fails safely and completion reports the failure without retry", async t => {
  const f = fixture(t); f.confirm(f.preview({ recipientIds: ["a"] }));
  f.config({ enabled: true, contacts: baseContacts.map(row => row.userId === "a" ? { ...row, number: "12025550109" } : row) });
  const jobs = f.jobs(); assert.equal((await jobs.deliverNext(noSend)).status, "failed");
  let receipt; assert.equal((await jobs.deliverNext(async message => { receipt = message; })).status, "sent");
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
  const sent = []; const jobs = f.jobs(); assert.equal((await jobs.deliverNext(async message => { sent.push(message); })).status, "sent");
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
  complete(); assert.equal((await inFlight).status, "sent"); assert.equal(sends, 1);
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
