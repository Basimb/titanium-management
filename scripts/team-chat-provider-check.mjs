// Run on the server with TITANIUM_TEAM_CHAT_CONFIG pointing to the private file:
// node --experimental-strip-types scripts/team-chat-provider-check.mjs
// One synthetic provider request only. No database, WhatsApp, phone or real user.
let failure = "provider_check_failed";
try {
  const [{ readTeamChatSettings }, { inferWhatsAppIntent }] = await Promise.all([
    import("../lib/team-chat-settings.ts"),
    import("../lib/whatsapp-intent.ts"),
  ]);
  failure = "settings_unavailable";
  const settings = readTeamChatSettings();
  const apiKey = settings.GROQ_API_KEY?.trim();
  if (!apiKey) {
    failure = "missing_api_key";
    throw new Error("configuration");
  }
  failure = "provider_check_failed";
  // IntentInput has no user/phone field. All supplied text and task data are fake.
  const intent = await inferWhatsAppIntent({
    text: "أنا موظف الاختبار التجريبي. خلصت تجهيز تقرير تجريبي بالكامل.",
    tasks: [{
      id: "synthetic-provider-check-task",
      title: "تجهيز تقرير تجريبي",
      projectName: "مشروع اختبار تقني تجريبي",
      status: "progress",
      dueDate: null,
    }],
    history: [],
  }, { apiKey, ...(settings.GROQ_MODEL ? { model: settings.GROQ_MODEL } : {}) });
  // Completion means requesting manager approval, not final task completion.
  const ok = intent.action === "submit" && intent.taskId === "synthetic-provider-check-task" && intent.question === null;
  process.stdout.write(`${JSON.stringify({ ok, intent: intent.action, ...(!ok ? { error: "unexpected_intent" } : {}) })}\n`);
  if (!ok) process.exitCode = 1;
} catch (error) {
  // Match only known safe categories; never print arbitrary errors, paths, keys,
  // model prose or a raw provider response. The parser provides its own timeout.
  const safeErrors = new Map([
    ["WhatsApp intent service timed out.", "provider_timeout"],
    ["WhatsApp intent service is temporarily rate limited.", "provider_rate_limited"],
    ["WhatsApp intent service is unavailable.", "provider_unavailable"],
    ["WhatsApp intent service returned an invalid result.", "invalid_provider_result"],
    ["WhatsApp intent model configuration is invalid.", "invalid_model_configuration"],
  ]);
  const safeError = error instanceof Error ? safeErrors.get(error.message) ?? failure : failure;
  process.stdout.write(`${JSON.stringify({ ok: false, error: safeError })}\n`);
  process.exitCode = 1;
}
