import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sameOriginLoginRequest, boundedLoginBody } from '../lib/whatsapp-login-http.ts';
import { whatsappLoginSettings } from '../lib/whatsapp-login-settings.ts';

const origin = 'https://management.example.test';
function request(body = '{}', headers = {}) { return new Request(`${origin}/api/auth`, {
  method: 'POST', body, headers: { origin, 'content-type': 'application/json', ...headers },
}); }
test('OTP origin guard ignores forged host/forwarded headers and rejects cross-origin/non-JSON', () => {
  assert.equal(sameOriginLoginRequest(request(), origin), true);
  for (const headers of [{ origin: 'https://evil.example', 'x-forwarded-host': 'management.example.test' },
    { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    assert.equal(sameOriginLoginRequest(request('{}', headers), origin), false);
  }
  assert.equal(sameOriginLoginRequest(new Request(`${origin}/api/auth`, { method: 'POST', body: '{}' }), origin), false);
});
test('auth payload is bounded, strict UTF8 JSON object only', async () => {
  assert.deepEqual(await boundedLoginBody(request('{"action":"request-code"}')), { action: 'request-code' });
  for (const body of ['[]', 'null', '"text"', '{', 'x'.repeat(4097), new Uint8Array([0xff])]) {
    await assert.rejects(() => boundedLoginBody(request(body)));
  }
});
test('slow request stream is cancelled within a fixed deadline', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const req = new Request(`${origin}/api/auth`, { method: 'POST', body, duplex: 'half' });
  await assert.rejects(() => boundedLoginBody(req, 5));
  assert.equal(cancelled, true);
});
const settings = { WHATSAPP_LOGIN_ENABLED: 'pilot', WHATSAPP_LOGIN_SECRET: 'cd'.repeat(32),
  TEAM_CHAT_SHARED_KEY: 'ab'.repeat(32), WHATSAPP_LOGIN_DATABASE: path.resolve('synthetic-test.sqlite'),
  WHATSAPP_LOGIN_ORIGIN: origin, TEAM_CHAT_CONTACTS_JSON: '[{"userId":"alice","number":"12025550101"}]' };
test('pilot permits testing without replacing PIN; activation explicitly replaces it', () => {
  assert.deepEqual(whatsappLoginSettings({}), { enabled: false, replacePin: false });
  assert.equal(whatsappLoginSettings(settings).replacePin, false);
  assert.equal(whatsappLoginSettings({ ...settings, WHATSAPP_LOGIN_ENABLED: '1' }).replacePin, true);
});
test('OTP requires separate secret, absolute database, HTTPS origin and private phone mappings', () => {
  for (const override of [{ WHATSAPP_LOGIN_SECRET: settings.TEAM_CHAT_SHARED_KEY }, { WHATSAPP_LOGIN_SECRET: '' },
    { WHATSAPP_LOGIN_ENABLED: 'yes' }, { WHATSAPP_LOGIN_DATABASE: 'relative' },
    { WHATSAPP_LOGIN_ORIGIN: 'http://management.example.test' }, { WHATSAPP_LOGIN_ORIGIN: `${origin}/wrong` },
    { TEAM_CHAT_CONTACTS_JSON: '[{"userId":"alice","number":"120363@g.us"}]' }]) {
    assert.throws(() => whatsappLoginSettings({ ...settings, ...override }));
  }
});
