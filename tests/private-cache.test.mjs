import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = path => readFile(new URL(path, import.meta.url), "utf8");

test("private API responses are never cacheable", async () => {
  const [auth, state] = await Promise.all([
    readSource("../app/api/auth/route.ts"),
    readSource("../app/api/state/route.ts"),
  ]);

  for (const source of [auth, state]) {
    assert.match(source, /dynamic = "force-dynamic"/);
    assert.match(source, /private, no-store, no-cache/);
    assert.match(source, /cdn-cache-control/);
    assert.match(source, /vary: "Cookie, X-Titanium-Session"/);
    assert.match(source, /function privateJson/);
  }
});

test("fresh production setup is closed unless explicitly enabled server-side", async () => {
  const source = await readSource("../lib/titanium-server.ts");
  assert.match(source, /TITANIUM_ALLOW_INITIAL_SETUP/);
  assert.doesNotMatch(source, /void request;\s*return true;/);
});
