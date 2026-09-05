import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";
import * as directory from "../lib/whatsapp-login-directory.ts";
import * as otpModule from "../lib/whatsapp-login-otp.ts";
import { createWhatsAppLoginQueue } from "../lib/whatsapp-login-queue.ts";
import * as http from "../lib/whatsapp-login-http.ts";
import * as settingsModule from "../lib/whatsapp-login-settings.ts";

const PHONE = "12025550101", OTHER_PHONE = "12025550102", ADMIN_PHONE = "12025550103";
const BASE_CONTACTS = [{ userId: "alice", number: PHONE }, { userId: "bob", number: OTHER_PHONE }, { userId: "basem", number: ADMIN_PHONE }];
const ORIGIN = "https://management.example.test";
const routeSource = readFileSync(new URL("../app/api/auth/route.ts", import.meta.url), "utf8");
const routeJs = ts.transpileModule(routeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function database(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,pin_hash TEXT,private_phone TEXT);
    INSERT INTO users VALUES ('alice','أليس','member',1,'private-pin-hash','12025559999'),
      ('bob','بوب','member',1,NULL,NULL),('basem','مدير تجريبي','admin',1,NULL,NULL),
      ('disabled','حساب معطل','member',0,NULL,NULL),('unsupported','صلاحية مجهولة','owner',1,NULL,NULL),
      ('unmapped','بلا رقم','member',1,NULL,NULL);`);
  return db;
}

function fixture(t, overrides = {}) {
  const db = database(t), sessions = [], audits = [], pathChecks = [];
  const secret = randomBytes(32); let contacts = BASE_CONTACTS.map(contact => ({ ...contact }));
  let currentUser = null;
  const databasePath = path.resolve("synthetic-directory-test.sqlite");
  const settings = () => ({ WHATSAPP_LOGIN_ENABLED: "1", WHATSAPP_LOGIN_SECRET: secret.toString("hex"),
    WHATSAPP_LOGIN_DATABASE: databasePath, WHATSAPP_LOGIN_ORIGIN: ORIGIN, TEAM_CHAT_CONTACTS_JSON: JSON.stringify(contacts) });
  const forbiddenLegacy = () => { throw new Error("legacy authentication must not be reached in WhatsApp mode"); };
  const server = {
    audit: async (...args) => { audits.push(args); }, chatDatabase: () => db,
    ensureSeedUsers: async () => {}, getSessionUser: async () => currentUser,
    createSession: async user => { sessions.push(user); return { token: "synthetic-session-token", cookie: "session=synthetic; HttpOnly; Secure; SameSite=Lax" }; },
    db: forbiddenLegacy, checkLoginBlocked: forbiddenLegacy, clearLoginAttempts: forbiddenLegacy,
    destroySession: forbiddenLegacy, hashPin: forbiddenLegacy, isPlatformAuthenticated: forbiddenLegacy,
    isSetupRequired: forbiddenLegacy, loginAttemptKey: forbiddenLegacy, recordFailedLogin: forbiddenLegacy,
    validPin: forbiddenLegacy, verifyPin: forbiddenLegacy,
  };
  const imports = {
    "@/lib/titanium-server": server,
    "@/lib/team-chat-settings": { readTeamChatSettings: settings },
    "@/lib/whatsapp-login-settings": settingsModule,
    "@/lib/whatsapp-login-otp": overrides.otpModule || otpModule,
    "@/lib/whatsapp-login-directory": directory,
    "@/lib/whatsapp-login-http": { ...http, requireLoginDatabasePath: (actualDb, expected) => {
      assert.equal(actualDb, db); assert.equal(expected, databasePath); pathChecks.push(expected);
    } },
  };
  const module = { exports: {} };
  new Function("module", "exports", "require", routeJs)(module, module.exports, name => {
    assert.ok(Object.hasOwn(imports, name), `unexpected route dependency: ${name}`); return imports[name];
  });
  const queue = createWhatsAppLoginQueue({ db, secret, contacts: () => contacts });
  const post = (body, origin = ORIGIN) => module.exports.POST(new Request(`${ORIGIN}/api/auth`, {
    method: "POST", headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body),
  }));
  const get = () => module.exports.GET(new Request(`${ORIGIN}/api/auth`));
  const deliver = async () => {
    let sent; const result = await queue.deliverNext(async delivery => { sent = { to: delivery.to, code: delivery.code }; });
    assert.equal(result.status, "sent"); return sent;
  };
  return { db, post, get, deliver, queue, sessions, audits, pathChecks,
    contacts: value => { contacts = value; }, currentUser: value => { currentUser = value; } };
}

test("public directory contains only eligible id/name entries and puts Basem first", t => {
  const db = database(t);
  const contacts = [...BASE_CONTACTS, { userId: "disabled", number: "12025550104" }, { userId: "unsupported", number: "12025550105" }];
  const names = directory.whatsappLoginNames(db, contacts);
  assert.equal(names[0].id, "basem"); assert.deepEqual(new Set(names.map(user => user.id)), new Set(["basem", "alice", "bob"]));
  for (const user of names) assert.deepEqual(Object.keys(user).sort(), ["id", "name"]);
  assert.doesNotMatch(JSON.stringify(names), /1202555|pin|role|active|private_phone/);
});

test("unknown, disabled, unsupported and malformed identities never resolve to a destination", t => {
  const db = database(t);
  const contacts = [...BASE_CONTACTS, { userId: "disabled", number: "12025550104" }, { userId: "unsupported", number: "12025550105" }];
  for (const id of [undefined, null, [], {}, 1, "", "missing", "disabled", "unsupported", "unmapped", "أليس", "alice' OR 1=1--", "a".repeat(81)]) {
    assert.equal(directory.whatsappLoginPhoneForUser(db, contacts, id), "");
  }
  assert.equal(directory.whatsappLoginPhoneForUser(db, contacts, "alice"), PHONE);
});

test("duplicate normalized phones and multiple phones per account are unavailable, not first-match wins", t => {
  const db = database(t);
  for (const contacts of [
    [{ userId: "alice", number: PHONE }, { userId: "bob", number: `+1 (202) 555-0101` }],
    [{ userId: "alice", number: PHONE }, { userId: "alice", number: OTHER_PHONE }],
    [{ userId: "alice", number: PHONE }, { userId: "alice", number: PHONE }],
    [{ userId: "alice", number: PHONE }, { userId: "missing", number: PHONE }],
    [{ userId: "alice", number: "not-a-phone" }],
  ]) {
    assert.equal(directory.whatsappLoginPhoneForUser(db, contacts, "alice"), "");
    assert.ok(!directory.whatsappLoginNames(db, contacts).some(user => user.id === "alice"));
  }
  assert.equal(directory.whatsappLoginPhoneForUser(db, [{ userId: "alice", number: "+١ (٢٠٢) ٥٥٥-٠١٠١" }], "alice"), PHONE);
});

test("real auth GET exposes public login names without phone, role, PIN or private fields", async t => {
  const f = fixture(t); const response = await f.get(), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.authMethod, "whatsapp");
  assert.equal(body.authenticated, false); assert.equal(body.user, null); assert.deepEqual(body.users, []);
  assert.equal(body.setupRequired, false); assert.equal(body.loginUsers[0].id, "basem");
  for (const user of body.loginUsers) assert.deepEqual(Object.keys(user).sort(), ["id", "name"]);
  assert.doesNotMatch(JSON.stringify(body), /1202555|private-pin-hash|pinSet|private_phone/);
  assert.match(response.headers.get("cache-control"), /private.*no-store/); assert.equal(f.pathChecks.length, 1);
  assert.equal(f.sessions.length, 0);
});

test("real auth route sends selected account OTP only to its server mapping and consumes it once", async t => {
  const f = fixture(t);
  const issueResponse = await f.post({ action: "request-code", userId: "alice", phone: OTHER_PHONE, name: "بوب" });
  const issued = await issueResponse.json(); assert.equal(issueResponse.status, 202); assert.equal(issued.accepted, true);
  assert.doesNotMatch(JSON.stringify(issued), /1202555|alice|أليس/); assert.equal(f.sessions.length, 0);
  const sent = await f.deliver(); assert.equal(sent.to, PHONE);
  const verifyBody = { action: "verify-code", userId: "alice", phone: OTHER_PHONE, challengeId: issued.challengeId, code: sent.code };
  const verified = await f.post(verifyBody), result = await verified.json();
  assert.equal(verified.status, 200); assert.equal(result.authenticated, true); assert.equal(result.user.id, "alice");
  assert.equal(result.sessionToken, "synthetic-session-token"); assert.match(verified.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(f.sessions.length, 1); assert.equal(f.audits[0][1], "login_whatsapp");
  assert.equal((await f.post(verifyBody)).status, 401); assert.equal(f.sessions.length, 1);
});

test("public name, selected ID and matching phone cannot authenticate without a delivered code", async t => {
  const f = fixture(t);
  const issueResponse = await f.post({ action: "request-code", userId: "alice" }), issued = await issueResponse.json();
  for (const payload of [
    { userId: "alice", challengeId: issued.challengeId, code: "" },
    { userId: "alice", challengeId: issued.challengeId, code: "123456" },
    { userId: "أليس", phone: PHONE, challengeId: issued.challengeId, code: "123456" },
  ]) assert.equal((await f.post({ action: "verify-code", ...payload })).status, 401);
  assert.equal(f.sessions.length, 0); assert.equal(f.audits.length, 0);
});

test("a valid delivered code cannot be used with another selected account or unknown id", async t => {
  const f = fixture(t), issued = await (await f.post({ action: "request-code", userId: "alice" })).json();
  const sent = await f.deliver();
  for (const userId of ["bob", "missing", "أليس", undefined]) {
    const response = await f.post({ action: "verify-code", userId, phone: PHONE, challengeId: issued.challengeId, code: sent.code });
    assert.equal(response.status, 401);
  }
  assert.equal(f.sessions.length, 0);
});

for (const change of ["disabled", "remapped-phone", "remapped-user", "ambiguous-phone", "multiple-user-phones"]) {
  test(`live ${change} change invalidates a previously delivered code and ignores browser destination`, async t => {
    const f = fixture(t), issued = await (await f.post({ action: "request-code", userId: "alice" })).json();
    const sent = await f.deliver();
    if (change === "disabled") f.db.exec("UPDATE users SET active=0 WHERE id='alice'");
    if (change === "remapped-phone") f.contacts([{ userId: "alice", number: "12025550109" }, BASE_CONTACTS[1]]);
    if (change === "remapped-user") f.contacts([{ userId: "bob", number: PHONE }]);
    if (change === "ambiguous-phone") f.contacts([{ userId: "alice", number: PHONE }, { userId: "bob", number: PHONE }]);
    if (change === "multiple-user-phones") f.contacts([{ userId: "alice", number: PHONE }, { userId: "alice", number: "12025550109" }]);
    assert.equal((await f.post({ action: "verify-code", userId: "alice", phone: PHONE, challengeId: issued.challengeId, code: sent.code })).status, 401);
    assert.equal(f.sessions.length, 0); assert.equal(f.audits.length, 0);
  });
}

test("unavailable selected IDs use the generic issue response and never queue to the supplied phone", async t => {
  const f = fixture(t); let shape;
  for (const userId of ["alice", "unknown", "disabled", "unmapped", "أليس", undefined]) {
    const response = await f.post({ action: "request-code", userId, phone: PHONE }), body = await response.json();
    assert.equal(response.status, 202);
    const { challengeId, ...rest } = body; assert.equal(typeof challengeId, "string");
    if (!shape) shape = rest; else assert.deepEqual(rest, shape);
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM whatsapp_login_otp_queue").get().n, 1);
});

test("legacy PIN login/setup remain 410 and cross-origin code requests remain blocked", async t => {
  const f = fixture(t);
  for (const action of ["login", "setup"]) {
    const response = await f.post({ action, userId: "basem", pin: "1234" }), body = await response.json();
    assert.equal(response.status, 410); assert.equal(body.authMethod, "whatsapp");
  }
  assert.equal((await f.post({ action: "request-code", userId: "alice" }, "https://attacker.example.test")).status, 403);
  assert.equal(f.sessions.length, 0);
});

test("route rejects a mismatched verifier identity before creating any session", async t => {
  const f = fixture(t, { otpModule: { createWhatsAppLoginOtp: () => ({ verify: () => ({
    ok: true, user: { id: "bob", name: "بوب", role: "member", active: 1 },
  }) }) } });
  const response = await f.post({ action: "verify-code", userId: "alice", phone: OTHER_PHONE, challengeId: "synthetic", code: "123456" });
  assert.equal(response.status, 401); assert.equal(f.sessions.length, 0); assert.equal(f.audits.length, 0);
});
