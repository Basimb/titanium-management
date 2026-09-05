import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeManagementAction, getManagementSnapshot, migrateManagementActions, ManagementActionError, type ManagementCommand } from "./management-actions.ts";
import { resolveChatUser, normalizeContactNumber, type ChatUser } from "./team-chat-policy.ts";
import type { TeamChatConfig, TeamChatEnvelope } from "./team-chat-gateway.ts";
import { validateSecretaryIntent, type SecretaryIntent, type SecretaryModelInput } from "./secretary-intent.ts";
import { safeConversationalReply } from "./secretary-conversation-policy.ts";

type Task = { id: string; projectId: string; title: string; details: string; status: string; priority: string; owner: string | null; suggestedOwner: string | null; dueDate: string | null; updatedAt: number | null; archivedAt: number | null };
type Project = { id: string; name: string; status: string; updatedAt?: number | null; archivedAt?: number | null };
type Snapshot = { tasks: Task[]; projects: Project[]; users: Array<ChatUser>; comments: Array<{ taskId: string; author: string; body: string; createdAt: number }> };
type Event = TeamChatEnvelope & { replyToMessageId?: string | null; responseMessageId?: string | null };
type Result = { status: string; reply: string; taskId?: string };
type Pending = { token: string; command_json: string; snapshot_hash: string; original_text: string; source_message_id: string; expires_at: number };
type HistoryRow = { original_text: string; result_json: string; scope_json: string };
const ORIGIN = "https://www.management.titanium-pharmacy.com";
const CONFIRM_MS = 10 * 60_000;
const HISTORY_MS = 24 * 60 * 60_000;
const HISTORY_CHARS = 6000;
const SENSITIVE = new Set(["edit_project", "approve_project", "reject_project", "restore_project", "archive_project", "delete_project", "edit_task", "cancel_claim", "submit", "approve", "reject", "reopen", "reassign", "move_task", "archive_task", "restore_task", "delete_task"]);
const LABELS: Record<string, string> = { open: "بانتظار الاستلام", progress: "قيد التنفيذ", approval: "بانتظار اعتماد باسم", completed: "معتمدة", active: "نشط", pending: "بانتظار الموافقة", rejected: "مرفوض" };
const ACTION_LABELS: Record<string, string> = { add_project: "إنشاء مشروع", edit_project: "تعديل المشروع", approve_project: "اعتماد المشروع", reject_project: "رفض المشروع", restore_project: "إعادة فتح المشروع", archive_project: "أرشفة المشروع", delete_project: "حذف المشروع نهائيًا", add_task: "إنشاء مهمة", edit_task: "تعديل المهمة", claim: "استلام المهمة", cancel_claim: "إرجاع المهمة", comment: "إضافة تعليق", submit: "إرسال المهمة لاعتماد باسم", approve: "اعتماد إنجاز المهمة", reject: "رفض الإنجاز", reopen: "إعادة فتح المهمة", reassign: "تغيير المسؤول", move_task: "نقل المهمة", archive_task: "أرشفة المهمة", restore_task: "استعادة المهمة", delete_task: "حذف المهمة نهائيًا" };
const clean = (value: unknown, max = 200) => String(value ?? "").replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conversation = (event: Event, actor: ChatUser) => hash([normalizeContactNumber(event.senderNumber), event.groupId, actor.id]);
const eventKey = (event: Event) => hash([event.senderNumber, event.groupId, event.messageId]);
const eventHash = (event: Event) => hash([event.senderNumber, event.groupId, event.text, event.replyToMessageId ?? null, event.responseMessageId ?? null, event.inputKind || "text"]);
function transaction<T>(db: DatabaseSync, work: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }
export function migrateSecretary(db: DatabaseSync) {
  migrateManagementActions(db);
  db.exec(`CREATE TABLE IF NOT EXISTS secretary_events (event_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,actor_id TEXT NOT NULL,conversation_key TEXT NOT NULL,original_text TEXT NOT NULL,result_json TEXT NOT NULL,scope_json TEXT NOT NULL,created_at INTEGER NOT NULL,response_message_id TEXT);
    CREATE INDEX IF NOT EXISTS secretary_history ON secretary_events(conversation_key,created_at);
    CREATE TABLE IF NOT EXISTS secretary_pending (conversation_key TEXT PRIMARY KEY,token TEXT NOT NULL,command_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,original_text TEXT NOT NULL,source_message_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS secretary_reminders (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,sender_number TEXT NOT NULL,group_id TEXT,task_id TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,sent_at INTEGER,sending_at INTEGER,responded_at INTEGER,reply_message_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS secretary_reminders_due ON secretary_reminders(state,due_at);`);
}
function actorFor(db: DatabaseSync, event: Event, config: TeamChatConfig) {
  return resolveChatUser({ senderNumber: event.senderNumber, groupId: event.groupId }, config.contacts, db.prepare("SELECT id,name,role,active FROM users").all() as ChatUser[], config.allowedGroupIds);
}
function stateFor(db: DatabaseSync, actor: ChatUser): Snapshot { return getManagementSnapshot(db, actor) as unknown as Snapshot; }
function fingerprint(state: Snapshot) { return hash({ tasks: state.tasks, projects: state.projects, users: state.users.map(u => ({ id: u.id, name: u.name, role: u.role, active: u.active })), comments: state.comments }); }
function scopeAllowed(scope: string[], state: Snapshot) { const ids = new Set([...state.tasks.map(t => "t:" + t.id), ...state.projects.map(p => "p:" + p.id)]); return scope.every(id => ids.has(id)); }
function conversationHistory(db: DatabaseSync, key: string, state: Snapshot, now: number): HistoryRow[] {
  const rows = db.prepare("SELECT original_text,result_json,scope_json FROM secretary_events WHERE conversation_key=? AND created_at>? ORDER BY created_at DESC,rowid DESC LIMIT 8")
    .all(key, now - HISTORY_MS) as HistoryRow[];
  // Never let an inaccessible event supply either model context or task focus.
  return rows.reverse().filter(row => scopeAllowed(JSON.parse(row.scope_json), state));
}
function boundedHistory(rows: HistoryRow[], quote?: { result_json: string }): SecretaryModelInput["history"] {
  const quoted = quote ? ("الرسالة التي يرد عليها المستخدم الآن: " + String(JSON.parse(quote.result_json).reply)).slice(0, 900) : "";
  let remaining = HISTORY_CHARS - quoted.length;
  const history: SecretaryModelInput["history"] = [];
  // Preserve complete recent pairs first; older pairs are shortened to the remaining budget.
  for (const row of [...rows].reverse()) {
    if (remaining < 2) break;
    const user = row.original_text.slice(0, Math.min(600, Math.floor(remaining / 2)));
    const assistant = String(JSON.parse(row.result_json).reply).slice(0, Math.min(900, remaining - user.length));
    history.unshift({ role: "user", content: user }, { role: "assistant", content: assistant });
    remaining -= user.length + assistant.length;
  }
  if (quoted) history.push({ role: "assistant", content: quoted });
  return history;
}
function lookup(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot): Result | null {
  const row = db.prepare("SELECT payload_hash,actor_id,result_json,scope_json FROM secretary_events WHERE event_key=?").get(eventKey(event)) as { payload_hash: string; actor_id: string; result_json: string; scope_json: string } | undefined;
  if (!row) return null;
  if (row.payload_hash !== eventHash(event) || row.actor_id !== actor.id || !scopeAllowed(JSON.parse(row.scope_json), state)) return { status: "denied", reply: "" };
  return { ...JSON.parse(row.result_json), status: "duplicate" };
}
function save(db: DatabaseSync, event: Event, actor: ChatUser, result: Result, scope: string[], now: number) {
  const bounded = { ...result, reply: result.reply.slice(0, 3800) };
  db.prepare("INSERT INTO secretary_events VALUES (?,?,?,?,?,?,?,?,?)").run(eventKey(event), eventHash(event), actor.id, conversation(event, actor), event.text, JSON.stringify(bounded), JSON.stringify(scope), now, event.responseMessageId ?? null);
  return bounded;
}
function log(db: DatabaseSync, actor: ChatUser, event: Event, action: string, details: Record<string, unknown>, now: number) {
  db.prepare("INSERT INTO audit_logs(actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,'secretary',?,?,?)")
    .run(actor.id, actor.name, action, eventKey(event), JSON.stringify({ summary: "محادثة سكرتير الإدارة", source: "whatsapp_secretary", sourceMessageId: event.messageId, senderNumber: event.senderNumber, originalText: event.text, ...details }), now);
}
function taskLink(task: Task) { return `${ORIGIN}/?project=${encodeURIComponent(task.projectId)}&task=${encodeURIComponent(task.id)}`; }
function icon(task: Task, now: number) { return task.status === "completed" ? "🟢" : task.dueDate && task.dueDate < new Date(now + 3 * 3600_000).toISOString().slice(0, 10) ? "🔴" : "🟡"; }
export function secretaryTaskCard(task: Task, state: Snapshot, now: number, detailed = false) {
  const project = state.projects.find(p => p.id === task.projectId);
  const latest = state.comments.filter(c => c.taskId === task.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  return `${icon(task, now)} *${clean(task.title, 150)}*\n${clean(project?.name, 90)} • ${LABELS[task.status] || clean(task.status)}\nالمسؤول: ${clean(task.owner || task.suggestedOwner || "لم يُعيّن")} ${task.dueDate ? `• الموعد: ${clean(task.dueDate, 10)}` : ""}${detailed ? `\nالمطلوب: ${clean(task.details || "لا توجد تفاصيل إضافية", 600)}\nالأولوية: ${{ red: "عالية", yellow: "عادية", green: "منخفضة" }[task.priority] || "عادية"}${latest ? `\nآخر تحديث (${clean(latest.author, 50)}): ${clean(latest.body, 500)}` : "\nلا يوجد تحديث مسجّل بعد."}` : ""}\n${taskLink(task)}`;
}
function readReply(plan: SecretaryIntent, actor: ChatUser, state: Snapshot, now: number): { result: Result; scope: string[] } {
  const greeting = `أهلًا يا ${clean(actor.name, 60)}، `;
  if (plan.kind === "help") return { result: { status: "summary", reply: `${greeting}أنا سكرتير فريق إدارة تيتانيوم.\nاحكيلي بطريقتك: شو مهامي؟ اشرح المهمة، سجل تحديث، أو افتح مشروعًا (لباسم). رح أستوضح أي غموض وأطلب تأكيدًا قبل التغييرات الحساسة.\nالدخول للموقع برمز خاص على واتسابك المسجّل:\n${ORIGIN}/` }, scope: [] };
  if (plan.kind === "projects") return { result: { status: "summary", reply: greeting + (state.projects.length ? state.projects.slice(0, 16).map(p => `• *${clean(p.name, 100)}* — ${LABELS[p.status] || clean(p.status)}\n${ORIGIN}/?project=${encodeURIComponent(p.id)}`).join("\n\n") : "ما في مشاريع متاحة إلك حاليًا.") }, scope: state.projects.map(p => "p:" + p.id) };
  if (plan.kind === "details") {
    const task = state.tasks.find(t => t.id === plan.taskId);
    if (task) return { result: { status: "summary", reply: `${greeting}\n${secretaryTaskCard(task, state, now, true)}\n\nاحكيلي شو صار معك أو شو بدك أعمل عليها.`, taskId: task.id }, scope: ["t:" + task.id, "p:" + task.projectId] };
    if (plan.projectId) { const project = state.projects.find(p => p.id === plan.projectId); if (project) { const tasks = state.tasks.filter(t => t.projectId === project.id); return { result: { status: "summary", reply: `*${clean(project.name)}* — ${LABELS[project.status] || clean(project.status)}\n${tasks.length} مهام متاحة إلك، ${tasks.filter(t => t.status === "completed").length} معتمدة.\n\n${tasks.slice(0, 6).map(t => secretaryTaskCard(t, state, now)).join("\n\n")}` }, scope: ["p:" + project.id, ...tasks.map(t => "t:" + t.id)] }; } }
    return { result: { status: "clarify", reply: "أي مهمة أو مشروع بدك أشرح لك؟" }, scope: [] };
  }
  const tasks = state.tasks.filter(t => !t.archivedAt);
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  const overdue = tasks.filter(t => t.status !== "completed" && t.dueDate && t.dueDate < today);
  const pending = tasks.filter(t => t.status === "approval");
  const header = plan.kind === "report" ? `📋 *ملخص الإدارة*\nالمشاريع: ${state.projects.length}\n🟢 معتمدة: ${tasks.filter(t => t.status === "completed").length}\n🟡 قيد التنفيذ: ${tasks.filter(t => t.status === "progress").length}\nبانتظار باسم: ${pending.length}\n🔴 متأخرة بموعد مسجل: ${overdue.length}\nبدون موعد: ${tasks.filter(t => !t.dueDate && t.status !== "completed").length}\n` : `${greeting}المهام المتاحة إلك: ${tasks.length}\n`;
  const ordered = [...tasks].sort((a, b) => Number(overdue.includes(b)) - Number(overdue.includes(a)) || Number(pending.includes(b)) - Number(pending.includes(a)));
  return { result: { status: "summary", reply: `${header}\n${ordered.slice(0, 6).map(t => secretaryTaskCard(t, state, now)).join("\n\n")}${tasks.length > 6 ? `\n\nبقية المهام: ${ORIGIN}/\nحدد مشروعًا أو مهمة لأعرض التفاصيل.` : ""}${tasks.length === 0 ? "ما في مهام متاحة إلك حاليًا." : ""}` }, scope: tasks.map(t => "t:" + t.id) };
}
function commandFrom(plan: SecretaryIntent, state: Snapshot): Record<string, unknown> {
  const command: Record<string, unknown> = { action: plan.action };
  if (plan.taskId) command.taskId = plan.taskId;
  if (plan.projectId && (plan.action?.endsWith("_project") || plan.action === "add_task" || plan.action === "move_task")) command.projectId = plan.projectId;
  if (plan.action === "add_project") delete command.projectId;
  for (const [key, value] of Object.entries(plan.fields)) if (value !== null && key !== "remindAt") command[key === "body" ? "comment" : key] = value;
  const task = state.tasks.find(t => t.id === plan.taskId);
  const project = state.projects.find(p => p.id === (task?.projectId || plan.projectId));
  if (task) Object.assign(command, { expectedUpdatedAt: task.updatedAt, expectedStatus: task.status, expectedProjectId: task.projectId });
  if (project) Object.assign(command, { expectedProjectUpdatedAt: project.updatedAt ?? null, ...(project.status !== "archived" ? { expectedProjectStatus: project.status } : {}) });
  if (plan.action === "move_task") command.expectedTargetProjectUpdatedAt = state.projects.find(p => p.id === plan.projectId)?.updatedAt ?? null;
  return command;
}
function commandDescription(command: Record<string, unknown>, state: Snapshot) {
  const task = state.tasks.find(t => t.id === command.taskId); const project = state.projects.find(p => p.id === command.projectId);
  const employee = state.users.find(u => u.id === command.ownerId);
  const lines = [ACTION_LABELS[String(command.action)] || "التغيير المطلوب", task ? `المهمة: ${clean(task.title)}` : null, project ? `المشروع: ${clean(project.name)}` : null,
    command.title ? `العنوان: ${clean(command.title)}` : null, command.name ? `الاسم: ${clean(command.name)}` : null,
    command.details ? `التفاصيل: ${clean(command.details, 500)}` : null, employee ? `المسؤول: ${clean(employee.name)}` : null,
    command.comment ? `التعليق: ${clean(command.comment, 500)}` : null,
    command.priority ? `الأولوية: ${{ red: "عالية", yellow: "عادية", green: "منخفضة" }[String(command.priority)] || "عادية"}` : null,
    command.dueDate ? `الموعد: ${clean(command.dueDate)}` : null, command.reason ? `السبب: ${clean(command.reason, 350)}` : null];
  return lines.filter(Boolean).join("\n");
}
const AFFIRMATIONS = ["نعم", "موافق", "أكد", "اكد", "أكيد", "اكيد", "نفذ", "تمام", "yes", "confirm"];
function confirmationText(text: string) { return text.trim().replace(/[.!،]/g, "").replace(/\s+/g, " ").toLowerCase(); }
function isConfirmationAttempt(text: string) {
  const value = confirmationText(text);
  return AFFIRMATIONS.includes(value) || /^(?:(?:نعم|موافق|أكد|اكد|أكيد|اكيد|نفذ|تمام|yes|confirm) )?t[0-9a-f]{6}$/.test(value);
}
function isAffirmation(text: string, token: string, matchingQuote: boolean) {
  const value = confirmationText(text), expected = token.toLowerCase();
  return value === expected || AFFIRMATIONS.some(word => value === `${word} ${expected}`) || (matchingQuote && AFFIRMATIONS.includes(value));
}
function isCancellation(text: string) { return /^(?:لا|الغ[يِ]?|إلغاء|الغاء|ألغي|تراجع|cancel|no)[.!،\s]*$/iu.test(text.trim()); }

function reminder(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, taskId: unknown, due: unknown, now: number): Result {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || typeof due !== "number" || !Number.isFinite(due) || due < now + 60_000 || due > now + 90 * 86400_000) return save(db, event, actor, { status: "clarify", reply: "حدد المهمة وموعدًا قادمًا للتذكير بالتاريخ والساعة بتوقيت عمّان/الرياض." }, [], now);
  if (Number((db.prepare("SELECT count(*) AS n FROM secretary_reminders WHERE actor_id=? AND state='pending'").get(actor.id) as { n: number }).n) >= 30) return save(db, event, actor, { status: "clarify", reply: "عندك 30 تذكيرًا قادمًا. خلينا نراجعها قبل إضافة المزيد." }, [], now);
  const id = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO secretary_reminders(id,actor_id,sender_number,group_id,task_id,due_at,created_at,reply_message_id) VALUES(?,?,?,?,?,?,?,?)").run(id, actor.id, event.senderNumber, event.groupId, task.id, due, now, "TITANIUMREM" + id.toUpperCase());
  log(db, actor, event, "secretary_reminder", { summary: "جدول تذكيرًا لمهمة", taskId: task.id, dueAt: due }, now);
  return save(db, event, actor, { status: "scheduled", reply: `جدولت تذكيرك عن «${clean(task.title)}» يوم ${new Intl.DateTimeFormat("ar-JO", { timeZone: "Asia/Amman", dateStyle: "medium", timeStyle: "short" }).format(due)} في نفس المحادثة.`, taskId: task.id }, ["t:" + task.id], now);
}

export async function handleSecretaryEvent(db: DatabaseSync, event: Event, config: TeamChatConfig, dependencies: {
  infer: (input: SecretaryModelInput) => Promise<SecretaryIntent>; search?: (query: string) => Promise<string>; now?: () => number;
}): Promise<Result> {
  migrateSecretary(db); const now = (dependencies.now || Date.now)();
  const actor = actorFor(db, event, config); if (!actor) return { status: "denied", reply: "" };
  const initial = stateFor(db, actor); const previous = lookup(db, event, actor, initial); if (previous) return previous;
  const key = conversation(event, actor); const initialHash = fingerprint(initial);
  const pending = db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined;
  const quote = event.replyToMessageId ? db.prepare("SELECT event_key,result_json,scope_json FROM secretary_events WHERE conversation_key=? AND response_message_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(key, event.replyToMessageId) as { event_key: string; result_json: string; scope_json: string } | undefined : undefined;
  if (event.replyToMessageId && (!quote || !scopeAllowed(JSON.parse(quote.scope_json), initial))) return transaction(db, () => save(db, event, actor, { status: "clarify", reply: "ما قدرت أربط هذا الرد بطلب متاح إلك. اذكر المهمة والتغيير المطلوب بدل الرد على رسالة قديمة أو لشخص آخر." }, [], now));
  const historyRows = conversationHistory(db, key, initial, now);
  const focusResult = quote ? JSON.parse(quote.result_json) : historyRows.length ? JSON.parse(historyRows[historyRows.length - 1].result_json) : null;
  const focusedTask = initial.tasks.find(task => task.id === focusResult?.taskId);
  const focusedTaskId = focusedTask?.id ?? null;
  if (!pending && isConfirmationAttempt(event.text)) return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    const focusSource = quote ?? historyRows[historyRows.length - 1];
    const visibleFocus = focusSource && scopeAllowed(JSON.parse(focusSource.scope_json), state) ? state.tasks.find(task => task.id === focusedTaskId) : undefined;
    if (!AFFIRMATIONS.includes(confirmationText(event.text))) return save(db, event, actor, { status: "clarify", reply: "ما في طلب معلّق مطابق للتأكيد. اذكر التغيير المطلوب لأعرضه عليك من جديد." }, [], now);
    return save(db, event, freshActor, { status: "summary", reply: `تمام يا ${clean(freshActor.name, 60)}، أنا معك.${visibleFocus ? ` نكمل على «${clean(visibleFocus.title, 120)}»؛ احكيلي شو المطلوب.` : " احكيلي كيف أقدر أساعدك."}`, ...(visibleFocus ? { taskId: visibleFocus.id } : {}) }, visibleFocus ? ["t:" + visibleFocus.id, "p:" + visibleFocus.projectId] : [], now);
  });
  if (pending && (isConfirmationAttempt(event.text) || isCancellation(event.text))) {
    return transaction(db, () => {
      const freshActor = actorFor(db, event, config); if (!freshActor) return { status: "denied", reply: "" };
      const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
      const live = db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined;
      if (!live || live.token !== pending.token) return save(db, event, freshActor, { status: "clarify", reply: "تغيّر الطلب المعلّق. اذكر التغيير المطلوب من جديد." }, [], now);
      const matchingQuote = !!quote && quote.event_key === eventKey({ ...event, messageId: live.source_message_id }) && JSON.parse(quote.result_json).status === "confirmation";
      if (quote && !matchingQuote) return save(db, event, freshActor, { status: "clarify", reply: "هذا الرد ليس على الطلب المعلّق الحالي. أكّد باستخدام رمز الطلب المعروض أمامك." }, [], now);
      if (!isCancellation(event.text) && !isAffirmation(event.text, live.token, matchingQuote)) return save(db, event, freshActor, { status: "clarify", reply: `حتى ما أنفّذ طلبًا غير المقصود، اكتب «موافق ${live.token}» أو رد مباشرةً بالموافقة على رسالة هذا الطلب. لم أنفّذ أي تغيير.` }, [], now);
      db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
      if (isCancellation(event.text)) { log(db, freshActor, event, "secretary_cancel", { summary: "ألغى الطلب قبل التنفيذ" }, now); return save(db, event, freshActor, { status: "cancelled", reply: "ألغيت الطلب المعلّق، ما غيّرت المهمة أو المشروع." }, [], now); }
      if (live.expires_at <= now || live.snapshot_hash !== fingerprint(state)) return save(db, event, freshActor, { status: "stale", reply: "انتهى وقت التأكيد أو تغيّرت البيانات/الصلاحيات. ما نفذت الطلب؛ اذكره من جديد لأعرض الوضع الحالي." }, [], now);
      const command = JSON.parse(live.command_json);
      if (command.action === "schedule_reminder") return reminder(db, event, freshActor, state, command.taskId, command.dueAt, now);
      return perform(db, event, freshActor, state, command, now, { originalText: live.original_text, sourceMessageId: live.source_message_id, confirmationRequired: true, confirmedBy: freshActor.id, confirmationMessageId: event.messageId });
    });
  }
  const history = boundedHistory(historyRows, quote);
  const input: SecretaryModelInput = { text: event.text, actor: { id: actor.id, name: actor.name, role: actor.role }, focusedTaskId,
    tasks: initial.tasks.map(t => ({ id: t.id, title: t.title, projectId: t.projectId, status: t.status })),
    projects: initial.projects.map(p => ({ id: p.id, name: p.name, status: p.status })), users: initial.users.filter(u => u.active === 1).map(u => ({ id: u.id, name: u.name })), history, now: new Date(now).toISOString() };
  const plan = validateSecretaryIntent(await dependencies.infer(input), input);
  let publicReply: string | null = null;
  if (plan.kind === "search") {
    // Require query to be newly supplied, not copied from internal catalog/history by the model.
    const query = event.text.trim(); // Never send model-invented fragments copied from an internal catalog.
    const leaked = query.length > 500 || /\d{6,}|@|(?:مهامي|مشاريعي|موظف|مريض|رقم الهوية|رمز الدخول|كلمة السر)/u.test(query)
      || [...initial.tasks.map(t => t.title), ...initial.projects.map(p => p.name), ...initial.users.map(u => u.name)].some(title => title.length > 2 && query.includes(title));
    publicReply = leaked ? "لن أرسل بيانات المشاريع إلى محرك بحث عام. اكتب سؤالك العام بدون معلومات داخلية." : dependencies.search ? await dependencies.search(query) : "البحث العام غير مفعّل حاليًا. أقدر أساعدك بمعلومات الموقع.";
  }
  return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    if (fingerprint(state) !== initialHash) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت بيانات العمل أثناء قراءة رسالتك. ما عدّلتها؛ أعد الطلب لأراجع آخر وضع." }, [], now);
    if (plan.kind === "command" || plan.kind === "remind") db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
    if (plan.kind === "command") {
      const command = commandFrom(plan, state);
      if (freshActor.id !== "basem" && !["claim", "cancel_claim", "comment", "submit"].includes(String(command.action))) return save(db, event, freshActor, { status: "denied", reply: "هذا القرار من صلاحيات باسم. أقدر أساعدك بتحديث مهامك أو إرسالها للمراجعة." }, [], now);
      if (SENSITIVE.has(String(command.action)) || event.inputKind === "voice") {
        const token = "T" + randomBytes(3).toString("hex").toUpperCase();
        db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS);
        const scope = [...(plan.taskId ? ["t:" + plan.taskId] : []), ...(plan.projectId ? ["p:" + plan.projectId] : [])];
        log(db, freshActor, event, "secretary_proposal", { summary: "عرض تغييرًا ينتظر التأكيد", proposedCommand: command, confirmationRequired: true }, now);
        return save(db, event, freshActor, { status: "confirmation", reply: `${event.inputKind === "voice" ? `فهمت من الصوت: «${clean(event.text, 450)}»\n` : ""}للتأكيد قبل التنفيذ:\n${commandDescription(command, state)}\n\nاكتب «موافق ${token}» للتنفيذ أو «إلغاء». الطلب صالح 10 دقائق ولن يُنفّذ إذا تغيّرت بياناته.`, ...(plan.taskId ? { taskId: plan.taskId } : {}) }, scope, now);
      }
      return perform(db, event, freshActor, state, command, now, { originalText: event.text, sourceMessageId: event.messageId, confirmationRequired: false });
    }
    if (plan.kind === "remind") {
      const task = state.tasks.find(t => t.id === plan.taskId); const due = Date.parse(plan.fields.remindAt || "");
      if (!task || !Number.isFinite(due) || due < now + 60_000 || due > now + 90 * 86400_000 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(plan.fields.remindAt || "")) return save(db, event, freshActor, { status: "clarify", reply: "حدد المهمة وموعد التذكير بالتاريخ والساعة بتوقيت عمّان/الرياض." }, [], now);
      if (event.inputKind === "voice") {
        const token = "T" + randomBytes(3).toString("hex").toUpperCase();
        db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify({ action: "schedule_reminder", taskId: task.id, dueAt: due }), initialHash, event.text, event.messageId, now + CONFIRM_MS);
        return save(db, event, freshActor, { status: "confirmation", reply: `فهمت من الصوت: «${clean(event.text, 450)}»\nأجدول تذكيرًا عن «${clean(task.title)}» في ${new Intl.DateTimeFormat("ar-JO", { timeZone: "Asia/Amman", dateStyle: "medium", timeStyle: "short" }).format(due)}؟\nاكتب «موافق ${token}» أو «إلغاء».` }, ["t:" + task.id], now);
      }
      return reminder(db, event, freshActor, state, task.id, due, now);
    }
    if (plan.kind === "chat" || plan.kind === "clarify" || plan.kind === "search") {
      let reply = publicReply || plan.message || "أي مهمة أو مشروع تقصد، وشو المطلوب؟";
      if (plan.kind === "chat" || plan.kind === "clarify") reply = safeConversationalReply(reply);
      // The planner explicitly identifies contextual replies; an unrelated topic has no focus.
      const contextTaskId = plan.kind !== "search" && state.tasks.some(task => task.id === plan.taskId) ? plan.taskId : null;
      return save(db, event, freshActor, { status: plan.kind === "clarify" ? "clarify" : "summary", reply, ...(contextTaskId ? { taskId: contextTaskId } : {}) }, plan.kind !== "search" ? [...state.tasks.map(t => "t:" + t.id), ...state.projects.map(p => "p:" + p.id)] : [], now);
    }
    const read = readReply(plan, freshActor, state, now); return save(db, event, freshActor, read.result, read.scope, now);
  });
}
function perform(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, command: Record<string, unknown>, now: number, context: Record<string, unknown>): Result {
  try {
    const result = executeManagementAction(db, actor, command as ManagementCommand, { now, source: "whatsapp_secretary", auditContext: { ...context, senderNumber: event.senderNumber, origin: "whatsapp", proposedCommand: command } });
    const taskId = typeof command.taskId === "string" ? command.taskId : result.entityType === "task" ? result.entityId : undefined;
    if (taskId) db.prepare("UPDATE secretary_reminders SET responded_at=? WHERE actor_id=? AND task_id=? AND group_id IS ? AND state='sent' AND responded_at IS NULL").run(now, actor.id, taskId, event.groupId);
    const scope = [...(taskId && state.tasks.some(t => t.id === taskId) && command.action !== "delete_task" ? ["t:" + taskId] : []), ...(typeof command.projectId === "string" && command.action !== "delete_project" ? ["p:" + command.projectId] : [])];
    // File blobs from confirmed deletions remain recoverable on disk; DB links are removed atomically.
    return save(db, event, actor, { status: "applied", reply: `✅ ${result.message}`, ...(taskId ? { taskId } : {}) }, scope, now);
  } catch (error) {
    if (!(error instanceof ManagementActionError)) throw error;
    return save(db, event, actor, { status: "clarify", reply: error.message }, [], now);
  }
}
