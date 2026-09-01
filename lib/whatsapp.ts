import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_VERSION = process.env.META_WA_GRAPH_VERSION || "v23.0";

// Kept only in the server environment; never commit personal numbers to GitHub.
export const BASIM_WHATSAPP = normalizeWhatsAppNumber(process.env.META_WA_ADMIN_NUMBER || "");

export function whatsappConfigured() {
  return process.env.WHATSAPP_ENABLED === "1" && Boolean(process.env.META_WA_ACCESS_TOKEN && process.env.META_WA_PHONE_NUMBER_ID);
}

export function normalizeWhatsAppNumber(value: string) {
  return value.replace(/\D/g, "").replace(/^00/, "");
}

export function verifyMetaSignature(rawBody:string, signature:string|null) {
  const secret = process.env.META_WA_APP_SECRET;
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
  const received = Buffer.from(signature.slice(7), "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export async function sendWhatsAppText(to:string, body:string, group = false) {
  if (!whatsappConfigured()) return { skipped:true };
  const phoneId = process.env.META_WA_PHONE_NUMBER_ID!;
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
    method:"POST",
    headers:{ authorization:`Bearer ${process.env.META_WA_ACCESS_TOKEN}`, "content-type":"application/json" },
    body:JSON.stringify({ messaging_product:"whatsapp", recipient_type:group ? "group" : "individual", to, type:"text", text:{ body, preview_url:false } }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WhatsApp ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

export async function notifyManagementGroup(body:string) {
  const groupId = process.env.META_WA_GROUP_ID;
  if (!groupId) return { skipped:true };
  return sendWhatsAppText(groupId, body, true);
}

export function taskNotification(action:string, taskTitle:string, actor:string, extra = "") {
  const labels:Record<string,string> = {
    create:"مهمة جديدة", claim:"تم استلام المهمة", submit:"بانتظار اعتماد باسم",
    approve:"تم اعتماد المهمة", reject:"تم رفض الإنجاز", reassign:"تم تعيين المسؤول",
    comment:"تحديث جديد", archive:"تمت أرشفة المهمة",
  };
  return `📌 ${labels[action] || "تحديث مهمة"}\n${taskTitle}\nبواسطة: ${actor}${extra ? `\n${extra}` : ""}\n${process.env.TITANIUM_PUBLIC_URL || "https://management.titanium-pharmacy.com/"}`;
}
