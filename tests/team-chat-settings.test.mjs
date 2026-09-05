import assert from "node:assert/strict";
import test from "node:test";
import fs, { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { readTeamChatSettings } from "../lib/team-chat-settings.ts";

const allowedKeys = ["TEAM_CHAT_ENABLED", "TEAM_CHAT_SHARED_KEY", "TEAM_CHAT_CONTACTS_JSON", "TEAM_CHAT_GROUP_IDS_JSON", "GROQ_API_KEY", "GROQ_MODEL"];
function fixture(t, contents = "{}", mode = 0o600) {
  const prefix = path.join(tmpdir(), "titanium-chat-settings-");
  const directory = mkdtempSync(prefix);
  t.after(() => {
    assert.ok(directory.startsWith(prefix) && directory !== prefix);
    rmSync(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, "settings.json");
  writeFileSync(filename, contents, { mode });
  return { directory, filename, env: { TITANIUM_TEAM_CHAT_CONFIG: filename } };
}

test("optional config preserves environment when no private file is configured", () => {
  const env = { TEAM_CHAT_ENABLED: "0", GROQ_API_KEY: "synthetic-value" };
  assert.equal(readTeamChatSettings(env), env);
  assert.equal(readTeamChatSettings({ ...env, TITANIUM_TEAM_CHAT_CONFIG: "" }).TEAM_CHAT_ENABLED, "0");
});

test("private JSON settings expose allowed string keys only and do not inherit environment", t => {
  const settings = {
    TEAM_CHAT_ENABLED: "1", TEAM_CHAT_SHARED_KEY: "ab".repeat(32),
    TEAM_CHAT_CONTACTS_JSON: '[{"userId":"tester","number":"12025550101"}]',
    TEAM_CHAT_GROUP_IDS_JSON: "[]", GROQ_API_KEY: "synthetic-groq-test-value", GROQ_MODEL: "example/test-model",
  };
  const f = fixture(t, JSON.stringify(settings));
  const result = readTeamChatSettings({ ...f.env, UNRELATED_SECRET: "should-not-copy", GROQ_MODEL: "ignored-environment-model" });
  assert.deepEqual(result, settings);
  assert.deepEqual(Object.keys(result).sort(), [...allowedKeys].sort());
  assert.equal(result.UNRELATED_SECRET, undefined);
});

test("a partial private config never silently falls back to enabled environment settings", t => {
  const f = fixture(t, JSON.stringify({ GROQ_MODEL: "example/test-model" }));
  const loaded = readTeamChatSettings({ ...f.env, TEAM_CHAT_ENABLED: "1", TEAM_CHAT_SHARED_KEY: "ab".repeat(32) });
  assert.equal(loaded.TEAM_CHAT_ENABLED, undefined);
  assert.equal(loaded.TEAM_CHAT_SHARED_KEY, undefined);
  assert.equal(loaded.GROQ_MODEL, "example/test-model");
});

test("relative and absent paths are rejected without exposing path or native exception", t => {
  assert.throws(() => readTeamChatSettings({ TITANIUM_TEAM_CHAT_CONFIG: "relative-settings.json" }));
  const f = fixture(t);
  const missing = path.join(f.directory, "sensitive-location-do-not-disclose.json");
  assert.throws(() => readTeamChatSettings({ TITANIUM_TEAM_CHAT_CONFIG: missing }), error => {
    assert.doesNotMatch(error.message, /sensitive-location|ENOENT|titanium-chat-settings/);
    return true;
  });
});

test("directory and symlink-to-directory are not accepted as config files", t => {
  const f = fixture(t);
  const folder = path.join(f.directory, "directory");
  mkdirSync(folder);
  assert.throws(() => readTeamChatSettings({ TITANIUM_TEAM_CHAT_CONFIG: folder }));
  const linkedFolder = path.join(f.directory, "linked-directory");
  symlinkSync(folder, linkedFolder, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readTeamChatSettings({ TITANIUM_TEAM_CHAT_CONFIG: linkedFolder }));
});

test("symlink to an otherwise valid private regular file is rejected", t => {
  const f = fixture(t, JSON.stringify({ TEAM_CHAT_ENABLED: "1" }));
  const link = path.join(f.directory, "settings-link.json");
  try { symlinkSync(f.filename, link, "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Windows host does not grant file symlink creation; directory-junction rejection is tested separately.");
      return;
    }
    throw error;
  }
  assert.throws(() => readTeamChatSettings({ TITANIUM_TEAM_CHAT_CONFIG: link }));
});

test("oversized config is rejected, exact size boundary is accepted", t => {
  const f = fixture(t, "{}".padEnd(32_768, " "));
  assert.equal(readTeamChatSettings(f.env).TEAM_CHAT_ENABLED, undefined);
  writeFileSync(f.filename, "{}".padEnd(32_769, " "));
  assert.throws(() => readTeamChatSettings(f.env));
});

test("POSIX group/world access is rejected and owner-only config remains accepted", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  for (const mode of [0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o644, 0o666]) {
    chmodSync(f.filename, mode);
    assert.throws(() => readTeamChatSettings(f.env), `mode ${mode.toString(8)}`);
  }
  chmodSync(f.filename, 0o600);
  assert.equal(readTeamChatSettings(f.env).TEAM_CHAT_ENABLED, undefined);
});

test("unknown keys including prototype-looking keys are rejected rather than ignored", t => {
  for (const extra of ["DATABASE_URL", "NODE_OPTIONS", "UNRELATED_SECRET", "__proto__", "constructor"]) {
    const f = fixture(t, `{"TEAM_CHAT_ENABLED":"1","${extra}":"synthetic-secret-do-not-disclose"}`);
    assert.throws(() => readTeamChatSettings(f.env), error => {
      assert.doesNotMatch(error.message, /synthetic-secret-do-not-disclose/);
      return true;
    });
  }
});

test("nonobject JSON and nonstring setting values are rejected", t => {
  for (const content of ["null", "[]", '"string"', "true", "123", '{"TEAM_CHAT_ENABLED":1}', '{"GROQ_API_KEY":null}', '{"TEAM_CHAT_CONTACTS_JSON":[]}', '{"GROQ_MODEL":{}}']) {
    const f = fixture(t, content);
    assert.throws(() => readTeamChatSettings(f.env), content);
  }
});

test("malformed JSON does not include parser snippets, secrets or filesystem paths in errors", t => {
  const secret = "DO_NOT_DISCLOSE_SYNTHETIC_GROQ_SECRET";
  for (const content of [secret, `{"GROQ_API_KEY":"${secret}",}`, `{"GROQ_API_KEY":"${secret}`]) {
    const f = fixture(t, content);
    assert.throws(() => readTeamChatSettings(f.env), error => {
      assert.doesNotMatch(error.message, /DO_NOT|DISCLOSE|SYNTHETIC|GROQ_SECRET|GROQ_API_KEY|titanium-chat-settings|position|JSON/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("invalid UTF-8 cannot silently alter a configured secret", t => {
  const invalid = Buffer.concat([Buffer.from('{"GROQ_API_KEY":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const f = fixture(t, invalid);
  assert.throws(() => readTeamChatSettings(f.env), /Unable to load private team chat settings/);
});

test("replacement between path check and descriptor open is rejected", t => {
  const f = fixture(t);
  const original = fs.lstatSync;
  let replaced = false;
  const mocked = t.mock.method(fs, "lstatSync", (...args) => {
    const metadata = original(...args);
    if (args[0] === f.filename && !replaced) {
      replaced = true;
      renameSync(f.filename, `${f.filename}.original`);
      writeFileSync(f.filename, '{"TEAM_CHAT_ENABLED":"1"}', { mode: 0o600 });
    }
    return metadata;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => readTeamChatSettings(f.env));
    assert.equal(replaced, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("file growth after descriptor stat cannot bypass the actual read limit", t => {
  const f = fixture(t);
  const original = fs.fstatSync;
  let expanded = false;
  const mocked = t.mock.method(fs, "fstatSync", (...args) => {
    const metadata = original(...args);
    if (!expanded) {
      expanded = true;
      writeFileSync(f.filename, "{}".padEnd(32_769, " "));
    }
    return metadata;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => readTeamChatSettings(f.env));
    assert.equal(expanded, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test("opened descriptor is closed on success and on malformed contents", t => {
  const valid = fixture(t);
  const invalid = fixture(t, "not valid contents");
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const opened = [];
  const closed = [];
  const openMock = t.mock.method(fs, "openSync", (...args) => {
    const descriptor = originalOpen(...args);
    opened.push(descriptor);
    return descriptor;
  });
  const closeMock = t.mock.method(fs, "closeSync", descriptor => {
    closed.push(descriptor);
    return originalClose(descriptor);
  });
  syncBuiltinESMExports();
  try {
    readTeamChatSettings(valid.env);
    assert.throws(() => readTeamChatSettings(invalid.env));
    assert.equal(opened.length, 2);
    assert.deepEqual(closed, opened);
  } finally {
    openMock.mock.restore();
    closeMock.mock.restore();
    syncBuiltinESMExports();
  }
});
