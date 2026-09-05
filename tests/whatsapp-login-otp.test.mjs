import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createWhatsAppLoginOtp } from "../lib/whatsapp-login-otp.ts";

const PHONE = "12025550101";
const SECOND_PHONE = "12025550102";
const CLIENT = "trusted-test-address";

function fixture(t, options = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, active INTEGER);
    INSERT INTO users VALUES ('alice', 'Alice', 'member', 1), ('bob', 'Bob', 'member', 1);`);
  const deliveries = [];
  let clock = 1_000_000;
  let contacts = [{ userId: "alice", number: PHONE }];
  const service = createWhatsAppLoginOtp({
    db, secret: randomBytes(32), contacts: () => contacts, now: () => clock,
    deliverOtp: async delivery => { deliveries.push({ ...delivery }); },
    ...options,
  });
  return {
    db, deliveries, service,
    advance: ms => { clock += ms; },
    contacts: value => { contacts = value; },
    prepare: (phone = PHONE, clientKey = CLIENT) => service.prepare({ phone, clientKey }),
    verify: (prepared, code, phone = PHONE, clientKey = CLIENT) => service.verify({
      challengeId: prepared.response.challengeId, phone, code, clientKey,
    }),
    state: prepared => db.prepare("SELECT * FROM whatsapp_login_otp_challenges WHERE challenge_id = ?")
      .get(prepared.response.challengeId),
  };
}

test("private six-digit code authenticates only after delivery and only once", async t => {
  const f = fixture(t);
  const p = f.prepare("+1 (202) 555-0101");
  assert.equal(f.state(p).state, "pending");
  assert.equal(f.verify(p, "123456").ok, false);
  await p.deliver();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].to, PHONE);
  assert.match(f.deliveries[0].code, /^\d{6}$/);
  assert.equal(f.state(p).state, "sent");
  assert.deepEqual(f.verify(p, f.deliveries[0].code), {
    ok: true, user: { id: "alice", name: "Alice", role: "member", active: 1 },
  });
  assert.equal(f.verify(p, f.deliveries[0].code).ok, false);
  assert.equal(f.state(p).state, "consumed");
});

test("database and public response contain no plaintext OTP, phone, or client address", async t => {
  const f = fixture(t);
  const p = f.prepare();
  await p.deliver();
  const serialized = JSON.stringify({
    response: p.response,
    challenges: f.db.prepare("SELECT * FROM whatsapp_login_otp_challenges").all(),
    rates: f.db.prepare("SELECT * FROM whatsapp_login_otp_rates").all(),
    cooldowns: f.db.prepare("SELECT * FROM whatsapp_login_otp_cooldowns").all(),
  });
  assert.equal(serialized.includes(`"${f.deliveries[0].code}"`), false);
  assert.equal(serialized.includes(PHONE), false);
  assert.equal(serialized.includes(CLIENT), false);
  assert.match(f.state(p).code_mac, /^[a-f0-9]{64}$/);
});

test("unknown, inactive, malformed, and duplicate contacts all give the same generic response", async t => {
  const f = fixture(t);
  const known = f.prepare();
  const shape = ({ challengeId, ...response }) => response;
  const unknown = f.prepare(SECOND_PHONE);
  const malformed = f.prepare("not a phone");
  await unknown.deliver();
  await malformed.deliver();
  f.db.exec("UPDATE users SET active = 0 WHERE id = 'alice'");
  await known.deliver();
  assert.equal(f.deliveries.length, 0);
  assert.deepEqual(shape(known.response), shape(unknown.response));
  assert.deepEqual(shape(known.response), shape(malformed.response));
  f.advance(60_000);
  f.db.exec("UPDATE users SET active = 1 WHERE id = 'alice'");
  f.contacts([{ userId: "alice", number: PHONE }, { userId: "bob", number: PHONE }]);
  const duplicate = f.prepare();
  await duplicate.deliver();
  assert.equal(f.deliveries.length, 0);
  assert.deepEqual(shape(known.response), shape(duplicate.response));
});

test("codes are bound to a challenge, login purpose, phone, and current user mapping", async t => {
  const f = fixture(t);
  const p = f.prepare();
  await p.deliver();
  const code = f.deliveries[0].code;
  assert.equal(f.verify(p, code, SECOND_PHONE).ok, false);
  const fake = { response: { challengeId: randomBytes(32).toString("base64url") } };
  assert.equal(f.verify(fake, code).ok, false);
  assert.equal(f.state(p).purpose, "login");
  f.contacts([{ userId: "bob", number: PHONE }]);
  assert.equal(f.verify(p, code).ok, false);
  assert.equal(f.state(p).state, "locked");
});

test("deactivated employee cannot use an already delivered code", async t => {
  const f = fixture(t);
  const p = f.prepare();
  await p.deliver();
  f.db.exec("UPDATE users SET active = 0 WHERE id = 'alice'");
  assert.equal(f.verify(p, f.deliveries[0].code).ok, false);
});

test("code expires exactly five minutes after issue", async t => {
  const f = fixture(t);
  const p = f.prepare();
  await p.deliver();
  f.advance(300_000);
  assert.equal(f.verify(p, f.deliveries[0].code).ok, false);
});

test("pending code is not sent after expiry", async t => {
  const f = fixture(t);
  const p = f.prepare();
  f.advance(300_000);
  await p.deliver();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.state(p).state, "failed");
});

test("resend cooldown preserves old code; accepted resend invalidates it", async t => {
  const f = fixture(t);
  const first = f.prepare();
  await first.deliver();
  const blocked = f.prepare();
  await blocked.deliver();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.state(blocked), undefined);
  assert.equal(f.state(first).state, "sent");
  f.advance(60_000);
  const second = f.prepare();
  assert.equal(f.state(first).state, "superseded");
  await second.deliver();
  assert.equal(f.verify(first, f.deliveries[0].code).ok, false);
  assert.equal(f.verify(second, f.deliveries[1].code).ok, true);
});

test("delayed old delivery cannot reactivate a superseded challenge", async t => {
  let finish;
  let captured;
  const f = fixture(t, {
    deliverOtp: delivery => { captured = delivery; return new Promise(resolve => { finish = resolve; }); },
  });
  const first = f.prepare();
  const delivering = first.deliver();
  await Promise.resolve();
  f.advance(60_000);
  f.prepare();
  finish();
  await delivering;
  assert.equal(f.state(first).state, "superseded");
  assert.equal(f.verify(first, captured.code).ok, false);
});

test("five wrong attempts lock a code; rotating client buckets does not bypass phone limits", async t => {
  const f = fixture(t);
  const p = f.prepare();
  await p.deliver();
  const code = f.deliveries[0].code;
  const wrong = code === "111111" ? "222222" : "111111";
  for (let i = 0; i < 5; i++) assert.equal(f.verify(p, wrong, PHONE, `trusted-${i}`).ok, false);
  assert.equal(f.state(p).state, "locked");
  assert.equal(f.verify(p, code, PHONE, "trusted-final").ok, false);
});

test("phone request quota holds across client rotation, and resets after fifteen minutes", async t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) {
    await f.prepare(PHONE, `trusted-${i}`).deliver();
    f.advance(60_000);
  }
  const blocked = f.prepare(PHONE, "trusted-new");
  await blocked.deliver();
  assert.equal(f.deliveries.length, 3);
  assert.equal(f.state(blocked), undefined);
  f.advance(15 * 60_000);
  await f.prepare().deliver();
  assert.equal(f.deliveries.length, 4);
});

test("client request quota holds across recipient rotation", async t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) await f.prepare(`12025550${String(i + 200).padStart(3, "0")}`).deliver();
  const blocked = f.prepare();
  await blocked.deliver();
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.state(blocked), undefined);
});

test("verification has phone-wide and client-wide limits even for nonexistent challenges", async t => {
  const f = fixture(t);
  const p = f.prepare();
  await p.deliver();
  const fake = { response: { challengeId: randomBytes(32).toString("base64url") } };
  for (let i = 0; i < 10; i++) f.verify(fake, "000000", PHONE, `trusted-${i}`);
  assert.equal(f.verify(p, f.deliveries[0].code, PHONE, "trusted-other").ok, false);

  f.advance(15 * 60_000);
  const second = f.prepare();
  await second.deliver();
  for (let i = 0; i < 60; i++) f.verify(fake, "000000", `12025550${String(i + 200).padStart(3, "0")}`);
  assert.equal(f.verify(second, f.deliveries[1].code).ok, false);
});

test("missing trusted client identity is denied without distinguishing accounts", async t => {
  const f = fixture(t);
  const p = f.prepare(PHONE, "");
  await p.deliver();
  assert.equal(f.deliveries.length, 0);
  assert.equal(p.response.accepted, true);
  assert.equal(f.verify(p, "000000", PHONE, "").ok, false);
});

test("delivery failures never make a code usable or expose provider errors", async t => {
  let captured;
  const f = fixture(t, { deliverOtp: async delivery => {
    captured = delivery;
    throw new Error(`sensitive ${delivery.code} ${delivery.to}`);
  } });
  const p = f.prepare();
  assert.equal(await p.deliver(), undefined);
  assert.equal(f.state(p).state, "failed");
  assert.equal(f.verify(p, captured.code).ok, false);
  assert.equal(JSON.stringify(p.response).includes(captured.code), false);
});

test("delivery timeout aborts the provider and ignores late acknowledgement", async t => {
  let captured;
  let finish;
  const f = fixture(t, { deliveryTimeoutMs: 5, deliverOtp: delivery => {
    captured = delivery;
    return new Promise(resolve => { finish = resolve; });
  } });
  const p = f.prepare();
  await p.deliver();
  assert.equal(captured.signal.aborted, true);
  assert.equal(f.state(p).state, "failed");
  finish();
  await Promise.resolve();
  assert.equal(f.verify(p, captured.code).ok, false);
});

test("concurrent delivery calls send once, and pending callback does not permit login", async t => {
  let captured;
  let finish;
  let count = 0;
  const f = fixture(t, { deliverOtp: delivery => {
    count++;
    captured = delivery;
    return new Promise(resolve => { finish = resolve; });
  } });
  const p = f.prepare();
  const first = p.deliver();
  const second = p.deliver();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(f.verify(p, captured.code).ok, false);
  finish();
  await Promise.all([first, second]);
  assert.equal(count, 1);
  assert.equal(f.verify(p, captured.code).ok, true);
});

test("short secrets are rejected and existing users/session tables are not modified", t => {
  const f = fixture(t);
  assert.throws(() => createWhatsAppLoginOtp({
    db: f.db, secret: randomBytes(16), contacts: () => [], deliverOtp: async () => {},
  }), /at least 32 bytes/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 2);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(), undefined);
});
