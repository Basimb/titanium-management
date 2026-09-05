import { handleTeamChatRequest, teamChatConfigFromEnv } from "@/lib/team-chat-gateway";
import { chatDatabase } from "@/lib/titanium-server";
import { readTeamChatSettings } from "@/lib/team-chat-settings";
import { inferWhatsAppIntent } from "@/lib/whatsapp-intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const settings = readTeamChatSettings();
    return handleTeamChatRequest(request, {
      config: teamChatConfigFromEnv(settings), getDatabase: chatDatabase,
      infer: input => inferWhatsAppIntent(input, { apiKey: settings.GROQ_API_KEY, model: settings.GROQ_MODEL }),
    });
  } catch {
    return Response.json({ error: "Team chat settings unavailable." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
}
