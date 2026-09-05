import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { LoginContact, OtpDelivery } from "./whatsapp-login-otp.ts";

/** Server-only durable private OTP delivery. Never expose this worker API via a
 * browser route, log its decrypted payload, or route it through the task LLM.
 * SQLite must be the same website database, on a private durable local filesystem.
 * An ambiguous/crashed send fails closed; there are no automatic OTP send retries.
 */
export type LoginQueueClaim = { challengeId: string; leaseId: string };
type QueuePayload = {
  version: 1; purpose: "login"; challengeId: string;
  to: string; userId: string; code: string; expiresAt: number;
};
type QueueRow = {
  challenge_id: string; encrypted_payload: string | null; state: string;
  lease_id: string | null; lease_until: number | null; expires_at: number;
};
type QueueOptions = {
  db: DatabaseSync; secret: Uint8Array; contacts: () => readonly LoginContact[];
  now?: () => number; leaseMs?: number; sendTimeoutMs?: number;
};

export function normalizeLoginPhone(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const ascii = input.replace(/[٠-٩۰-۹]/g, digit =>
    String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660)));
  if (!/^[+\d\s().-]+$/.test(ascii)) return null;
  const normalized = ascii.replace(/\D/g, "").replace(/^00/, "");
  return /^[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}

export function deriveLoginKey(secret: Uint8Array, purpose: "verifier" | "queue") {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new Error("OTP requires an independent random server secret of at least 32 bytes.");
  }
  return Buffer.from(hkdfSync("sha256", secret, "titanium-whatsapp-login-v1", purpose, 32));
}

export function createWhatsAppLoginQueue(options: QueueOptions) {
  const database = options.db;
  const now = options.now ?? Date.now;
  const cipherKey = deriveLoginKey(options.secret, "queue");
  const verifierKey = deriveLoginKey(options.secret, "verifier");
  const leaseMs = options.leaseMs ?? 30_000;
  const timeoutMs = options.sendTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 60_000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= leaseMs) {
    throw new Error("Invalid OTP delivery timing configuration.");
  }
  database.exec(`CREATE TABLE IF NOT EXISTS whatsapp_login_otp_queue (
    challenge_id TEXT PRIMARY KEY NOT NULL,
    encrypted_payload TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued','claimed','sending','sent','failed')),
    lease_id TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_whatsapp_login_otp_queue_ready
    ON whatsapp_login_otp_queue(state, created_at);`);

  const mac = (...parts: (string | null)[]) =>
    createHmac("sha256", verifierKey).update(JSON.stringify(parts)).digest("hex");
  const transaction = <T>(run: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try { const result = run(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  };
  const hasChallenges = () => !!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_login_otp_challenges'").get();

  function encrypt(payload: QueuePayload) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", cipherKey, iv);
    cipher.setAAD(Buffer.from(`titanium-login-queue-v1:${payload.challengeId}`));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), bytes.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
  }

  function decrypt(row: QueueRow): QueuePayload | null {
    try {
      const parts = row.encrypted_payload?.split(".");
      if (!parts || parts.length !== 4 || parts[0] !== "v1" || parts.some(part => part.length > 4096)) return null;
      const iv = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[3], "base64url");
      if (iv.length !== 12 || tag.length !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", cipherKey, iv);
      decipher.setAAD(Buffer.from(`titanium-login-queue-v1:${row.challenge_id}`));
      decipher.setAuthTag(tag);
      const bytes = Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]);
      const payload = JSON.parse(bytes.toString("utf8")) as QueuePayload;
      if (!payload || payload.version !== 1 || payload.purpose !== "login"
        || payload.challengeId !== row.challenge_id || payload.expiresAt !== row.expires_at
        || typeof payload.to !== "string" || !/^[1-9]\d{7,14}$/.test(payload.to)
        || typeof payload.userId !== "string" || !payload.userId || payload.userId.length > 100
        || typeof payload.code !== "string" || !/^\d{6}$/.test(payload.code)) return null;
      return payload;
    } catch { return null; }
  }

  function validPayload(payload: QueuePayload, at: number): boolean {
    if (payload.expiresAt <= at) return false;
    const mapped = options.contacts().filter(contact => normalizeLoginPhone(contact.number) === payload.to);
    if (mapped.length !== 1 || mapped[0].userId !== payload.userId) return false;
    const user = database.prepare("SELECT id, role FROM users WHERE id = ? AND active = 1").get(payload.userId) as { id: string; role: string } | undefined;
    if (!user || !["member", "admin"].includes(user.role)) return false;
    const challenge = database.prepare(`SELECT phone_key, user_id, code_mac, state, expires_at
      FROM whatsapp_login_otp_challenges WHERE challenge_id = ? AND purpose = 'login'`).get(payload.challengeId) as
      { phone_key: string; user_id: string; code_mac: string; state: string; expires_at: number } | undefined;
    const phoneKey = mac("phone", payload.to);
    if (!challenge || challenge.state !== "pending" || challenge.user_id !== payload.userId
      || challenge.phone_key !== phoneKey || challenge.expires_at !== payload.expiresAt) return false;
    const expected = Buffer.from(challenge.code_mac, "hex");
    const actual = Buffer.from(mac("login", payload.challengeId, phoneKey, payload.userId, payload.code), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function fail(challengeId: string) {
    if (hasChallenges()) database.prepare("UPDATE whatsapp_login_otp_challenges SET state = 'failed' WHERE challenge_id = ? AND state = 'pending'").run(challengeId);
    database.prepare(`UPDATE whatsapp_login_otp_queue SET state = 'failed', encrypted_payload = NULL,
      lease_id = NULL, lease_until = NULL WHERE challenge_id = ? AND state IN ('queued','claimed','sending')`).run(challengeId);
  }

  /** Internal to the core's transaction. Calling this never starts/commits one. */
  function pruneInTransaction(at = now()) {
    const rows = database.prepare(`SELECT challenge_id FROM whatsapp_login_otp_queue
      WHERE state IN ('queued','claimed','sending') AND
        (expires_at <= ? OR (state IN ('claimed','sending') AND lease_until <= ?))`).all(at, at) as { challenge_id: string }[];
    for (const row of rows) fail(row.challenge_id);
    if (hasChallenges()) {
      // Resending invalidates and scrubs any older queued/in-flight verifier.
      const stale = database.prepare(`SELECT q.challenge_id FROM whatsapp_login_otp_queue q
        LEFT JOIN whatsapp_login_otp_challenges c ON c.challenge_id = q.challenge_id
        WHERE q.state IN ('queued','claimed','sending') AND (c.challenge_id IS NULL OR c.state != 'pending')`).all() as { challenge_id: string }[];
      for (const row of stale) fail(row.challenge_id);
    }
    database.prepare("DELETE FROM whatsapp_login_otp_queue WHERE expires_at <= ?").run(at);
  }

  /** INTERNAL: invoked synchronously after verifier INSERT in its SAME transaction.
   * Not a standalone enqueue API. Failure must propagate so both inserts roll back.
   */
  function enqueueInTransaction(input: { challengeId: string; to: string; userId: string; code: string; expiresAt: number }) {
    const payload: QueuePayload = { version: 1, purpose: "login", ...input };
    if (!validPayload(payload, now())) throw new Error("OTP could not be queued.");
    database.prepare(`INSERT INTO whatsapp_login_otp_queue
      (challenge_id, encrypted_payload, state, lease_id, lease_until, created_at, expires_at)
      VALUES (?, ?, 'queued', NULL, NULL, ?, ?)`).run(input.challengeId, encrypt(payload), now(), input.expiresAt);
  }

  function claim(): LoginQueueClaim | null {
    return transaction(() => {
      pruneInTransaction();
      if (!hasChallenges()) return null;
      for (let scanned = 0; scanned < 30; scanned++) {
        const row = database.prepare("SELECT * FROM whatsapp_login_otp_queue WHERE state = 'queued' ORDER BY created_at, challenge_id LIMIT 1").get() as QueueRow | undefined;
        if (!row) return null;
        const payload = decrypt(row);
        if (!payload || !validPayload(payload, now())) { fail(row.challenge_id); continue; }
        const leaseId = randomBytes(32).toString("base64url");
        database.prepare("UPDATE whatsapp_login_otp_queue SET state = 'claimed', lease_id = ?, lease_until = ? WHERE challenge_id = ? AND state = 'queued'")
          .run(leaseId, now() + leaseMs, row.challenge_id);
        return { challengeId: row.challenge_id, leaseId };
      }
      return null;
    });
  }

  /** Read plaintext only immediately before one private send. A second call is denied. */
  function beginSend(lease: LoginQueueClaim): Omit<OtpDelivery, "signal"> | null {
    return transaction(() => {
      pruneInTransaction();
      const row = database.prepare("SELECT * FROM whatsapp_login_otp_queue WHERE challenge_id = ? AND lease_id = ? AND state = 'claimed'")
        .get(lease.challengeId, lease.leaseId) as QueueRow | undefined;
      if (!row) return null;
      const payload = decrypt(row);
      if (!payload || !validPayload(payload, now())) { fail(row.challenge_id); return null; }
      database.prepare("UPDATE whatsapp_login_otp_queue SET state = 'sending' WHERE challenge_id = ? AND lease_id = ? AND state = 'claimed'")
        .run(lease.challengeId, lease.leaseId);
      return { to: payload.to, code: payload.code, challengeId: payload.challengeId, expiresAt: payload.expiresAt };
    });
  }

  /** accepted=true only after the private sender acknowledged acceptance. */
  function ack(lease: LoginQueueClaim, accepted: boolean): boolean {
    return transaction(() => {
      pruneInTransaction();
      const row = database.prepare("SELECT * FROM whatsapp_login_otp_queue WHERE challenge_id = ? AND lease_id = ? AND state IN ('claimed','sending')")
        .get(lease.challengeId, lease.leaseId) as QueueRow | undefined;
      if (!row) return false;
      const payload = decrypt(row);
      if (accepted !== true || row.state !== "sending" || !payload || !validPayload(payload, now())) { fail(row.challenge_id); return false; }
      const changed = database.prepare("UPDATE whatsapp_login_otp_challenges SET state = 'sent' WHERE challenge_id = ? AND state = 'pending'").run(lease.challengeId);
      if (Number(changed.changes) !== 1) { fail(row.challenge_id); return false; }
      database.prepare(`UPDATE whatsapp_login_otp_queue SET state = 'sent', encrypted_payload = NULL,
        lease_id = NULL, lease_until = NULL WHERE challenge_id = ? AND lease_id = ? AND state = 'sending'`).run(lease.challengeId, lease.leaseId);
      return true;
    });
  }

  async function deliverNext(send: (delivery: OtpDelivery) => Promise<void>): Promise<{ status: "idle" | "sent" | "failed" }> {
    let lease: LoginQueueClaim | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      lease = claim();
      if (!lease) return { status: "idle" };
      const delivery = beginSend(lease);
      if (!delivery) return { status: "failed" };
      const controller = new AbortController();
      await Promise.race([
        Promise.resolve().then(() => send({ ...delivery, signal: controller.signal })),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("OTP delivery unavailable.")); }, timeoutMs); }),
      ]);
      return { status: ack(lease, true) ? "sent" : "failed" };
    } catch {
      // Database/configuration failures are also sanitized. If marking failure
      // is temporarily impossible, the persisted lease expires without retry.
      if (lease) { try { ack(lease, false); } catch { /* Lease expiry fails closed. */ } }
      return { status: "failed" };
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }

  return { enqueueInTransaction, pruneInTransaction, claim, beginSend, ack, deliverNext,
    prune: () => transaction(() => pruneInTransaction()) };
}
