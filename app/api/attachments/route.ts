import { audit, bucket, db, requireSession } from "@/lib/titanium-server";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

export async function POST(request: Request) {
  try {
    const auth = await requireSession(request); if (auth.response) return auth.response;
    const form = await request.formData();
    const taskId = typeof form.get("taskId") === "string" ? String(form.get("taskId")) : "";
    const file = form.get("file");
    if (!taskId || !(file instanceof File)) return Response.json({ error: "اختر الملف والمهمة" }, { status: 400 });
    if (!file.size || file.size > MAX_FILE_SIZE) return Response.json({ error: "حجم الملف يجب ألا يتجاوز 10 ميجابايت" }, { status: 400 });
    if (!allowedTypes.has(file.type)) return Response.json({ error: "نوع الملف غير مدعوم" }, { status: 400 });
    const task = await db().prepare("SELECT id, title, owner, status FROM tasks WHERE id = ? AND archived_at IS NULL").bind(taskId).first<{id:string;title:string;owner:string|null;status:string}>();
    if (!task) return Response.json({ error: "المهمة غير موجودة أو مؤرشفة" }, { status: 404 });
    if (auth.user!.id !== "basem" && (task.owner !== auth.user!.name || task.status !== "progress")) return Response.json({ error: "يمكنك إرفاق ملف فقط بمهمة استلمتها وهي قيد التنفيذ" }, { status: 403 });
    const id = crypto.randomUUID();
    const safeName = file.name.replace(/[\r\n/\\]/g, "_").slice(0, 180) || "ملف";
    const objectKey = `tasks/${taskId}/${id}`;
    await bucket().put(objectKey, await file.arrayBuffer(), { httpMetadata: { contentType:file.type } });
    await db().prepare("INSERT INTO attachments (id, task_id, file_name, content_type, size, object_key, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, taskId, safeName, file.type, file.size, objectKey, auth.user!.name, Date.now()).run();
    await audit(auth.user!, "upload", "task", taskId, `أرفق الملف ${safeName} بالمهمة ${task.title}`);
    return Response.json({ ok:true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "تعذر رفع الملف" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const auth = await requireSession(request); if (auth.response) return auth.response;
    const id = new URL(request.url).searchParams.get("id") || "";
    const attachment = await db().prepare("SELECT id, task_id AS taskId, file_name AS fileName, content_type AS contentType, object_key AS objectKey FROM attachments WHERE id = ?")
      .bind(id).first<{id:string;taskId:string;fileName:string;contentType:string;objectKey:string}>();
    if (!attachment) return Response.json({ error: "الملف غير موجود" }, { status: 404 });
    const object = await bucket().get(attachment.objectKey);
    if (!object) return Response.json({ error: "محتوى الملف غير موجود" }, { status: 404 });
    const encodedName = encodeURIComponent(attachment.fileName);
    return new Response(object.body, { headers: {
      "content-type": attachment.contentType,
      "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
      "cache-control": "private, no-store",
    } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "تعذر تنزيل الملف" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireSession(request); if (auth.response) return auth.response;
    const body = await request.json() as { id?: string };
    const attachment = await db().prepare("SELECT id, task_id AS taskId, file_name AS fileName, object_key AS objectKey, uploaded_by AS uploadedBy FROM attachments WHERE id = ?")
      .bind(body.id || "").first<{id:string;taskId:string;fileName:string;objectKey:string;uploadedBy:string}>();
    if (!attachment) return Response.json({ error: "الملف غير موجود" }, { status: 404 });
    if (auth.user!.id !== "basem") return Response.json({ error: "حذف الملفات متاح لباسم فقط" }, { status: 403 });
    await db().prepare("DELETE FROM attachments WHERE id = ?").bind(attachment.id).run();
    await bucket().delete(attachment.objectKey);
    await audit(auth.user!, "delete_attachment", "task", attachment.taskId, `حذف الملف ${attachment.fileName}`);
    return Response.json({ ok:true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "تعذر حذف الملف" }, { status: 500 });
  }
}
