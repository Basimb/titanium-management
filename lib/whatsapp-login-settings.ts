import path from "node:path";
import type { LoginContact } from "./whatsapp-login-otp.ts";

export function whatsappLoginSettings(settings: Record<string, string | undefined>) {
  const mode = settings.WHATSAPP_LOGIN_ENABLED || "0";
  if (!["0", "pilot", "1"].includes(mode)) throw new Error("Login settings unavailable.");
  if (mode === "0") return { enabled: false as const, replacePin: false as const };
  const key = settings.WHATSAPP_LOGIN_SECRET || "";
  if (!/^[a-fA-F0-9]{64}$/.test(key) || key.toLowerCase() === settings.TEAM_CHAT_SHARED_KEY?.toLowerCase()) {
    throw new Error("Login settings unavailable.");
  }
  const databasePath = settings.WHATSAPP_LOGIN_DATABASE || "";
  if (!path.isAbsolute(databasePath)) throw new Error("Login settings unavailable.");
  const origin = settings.WHATSAPP_LOGIN_ORIGIN || "";
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Login settings unavailable.");
  const contacts: LoginContact[] = JSON.parse(settings.TEAM_CHAT_CONTACTS_JSON || "[]");
  if (!Array.isArray(contacts) || !contacts.length || contacts.length > 100 || contacts.some(contact =>
    !contact || typeof contact.userId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(contact.userId)
    || typeof contact.number !== "string" || !/^\+?[1-9]\d{7,14}$/.test(contact.number))) {
    throw new Error("Login settings unavailable.");
  }
  return { enabled: true as const, replacePin: mode === "1", secret: Buffer.from(key, "hex"), databasePath, origin, contacts };
}
