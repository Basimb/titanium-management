import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const readSource = path => readFile(new URL(path, import.meta.url), "utf8");

test("management homepage is request-rendered and Next emits private no-store HTML headers", async () => {
  const require = createRequire(import.meta.url);
  const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const source = await readSource("../app/page.tsx");
  assert.doesNotMatch(source, /^[\s\n]*["']use client["']/);
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  // Load the real server wrapper, replacing only its client component dependency.
  compiled = compiled.replace('from "./dashboard"', `from ${JSON.stringify(dataUrl("export default function Dashboard() { return null; }"))}`)
    .replace('from "react/jsx-runtime"', `from ${JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href)}`);
  const page = await import(dataUrl(compiled));
  assert.equal(page.dynamic, "force-dynamic");
  assert.equal(page.revalidate, 0);
  assert.equal(typeof page.default, "function");
  // Validate with the installed Next implementation, not a hand-written header.
  const { getCacheControlHeader } = require("next/dist/server/lib/cache-control.js");
  assert.equal(getCacheControlHeader({ revalidate: page.revalidate }), "private, no-cache, no-store, max-age=0, must-revalidate");
  assert.doesNotMatch(await readSource("../next.config.ts"), /headers\s*\(|Cache-Control|cache-control|_next\/static/);
});

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
