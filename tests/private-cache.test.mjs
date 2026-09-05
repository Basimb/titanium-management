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

test("only the exact non-www management host redirects, preserving paths and query values", async () => {
  const require = createRequire(import.meta.url);
  const source = await readSource("../next.config.ts");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { default: config } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const redirects = await config.redirects();
  assert.equal(redirects.length, 1);
  const [rule] = redirects;
  assert.equal(rule.source, "/:path*");
  assert.equal(rule.permanent, true);
  const { matchHas, prepareDestination } = require("next/dist/shared/lib/router/utils/prepare-destination.js");
  const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match.js");
  const { getRedirectStatus } = require("next/dist/lib/redirect-status.js");
  assert.equal(getRedirectStatus(rule), 308);
  for (const host of ["management.titanium-pharmacy.com", "management.titanium-pharmacy.com:443", "MANAGEMENT.TITANIUM-PHARMACY.COM"]) {
    assert.ok(matchHas({ headers: { host } }, {}, rule.has));
  }
  for (const host of ["www.management.titanium-pharmacy.com", "titanium-pharmacy.com", "cpanel.titanium-pharmacy.com",
    "managementXtitanium-pharmacyXcom", "management.titanium-pharmacy.com.attacker.test", "other.management.titanium-pharmacy.com", "localhost"]) {
    assert.equal(matchHas({ headers: { host, "x-forwarded-host": "management.titanium-pharmacy.com" } }, {}, rule.has), false, host);
  }
  const query = { project: "project-1", task: "task-2", search: "مهمة باسم", filter: ["open", "progress"] };
  for (const pathname of ["/", "/privacy", "/api/auth", "/projects/example", "/_next/static/chunks/abc123.js"]) {
    const params = getPathMatch(rule.source)(pathname);
    assert.ok(params);
    const { parsedDestination } = prepareDestination({ destination: rule.destination, params, query, appendParamsToQuery: false });
    assert.equal(parsedDestination.protocol, "https:");
    assert.equal(parsedDestination.hostname, "www.management.titanium-pharmacy.com");
    // Next represents the zero-segment root as an empty URL pathname.
    assert.equal(parsedDestination.pathname || "/", pathname);
    assert.deepEqual(parsedDestination.query, query);
    assert.equal(matchHas({ headers: { host: parsedDestination.hostname } }, query, rule.has), false, "destination must not redirect again");
  }
  assert.equal(config.headers, undefined, "hashed asset caching must remain managed by Next");
});

test("fresh production setup is closed unless explicitly enabled server-side", async () => {
  const source = await readSource("../lib/titanium-server.ts");
  assert.match(source, /TITANIUM_ALLOW_INITIAL_SETUP/);
  assert.doesNotMatch(source, /void request;\s*return true;/);
});
