// UI-only validation. The server remains authoritative for phone ownership,
// expiry, resend limits and code verification. Nothing here stores a secret.
export type WhatsAppLoginUser = { id: string; name: string };

export function publicWhatsAppLoginUsers(value: unknown): WhatsAppLoginUser[] {
  if (!Array.isArray(value) || value.length > 100) return [];
  const users: WhatsAppLoginUser[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const user = entry as Record<string, unknown>;
    if (typeof user.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(user.id) || seen.has(user.id)
      || typeof user.name !== "string" || !user.name.trim() || user.name.length > 160) return [];
    seen.add(user.id);
    // Copy the public contract only; never retain a phone or server metadata.
    users.push({ id: user.id, name: user.name.trim() });
  }
  return users;
}

export function latinDigits(value: string): string {
  return value.normalize("NFKC")
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x6f0));
}

export function internationalLoginPhone(value: string): string | null {
  const cleaned = latinDigits(value).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  if (!/^(?:\+|00)[\d\s().-]+$/.test(cleaned)) return null;
  const allDigits = cleaned.replace(/\D/g, "");
  const digits = cleaned.startsWith("00") ? allDigits.slice(2) : allDigits;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

export function loginCodeDigits(value: string): string {
  return latinDigits(value).replace(/\D/g, "").slice(0, 6);
}

export function secondsUntil(deadline: number, now: number): number {
  return Number.isFinite(deadline) && Number.isFinite(now) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

export function clockLabel(seconds: number): string {
  const remaining = Math.max(0, Math.floor(seconds));
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
}

export type LoginChallengeResponse = {
  accepted: true;
  challengeId: string;
  expiresInSeconds: number;
  retryAfterSeconds: number;
};

export function isLoginChallenge(value: unknown): value is LoginChallengeResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return response.accepted === true && typeof response.challengeId === "string"
    && /^[A-Za-z0-9_-]{16,200}$/.test(response.challengeId)
    && typeof response.expiresInSeconds === "number" && Number.isInteger(response.expiresInSeconds)
    && response.expiresInSeconds > 0 && response.expiresInSeconds <= 900
    && typeof response.retryAfterSeconds === "number" && Number.isInteger(response.retryAfterSeconds)
    && response.retryAfterSeconds >= 60 && response.retryAfterSeconds <= 900;
}

export type WhatsAppLoginSuccess = {
  authenticated: true;
  user: { id: string; name: string; role: "admin" | "member"; active: number };
  sessionToken?: string;
};

export function isWhatsAppLoginSuccess(value: unknown): value is WhatsAppLoginSuccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (response.authenticated !== true || !response.user || typeof response.user !== "object" || Array.isArray(response.user)) return false;
  const user = response.user as Record<string, unknown>;
  return typeof user.id === "string" && !!user.id && typeof user.name === "string" && !!user.name
    && (user.role === "admin" || user.role === "member") && user.active === 1
    && (response.sessionToken === undefined || (typeof response.sessionToken === "string" && response.sessionToken.length <= 1024));
}
