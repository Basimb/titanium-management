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
  latinDigits, loginCodeDigits, secondsUntil,
} from "../components/whatsapp-login-helpers.ts";

const read = relative => readFile(new URL(relative, import.meta.url), "utf8");

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

test("initial OTP view renders accessible Arabic phone form without account list or PIN", async () => {
  // Render the real component's initial view. Styling primitives/icons are tiny
  // native-element test doubles; React rendering and component source are real.
  const require = createRequire(import.meta.url);
  const moduleUrl = name => pathToFileURL(require.resolve(name)).href;
  const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const primitives = dataUrl(`import React from ${JSON.stringify(moduleUrl("react"))};
    export function Button({variant,...props}) { return React.createElement('button',props); }
    export function Input(props) { return React.createElement('input',props); }
    export function MessageCircle(props) { return React.createElement('svg',props); }
    export function ShieldCheck(props) { return React.createElement('svg',props); }`);
  const source = await read("../components/whatsapp-login.tsx");
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const [specifier, destination] of [
    ["react/jsx-runtime", moduleUrl("react/jsx-runtime")], ["react", moduleUrl("react")],
    ["lucide-react", primitives], ["@/components/ui/button", primitives], ["@/components/ui/input", primitives],
    ["./whatsapp-login-helpers", new URL("../components/whatsapp-login-helpers.ts", import.meta.url).href],
  ]) compiled = compiled.replaceAll(`from ${JSON.stringify(specifier)}`, `from ${JSON.stringify(destination)}`);
  const { WhatsAppLogin } = await import(dataUrl(compiled));
  const html = renderToStaticMarkup(React.createElement(WhatsAppLogin, { onAuthenticated() { throw new Error("No authentication during rendering"); } }));
  assert.match(html, /رقم واتساب المسجّل لدى الإدارة/);
  assert.match(html, /for="whatsapp-login-phone"/);
  assert.match(html, /id="whatsapp-login-phone"/);
  assert.match(html, /type="tel"/);
  assert.match(html, /autoComplete="tel"/);
  assert.match(html, /dir="ltr"/);
  assert.match(html, /أرسل رمز الدخول على واتساب/);
  assert.doesNotMatch(html, /type="password"|<select|الكود السري|اختر اسمك/);
});

test("OTP form uses agreed POST actions, autofill, countdown, expiry and change-number controls", async () => {
  const source = await read("../components/whatsapp-login.tsx");
  assert.match(source, /action: "request-code", phone/);
  assert.match(source, /action: "verify-code", phone: sentPhone, challengeId, code/);
  assert.match(source, /credentials: "include", cache: "no-store"/);
  assert.match(source, /autoComplete="one-time-code"/);
  assert.match(source, /maxLength=\{6\}/);
  assert.match(source, /event\.clipboardData\.getData\("text"\)/);
  assert.match(source, /disabled=\{pending \|\| retrySeconds > 0\}/);
  assert.match(source, /code\.length !== 6 \|\| expiresSeconds === 0/);
  assert.match(source, /onClick=\{changeNumber\}/);
  assert.match(source, /إذا كان رقمك مسجّلًا ومفعّلًا/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.|URLSearchParams|location\.search/);
});

test("dashboard uses server-selected auth method and gates every PIN section in WhatsApp mode", async () => {
  const source = await read("../app/dashboard.tsx");
  assert.match(source, /auth\.authMethod === "whatsapp"/);
  assert.match(source, /setLoginUsers\(whatsapp \? \[\]/);
  assert.match(source, /authMethod === null \? <div/);
  assert.match(source, /whatsappLogin \? <WhatsAppLogin onAuthenticated=\{completeWhatsAppLogin\}/);
  assert.match(source, /!whatsappLogin && <Button[^\n]+setChangePinOpen/);
  assert.match(source, /!whatsappLogin && <><Input[^\n]+set_user_pin/);
  assert.match(source, /!whatsappLogin && <Dialog open=\{changePinOpen\}/);
  assert.match(source, /if \(next\.sessionToken\) sessionTokenRef\.current = next\.sessionToken/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});
