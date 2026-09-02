import { audit, db, ensureSeedUsers } from "@/lib/titanium-server";
import { BASIM_WHATSAPP, ensureWhatsAppTables, normalizeWhatsAppNumber, notifyManagementGroup, sendWhatsAppText, verifyMetaSignature } from "@/lib/whatsapp";

type IncomingMessage = { id?:string; from?:string; type?:string; text?:{body?:string} };

export async function GET(request:Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === process.env.META_WA_VERIFY_TOKEN) return new Response(challenge || "", { status:200 });
  return new Response("Forbidden", { status:403 });
}

export async function POST(request:Request) {
  if (process.env.WHATSAPP_ENABLED !== "1") return Response.json({ ok:true, skipped:"whatsapp_disabled" });
  const raw = await request.text();
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"))) return new Response("Invalid signature", { status:401 });
  try {
    const payload = JSON.parse(raw) as {entry?:Array<{changes?:Array<{value?:{messages?:IncomingMessage[]}}>}>};
    const messages = payload.entry?.flatMap(entry => entry.changes?.flatMap(change => change.value?.messages || []) || []) || [];
    for (const message of messages) await processMessage(message);
    return Response.json({ ok:true });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "Invalid webhook" }, { status:400 });
  }
}

async function processMessage(message:IncomingMessage) {
  if (!message.id || message.type !== "text" || !message.text?.body) return;
  const sender = normalizeWhatsAppNumber(message.from || "");
  const body = message.text.body.trim();
  await ensureWhatsAppTables();
  const inserted = await db().prepare("INSERT OR IGNORE INTO whatsapp_messages (message_id, sender, body, processed_at, result) VALUES (?, ?, ?, ?, '')")
    .bind(message.id, sender, body, Date.now()).run();
  if (inserted.meta.changes === 0) return;
  if (isDeletionRequest(body)) {
    const acknowledgement = "✅ تم استلام طلب حذف بياناتك. سيراجعه مدير النظام ويؤكد النتيجة عبر نفس الرقم.";
    await db().prepare("UPDATE whatsapp_messages SET result = 'deletion_request_received' WHERE message_id = ?").bind(message.id).run();
    const notifications:Promise<unknown>[] = [sendWhatsAppText(sender, acknowledgement)];
    if (BASIM_WHATSAPP) notifications.push(sendWhatsAppText(BASIM_WHATSAPP, `🗑️ طلب حذف بيانات WhatsApp من الرقم: ${sender}`));
    await Promise.allSettled(notifications);
    return;
  }
  if (sender !== BASIM_WHATSAPP) {
    await db().prepare("UPDATE whatsapp_messages SET result = 'ignored_non_admin' WHERE message_id = ?").bind(message.id).run();
    return;
  }
  await ensureSeedUsers();
  const result = await executeCommand(body);
  await db().prepare("UPDATE whatsapp_messages SET result = ? WHERE message_id = ?").bind(result.slice(0, 1000), message.id).run();
  await notifyManagementGroup(result);
}

async function executeCommand(body:string) {
  const command = body.replace(/^تيتانيوم[\s:،-]*/i, "").trim();
  if (/^(مساعدة|الاوامر|الأوامر)$/i.test(command)) return help();
  if (/^(ملخص|الحالة|المهام)$/i.test(command)) return summary();
  if (/^(المتأخر|متأخر)$/i.test(command)) return taskList("overdue");
  if (/^(المفتوحة|مفتوحة)$/i.test(command)) return taskList("open");

  const parts = command.split("|").map(part => part.trim());
  if (parts[0] === "مهمة" && parts.length >= 5) return addTask(parts);
  if (parts[0] === "اعتماد" && parts[1]) return approveTask(parts[1]);
  if (parts[0] === "رفض" && parts[1] && parts[2]) return rejectTask(parts[1], parts.slice(2).join(" | "));
  if (parts[0] === "تعيين" && parts[1] && parts[2]) return assignTask(parts[1], parts[2]);
  return `لم أفهم الأمر.\n${help()}`;
}

async function summary() {
  const rows = await db().prepare("SELECT status, COUNT(*) AS count FROM tasks WHERE archived_at IS NULL GROUP BY status").all<{status:string;count:number}>();
  const counts = Object.fromEntries(rows.results.map(row => [row.status, row.count]));
  return `📊 ملخص تيتانيوم\nمفتوحة: ${counts.open || 0}\nقيد التنفيذ: ${counts.progress || 0}\nبانتظار باسم: ${counts.approval || 0}\nمعتمدة: ${counts.completed || 0}`;
}

async function taskList(kind:"open"|"overdue") {
  const today = new Date().toISOString().slice(0,10);
  const sql = kind === "open"
    ? "SELECT title, suggested_owner AS owner, due_date AS dueDate FROM tasks WHERE status = 'open' AND archived_at IS NULL ORDER BY due_date IS NULL, due_date LIMIT 15"
    : "SELECT title, COALESCE(owner,suggested_owner) AS owner, due_date AS dueDate FROM tasks WHERE status != 'completed' AND archived_at IS NULL AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date LIMIT 15";
  const rows = kind === "open" ? await db().prepare(sql).all<{title:string;owner:string|null;dueDate:string|null}>() : await db().prepare(sql).bind(today).all<{title:string;owner:string|null;dueDate:string|null}>();
  if (!rows.results.length) return kind === "open" ? "✅ لا توجد مهام مفتوحة" : "✅ لا توجد مهام متأخرة";
  return `${kind === "open" ? "📋 المهام المفتوحة" : "⏰ المهام المتأخرة"}\n${rows.results.map((row,index) => `${index+1}. ${row.title}${row.owner ? ` — ${row.owner}` : ""}${row.dueDate ? ` — ${row.dueDate}` : ""}`).join("\n")}`;
}

async function addTask(parts:string[]) {
  const [, projectName, title, ownerName, priorityName, dueDate = ""] = parts;
  const project = await db().prepare("SELECT id FROM projects WHERE name = ? AND status = 'active'").bind(projectName).first<{id:string}>();
  if (!project) return `❌ المشروع غير موجود أو غير فعال: ${projectName}`;
  const owner = await db().prepare("SELECT name FROM users WHERE name = ? AND active = 1").bind(ownerName).first<{name:string}>();
  if (!owner) return `❌ المستخدم غير موجود أو موقوف: ${ownerName}`;
  const priority = priorityName.includes("حمر") ? "red" : priorityName.includes("خضر") ? "green" : "yellow";
  const id = crypto.randomUUID(); const now = Date.now();
  await db().prepare("INSERT INTO tasks (id, project_id, title, details, priority, status, suggested_owner, due_date, created_at, updated_at) VALUES (?, ?, ?, '', ?, 'open', ?, ?, ?, ?)")
    .bind(id, project.id, title, priority, owner.name, dueDate || null, now, now).run();
  const basem = { id:"basem", name:"باسم", role:"admin" as const, active:1 };
  await audit(basem, "create", "task", id, `أضاف مهمة من واتساب: ${title}`);
  return `✅ تمت إضافة المهمة\n${title}\nالمسؤول: ${owner.name}`;
}

async function approveTask(title:string) {
  const task = await db().prepare("SELECT id, title FROM tasks WHERE title = ? AND status = 'approval' AND archived_at IS NULL").bind(title).first<{id:string;title:string}>();
  if (!task) return `❌ لا توجد مهمة بهذا الاسم بانتظار الاعتماد: ${title}`;
  const now=Date.now(); await db().prepare("UPDATE tasks SET status='completed', completed_at=?, updated_at=? WHERE id=?").bind(now,now,task.id).run();
  await audit({id:"basem",name:"باسم",role:"admin",active:1},"approve","task",task.id,`اعتمد من واتساب: ${task.title}`);
  return `✅ تم اعتماد المهمة: ${task.title}`;
}

async function rejectTask(title:string, reason:string) {
  const task = await db().prepare("SELECT id, title FROM tasks WHERE title = ? AND status = 'approval' AND archived_at IS NULL").bind(title).first<{id:string;title:string}>();
  if (!task) return `❌ لا توجد مهمة بهذا الاسم بانتظار الاعتماد: ${title}`;
  await db().prepare("UPDATE tasks SET status='progress', rejection_reason=?, updated_at=? WHERE id=?").bind(reason,Date.now(),task.id).run();
  await audit({id:"basem",name:"باسم",role:"admin",active:1},"reject","task",task.id,`رفض من واتساب: ${reason}`);
  return `↩️ عادت المهمة للتنفيذ: ${task.title}\nالسبب: ${reason}`;
}

async function assignTask(title:string, ownerName:string) {
  const task = await db().prepare("SELECT id, title FROM tasks WHERE title = ? AND archived_at IS NULL").bind(title).first<{id:string;title:string}>();
  const owner = await db().prepare("SELECT name FROM users WHERE name = ? AND active = 1").bind(ownerName).first<{name:string}>();
  if (!task) return `❌ المهمة غير موجودة: ${title}`; if (!owner) return `❌ المستخدم غير موجود: ${ownerName}`;
  await db().prepare("UPDATE tasks SET status='open', owner=NULL, suggested_owner=?, started_at=NULL, completed_at=NULL, rejection_reason=NULL, updated_at=? WHERE id=?").bind(owner.name,Date.now(),task.id).run();
  await audit({id:"basem",name:"باسم",role:"admin",active:1},"reassign","task",task.id,`عيّن من واتساب إلى ${owner.name}`);
  return `✅ تم تعيين ${task.title} إلى ${owner.name}`;
}

function isDeletionRequest(value:string) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "حذف بياناتي" || normalized === "delete my data" || normalized === "حذف بياناتي | delete my data";
}

function help() {
  return "أوامر باسم:\n• تيتانيوم ملخص\n• تيتانيوم المتأخر\n• تيتانيوم المفتوحة\n• مهمة | المشروع | عنوان المهمة | خالد | حمراء | 2026-09-10\n• اعتماد | عنوان المهمة\n• رفض | عنوان المهمة | السبب\n• تعيين | عنوان المهمة | شادي";
}
