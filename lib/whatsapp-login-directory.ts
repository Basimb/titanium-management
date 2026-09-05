import type { DatabaseSync } from "node:sqlite";
import type { LoginContact } from "./whatsapp-login-otp.ts";
import { normalizeLoginPhone } from "./whatsapp-login-queue.ts";

export type WhatsAppLoginName = { id: string; name: string };

// Read only administrator-managed mappings. Never accept a destination from
// the browser, and never include destinations in the public name directory.
export function whatsappLoginPhoneForUser(database: DatabaseSync, contacts: readonly LoginContact[], userId: unknown): string {
  if (typeof userId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(userId)) return "";
  const matches = contacts.filter(contact => contact.userId === userId);
  if (matches.length !== 1) return "";
  const phone = normalizeLoginPhone(matches[0].number);
  if (!phone || contacts.filter(contact => normalizeLoginPhone(contact.number) === phone).length !== 1) return "";
  const user = database.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role IN ('admin', 'member')").get(userId);
  return user ? phone : "";
}

export function whatsappLoginNames(database: DatabaseSync, contacts: readonly LoginContact[]): WhatsAppLoginName[] {
  const users = database.prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('admin', 'member') ORDER BY CASE WHEN id = 'basem' THEN 0 ELSE 1 END, name, id")
    .all() as WhatsAppLoginName[];
  return users.filter(user => whatsappLoginPhoneForUser(database, contacts, user.id))
    .map(user => ({ id: user.id, name: user.name }));
}
