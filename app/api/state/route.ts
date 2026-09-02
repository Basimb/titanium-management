import {
  audit,
  bucket,
  db,
  ensureSeedUsers,
  hashPin,
  requireAdmin,
  requireSession,
  validPin,
  verifyPin,
  type TitaniumUser,
} from "@/lib/titanium-server";
import { notifyManagementGroup, taskNotification } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store, no-cache, max-age=0, must-revalidate",
  "cdn-cache-control": "no-store",
  pragma: "no-cache",
  expires: "0",
  vary: "Cookie, X-Titanium-Session",
} as const;

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(PRIVATE_RESPONSE_HEADERS)) headers.set(name, value);
  return Response.json(body, { ...init, headers });
}


const seedProjects = [
  ["dabouq-setup", "تجهيز صيدلية دابوق"],
  ["dabouq-license", "ترخيص ونقل ملكية دابوق"],
  ["clinics-setup", "تجهيز وتشغيل العيادات"],
  ["clinics-license", "ترخيص العيادات"],
] as const;

const seedTasks = [
  ["ds-1","dabouq-setup","الديكور واللوحة وتعديل كونتر الاستقبال","أولوية قصوى","red"],
  ["ds-2","dabouq-setup","أدابتر كهرباء لتليفون أفايا — تحويلة 110","أولوية قصوى","red"],
  ["ds-3","dabouq-setup","رفع ملف الجرد وتأكيد الستوك وترحيل البضاعة","حوالي 800 صنف","red"],
  ["ds-4","dabouq-setup","تأكيد موعد قدوم محمد من فرع الجمرك","بانتظار التأكيد","yellow"],
  ["ds-5","dabouq-setup","تحديد جدول دوام الصيدلي والموظفين","لم يبدأ","yellow"],
  ["dl-1","dabouq-license","براءة ذمة صندوق الأخطاء الطبية وكتاب الضمان","من 31/3/2025 حتى اليوم","red"],
  ["dl-2","dabouq-license","حضور المزاول والمدير العام وتجهيز الهويات","أولوية قصوى","red"],
  ["dl-3","dabouq-license","مزاولات جميع الصيادلة مجددة وسارية","قيد التجهيز","red"],
  ["dl-4","dabouq-license","عقد إيجار باسم الشركة وختم فرع دابوق","أولوية قصوى","red"],
  ["dl-5","dabouq-license","جدول الفروع والصيادلة المسؤولين","لم يبدأ","red"],
  ["dl-6","dabouq-license","توثيق تنازلات الصيادلة المزاولين","المحامي أحمد","red"],
  ["dl-7","dabouq-license","كتاب وزارة الصحة بالموافقة على إنشاء الشركة","مطلوب","red"],
  ["cs-1","clinics-setup","حسم دوام دكتورة النسائية","أولوية قصوى","red"],
  ["cs-2","clinics-setup","استكمال برنامج العيادات ودفع رسومه","أولوية قصوى","red"],
  ["cs-3","clinics-setup","نقل السرير وتجهيز غرفة المنامة","قيد المتابعة","yellow"],
  ["cs-4","clinics-setup","معالجة فتحات غرف المنامة والتخصصية","لم يبدأ","yellow"],
  ["cs-5","clinics-setup","تركيب واقي شمس للغرف التي دون تكييف","التخصصية، الطب العام، الإدارة","yellow"],
  ["cl-1","clinics-license","تحديد الطبيب المالك ونسبة ملكية الأطباء وعقودهم","نسبة الأطباء 51% على الأقل","red"],
  ["cl-2","clinics-license","الاسم التجاري والسجل التجاري للمركز","أولوية قصوى","red"],
  ["cl-3","clinics-license","مزاولات الأطباء وبراءات الذمة","صلاحية البراءة شهر واحد","red"],
  ["cl-4","clinics-license","عقد إيجار موثق باسم المركز","مطلوب","red"],
  ["cl-5","clinics-license","متطلبات الموقع والعقار وعقد النفايات الطبية","قيد التجهيز","red"],
  ["cl-6","clinics-license","تعهد الأطباء بالتفرغ التام","يتطلب حضورهم شخصياً","red"],
  ["cl-7","clinics-license","رسوم الترخيص بعد موافقة اللجنة","1,000 دينار","red"],
] as const;

async function bootstrap() {
  await ensureSeedUsers();
  const count = await db().prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>();
  if ((count?.count ?? 0) > 0) return;
  const now = Date.now();
  const statements = seedProjects.map(([id, name]) => db().prepare("INSERT INTO projects (id, name, status, created_by, created_at) VALUES (?, ?, 'active', 'باسم', ?)").bind(id, name, now));
  statements.push(...seedTasks.map(([id, projectId, title, details, priority]) => db().prepare("INSERT INTO tasks (id, project_id, title, details, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)").bind(id, projectId, title, details, priority, now, now)));
  await db().batch(statements);
}

async function loadState(user: TitaniumUser) {
  const [projects, tasks, comments, users, attachments, activity] = await Promise.all([
    db().prepare("SELECT id, name, status, created_by AS createdBy, created_at AS createdAt, rejection_reason AS rejectionReason, rejected_by AS rejectedBy, rejected_at AS rejectedAt FROM projects ORDER BY created_at, id").all(),
    db().prepare("SELECT id, project_id AS projectId, title, details, priority, status, owner, suggested_owner AS suggestedOwner, started_at AS startedAt, due_date AS dueDate, completed_at AS completedAt, rejection_reason AS rejectionReason, created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt, archived_by AS archivedBy FROM tasks ORDER BY created_at, id").all(),
    db().prepare("SELECT id, task_id AS taskId, author, body, created_at AS createdAt FROM comments ORDER BY created_at DESC, id DESC").all(),
    db().prepare("SELECT id, name, role, active, CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END AS pinSet, created_at AS createdAt, updated_at AS updatedAt FROM users ORDER BY role, created_at, name").all(),
    db().prepare("SELECT id, task_id AS taskId, file_name AS fileName, content_type AS contentType, size, uploaded_by AS uploadedBy, created_at AS createdAt FROM attachments ORDER BY created_at DESC").all(),
    db().prepare("SELECT id, actor_user_id AS actorUserId, actor_name AS actorName, action, entity_type AS entityType, entity_id AS entityId, details, created_at AS createdAt FROM audit_logs ORDER BY created_at DESC, id DESC").all(),
  ]);
  return privateJson({ currentUser:user, projects:projects.results, tasks:tasks.results, comments:comments.results, users:users.results, attachments:attachments.results, activity:activity.results });
}

export async function GET(request: Request) {
  try {
    await bootstrap();
    const auth = await requireSession(request);
    if (auth.response) return auth.response;
    return loadState(auth.user!);
  } catch (error) {
    return privateJson({ error: error instanceof Error ? error.message : "تعذر تحميل البيانات" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await bootstrap();
    const auth = await requireSession(request);
    if (auth.response) return auth.response;
    const user = auth.user!;
    const body = await request.json() as Record<string, unknown>;
    const action = text(body.action);
    const now = Date.now();
    let waNotification:string|null = null;

    if (action === "add_project") {
      const denied = requireAdmin(user); if (denied) return denied;
      const name = text(body.name).trim();
      if (!name) return bad("اسم المشروع مطلوب");
      const id = crypto.randomUUID();
      const status = "active";
      await db().prepare("INSERT INTO projects (id, name, status, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, status, user.name, now).run();
      await audit(user, "create", "project", id, `أضاف مشروع: ${name}`);
    } else if (action === "approve_project") {
      const denied = requireAdmin(user); if (denied) return denied;
      const projectId = text(body.projectId);
      const project = await projectById(projectId); if (!project) return missing("المشروع");
      await db().prepare("UPDATE projects SET status = 'active', rejection_reason = NULL, rejected_by = NULL, rejected_at = NULL WHERE id = ?").bind(projectId).run();
      await audit(user, "approve", "project", projectId, `اعتمد مشروع: ${project.name}`);
    } else if (action === "reject_project") {
      const denied = requireAdmin(user); if (denied) return denied;
      const projectId = text(body.projectId); const reason = text(body.reason).trim();
      if (!reason) return bad("سبب رفض المشروع مطلوب");
      const project = await projectById(projectId); if (!project) return missing("المشروع");
      await db().prepare("UPDATE projects SET status = 'rejected', rejection_reason = ?, rejected_by = ?, rejected_at = ? WHERE id = ?").bind(reason, user.name, now, projectId).run();
      await audit(user, "reject", "project", projectId, `رفض مشروع ${project.name}: ${reason}`);
    } else if (action === "restore_project") {
      const denied = requireAdmin(user); if (denied) return denied;
      const projectId = text(body.projectId); const project = await projectById(projectId); if (!project) return missing("المشروع");
      await db().prepare("UPDATE projects SET status = 'pending', rejection_reason = NULL, rejected_by = NULL, rejected_at = NULL WHERE id = ?").bind(projectId).run();
      await audit(user, "restore", "project", projectId, `أعاد مشروع ${project.name} للمراجعة`);
    } else if (action === "add_task") {
      const denied = requireAdmin(user); if (denied) return denied;
      const title = text(body.title).trim(); const projectId = text(body.projectId);
      if (!title || !projectId) return bad("اسم المهمة والمشروع مطلوبان");
      const priority = validPriority(body.priority); const id = crypto.randomUUID();
      await db().prepare("INSERT INTO tasks (id, project_id, title, details, priority, status, suggested_owner, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)")
        .bind(id, projectId, title, text(body.details).trim(), priority, nullable(body.suggestedOwner), nullable(body.dueDate), now, now).run();
      await audit(user, "create", "task", id, `أضاف مهمة: ${title}`);
      waNotification = taskNotification("create", title, user.name, nullable(body.suggestedOwner) ? `المسؤول: ${nullable(body.suggestedOwner)}` : "غير معيّنة");
    } else if (action === "edit_task") {
      const denied = requireAdmin(user); if (denied) return denied;
      const taskId = text(body.taskId); const title = text(body.title).trim();
      if (!title) return bad("اسم المهمة مطلوب");
      const task = await taskById(taskId); if (!task) return missing("المهمة");
      await db().prepare("UPDATE tasks SET title = ?, details = ?, priority = ?, due_date = ?, suggested_owner = ?, updated_at = ? WHERE id = ?")
        .bind(title, text(body.details).trim(), validPriority(body.priority), nullable(body.dueDate), nullable(body.suggestedOwner), now, taskId).run();
      await audit(user, "edit", "task", taskId, `عدّل المهمة: ${task.title}`);
    } else if (action === "claim") {
      const taskId = text(body.taskId); const task = await taskById(taskId); if (!task) return missing("المهمة");
      if (user.id !== "basem" && task.suggestedOwner !== user.name) return forbidden("هذه المهمة لم يعيّنها باسم لك");
      const result = await db().prepare("UPDATE tasks SET status = 'progress', owner = ?, started_at = ?, rejection_reason = NULL, updated_at = ? WHERE id = ? AND status = 'open' AND archived_at IS NULL AND (suggested_owner = ? OR ? = 'basem')")
        .bind(user.name, now, now, taskId, user.name, user.id).run();
      if (result.meta.changes === 0) {
        const current = await taskById(taskId);
        return privateJson({ error: current?.owner ? `سبقك ${current.owner} واستلمها قبلك` : "تعذر استلام المهمة" }, { status: 409 });
      }
      await audit(user, "claim", "task", taskId, "استلم المهمة وبدأ تنفيذها");
      waNotification = taskNotification("claim", task.title, user.name);
    } else if (action === "cancel_claim") {
      const taskId = text(body.taskId); const task = await taskById(taskId); if (!task) return missing("المهمة");
      if (user.id !== "basem" && task.owner !== user.name) return forbidden("إرجاع المهمة متاح لمستلمها أو باسم");
      if (user.id !== "basem" && await hasProgressAfterClaim(taskId, task.startedAt)) return forbidden("بدأ العمل على المهمة؛ لا يمكن إرجاعها الآن. تواصل مع باسم");
      await db().prepare("UPDATE tasks SET status = 'open', owner = NULL, started_at = NULL, rejection_reason = NULL, updated_at = ? WHERE id = ? AND status = 'progress'").bind(now, taskId).run();
      await audit(user, "unclaim", "task", taskId, `ألغى استلام المهمة: ${task.title}`);
    } else if (action === "reassign") {
      const denied = requireAdmin(user); if (denied) return denied;
      const taskId = text(body.taskId); const ownerId = text(body.ownerId);
      const target = await db().prepare("SELECT id, name FROM users WHERE id = ? AND active = 1").bind(ownerId).first<{id:string;name:string}>();
      if (!target) return bad("المسؤول المختار غير متاح");
      const task = await taskById(taskId); if (!task) return missing("المهمة");
      await db().prepare("UPDATE tasks SET status = 'open', owner = NULL, suggested_owner = ?, started_at = NULL, completed_at = NULL, rejection_reason = NULL, updated_at = ? WHERE id = ? AND archived_at IS NULL")
        .bind(target.name, now, taskId).run();
      await audit(user, "reassign", "task", taskId, `عيّن المهمة إلى ${target.name} بانتظار استلامه: ${task.title}`);
      waNotification = taskNotification("reassign", task.title, user.name, `المسؤول: ${target.name}`);
    } else if (action === "comment") {
      const taskId = text(body.taskId); const comment = text(body.comment).trim();
      if (!comment) return bad("اكتب التعليق أولاً");
      const task = await taskById(taskId); if (!task) return missing("المهمة");
      if (user.id !== "basem" && (task.owner !== user.name || task.status !== "progress")) return forbidden("يمكنك إضافة تحديث فقط على مهمة استلمتها وهي قيد التنفيذ");
      const result = await db().prepare("INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)").bind(taskId, user.name, comment, now).run();
      await audit(user, "comment", "task", taskId, `أضاف تعليق #${result.meta.last_row_id ?? "جديد"}`);
      waNotification = taskNotification("comment", task.title, user.name, comment.slice(0,300));
    } else if (action === "submit") {
      const taskId = text(body.taskId); const task = await taskById(taskId); if (!task) return missing("المهمة");
      if (user.id !== "basem" && task.owner !== user.name) return forbidden("المهمة ليست مستلمة باسمك");
      const result = await db().prepare("UPDATE tasks SET status = 'approval', rejection_reason = NULL, updated_at = ? WHERE id = ? AND status = 'progress'").bind(now, taskId).run();
      if (result.meta.changes === 0) return privateJson({ error: "حالة المهمة تغيّرت، حدّث الصفحة" }, { status: 409 });
      await audit(user, "submit", "task", taskId, "أرسل المهمة لاعتماد باسم");
      waNotification = taskNotification("submit", task.title, user.name);
    } else if (action === "approve") {
      const denied = requireAdmin(user); if (denied) return denied;
      const taskId = text(body.taskId); const task = await taskById(taskId); if (!task) return missing("المهمة");
      const result = await db().prepare("UPDATE tasks SET status = 'completed', completed_at = ?, rejection_reason = NULL, updated_at = ? WHERE id = ? AND status = 'approval'").bind(now, now, taskId).run();
      if (result.meta.changes === 0) return privateJson({ error: "المهمة ليست بانتظار الاعتماد" }, { status: 409 });
      await audit(user, "approve", "task", taskId, `اعتمد إنجاز المهمة: ${task.title}`);
      waNotification = taskNotification("approve", task.title, user.name);
    } else if (action === "reject") {
      const denied = requireAdmin(user); if (denied) return denied;
      const taskId = text(body.taskId); const reason = text(body.reason).trim();
      if (!reason) return bad("سبب الرفض مطلوب");
      const task = await taskById(taskId); if (!task) return missing("المهمة");
      const result = await db().prepare("UPDATE tasks SET status = 'progress', rejection_reason = ?, updated_at = ? WHERE id = ? AND status = 'approval'").bind(reason, now, taskId).run();
      if (result.meta.changes === 0) return privateJson({ error: "المهمة ليست بانتظار الاعتماد" }, { status: 409 });
      await audit(user, "reject", "task", taskId, `رفض الإنجاز وأعاده إلى ${task.owner ?? "المسؤول"}: ${reason}`);
      waNotification = taskNotification("reject", task.title, user.name, `السبب: ${reason}`);
    } else if (action === "archive_task") {
      const denied = requireAdmin(user); if (denied) return denied;
      const taskId = text(body.taskId); const task = await taskById(taskId); if (!task) return missing("المهمة");
      await db().prepare("UPDATE tasks SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL").bind(now, user.name, now, taskId).run();
      await audit(user, "archive", "task", taskId, `أرشف المهمة: ${task.title}`);
    } else if (action === "restore_task") {
      const denied = requireAdmin(user); if (denied) return denied;
      const taskId = text(body.taskId); const task = await taskById(taskId); if (!task) return missing("المهمة");
      await db().prepare("UPDATE tasks SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ?").bind(now, taskId).run();
      await audit(user, "restore", "task", taskId, `استرجع المهمة من الأرشيف: ${task.title}`);
    } else if (action === "delete_task") {
      const denied = requireAdmin(user); if (denied) return denied;
      const taskId = text(body.taskId); const task = await taskById(taskId); if (!task) return missing("المهمة");
      const files = await db().prepare("SELECT object_key AS objectKey FROM attachments WHERE task_id = ?").bind(taskId).all<{objectKey:string}>();
      await db().batch([
        db().prepare("DELETE FROM comments WHERE task_id = ?").bind(taskId),
        db().prepare("DELETE FROM attachments WHERE task_id = ?").bind(taskId),
        db().prepare("DELETE FROM tasks WHERE id = ?").bind(taskId),
      ]);
      await audit(user, "delete", "task", taskId, `حذف المهمة نهائياً: ${task.title}`);
      await Promise.allSettled(files.results.map(file => bucket().delete(file.objectKey)));
    } else if (action === "add_user") {
      const denied = requireAdmin(user); if (denied) return denied;
      const name = text(body.name).trim(); if (!name) return bad("اسم المستخدم مطلوب");
      const id = crypto.randomUUID(); const role = "member";
      await db().prepare("INSERT INTO users (id, name, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").bind(id, name, role, now, now).run();
      await audit(user, "create", "user", id, `أضاف المستخدم ${name}`);
    } else if (action === "update_user") {
      const denied = requireAdmin(user); if (denied) return denied;
      const userId = text(body.userId); const target = await db().prepare("SELECT id, name, role, active FROM users WHERE id = ?").bind(userId).first<{id:string;name:string;role:string;active:number}>();
      if (!target) return missing("المستخدم");
      const active = body.active === true || body.active === "true" ? 1 : 0; const role = target.id === "basem" ? "admin" : "member";
      if (target.id === user.id && (!active || role !== "admin")) return bad("لا يمكنك إيقاف أو إزالة صلاحية مدير حسابك الحالي");
      await db().prepare("UPDATE users SET active = ?, role = ?, updated_at = ? WHERE id = ?").bind(active, role, now, userId).run();
      if (!active) await db().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      await audit(user, "edit", "user", userId, `حدّث صلاحيات المستخدم ${target.name}`);
    } else if (action === "set_user_pin") {
      const denied = requireAdmin(user); if (denied) return denied;
      const userId = text(body.userId); const pin = body.pin;
      if (!validPin(pin)) return bad("الكود يجب أن يكون من 4 إلى 8 أرقام");
      const target = await db().prepare("SELECT id, name FROM users WHERE id = ?").bind(userId).first<{id:string;name:string}>(); if (!target) return missing("المستخدم");
      const result = await hashPin(pin);
      await db().prepare("UPDATE users SET pin_salt = ?, pin_hash = ?, updated_at = ? WHERE id = ?").bind(result.salt, result.hash, now, userId).run();
      if (userId !== user.id) await db().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      await audit(user, "pin_reset", "user", userId, `غيّر كود المستخدم ${target.name}`);
    } else if (action === "change_own_pin") {
      const oldPin = text(body.oldPin); const newPin = body.newPin;
      if (!validPin(newPin)) return bad("الكود الجديد يجب أن يكون من 4 إلى 8 أرقام");
      const record = await db().prepare("SELECT pin_salt AS pinSalt, pin_hash AS pinHash FROM users WHERE id = ?").bind(user.id).first<{pinSalt:string|null;pinHash:string|null}>();
      if (!record || !(await verifyPin(oldPin, record.pinSalt, record.pinHash))) return forbidden("الكود الحالي غير صحيح");
      const result = await hashPin(newPin);
      await db().prepare("UPDATE users SET pin_salt = ?, pin_hash = ?, updated_at = ? WHERE id = ?").bind(result.salt, result.hash, now, user.id).run();
      await audit(user, "pin_change", "user", user.id, "غيّر كود دخوله");
    } else {
      return bad("الطلب غير معروف");
    }

    if (waNotification) await notifyManagementGroup(waNotification).catch(error => console.error("WhatsApp notification failed", error));
    return loadState(user);
  } catch (error) {
    const message = error instanceof Error ? error.message : "تعذر حفظ التحديث";
    const status = message.includes("UNIQUE") ? 409 : 500;
    return privateJson({ error: status === 409 ? "الاسم مستخدم مسبقاً" : message }, { status });
  }
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function nullable(value: unknown) { const result = text(value).trim(); return result || null; }
function validPriority(value: unknown) { return value === "red" || value === "green" ? value : "yellow"; }
function bad(message: string) { return privateJson({ error: message }, { status: 400 }); }
function forbidden(message: string) { return privateJson({ error: message }, { status: 403 }); }
function missing(entity: string) { return privateJson({ error: `${entity} غير موجود` }, { status: 404 }); }
async function taskById(id: string) { return db().prepare("SELECT id, title, owner, suggested_owner AS suggestedOwner, status, started_at AS startedAt, archived_at AS archivedAt FROM tasks WHERE id = ?").bind(id).first<{id:string;title:string;owner:string|null;suggestedOwner:string|null;status:string;startedAt:number|null;archivedAt:number|null}>(); }
async function hasProgressAfterClaim(taskId: string, startedAt: number | null) {
  if (!startedAt) return false;
  const [comments, files] = await Promise.all([
    db().prepare("SELECT COUNT(*) AS count FROM comments WHERE task_id = ? AND created_at >= ?").bind(taskId, startedAt).first<{count:number}>(),
    db().prepare("SELECT COUNT(*) AS count FROM attachments WHERE task_id = ? AND created_at >= ?").bind(taskId, startedAt).first<{count:number}>(),
  ]);
  return (comments?.count ?? 0) > 0 || (files?.count ?? 0) > 0;
}
async function projectById(id: string) { return db().prepare("SELECT id, name, status FROM projects WHERE id = ?").bind(id).first<{id:string;name:string;status:string}>(); }
