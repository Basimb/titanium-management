import { db } from "@/lib/titanium-server";
import { notifyManagementGroup, whatsappConfigured } from "@/lib/whatsapp";

export async function POST(request:Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.TITANIUM_CRON_SECRET || secret !== process.env.TITANIUM_CRON_SECRET) return new Response("Forbidden", { status:403 });
  if (!whatsappConfigured()) return Response.json({ ok:true, skipped:"whatsapp_not_configured" });
  const today = new Date().toLocaleDateString("en-CA", { timeZone:"Asia/Amman" });
  const inserted = await db().prepare("INSERT OR IGNORE INTO reminder_runs (run_date, created_at) VALUES (?, ?)").bind(today,Date.now()).run();
  if (inserted.meta.changes === 0) return Response.json({ ok:true, skipped:"already_sent" });
  const overdue = await db().prepare("SELECT title, COALESCE(owner,suggested_owner) AS owner, due_date AS dueDate FROM tasks WHERE status != 'completed' AND archived_at IS NULL AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date LIMIT 25")
    .bind(today).all<{title:string;owner:string|null;dueDate:string}>();
  const dueToday = await db().prepare("SELECT title, COALESCE(owner,suggested_owner) AS owner FROM tasks WHERE status != 'completed' AND archived_at IS NULL AND due_date = ? ORDER BY title LIMIT 25")
    .bind(today).all<{title:string;owner:string|null}>();
  if (!overdue.results.length && !dueToday.results.length) return Response.json({ ok:true, sent:false });
  const sections=[];
  if (overdue.results.length) sections.push(`⏰ متأخرة (${overdue.results.length})\n${overdue.results.map((task,index)=>`${index+1}. ${task.title}${task.owner?` — ${task.owner}`:""} — ${task.dueDate}`).join("\n")}`);
  if (dueToday.results.length) sections.push(`📅 مستحقة اليوم (${dueToday.results.length})\n${dueToday.results.map((task,index)=>`${index+1}. ${task.title}${task.owner?` — ${task.owner}`:""}`).join("\n")}`);
  await notifyManagementGroup(`تذكير فريق إدارة تيتانيوم — ${today}\n\n${sections.join("\n\n")}\n\n${process.env.TITANIUM_PUBLIC_URL || "https://management.titanium-pharmacy.com/"}`);
  return Response.json({ ok:true, sent:true, overdue:overdue.results.length, dueToday:dueToday.results.length });
}
