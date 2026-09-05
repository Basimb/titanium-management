import assert from "node:assert/strict";
import test from "node:test";
import { CONVERSATION_NO_CHANGE_REPLY, isDiscussionOnlyRequest, safeConversationalReply } from "../lib/secretary-conversation-policy.ts";

test("non-mutating chat cannot assert obvious completed task writes", () => {
  for (const reply of [
    "أضفت المهمة الجديدة للمشروع.", "✅ عدّلت الموعد لبكرا.", "سجلتلك التحديث على المهمة.",
    "حذفتها.", "خلصتلك، المهمة جاهزة.", "أنا اعتمدت إنجاز المهمة.",
    "جدولت التذكير للساعة تسعة.", "تمت إضافة التعليق.", "تم اعتماد المهمة.",
    "أضفتها، بدك شيء ثاني؟", "لم أحذفها، لكن أضفت التعليق.", "لم أحذفها لكن أضفت التعليق.",
    "لا تقلق، غيرت المسؤول.", "«ما غيرت المهمة» لكن عدّلت الموعد.",
  ]) assert.equal(safeConversationalReply(reply), CONVERSATION_NO_CHANGE_REPLY, reply);
});

test("negations, questions and ordinary timeless conversation survive verb checks", () => {
  for (const reply of [
    "ما غيّرت المهمة.", "لم أضف أي تعليق.", "ما أنا اللي حذفتها.",
    "هل أضفت المهمة؟", "سجلت التحديث؟", "كيف عدلت المهمة؟", "ليش تم حذف المهمة؟",
    "التذكير يحتاج موعدًا واضحًا.", "غيّرت رأيي؛ الأفضل نبدأ بالأولوية العالية.",
    "أضفت مثالين للصياغة، اختار اللي بناسبك.", "لم يتم اعتماد المهمة بعد.", "لم تتم إضافة التعليق.",
    "أهلًا يا خالد، كيف أقدر أساعدك؟", "", "أنا جاهز أساعدك في ترتيب أفكارك.",
  ]) assert.equal(safeConversationalReply(reply), reply, reply);
});

test("quoted drafts are preserved but cannot hide an external execution claim", () => {
  for (const reply of [
    "صياغة مقترحة: «أضفت التعليق على المهمة». لم أرسلها لأحد.",
    'ممكن تكتب: "اعتمدت المهمة" إذا كان الاعتماد حصل فعلًا.',
    "مسودة:\n```\nأضفت المهمة.\n```\nراجعها قبل الإرسال.",
    "هل تقصد «حذفت المهمة» أم «أرشفتها»؟", "أنت قلت: أضفت المهمة.",
  ]) assert.equal(safeConversationalReply(reply), reply, reply);
  assert.equal(safeConversationalReply("هذه الصياغة: «أضفت المهمة». وأنا سجلت التعليق بالموقع."), CONVERSATION_NO_CHANGE_REPLY);
});

test("discussion framing blocks only high-confidence explanation, hypothetical and draft requests", () => {
  for (const text of [
    "كيف أضيف مهمة؟", "شو رأيك نغيّر الموعد؟", "ما رأيك بالجدول؟", "لو خلصت المهمة شو بتعمل؟",
    "هل يمكن حذف المشروع؟", "هل ممكن أعدلها؟", "اشرحلي شو يعني بانتظار الاعتماد",
    "بدي أفهم ليش المهمة متأخرة", "اكتب لي صياغة: «خلصت المهمة»", "جهز مسودة رسالة للفريق",
    "مثال: احذف المهمة", "«احذف المهمة»", '"سجل تعليق أني خلصت"',
  ]) assert.equal(isDiscussionOnlyRequest(text), true, text);
});

test("real updates remain actionable even when their comment body contains negation or questions", () => {
  for (const text of [
    "سجل تعليق: ما رد المورد لسه", "أضف تحديث: لو وصل الشحن بنتابع", "اكتب تعليق على المهمة: وين وصل المورد؟",
    "حدث المهمة بأننا لم نستلم القطع", "سجل عليها: «هل يمكن تأجيل التوريد؟»", "لو سمحت أضف مهمة الجرد",
    "كيف أعدل الموعد؟ عدل المهمة لبكرا", "شو رأيك؟ سجل تعليق أن المورد تأخر", "خلصت المهمة بالكامل",
    "أنا خالد", "كيفك", "", "سجل تعليق: ناقص قطعة ولسه ما خلصنا",
  ]) assert.equal(isDiscussionOnlyRequest(text), false, text);
});
