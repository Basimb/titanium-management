import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createWhatsAppLoginQueue, deriveLoginKey, normalizeLoginPhone } from "./whatsapp-login-queue.ts";

/**
 * Server-only OTP core; routes/session policy and live activation are external.
 *
 * Integration contract:
 * - contacts() is administrator-controlled configuration, NEVER request data.
 * - clientKey is a stable address/client bucket derived by trusted server/proxy
 *   configuration. Do not trust arbitrary X-Forwarded-For or supplied phone IDs.
 * - deliverOtp must send privately from the management account, never to a group,
 *   and acknowledge delivery acceptance. Never log its code or request body.
 * - Production must use deliveryMode:'durable': prepare atomically persists the
 *   verifier and AES-GCM queue, returns immediately, and deliver() is a no-op.
 *   A separate managed createWhatsAppLoginQueue worker on the same DB sends it.
 * - Return ONLY prepared.response with the same status/shape for every number.
 *   Legacy callback mode is for tests/managed in-memory delivery only; never
 *   fire-and-forget inside a Next request or await sending before HTTP response.
 * - Protect routes with same-origin/CSRF checks and global edge abuse controls.
 * - After verify succeeds, create the existing application session server-side;
 *   never treat a submitted user ID, name, or a WhatsApp reply as authentication.
 *
 * Verifiers/rate keys use HMAC; durable payloads use AES-256-GCM. HKDF separates
 * these keys from an independent random >=32-byte server secret, never in git.
 */

export type LoginContact = { userId: string; number: string };
export type LoginUser = { id: string; name: string; role: "admin" | "member"; active: number };
export type OtpPublicResponse = {
  accepted: true;
  challengeId: string;
  expiresInSeconds: 300;
  retryAfterSeconds: 60;
  message: string;
};
export type OtpDelivery = {
  to: string;
  code: string;
  challengeId: string;
  expiresAt: number;
  signal: AbortSignal;
};
export type OtpVerification = { ok: true; user: LoginUser } | { ok: false; message: string };

type OtpOptions = {
  db: DatabaseSync;
  secret: Uint8Array;
  contacts: () => readonly LoginContact[];
  deliverOtp?: (delivery: OtpDelivery) => Promise<void>;
  deliveryMode?: "memory" | "durable";
  now?: () => number;
  deliveryTimeoutMs?: number;
};

type Challenge = {
  challenge_id: string;
  phone_key: string;
  user_id: string | null;
  code_mac: string;
  state: string;
  attempts: number;
  expires_at: number;
};

const TTL = 5 * 60_000;
const COOLDOWN = 60_000;
const RATE_WINDOW = 15 * 60_000;
const INVALID = "الرمز غير صالح أو انتهت صلاحيته. اطلب رمزًا جديدًا عند الحاجة.";
const ACCEPTED = "إذا كان الرقم مسجّلًا ومفعّلًا، سيصلك رمز الدخول برسالة خاصة على واتساب.";

const normalizePhone = normalizeLoginPhone;

export function createWhatsAppLoginOtp(options: OtpOptions) {
  if (!(options.secret instanceof Uint8Array) || options.secret.byteLength < 32) {
    throw new Error("OTP requires an independent random server secret of at least 32 bytes.");
  }
  const secret = deriveLoginKey(options.secret, "verifier");
  const database = options.db;
  const now = options.now ?? Date.now;
  if (options.deliveryMode !== "durable" && typeof options.deliverOtp !== "function") {
    throw new Error("OTP requires durable delivery mode or a managed delivery callback.");
  }
  const timeoutMs = options.deliveryTimeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    throw new Error("OTP delivery timeout must be between 1 and 15000 milliseconds.");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_login_otp_challenges (
      challenge_id TEXT PRIMARY KEY NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose = 'login'),
      phone_key TEXT NOT NULL,
      user_id TEXT,
      code_mac TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','sent','consumed','failed','superseded','locked')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_login_otp_phone
      ON whatsapp_login_otp_challenges(phone_key, state);
    CREATE TABLE IF NOT EXISTS whatsapp_login_otp_rates (
      rate_key TEXT PRIMARY KEY NOT NULL,
      window_started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whatsapp_login_otp_cooldowns (
      phone_key TEXT PRIMARY KEY NOT NULL,
      next_allowed_at INTEGER NOT NULL
    );
  `);
  const durableQueue = options.deliveryMode === "durable"
    ? createWhatsAppLoginQueue({ db: database, secret: options.secret, contacts: options.contacts, now })
    : null;

  const mac = (...parts: (string | null)[]) =>
    createHmac("sha256", secret).update(JSON.stringify(parts)).digest("hex");
  const transaction = <T>(run: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  const validClient = (key: string) => typeof key === "string" && key.length > 0 && key.length <= 256;

  function consumeRate(scope: string, value: string, limit: number, at: number) {
    const key = mac("rate", scope, value);
    const prior = database.prepare("SELECT window_started_at, attempts FROM whatsapp_login_otp_rates WHERE rate_key = ?")
      .get(key) as { window_started_at: number; attempts: number } | undefined;
    const sameWindow = prior && at >= prior.window_started_at && at < prior.window_started_at + RATE_WINDOW;
    const attempts = sameWindow ? Math.min(prior.attempts + 1, 1_000_000) : 1;
    database.prepare(`INSERT INTO whatsapp_login_otp_rates (rate_key, window_started_at, attempts) VALUES (?, ?, ?)
      ON CONFLICT(rate_key) DO UPDATE SET window_started_at = excluded.window_started_at, attempts = excluded.attempts`)
      .run(key, sameWindow ? prior.window_started_at : at, attempts);
    return attempts <= limit;
  }

  function registeredUser(phone: string | null): LoginUser | null {
    if (!phone) return null;
    const matches = options.contacts().filter(contact => normalizePhone(contact.number) === phone);
    // Duplicate/ambiguous mappings are denied, even when the user ID repeats.
    if (matches.length !== 1) return null;
    const user = database.prepare("SELECT id, name, role, active FROM users WHERE id = ? AND active = 1")
      .get(matches[0].userId) as LoginUser | undefined;
    return user && (user.role === "member" || user.role === "admin")
      ? { id: user.id, name: user.name, role: user.role, active: user.active }
      : null;
  }

  function prepare(input: { phone: string; clientKey: string }) {
    const challengeId = randomBytes(32).toString("base64url");
    const response: OtpPublicResponse = {
      accepted: true, challengeId, expiresInSeconds: 300, retryAfterSeconds: 60, message: ACCEPTED,
    };
    const phone = typeof input.phone === "string" ? normalizePhone(input.phone) : null;
    const client = validClient(input.clientKey) ? input.clientKey : null;
    const phoneKey = mac("phone", phone ?? "invalid");
    const at = now();
    const expiresAt = at + TTL;
    let code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    let user: LoginUser | null = null;
    const prepared = transaction(() => {
      // These tables contain only disposable OTP/rate state, not account data.
      durableQueue?.pruneInTransaction(at);
      database.prepare("DELETE FROM whatsapp_login_otp_challenges WHERE expires_at <= ?").run(at);
      database.prepare("DELETE FROM whatsapp_login_otp_rates WHERE window_started_at <= ?").run(at - RATE_WINDOW);
      database.prepare("DELETE FROM whatsapp_login_otp_cooldowns WHERE next_allowed_at <= ?").run(at);
      const clientAllowed = consumeRate("request-client", client ?? "invalid", 30, at);
      const phoneAllowed = consumeRate("request-phone", phoneKey, 3, at);
      const cooldown = database.prepare("SELECT next_allowed_at FROM whatsapp_login_otp_cooldowns WHERE phone_key = ?")
        .get(phoneKey) as { next_allowed_at: number } | undefined;
      if (!client || !phone || !clientAllowed || !phoneAllowed || (cooldown && cooldown.next_allowed_at > at)) return false;
      user = registeredUser(phone);
      database.prepare("UPDATE whatsapp_login_otp_challenges SET state = 'superseded' WHERE phone_key = ? AND state IN ('pending','sent')")
        .run(phoneKey);
      durableQueue?.pruneInTransaction(at);
      database.prepare(`INSERT INTO whatsapp_login_otp_challenges
        (challenge_id, purpose, phone_key, user_id, code_mac, state, attempts, created_at, expires_at)
        VALUES (?, 'login', ?, ?, ?, 'pending', 0, ?, ?)`)
        .run(challengeId, phoneKey, user?.id ?? null, mac("login", challengeId, phoneKey, user?.id ?? null, code), at, expiresAt);
      if (durableQueue && user) {
        durableQueue.enqueueInTransaction({ challengeId, to: phone, userId: user.id, code, expiresAt });
      }
      database.prepare(`INSERT INTO whatsapp_login_otp_cooldowns (phone_key, next_allowed_at) VALUES (?, ?)
        ON CONFLICT(phone_key) DO UPDATE SET next_allowed_at = excluded.next_allowed_at`).run(phoneKey, at + COOLDOWN);
      return true;
    });
    const userId: string | null = (user as LoginUser | null)?.id ?? null;
    if (!prepared || !userId || durableQueue) code = "";
    let deliveryPromise: Promise<void> | null = null;

    async function performDelivery(): Promise<void> {
      if (durableQueue) return;
      const active = database.prepare("SELECT state, expires_at FROM whatsapp_login_otp_challenges WHERE challenge_id = ?")
        .get(challengeId) as { state: string; expires_at: number } | undefined;
      if (!prepared || !phone || !code || !userId || !active || active.state !== "pending" || active.expires_at <= now()
        || registeredUser(phone)?.id !== userId) {
        code = "";
        database.prepare("UPDATE whatsapp_login_otp_challenges SET state = 'failed' WHERE challenge_id = ? AND state = 'pending'").run(challengeId);
        return;
      }
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => options.deliverOtp!({ to: phone, code, challengeId, expiresAt, signal: controller.signal })),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => { controller.abort(); reject(new Error("OTP delivery unavailable")); }, timeoutMs);
          }),
        ]);
        // A timeout, stale mapping, newer code, or expiry cannot become usable.
        const stillSameUser = registeredUser(phone)?.id === userId;
        database.prepare(`UPDATE whatsapp_login_otp_challenges SET state = ?
          WHERE challenge_id = ? AND state = 'pending'`)
          .run(stillSameUser && now() < expiresAt ? "sent" : "failed", challengeId);
      } catch {
        database.prepare("UPDATE whatsapp_login_otp_challenges SET state = 'failed' WHERE challenge_id = ? AND state = 'pending'").run(challengeId);
        // Do not expose or log provider errors: they can contain an OTP or phone.
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        code = "";
      }
    }
    return {
      response,
      // Repeated/concurrent invocations do not send the same challenge twice.
      deliver: () => deliveryPromise ??= performDelivery(),
    };
  }

  function verify(input: { challengeId: string; phone: string; code: string; clientKey: string }): OtpVerification {
    const phone = typeof input.phone === "string" ? normalizePhone(input.phone) : null;
    const client = validClient(input.clientKey) ? input.clientKey : null;
    const phoneKey = mac("phone", phone ?? "invalid");
    const invalid = (): OtpVerification => ({ ok: false, message: INVALID });
    const at = now();
    return transaction(() => {
      const clientAllowed = consumeRate("verify-client", client ?? "invalid", 60, at);
      const phoneAllowed = consumeRate("verify-phone", phoneKey, 10, at);
      if (!client || !phone || !clientAllowed || !phoneAllowed
        || typeof input.challengeId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.challengeId)) return invalid();
      const challenge = database.prepare("SELECT * FROM whatsapp_login_otp_challenges WHERE challenge_id = ? AND purpose = 'login'")
        .get(input.challengeId) as Challenge | undefined;
      if (!challenge || challenge.phone_key !== phoneKey || challenge.state !== "sent"
        || challenge.expires_at <= at || challenge.attempts >= 5) return invalid();
      const attempts = challenge.attempts + 1;
      database.prepare("UPDATE whatsapp_login_otp_challenges SET attempts = ? WHERE challenge_id = ?").run(attempts, input.challengeId);
      const boundedCode = typeof input.code === "string" && /^\d{6}$/.test(input.code) ? input.code : "invalid";
      const expected = Buffer.from(challenge.code_mac, "hex");
      const actual = Buffer.from(mac("login", input.challengeId, phoneKey, challenge.user_id, boundedCode), "hex");
      const matched = expected.length === actual.length && timingSafeEqual(expected, actual);
      const user = registeredUser(phone);
      if (!matched || !user || user.id !== challenge.user_id) {
        if (attempts >= 5 || !user || user.id !== challenge.user_id) {
          database.prepare("UPDATE whatsapp_login_otp_challenges SET state = 'locked' WHERE challenge_id = ?").run(input.challengeId);
        }
        return invalid();
      }
      database.prepare("UPDATE whatsapp_login_otp_challenges SET state = 'consumed' WHERE challenge_id = ? AND state = 'sent'")
        .run(input.challengeId);
      return { ok: true, user };
    });
  }

  return { prepare, verify };
}
