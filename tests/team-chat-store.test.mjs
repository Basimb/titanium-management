import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyTeamChatIntent, getTeamChatCatalog, lookupTeamChatEvent, migrateTeamChatStore } from "../lib/team-chat-store.ts";

const origin = { senderNumber: "+1 202 555 0101" };
const otherOrigin = { senderNumber: "+1 202 555 0102" };
const config = { contacts: [{ userId: "member", number: "12025550101" }, { userId: "other", number: "12025550102" }, { userId: "basem", number: "12025550103" }] };
function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, active INTEGER NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT NOT NULL,
      status TEXT NOT NULL, owner TEXT, suggested_owner TEXT, started_at INTEGER, completed_at INTEGER,
      due_date TEXT, updated_at INTEGER, archived_at INTEGER, rejection_reason TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id TEXT REFERENCES tasks(id), author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, actor_user_id TEXT, actor_name TEXT NOT NULL, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO users VALUES ('member','موظف تجريبي','member',1), ('other','موظف آخر','member',1), ('basem','مدير تجريبي','admin',1);
    INSERT INTO projects VALUES ('project','مشروع تجريبي','active');
    INSERT INTO tasks VALUES ('task','project','الجرد','progress','موظف تجريبي','موظف تجريبي',100,NULL,NULL,100,NULL,NULL),
      ('other-task','project','مهمة خاصة','progress','موظف آخر','موظف آخر',100,NULL,NULL,100,NULL,NULL),
      ('open-task','project','الدوام','open',NULL,'موظف تجريبي',NULL,NULL,NULL,NULL,NULL,NULL);`);
  migrateTeamChatStore(sqlite);
  migrateTeamChatStore(sqlite);
  return sqlite;
}
const event = (overrides = {}) => ({ messageId: "event-1", origin, text: "خلصت الجرد", ...overrides });
const intent = (action = "submit", taskId = "task") => ({ action, taskId, question: null });
function apply(sqlite, overrides = {}, cfg = config) {
  const incoming = event(overrides);
  return applyTeamChatIntent(sqlite, { ...incoming, intent: intent(), catalog: getTeamChatCatalog(sqlite, incoming.origin, cfg), ...overrides }, cfg);
}
const counts = sqlite => ["comments", "audit_logs", "team_chat_events"].map(table => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
const task = sqlite => sqlite.prepare("SELECT * FROM tasks WHERE id='task'").get();

test("preflight exposes only active scoped catalog with model fields and freezes it", t => {
  const sqlite = fixture(t);
  const catalog = getTeamChatCatalog(sqlite, origin, config);
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.tasks.map(x => x.id), ["open-task", "task"]);
  assert.equal(catalog.tasks[0].projectName, "مشروع تجريبي");
  assert.equal(catalog.tasks[0].dueDate, null);
  assert.ok(Object.isFrozen(catalog) && Object.isFrozen(catalog.tasks[0]));
  assert.throws(() => { catalog.actor.id = "basem"; });
});

test("completion, exact original message, audit and idempotency commit together", t => {
  const sqlite = fixture(t);
  const result = apply(sqlite, { text: "  خلصت الجرد\n100%  " });
  assert.equal(result.status, "applied");
  assert.match(result.reply, /لاعتماد باسم/);
  assert.equal(task(sqlite).status, "approval");
  assert.equal(task(sqlite).completed_at, null);
  assert.equal(sqlite.prepare("SELECT body FROM comments").get().body, "  خلصت الجرد\n100%  ");
  const log = sqlite.prepare("SELECT * FROM audit_logs").get();
  assert.equal(log.actor_user_id, "member");
  assert.equal(log.action, "chat_submit");
  assert.equal(JSON.parse(log.details).nextStatus, "approval");
  assert.deepEqual(counts(sqlite), [1, 1, 1]);
});

test("duplicate returns stored reply even if a later inference differs", t => {
  const sqlite = fixture(t);
  const first = apply(sqlite);
  const second = apply(sqlite, { intent: intent("update") });
  assert.equal(second.status, "duplicate");
  assert.equal(second.originalStatus, "applied");
  assert.equal(second.reply, first.reply);
  assert.equal(lookupTeamChatEvent(sqlite, event(), config).reply, first.reply);
  assert.deepEqual(counts(sqlite), [1, 1, 1]);
});

test("changed payload or reply context cannot reuse an event ID within its origin", t => {
  const sqlite = fixture(t);
  apply(sqlite);
  for (const change of [{ text: "تحديث آخر" }, { replyToMessageId: "different" }]) {
    assert.equal(lookupTeamChatEvent(sqlite, event(change), config).status, "denied");
    assert.equal(apply(sqlite, change).status, "denied");
  }
  const grouped = { ...config, allowedGroupIds: ["test-group"] };
  assert.equal(lookupTeamChatEvent(sqlite, event({ origin: { ...origin, groupId: "test-group" } }), grouped), null);
  assert.deepEqual(counts(sqlite), [1, 1, 1]);
});

test("disabled sender and remapped contact cannot apply or replay cached replies", t => {
  const sqlite = fixture(t);
  const catalog = getTeamChatCatalog(sqlite, origin, config);
  sqlite.exec("UPDATE users SET active=0 WHERE id='member'");
  assert.equal(apply(sqlite, { catalog }).status, "denied");
  assert.deepEqual(counts(sqlite), [0, 0, 0]);
  sqlite.exec("UPDATE users SET active=1 WHERE id='member'");
  apply(sqlite);
  sqlite.exec("UPDATE users SET active=0 WHERE id='member'");
  assert.equal(lookupTeamChatEvent(sqlite, event(), config).status, "denied");
  const remapped = { contacts: [{ userId: "other", number: origin.senderNumber }] };
  assert.equal(lookupTeamChatEvent(sqlite, event(), remapped).status, "denied");
});

test("unknown, duplicate contact and unapproved group identities fail closed", t => {
  const sqlite = fixture(t);
  for (const [incoming, cfg] of [
    [{ senderNumber: "12025550999" }, config],
    [origin, { contacts: [...config.contacts, config.contacts[0]] }],
    [{ ...origin, groupId: "unapproved" }, config],
  ]) {
    assert.equal(getTeamChatCatalog(sqlite, incoming, cfg).ok, false);
    assert.equal(lookupTeamChatEvent(sqlite, event({ origin: incoming }), cfg).status, "denied");
  }
  assert.deepEqual(counts(sqlite), [0, 0, 0]);
});

test("forged and cross-sender catalogs cannot authenticate an actor", t => {
  const sqlite = fixture(t);
  const catalog = getTeamChatCatalog(sqlite, origin, config);
  assert.equal(apply(sqlite, { catalog: JSON.parse(JSON.stringify(catalog)) }).status, "denied");
  const otherCatalog = getTeamChatCatalog(sqlite, otherOrigin, config);
  assert.equal(apply(sqlite, { messageId: "event-2", catalog: otherCatalog }).status, "denied");
  assert.deepEqual(counts(sqlite), [0, 0, 2]);
});

test("two in-flight snapshots serialize: first wins, second is stale without partial writes", t => {
  const sqlite = fixture(t);
  const first = getTeamChatCatalog(sqlite, origin, config);
  const second = getTeamChatCatalog(sqlite, origin, config);
  assert.equal(apply(sqlite, { catalog: first, intent: intent("update") }).status, "applied");
  assert.equal(apply(sqlite, { messageId: "event-2", catalog: second }).status, "stale");
  assert.equal(task(sqlite).status, "progress");
  assert.deepEqual(counts(sqlite), [1, 1, 2]);
});

test("version and ownership changes, archive and rejected project invalidate preflight", t => {
  for (const sql of [
    "UPDATE tasks SET updated_at=101 WHERE id='task'",
    "UPDATE tasks SET owner='موظف آخر' WHERE id='task'",
    "UPDATE tasks SET suggested_owner='موظف آخر' WHERE id='task'",
    "UPDATE tasks SET archived_at=101 WHERE id='task'",
    "UPDATE tasks SET title='عنوان جديد' WHERE id='task'",
    "UPDATE projects SET status='rejected'",
    "UPDATE users SET role='admin' WHERE id='member'",
  ]) {
    const sqlite = fixture(t);
    const catalog = getTeamChatCatalog(sqlite, origin, config);
    sqlite.exec(sql);
    assert.equal(apply(sqlite, { catalog }).status, "stale", sql);
    assert.deepEqual(counts(sqlite), [0, 0, 1]);
  }
});

test("cross-task requests, claimed-by-another and manager personal updates cannot mutate", t => {
  const sqlite = fixture(t);
  assert.equal(apply(sqlite, { intent: intent("submit", "other-task") }).status, "clarify");
  assert.equal(apply(sqlite, { messageId: "event-2", origin: { senderNumber: "12025550103" } }).status, "clarify");
  assert.equal(task(sqlite).status, "progress");
  assert.deepEqual(counts(sqlite), [0, 0, 2]);
});

test("claim and first progress on assigned open task set owner and start time atomically", t => {
  for (const action of ["claim", "update", "submit"]) {
    const sqlite = fixture(t);
    assert.equal(apply(sqlite, { intent: intent(action, "open-task") }).status, "applied");
    const open = sqlite.prepare("SELECT * FROM tasks WHERE id='open-task'").get();
    assert.equal(open.owner, "موظف تجريبي");
    assert.ok(open.started_at > 0 && open.updated_at > 0);
    assert.equal(open.status, action === "submit" ? "approval" : "progress");
    assert.equal(open.completed_at, null);
  }
});

test("unsupported destructive/admin intents and terminal tasks never mutate", t => {
  const sqlite = fixture(t);
  for (const action of ["approve", "delete", "reassign", "set_role"]) {
    assert.equal(apply(sqlite, { messageId: action, intent: intent(action) }).status, "denied");
  }
  for (const status of ["approval", "completed"]) {
    sqlite.prepare("UPDATE tasks SET status=? WHERE id='task'").run(status);
    assert.equal(apply(sqlite, { messageId: status }).status, "clarify");
  }
  assert.equal(counts(sqlite)[0], 0);
  assert.equal(counts(sqlite)[1], 0);
});

test("summary is server-rendered, scoped, bounded and cached", t => {
  const sqlite = fixture(t);
  const result = apply(sqlite, { intent: intent("summary", null), text: "شو علي" });
  assert.equal(result.status, "summary");
  assert.match(result.reply, /الجرد/);
  assert.doesNotMatch(result.reply, /مهمة خاصة/);
  assert.deepEqual(counts(sqlite), [0, 0, 1]);
  sqlite.exec("UPDATE tasks SET owner='موظف آخر' WHERE id='task'");
  assert.equal(lookupTeamChatEvent(sqlite, event({ text: "شو علي" }), config).status, "denied");
});

test("failure on audit insert rolls back task, comment and event so retry is safe", t => {
  const sqlite = fixture(t);
  sqlite.exec("CREATE TRIGGER reject_chat_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;");
  assert.throws(() => apply(sqlite), /test audit failure/);
  assert.equal(task(sqlite).status, "progress");
  assert.equal(task(sqlite).updated_at, 100);
  assert.deepEqual(counts(sqlite), [0, 0, 0]);
  sqlite.exec("DROP TRIGGER reject_chat_audit");
  assert.equal(apply(sqlite).status, "applied");
});

test("same-clock updates still advance monotonically and preserve start timestamp", t => {
  const sqlite = fixture(t);
  const future = Date.now() + 10_000;
  sqlite.prepare("UPDATE tasks SET updated_at=? WHERE id='task'").run(future);
  apply(sqlite, { intent: intent("update") });
  assert.equal(task(sqlite).updated_at, future + 1);
  assert.equal(task(sqlite).started_at, 100);
  apply(sqlite, { messageId: "event-2", intent: intent("update") });
  assert.equal(task(sqlite).updated_at, future + 2);
});

test("invalid event does not create records and cannot hide identity in text", t => {
  const sqlite = fixture(t);
  for (const change of [{ messageId: "" }, { text: "" }, { text: "x".repeat(4001) }, { origin: { senderNumber: "أنا باسم 12025550101" } }]) {
    assert.equal(apply(sqlite, change).status, "denied");
  }
  assert.deepEqual(counts(sqlite), [0, 0, 0]);
});

test("overlarge catalog is rejected rather than silently dropping ambiguous tasks", t => {
  const sqlite = fixture(t);
  const insert = sqlite.prepare("INSERT INTO tasks (id,project_id,title,status,suggested_owner) VALUES (?,'project','عنوان مكرر','open','موظف تجريبي')");
  for (let i = 0; i < 50; i++) insert.run(`extra-${i}`);
  assert.equal(getTeamChatCatalog(sqlite, origin, config).ok, false);
  assert.deepEqual(counts(sqlite), [0, 0, 0]);
});

test("failure saving the message receipt rolls back all preceding writes", t => {
  const sqlite = fixture(t);
  sqlite.exec("CREATE TRIGGER reject_chat_receipt BEFORE INSERT ON team_chat_events BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END;");
  assert.throws(() => apply(sqlite), /test receipt failure/);
  assert.equal(task(sqlite).status, "progress");
  assert.deepEqual(counts(sqlite), [0, 0, 0]);
});

test("adding a new ambiguous task during inference makes the old catalog stale", t => {
  const sqlite = fixture(t);
  const catalog = getTeamChatCatalog(sqlite, origin, config);
  sqlite.exec("INSERT INTO tasks (id,project_id,title,status,suggested_owner) VALUES ('new','project','الجرد','open','موظف تجريبي')");
  assert.equal(apply(sqlite, { catalog }).status, "stale");
  assert.deepEqual(counts(sqlite), [0, 0, 1]);
});

test("explicitly allowed group uses participant identity and cannot borrow a direct catalog", t => {
  const sqlite = fixture(t);
  const groupedConfig = { ...config, allowedGroupIds: ["approved-group"] };
  const groupOrigin = { ...origin, groupId: "approved-group" };
  const directCatalog = getTeamChatCatalog(sqlite, origin, groupedConfig);
  assert.equal(apply(sqlite, { origin: groupOrigin, catalog: directCatalog }, groupedConfig).status, "denied");
  assert.equal(apply(sqlite, { messageId: "group-2", origin: groupOrigin }, groupedConfig).status, "applied");
  assert.equal(sqlite.prepare("SELECT actor_user_id FROM audit_logs").get().actor_user_id, "member");
});

test("catalog issued by another SQLite handle cannot authorize this database", t => {
  const first = fixture(t);
  const second = fixture(t);
  const catalog = getTeamChatCatalog(first, origin, config);
  assert.equal(apply(second, { catalog }).status, "denied");
  assert.deepEqual(counts(first), [0, 0, 0]);
  assert.deepEqual(counts(second), [0, 0, 1]);
});

test("same raw message ID from different authorized origins has independent receipts", t => {
  const sqlite = fixture(t);
  assert.equal(apply(sqlite).status, "applied");
  assert.equal(lookupTeamChatEvent(sqlite, event({ origin: otherOrigin }), config), null);
  assert.equal(apply(sqlite, { origin: otherOrigin, intent: intent("submit", "other-task") }).status, "applied");
  assert.equal(lookupTeamChatEvent(sqlite, event(), config).status, "duplicate");
  assert.equal(lookupTeamChatEvent(sqlite, event({ origin: otherOrigin }), config).status, "duplicate");
  assert.deepEqual(counts(sqlite), [2, 2, 2]);
  assert.equal(sqlite.prepare("SELECT COUNT(DISTINCT message_id) AS n FROM team_chat_events").get().n, 2);
});
