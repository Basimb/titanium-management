import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = path => readFile(new URL(path, import.meta.url), "utf8");

test("public privacy page describes the WhatsApp data actually processed", async () => {
  const source = await readSource("../app/privacy/page.tsx");

  assert.match(source, /sender number, message identifier, type and text/i);
  assert.match(source, /رقم المرسل، معرّف الرسالة ونوعها ونصها/);
  assert.match(source, /href="\/data-deletion"/);
  assert.doesNotMatch(source, /example\.com|TODO|your@email/i);
});

test("data deletion page provides a specific bilingual request path", async () => {
  const source = await readSource("../app/data-deletion/page.tsx");

  assert.match(source, /wa\.me\/962793333798/);
  assert.match(source, /حذف بياناتي \| Delete my data/);
  assert.match(source, /We will never ask for a password or verification code/);
  assert.match(source, /لا يحذف حساب WhatsApp/);
  assert.doesNotMatch(source, /example\.com|TODO|your@email/i);
});

