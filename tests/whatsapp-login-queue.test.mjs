import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWhatsAppLoginOtp } from "../lib/whatsapp-login-otp.ts";
import { createWhatsAppLoginQueue, deriveLoginKey, normalizeLoginPhone } from "../lib/whatsapp-login-queue.ts";

const PHONE = "12025550101";
const OTHER = "12025550102";
const CLIENT = "trusted-site-wide-limit";

function fixture(t, workerOptions = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, active INTEGER);
    INSERT INTO users VALUES ('alice','Alice','member',1), ('bob','Bob','member',1);`);
  const secret = randomBytes(32);
  let clock = 1_000_000;
  let contacts = [{ userId: "alice", number: PHONE }];
  const config = { db, secret, contacts: () => contacts, now: () => clock };
  const otp = createWhatsAppLoginOtp({ ...config, deliveryMode: "durable" });
  const queue = createWhatsAppLoginQueue({ ...config, ...workerOptions });
  return {
    db, secret, otp, queue, config,
    advance: ms => { clock += ms; },
    contacts: values => { contacts = values; },
    prepare: (phone = PHONE) => otp.prepare({ phone, clientKey: CLIENT }),
    verify: (prepared, code, phone = PHONE) => otp.verify({ phone, code, clientKey: CLIENT, challengeId: prepared.response.challengeId }),
    state: prepared => db.prepare("SELECT * FROM whatsapp_login_otp_challenges WHERE challenge_id = ?").get(prepared.response.challengeId),
    row: prepared => db.prepare("SELECT * FROM whatsapp_login_otp_queue WHERE challenge_id = ?").get(prepared.response.challengeId),
  };
}

test("durable prepare queues atomically and needs worker acknowledgement before login", async t => {
  const f = fixture(t);
  const p = f.prepare();
  assert.equal(f.state(p).state, "pending");
  assert.equal(f.row(p).state, "queued");
  await p.deliver();
  assert.equal(f.row(p).state, "queued"); // Request lifecycle does not send anything.
  let sent;
  const result = await f.queue.deliverNext(async delivery => {
    sent = delivery;
    assert.equal(f.verify(p, delivery.code).ok, false);
    assert.equal(f.row(p).state, "sending");
  });
  assert.deepEqual(result, { status: "sent" });
  assert.equal(sent.to, PHONE);
  assert.match(sent.code, /^\d{6}$/);
  assert.equal(f.row(p).encrypted_payload, null);
  assert.equal(f.verify(p, sent.code).ok, true);
  assert.equal(f.verify(p, sent.code).ok, false);
  assert.deepEqual(await f.queue.deliverNext(async () => assert.fail("duplicate send")), { status: "idle" });
});

test("OTP queue contains no plaintext phone, user, or code and uses a separate derived key", t => {
  const f = fixture(t);
  const p = f.prepare();
  const row = f.row(p);
  assert.match(row.encrypted_payload, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const lease = f.queue.claim();
  const delivery = f.queue.beginSend(lease);
  const persisted = JSON.stringify({ row, challenge: f.state(p) });
  assert.equal(persisted.includes(PHONE), false);
  assert.equal(persisted.includes(`"${delivery.code}"`), false);
  assert.equal(row.encrypted_payload.includes("alice"), false);
  assert.notDeepEqual(deriveLoginKey(f.secret, "queue"), deriveLoginKey(f.secret, "verifier"));
  assert.equal(f.queue.ack(lease, false), false);
  assert.equal(f.row(p).encrypted_payload, null);
});

test("queue INSERT failure rolls back verifier, rate and cooldown writes", t => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER fail_otp_queue BEFORE INSERT ON whatsapp_login_otp_queue
    BEGIN SELECT RAISE(ABORT, 'simulated queue unavailable'); END;`);
  assert.throws(() => f.prepare(), /queue unavailable/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM whatsapp_login_otp_challenges").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM whatsapp_login_otp_rates").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM whatsapp_login_otp_cooldowns").get().n, 0);
});

test("only active unique registered numbers have queue entries; public response stays generic", t => {
  const f = fixture(t);
  const shape = ({ challengeId, ...rest }) => rest;
  const known = f.prepare();
  const unknown = f.prepare(OTHER);
  assert.deepEqual(shape(known.response), shape(unknown.response));
  assert.equal(f.row(unknown), undefined);
  f.contacts([{ userId: "alice", number: PHONE }, { userId: "bob", number: PHONE }]);
  f.advance(60_000);
  const duplicate = f.prepare();
  assert.equal(f.row(duplicate), undefined);
  f.contacts([{ userId: "alice", number: PHONE }]);
  f.db.exec("UPDATE users SET active = 0 WHERE id = 'alice'");
  f.advance(60_000);
  const inactive = f.prepare();
  assert.equal(f.row(inactive), undefined);
  assert.deepEqual(shape(known.response), shape(inactive.response));
});

test("Arabic and Persian digits normalize identically on server and private worker", async t => {
  assert.equal(normalizeLoginPhone("+١ (٢٠٢) ٥٥٥-٠١٠١"), PHONE);
  assert.equal(normalizeLoginPhone("۰۰۱۲۰۲۵۵۵۰۱۰۱"), PHONE);
  assert.equal(normalizeLoginPhone("group12025550101@g.us"), null);
  const f = fixture(t);
  f.contacts([{ userId: "alice", number: "+١٢٠٢٥٥٥٠١٠١" }]);
  const p = f.prepare("+۱۲۰۲۵۵۵۰۱۰۱");
  let sent;
  await f.queue.deliverNext(async delivery => { sent = delivery; });
  assert.equal(sent.to, PHONE);
  assert.equal(f.verify(p, sent.code, "+١٢٠٢٥٥٥٠١٠١").ok, true);
});

test("two independent SQLite handles cannot claim/send the same challenge twice", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "titanium-login-queue-test-"));
  const filename = path.join(directory, "queue.sqlite");
  const firstDb = new DatabaseSync(filename);
  const secondDb = new DatabaseSync(filename);
  t.after(() => {
    firstDb.close(); secondDb.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(filename + suffix, { force: true });
    rmdirSync(directory);
  });
  firstDb.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, active INTEGER);
    INSERT INTO users VALUES ('alice','Alice','member',1);`);
  const config = { secret: randomBytes(32), contacts: () => [{ userId: "alice", number: PHONE }] };
  const otp = createWhatsAppLoginOtp({ ...config, db: firstDb, deliveryMode: "durable" });
  const first = createWhatsAppLoginQueue({ ...config, db: firstDb });
  const second = createWhatsAppLoginQueue({ ...config, db: secondDb });
  otp.prepare({ phone: PHONE, clientKey: CLIENT });
  let sends = 0;
  const results = await Promise.all([
    first.deliverNext(async () => { sends++; }),
    second.deliverNext(async () => { sends++; }),
  ]);
  assert.equal(sends, 1);
  assert.deepEqual(results.map(result => result.status).sort(), ["idle", "sent"]);
});

test("wrong lease, second beginSend and replay acknowledgement are rejected", t => {
  const f = fixture(t);
  const p = f.prepare();
  const lease = f.queue.claim();
  assert.equal(f.queue.beginSend({ ...lease, leaseId: randomBytes(32).toString("base64url") }), null);
  assert.equal(f.queue.ack(lease, true), false); // Claim alone is not send acceptance.
  assert.equal(f.row(p).state, "failed");
  f.advance(60_000);
  const second = f.prepare();
  const freshLease = f.queue.claim();
  const delivery = f.queue.beginSend(freshLease);
  assert.equal(f.queue.beginSend(freshLease), null);
  assert.equal(f.queue.ack({ ...freshLease, leaseId: "wrong" }, true), false);
  assert.equal(f.queue.ack(freshLease, true), true);
  assert.equal(f.queue.ack(freshLease, true), false);
  assert.equal(f.verify(second, delivery.code).ok, true);
});

test("claimed/sending crash leases expire to failure, never automatic resend", t => {
  const f = fixture(t, { leaseMs: 1000, sendTimeoutMs: 10 });
  const p = f.prepare();
  const lease = f.queue.claim();
  const delivery = f.queue.beginSend(lease);
  f.advance(1000);
  const restarted = createWhatsAppLoginQueue({ ...f.config, leaseMs: 1000, sendTimeoutMs: 10 });
  assert.equal(restarted.claim(), null);
  assert.equal(f.row(p).state, "failed");
  assert.equal(f.row(p).encrypted_payload, null);
  assert.equal(restarted.ack(lease, true), false);
  assert.equal(f.verify(p, delivery.code).ok, false);

  f.advance(60_000);
  const claimed = f.prepare();
  restarted.claim(); // Crash before any send is also fail-closed.
  f.advance(1000);
  restarted.prune();
  assert.equal(f.row(claimed).state, "failed");
});

test("provider failure and timeout are sanitized terminal outcomes", async t => {
  const f = fixture(t, { leaseMs: 1000, sendTimeoutMs: 5 });
  const p = f.prepare();
  let code;
  const failure = await f.queue.deliverNext(async delivery => {
    code = delivery.code;
    throw new Error(`secret ${delivery.to} ${delivery.code}`);
  });
  assert.deepEqual(failure, { status: "failed" });
  assert.equal(f.verify(p, code).ok, false);
  f.advance(60_000);
  const second = f.prepare();
  let signal;
  let finish;
  const timeout = await f.queue.deliverNext(delivery => {
    code = delivery.code;
    signal = delivery.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  assert.deepEqual(timeout, { status: "failed" });
  assert.equal(signal.aborted, true);
  finish();
  await Promise.resolve();
  assert.equal(f.verify(second, code).ok, false);
  assert.equal(f.row(second).encrypted_payload, null);
});

test("resend atomically supersedes and scrubs previous queued or in-flight code", t => {
  const f = fixture(t);
  const first = f.prepare();
  const lease = f.queue.claim();
  const old = f.queue.beginSend(lease);
  f.advance(60_000);
  const second = f.prepare();
  assert.equal(f.row(first).encrypted_payload, null);
  assert.equal(f.row(first).state, "failed");
  assert.equal(f.row(second).state, "queued");
  assert.equal(f.queue.ack(lease, true), false);
  assert.equal(f.verify(first, old.code).ok, false);
});

test("expired payloads are removed and cannot be sent or acknowledged", t => {
  const f = fixture(t);
  const p = f.prepare();
  f.advance(300_000);
  assert.equal(f.queue.claim(), null);
  assert.equal(f.row(p), undefined);
  assert.equal(f.state(p).state, "failed");
});

test("mapping/deactivation is rechecked before claim, immediately before send, after send, and verify", async t => {
  const f = fixture(t);
  const first = f.prepare();
  f.contacts([{ userId: "bob", number: PHONE }]);
  assert.equal(f.queue.claim(), null);
  assert.equal(f.row(first).state, "failed");

  f.contacts([{ userId: "alice", number: PHONE }]);
  f.advance(60_000);
  const second = f.prepare();
  const lease = f.queue.claim();
  f.db.exec("UPDATE users SET active = 0 WHERE id = 'alice'");
  assert.equal(f.queue.beginSend(lease), null);
  assert.equal(f.row(second).state, "failed");

  f.db.exec("UPDATE users SET active = 1 WHERE id = 'alice'");
  f.advance(60_000);
  const third = f.prepare();
  let delivery;
  assert.deepEqual(await f.queue.deliverNext(async value => {
    delivery = value;
    f.contacts([{ userId: "bob", number: PHONE }]);
  }), { status: "failed" });
  assert.equal(f.verify(third, delivery.code).ok, false);
});

test("ciphertext mutation or copying across challenges cannot redirect OTP delivery", t => {
  const f = fixture(t);
  const p = f.prepare();
  const ciphertext = f.row(p).encrypted_payload;
  f.db.prepare("UPDATE whatsapp_login_otp_queue SET encrypted_payload = ? WHERE challenge_id = ?")
    .run(ciphertext.slice(0, 12) + "!" + ciphertext.slice(13), p.response.challengeId);
  assert.equal(f.queue.claim(), null);
  assert.equal(f.row(p).state, "failed");
  f.advance(60_000);
  const second = f.prepare();
  f.db.prepare("UPDATE whatsapp_login_otp_queue SET encrypted_payload = ? WHERE challenge_id = ?")
    .run(ciphertext, second.response.challengeId);
  assert.equal(f.queue.claim(), null);
  assert.equal(f.row(second).state, "failed");
});

test("worker constructed before OTP schema is ready stays idle", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const queue = createWhatsAppLoginQueue({ db, secret: randomBytes(32), contacts: () => [] });
  assert.equal(queue.claim(), null);
});

test("worker sanitizes configuration/database failures before any send", async t => {
  const f = fixture(t);
  f.prepare();
  const queue = createWhatsAppLoginQueue({ ...f.config, contacts: () => { throw new Error(`private ${PHONE}`); } });
  assert.deepEqual(await queue.deliverNext(async () => assert.fail("must not send")), { status: "failed" });
  // Failed claim transaction rolled back; a healthy configuration can claim it.
  assert.notEqual(f.queue.claim(), null);
});
