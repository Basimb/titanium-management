import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  clockLabel, internationalLoginPhone, isLoginChallenge, isWhatsAppLoginSuccess,
  latinDigits, loginCodeDigits, publicWhatsAppLoginUsers, secondsUntil,
} from "../components/whatsapp-login-helpers.ts";

const read = relative => readFile(new URL(relative, import.meta.url), "utf8");
const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

async function loadLoginComponent(reactOverride) {
  const require = createRequire(import.meta.url);
  const moduleUrl = name => pathToFileURL(require.resolve(name)).href;
  const primitives = dataUrl(`import React from ${JSON.stringify(moduleUrl("react"))};
    export function Button({variant,...props}) { return React.createElement('button',props); }
    export function Input(props) { return React.createElement('input',props); }
    export function MessageCircle(props) { return React.createElement('svg',props); }
    export function ShieldCheck(props) { return React.createElement('svg',props); }`);
  const source = await read("../components/whatsapp-login.tsx");
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const [specifier, destination] of [
    ["react/jsx-runtime", moduleUrl("react/jsx-runtime")], ["react", reactOverride || moduleUrl("react")],
    ["lucide-react", primitives], ["@/components/ui/button", primitives], ["@/components/ui/input", primitives],
    ["./whatsapp-login-helpers", new URL("../components/whatsapp-login-helpers.ts", import.meta.url).href],
  ]) compiled = compiled.replaceAll(`from ${JSON.stringify(specifier)}`, `from ${JSON.stringify(destination)}`);
  return (await import(dataUrl(compiled))).WhatsAppLogin;
}

test("public login names are validated, uniquely identified and stripped of private fields", () => {
  assert.deepEqual(publicWhatsAppLoginUsers([{ id: "alice", name: " أليس ", phone: "+12025550101", pinSet: 1 }]), [{ id: "alice", name: "أليس" }]);
  for (const value of [null, {}, [{ id: "alice", name: "" }], [{ id: "bad/id", name: "أليس" }],
    [{ id: "alice", name: "أليس" }, { id: "alice", name: "آخر" }], [{ id: "alice", name: "x".repeat(161) }]]) {
    assert.deepEqual(publicWhatsAppLoginUsers(value), []);
  }
});

test("international phone UI requires a country prefix and accepts Arabic/Persian digits", () => {
  for (const phone of ["+1 202 555 0101", "001 (202) 555-0101", "+١ ٢٠٢ ٥٥٥ ٠١٠١", "+۱ ۲۰۲ ۵۵۵ ۰۱۰۱", "\u200f+1 202 555 0101\u200e"]) {
    assert.equal(internationalLoginPhone(phone), "+12025550101", phone);
  }
  for (const phone of ["", "0793333798", "12025550101", "hello +12025550101", "+12025550101 ext 2", "+0012025550101", "+123", "+1234567890123456", "++12025550101"]) {
    assert.equal(internationalLoginPhone(phone), null, phone);
  }
});

test("code input preserves leading zeroes, Arabic digits, numeric paste and six-digit limit", () => {
  assert.equal(latinDigits("٠١٢۳۴۵"), "012345");
  assert.equal(loginCodeDigits("٠١٢ ٣٤٥"), "012345");
  assert.equal(loginCodeDigits("۰۱۲-۳۴۵"), "012345");
  assert.equal(loginCodeDigits("1234567"), "123456");
  assert.equal(loginCodeDigits("000001"), "000001");
  assert.equal(loginCodeDigits(""), "");
});

test("resend/expiry clocks respect exact boundary and never become negative", () => {
  assert.equal(secondsUntil(61_000, 1000), 60);
  assert.equal(secondsUntil(61_000, 60_001), 1);
  assert.equal(secondsUntil(61_000, 61_000), 0);
  assert.equal(secondsUntil(61_000, 70_000), 0);
  assert.equal(secondsUntil(Infinity, 1000), 0);
  assert.equal(clockLabel(300), "5:00");
  assert.equal(clockLabel(59), "0:59");
  assert.equal(clockLabel(0), "0:00");
});

test("challenge view accepts agreed response and rejects missing or unsafe timer data", () => {
  const challenge = { accepted: true, challengeId: "a".repeat(43), expiresInSeconds: 300, retryAfterSeconds: 60 };
  assert.equal(isLoginChallenge(challenge), true);
  assert.equal(isLoginChallenge({ ...challenge, message: "Generic account-safe message" }), true);
  for (const change of [{ accepted: false }, { challengeId: "" }, { challengeId: "arbitrary phone 123" }, { expiresInSeconds: 0 }, { retryAfterSeconds: 0 }, { retryAfterSeconds: 0.5 }, { retryAfterSeconds: Infinity }]) {
    assert.equal(isLoginChallenge({ ...challenge, ...change }), false);
  }
  assert.equal(isLoginChallenge(null), false);
});

test("UI completes login only after authenticated active-user response, retaining optional memory token", () => {
  const success = { authenticated: true, user: { id: "tester", name: "موظف تجريبي", role: "member", active: 1 }, sessionToken: "synthetic-session-token" };
  assert.equal(isWhatsAppLoginSuccess(success), true);
  assert.equal(isWhatsAppLoginSuccess({ ...success, sessionToken: undefined }), true);
  assert.equal(isWhatsAppLoginSuccess({ ...success, authenticated: false }), false);
  assert.equal(isWhatsAppLoginSuccess({ ...success, user: { ...success.user, active: 0 } }), false);
  assert.equal(isWhatsAppLoginSuccess({ ...success, user: { ...success.user, role: "owner" } }), false);
  assert.equal(isWhatsAppLoginSuccess({ accepted: true }), false);
});

test("initial OTP view renders an unselected accessible name list without phone fields or PIN", async () => {
  // Render the real component's initial view. Styling primitives/icons are tiny
  // native-element test doubles; React rendering and component source are real.
  const WhatsAppLogin = await loadLoginComponent();
  const props = { users: [{ id: "alice", name: "أليس", phone: "+12025550101" }, { id: "bob", name: '<img src=x onerror="attack()">' }], onAuthenticated() { throw new Error("No authentication during rendering"); } };
  const html = renderToStaticMarkup(React.createElement(WhatsAppLogin, props));
  assert.match(html, /for="whatsapp-login-user"/);
  assert.match(html, /<select[^>]+id="whatsapp-login-user"/);
  assert.match(html, /<option value="" disabled="" selected="">اختر اسمك<\/option>/);
  assert.match(html, /<option value="alice">أليس<\/option>/);
  assert.match(html, /&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;/);
  assert.match(html, /<button type="submit" disabled=""/);
  assert.match(html, /أرسل رمز الدخول على واتساب/);
  assert.doesNotMatch(html, /type="password"|type="tel"|name="phone"|12025550101|<img|الكود السري/);
  const empty = renderToStaticMarkup(React.createElement(WhatsAppLogin, { ...props, users: [] }));
  assert.match(empty, /لا توجد أسماء متاحة للدخول الآن/);
  assert.match(empty, /<select[^>]+disabled=""/);
});

test("OTP form uses userId-only POST actions, autofill, countdown and change-name controls", async () => {
  const source = await read("../components/whatsapp-login.tsx");
  assert.match(source, /action: "request-code", userId/);
  assert.match(source, /action: "verify-code", userId: sentUserId, challengeId, code/);
  assert.match(source, /credentials: "include", cache: "no-store"/);
  assert.match(source, /autoComplete="one-time-code"/);
  assert.match(source, /maxLength=\{6\}/);
  assert.match(source, /event\.clipboardData\.getData\("text"\)/);
  assert.match(source, /disabled=\{pending \|\| !sentUserAvailable \|\| retrySeconds > 0\}/);
  assert.match(source, /code\.length !== 6 \|\| expiresSeconds === 0/);
  assert.match(source, /onClick=\{changeUser\}/);
  assert.match(source, /إذا كان الحساب المختار مفعّلًا ورقمه مسجّلًا/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|URLSearchParams|location\.search|phoneInput|sentPhone|type="tel"|phone:/);
});

test("real OTP handlers require selection, bind requests to one name and preserve per-user cooldowns", async t => {
  // Run real component handlers with a deterministic hook host. No DOM, network,
  // timers or WhatsApp delivery occurs; rendering is covered separately above.
  const hooksUrl = dataUrl(`
    const cells=[]; let cursor=0;
    export function reset(){cursor=0;}
    export function useState(initial){const slot=cursor++; if(!(slot in cells)) cells[slot]=typeof initial==='function'?initial():initial;
      return [cells[slot],value=>{cells[slot]=typeof value==='function'?value(cells[slot]):value;}];}
    export function useRef(initial){const slot=cursor++; if(!(slot in cells)) cells[slot]={current:initial}; return cells[slot];}
    export function useEffect(){}
  `);
  const hooks = await import(hooksUrl);
  const WhatsAppLogin = await loadLoginComponent(hooksUrl);
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const requests = [];
  const challenge = { accepted: true, challengeId: "c".repeat(43), expiresInSeconds: 300, retryAfterSeconds: 60 };
  let reply = challenge;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json(reply);
  });
  const completed = [];
  const props = { users: [{ id: "alice", name: "أليس" }, { id: "bob", name: "بوب" }], onAuthenticated: value => completed.push(value) };
  let tree;
  function render() { hooks.reset(); tree = WhatsAppLogin(props); }
  function find(predicate, node = tree) {
    if (!node || typeof node !== "object") return null;
    if (predicate(node)) return node;
    for (const child of React.Children.toArray(node.props?.children)) { const found = find(predicate, child); if (found) return found; }
    return null;
  }
  const field = id => find(node => node.props?.id === id);
  const form = () => find(node => node.type === "form");
  const submit = async () => { await form().props.onSubmit({ preventDefault() {} }); render(); };
  const choose = id => { field("whatsapp-login-user").props.onChange({ target: { value: id } }); render(); };
  const change = () => { find(node => node.props?.children === "تغيير الاسم").props.onClick(); render(); };
  const enter = code => { field("whatsapp-login-code").props.onChange({ target: { value: code } }); render(); };

  render();
  assert.equal(field("whatsapp-login-user").props.value, "");
  assert.equal(requests.length, 0);
  await submit(); // Forged submit without the disabled button still fails closed.
  assert.equal(requests.length, 0);
  choose("unregistered");
  await submit();
  assert.equal(requests.length, 0);
  choose("alice");
  assert.equal(requests.length, 0, "selection alone must never send");
  await submit();
  assert.deepEqual(requests, [{ action: "request-code", userId: "alice" }]);
  assert.ok(field("whatsapp-login-code"));
  change();
  assert.equal(field("whatsapp-login-user").props.value, "");
  choose("alice");
  await submit();
  assert.equal(requests.length, 1, "changing name must not reset Alice's cooldown");
  choose("bob");
  await submit();
  assert.deepEqual(requests.at(-1), { action: "request-code", userId: "bob" });
  change();
  choose("alice");
  await submit();
  assert.equal(requests.length, 2, "Bob's request must not forget Alice's cooldown");
  now += 61_000;
  await submit();
  enter("٠١٢٣٤٥");
  reply = { authenticated: true, user: { id: "bob", name: "بوب", role: "member", active: 1 } };
  await submit();
  assert.deepEqual(requests.at(-1), { action: "verify-code", userId: "alice", challengeId: challenge.challengeId, code: "012345" });
  assert.equal(completed.length, 0, "a different returned user must not complete login");
  reply = { authenticated: true, user: { id: "alice", name: "أليس", role: "member", active: 1 } };
  await submit();
  assert.equal(completed.length, 1);
  assert.equal(field("whatsapp-login-code").props.value, "");
  assert.ok(requests.every(body => !Object.hasOwn(body, "phone") && !Object.hasOwn(body, "name")));
});

test("dashboard uses server-selected auth method and gates every PIN section in WhatsApp mode", async () => {
  const source = await read("../app/dashboard.tsx");
  assert.match(source, /auth\.authMethod === "whatsapp"/);
  assert.match(source, /setLoginUsers\(whatsapp \? \[\]/);
  assert.match(source, /authMethod === null \? <div/);
  assert.match(source, /setWhatsappUsers\(whatsapp \? publicWhatsAppLoginUsers\(auth.loginUsers\) : \[\]\)/);
  assert.match(source, /whatsappLogin \? <WhatsAppLogin users=\{whatsappUsers\} onAuthenticated=\{completeWhatsAppLogin\}/);
  assert.match(source, /auth.authMethod !== "whatsapp" && auth.authMethod !== "pin"/);
  assert.match(source, /setAuthMethod\(current => current === "whatsapp" \? "whatsapp" : null\)/);
  assert.match(source, /!whatsappLogin && <Button[^\n]+setChangePinOpen/);
  assert.match(source, /!whatsappLogin && <><Input[^\n]+set_user_pin/);
  assert.match(source, /!whatsappLogin && <Dialog open=\{changePinOpen\}/);
  assert.match(source, /if \(next\.sessionToken\) sessionTokenRef\.current = next\.sessionToken/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("auth and private state GETs use fresh per-request nonce with no-store and credentials", async () => {
  const source = await read("../app/dashboard.tsx");
  for (const endpoint of ["auth", "state"]) {
    const request = 'fetch(`/api/' + endpoint + '?v=${crypto.randomUUID()}`, { cache:"no-store", credentials:"include", headers:sessionHeaders() })';
    assert.ok(source.includes(request), `${endpoint} must generate a fresh nonce for each request`);
  }
  assert.doesNotMatch(source, /\/api\/(?:auth|state)\?v=\d/);
});
