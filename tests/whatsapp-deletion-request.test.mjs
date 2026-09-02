import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../app/api/whatsapp/webhook/route.ts", import.meta.url),
  "utf8",
);

test("data deletion requests are handled before the admin-only command guard", () => {
  const deletion = source.indexOf("isDeletionRequest(body)");
  const adminGuard = source.indexOf("sender !== BASIM_WHATSAPP");
  assert.notEqual(deletion, -1);
  assert.notEqual(adminGuard, -1);
  assert.ok(deletion < adminGuard);
  assert.match(source, /deletion_request_received/);
  assert.match(source, /تم استلام طلب حذف بياناتك/);
  assert.match(source, /delete my data/);
});
