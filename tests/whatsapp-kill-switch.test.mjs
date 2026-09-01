import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(
  new URL("../app/api/whatsapp/webhook/route.ts", import.meta.url),
  "utf8",
);

test("WhatsApp webhook stops before processing when disabled", () => {
  const postStart = routeSource.indexOf("export async function POST");
  const disabledGuard = routeSource.indexOf('process.env.WHATSAPP_ENABLED !== "1"', postStart);
  const bodyRead = routeSource.indexOf("await request.text()", postStart);
  const signatureCheck = routeSource.indexOf("verifyMetaSignature", postStart);

  assert.notEqual(postStart, -1, "POST handler must exist");
  assert.notEqual(disabledGuard, -1, "POST handler must check WHATSAPP_ENABLED");
  assert.match(
    routeSource.slice(disabledGuard, bodyRead),
    /return Response\.json\(\{ ok:true, skipped:"whatsapp_disabled" \}\)/,
  );
  assert.ok(disabledGuard < bodyRead, "kill switch must run before reading the request body");
  assert.ok(disabledGuard < signatureCheck, "kill switch must run before webhook processing");
});
