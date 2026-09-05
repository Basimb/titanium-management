import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeContactNumber, type ChatUser } from "./team-chat-policy.ts";

type Contact = { userId: string; number: string; active?: boolean; verified?: boolean };
export type SecretaryOutboxConfig = { enabled: boolean; contacts: readonly Contact[] };
type Origin = { senderNumber: string; groupId?: string | null };
type Identity = { actor: ChatUser; origin: Origin };
type Recipient = { userId: string; name: string; phone: string };
type DeliveryState = "queued" | "sending" | "sent" | "submitted" | "failed" | "uncertain";
export type SecretaryTransportStatus = "server_ack" | "delivered" | "read" | "error";
type PublicDeliveryState = Exclude<DeliveryState, "sent"> | SecretaryTransportStatus;
type BatchState = "preview" | "queued" | "sent" | "submitted" | "server_ack" | "delivered" | "read" | "failed" | "uncertain";
type Evidence = { serverAckAt: number | null; deliveredAt: number | null; readAt: number | null; errorAt: number | null; errorCode: string | null };
export type SecretaryOutboxRecipientStatus = { userId: string; name: string; state: PublicDeliveryState; submissionState: DeliveryState; legacySubmission: boolean; evidence: Evidence };
type Batch = { id: string; source_key: string; payload_hash: string; source_message_id: string; requester_id: string; requester_name: string;
  requester_phone: string; body: string; recipients_json: string; state: BatchState; created_at: number; expires_at: number;
  confirmed_at: number | null; confirmation_key: string | null; confirmation_message_id: string | null;
  receipt_state: DeliveryState | null; receipt_sending_at: number | null; receipt_message_id: string };
export type SecretaryOutboxPreview = { batchId: string; state: BatchState; text: string; recipients: Array<{ userId: string; name: string }>; expiresAt: number };
export type SecretaryOutboxStatus = { batchId: string; state: BatchState; recipientCount: number; acceptedCount: number;
  submittedCount: number; deliveredCount: number; readCount: number;
  failedCount: number; uncertainCount: number; pendingCount: number; recipients: SecretaryOutboxRecipientStatus[] };
export type SecretaryTransportBinding = { messageId: string; to: string; kind: "delivery" | "receipt" };
export type SecretaryTransportUpdate = { messageId: string; to: string; status: SecretaryTransportStatus; at: number; errorCode?: string };
export class SecretaryOutboxError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "SecretaryOutboxError"; this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string): never => { throw new SecretaryOutboxError(status, code, message); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const PREVIEW_MS = 10 * 60_000, STALE_SEND_MS = 60_000, MAX_QUEUE_MS = 24 * 60 * 60_000;
const MAX_RECIPIENTS = 20, MAX_BATCHES_PER_HOUR = 10, MAX_QUEUED_DELIVERIES = 200;
let savepoint = 0;
function atomic<T>(db: DatabaseSync, work: () => T): T {
  const nested = db.isTransaction, name = `secretary_outbox_${++savepoint}`;
  db.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  try { const result = work(); db.exec(nested ? `RELEASE ${name}` : "COMMIT"); return result; }
  catch (error) { db.exec(nested ? `ROLLBACK TO ${name}` : "ROLLBACK"); if (nested) db.exec(`RELEASE ${name}`); throw error; }
}
function timestamp(value?: number | (() => number)): number {
  const now = typeof value === "function" ? value() : value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) return fail(400, "invalid_time", "وقت الطلب غير صالح"); return now;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) return fail(400, "invalid_id", "معرّف الطلب غير صالح"); return value;
}
function normalizedText(value: unknown): string {
  if (typeof value !== "string" || value.length > 4000) return fail(400, "invalid_text", "نص الرسالة مطلوب وبحد أقصى 4000 حرف");
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) return fail(400, "invalid_text", "نص الرسالة مطلوب"); return text;
}
function phoneFor(config: SecretaryOutboxConfig, userId: string): string | null {
  const matches = config.contacts.filter(contact => contact.userId === userId);
  if (matches.length !== 1 || matches[0].active === false || matches[0].verified === false) return null;
  const phone = normalizeContactNumber(matches[0].number);
  return phone && config.contacts.filter(contact => normalizeContactNumber(contact.number) === phone).length === 1 ? phone : null;
}
function owner(db: DatabaseSync, identity: Identity, config: SecretaryOutboxConfig) {
  if (!config.enabled) return fail(503, "disabled", "إرسال رسائل الفريق غير مفعّل حاليًا");
  if (identity.origin?.groupId != null || !identity.actor || identity.actor.id !== "basem") return fail(403, "owner_private_only", "إرسال رسائل الفريق متاح لباسم على الخاص فقط");
  const actor = db.prepare("SELECT id,name,role,active FROM users WHERE id='basem'").get() as ChatUser | undefined;
  const phone = phoneFor(config, "basem");
  if (!actor || actor.active !== 1 || actor.role !== "admin" || identity.actor.name !== actor.name || identity.actor.role !== actor.role
    || identity.actor.active !== 1 || !phone || normalizeContactNumber(identity.origin.senderNumber) !== phone) {
    return fail(403, "owner_unavailable", "تعذر التحقق من حساب باسم ورقمه المسجّل؛ لم تُرسل أي رسالة");
  }
  return { actor, phone };
}
function frozenRecipients(batch: Batch): Recipient[] { return JSON.parse(batch.recipients_json) as Recipient[]; }
function availableRecipients(db: DatabaseSync, config: SecretaryOutboxConfig): Recipient[] {
  if (!config.enabled) return [];
  const users = db.prepare("SELECT id,name FROM users WHERE active=1 AND role='member' AND id<>'basem' ORDER BY name,id").all();
  return users.flatMap(user => { const phone = phoneFor(config, String(user.id)); return phone ? [{ userId: String(user.id), name: String(user.name), phone }] : []; });
}
export function getSecretaryOutboxRecipients(db: DatabaseSync, config: SecretaryOutboxConfig): Array<{ userId: string; name: string }> {
  return availableRecipients(db, config).map(({ userId, name }) => ({ userId, name }));
}
export function migrateSecretaryOutbox(db: DatabaseSync) {
  atomic(db, () => db.exec(`CREATE TABLE IF NOT EXISTS secretary_outbox_batches (
    id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,payload_hash TEXT NOT NULL,source_message_id TEXT NOT NULL,
    requester_id TEXT NOT NULL,requester_name TEXT NOT NULL,requester_phone TEXT NOT NULL,body TEXT NOT NULL,recipients_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'preview',created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,confirmed_at INTEGER,
    confirmation_key TEXT UNIQUE,confirmation_message_id TEXT,receipt_state TEXT,receipt_sending_at INTEGER,receipt_message_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS secretary_outbox_deliveries (
    id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES secretary_outbox_batches(id),recipient_id TEXT NOT NULL,recipient_name TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL,
    sending_at INTEGER,finished_at INTEGER,outcome_code TEXT,UNIQUE(batch_id,recipient_id));
    CREATE INDEX IF NOT EXISTS secretary_outbox_ready ON secretary_outbox_deliveries(state,created_at,id);
    CREATE TABLE IF NOT EXISTS secretary_outbox_transport (
    message_id TEXT PRIMARY KEY,to_jid TEXT NOT NULL,server_ack_at INTEGER,delivered_at INTEGER,read_at INTEGER,
    error_at INTEGER,error_code TEXT,updated_at INTEGER NOT NULL);`));
}
function publicPreview(batch: Batch): SecretaryOutboxPreview {
  return { batchId: batch.id, state: batch.state === "sent" ? "submitted" : batch.state, text: batch.body, recipients: frozenRecipients(batch).map(({ userId, name }) => ({ userId, name })), expiresAt: batch.expires_at };
}
function batchById(db: DatabaseSync, id: string): Batch {
  return db.prepare("SELECT * FROM secretary_outbox_batches WHERE id=?").get(id) as Batch ?? fail(404, "missing", "طلب الإرسال غير موجود");
}
function transportBinding(db: DatabaseSync, messageId: unknown): (SecretaryTransportBinding & { sendingAt: number }) | null {
  if (typeof messageId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(messageId)) return null;
  const delivery = db.prepare("SELECT d.recipient_id,d.recipient_name,d.recipient_phone,d.sending_at,d.state,b.recipients_json FROM secretary_outbox_deliveries d JOIN secretary_outbox_batches b ON b.id=d.batch_id WHERE d.message_id=? AND b.confirmed_at IS NOT NULL").get(messageId);
  if (delivery && delivery.sending_at !== null && !["queued", "failed"].includes(String(delivery.state))) {
    let frozen: Recipient[]; try { frozen = JSON.parse(String(delivery.recipients_json)); } catch { return null; }
    if (!Array.isArray(frozen) || !frozen.some(item => item.userId === delivery.recipient_id && item.name === delivery.recipient_name && item.phone === delivery.recipient_phone)) return null;
    return { messageId, to: `${delivery.recipient_phone}@s.whatsapp.net`, kind: "delivery", sendingAt: Number(delivery.sending_at) };
  }
  const receipt = db.prepare("SELECT requester_phone,receipt_sending_at,receipt_state FROM secretary_outbox_batches WHERE receipt_message_id=? AND confirmed_at IS NOT NULL").get(messageId);
  return receipt && receipt.receipt_sending_at !== null && !["queued", "failed"].includes(String(receipt.receipt_state))
    ? { messageId, to: `${receipt.requester_phone}@s.whatsapp.net`, kind: "receipt", sendingAt: Number(receipt.receipt_sending_at) } : null;
}
function evidenceState(evidence: Evidence): SecretaryTransportStatus | null {
  return evidence.readAt !== null ? "read" : evidence.deliveredAt !== null ? "delivered" : evidence.serverAckAt !== null ? "server_ack" : evidence.errorAt !== null ? "error" : null;
}
function readEvidence(db: DatabaseSync, messageId: string): Evidence {
  const row = db.prepare("SELECT server_ack_at AS serverAckAt,delivered_at AS deliveredAt,read_at AS readAt,error_at AS errorAt,error_code AS errorCode FROM secretary_outbox_transport WHERE message_id=?").get(messageId);
  return row as Evidence ?? { serverAckAt: null, deliveredAt: null, readAt: null, errorAt: null, errorCode: null };
}
const SAFE_TRANSPORT_ERRORS = new Set(["recipient_devices_unavailable", "transport_preflight_rejected", "transport_rejected", "message_error", "server_error", "transport_error"]);
function recordTransportUpdate(db: DatabaseSync, update: SecretaryTransportUpdate, now: number): { status: "recorded" | "ignored"; evidenceStatus?: SecretaryTransportStatus } {
  if (!update || typeof update !== "object" || Array.isArray(update) || Object.keys(update).some(key => !["messageId", "to", "status", "at", "errorCode"].includes(key))
    || !["server_ack", "delivered", "read", "error"].includes(update.status) || typeof update.to !== "string" || !/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(update.to)
    || !Number.isSafeInteger(update.at) || update.at < 0 || update.at > now + 300_000) return { status: "ignored" };
  return atomic(db, () => {
    const binding = transportBinding(db, update.messageId);
    if (!binding || binding.to !== update.to || update.at < binding.sendingAt - 1000) return { status: "ignored" };
    const prior = db.prepare("SELECT to_jid FROM secretary_outbox_transport WHERE message_id=?").get(update.messageId);
    if (prior && prior.to_jid !== update.to) return { status: "ignored" };
    const evidence = readEvidence(db, update.messageId);
    const field = { server_ack: "serverAckAt", delivered: "deliveredAt", read: "readAt", error: "errorAt" }[update.status] as "serverAckAt" | "deliveredAt" | "readAt" | "errorAt";
    evidence[field] = evidence[field] === null ? update.at : Math.min(evidence[field]!, update.at);
    if (update.status === "error" && evidence.errorCode === null) evidence.errorCode = SAFE_TRANSPORT_ERRORS.has(update.errorCode || "") ? update.errorCode! : "transport_error";
    db.prepare("INSERT INTO secretary_outbox_transport VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET server_ack_at=excluded.server_ack_at,delivered_at=excluded.delivered_at,read_at=excluded.read_at,error_at=excluded.error_at,error_code=excluded.error_code,updated_at=MAX(secretary_outbox_transport.updated_at,excluded.updated_at)")
      .run(update.messageId, update.to, evidence.serverAckAt, evidence.deliveredAt, evidence.readAt, evidence.errorAt, evidence.errorCode, now);
    // Evidence never changes submission state, queue membership or completion-receipt state.
    return { status: "recorded", evidenceStatus: evidenceState(evidence)! };
  });
}
export function secretaryOutboxDeliveryLabel(recipient: SecretaryOutboxRecipientStatus): string {
  const labels: Record<PublicDeliveryState, string> = { queued: "بانتظار محاولة الإرسال", sending: "تجري محاولة الإرسال", submitted: recipient.legacySubmission ? "تسليم قديم للنقل بلا إيصال واتساب موثّق" : "سُلّمت للنقل؛ لا يوجد إيصال واتساب بعد",
    server_ack: "ورد إقرار خادم واتساب؛ وصولها للجهاز غير مؤكد", delivered: "ورد إيصال وصول إلى جهاز المستلم", read: "ورد إيصال قراءة", error: "ورد خطأ من النقل", failed: "تعذّر الإرسال قبل النقل", uncertain: "نتيجة المحاولة غير مؤكدة؛ لن نكررها تلقائيًا" };
  return labels[recipient.state] + (recipient.evidence.errorAt !== null && ["server_ack", "delivered", "read"].includes(recipient.state) ? "؛ ويوجد خطأ نقل مسجّل أيضًا" : "");
}
function validateFrozen(db: DatabaseSync, batch: Batch, config: SecretaryOutboxConfig, recipient?: Recipient | null): boolean {
  try {
    const actor = db.prepare("SELECT id,name,role,active FROM users WHERE id=?").get(batch.requester_id) as ChatUser | undefined;
    if (!actor || actor.name !== batch.requester_name) return false;
    owner(db, { actor, origin: { senderNumber: batch.requester_phone, groupId: null } }, config);
    const frozen = frozenRecipients(batch);
    if (recipient && !frozen.some(item => item.userId === recipient.userId && item.name === recipient.name && item.phone === recipient.phone)) return false;
    return (recipient === null ? [] : recipient ? [recipient] : frozen).every(item => {
      const user = db.prepare("SELECT name,role,active FROM users WHERE id=?").get(item.userId);
      return item.userId !== "basem" && user?.active === 1 && user.role === "member" && user.name === item.name && phoneFor(config, item.userId) === item.phone;
    });
  } catch { return false; }
}
export function createSecretaryOutboxPreview(db: DatabaseSync, input: Identity & {
  sourceMessageId: string; text: string; recipientIds: "all-team" | readonly string[];
}, config: SecretaryOutboxConfig, options: { now?: number | (() => number) } = {}): SecretaryOutboxPreview {
  migrateSecretaryOutbox(db);
  return atomic(db, () => {
    const requester = owner(db, input, config), now = timestamp(options.now), source = identifier(input.sourceMessageId), text = normalizedText(input.text);
    const selection = input.recipientIds === "all-team" ? "all-team" : Array.isArray(input.recipientIds) && input.recipientIds.length > 0 && input.recipientIds.length <= MAX_RECIPIENTS
      ? [...input.recipientIds].map(identifier).sort() : fail(400, "invalid_recipients", "اختر مستلمًا مسجّلًا أو جميع أعضاء الفريق");
    if (selection !== "all-team" && new Set(selection).size !== selection.length) return fail(400, "duplicate_recipient", "المستلم مكرر في الطلب");
    const sourceKey = digest([requester.actor.id, requester.phone, source]), payloadHash = digest([text, selection]);
    const existing = db.prepare("SELECT * FROM secretary_outbox_batches WHERE source_key=?").get(sourceKey) as Batch | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) return fail(409, "changed_event", "لا يمكن استخدام الطلب نفسه لنص أو مستلمين مختلفين");
      if (!validateFrozen(db, existing, config)) return fail(409, "stale_recipients", "تغيّر أحد الحسابات أو الأرقام؛ أنشئ معاينة جديدة");
      return publicPreview(existing);
    }
    const available = availableRecipients(db, config);
    const recipients = selection === "all-team" ? available : selection.map(id => available.find(item => item.userId === id) ?? fail(400, "recipient_unavailable", "أحد المستلمين غير مسجّل برقم فريد أو حسابه غير مفعّل"));
    if (!recipients.length) return fail(400, "no_recipients", "لا توجد قائمة مستلمين صالحة؛ راجع حسابات الفريق وأرقامهم");
    if (recipients.length > MAX_RECIPIENTS) return fail(400, "too_many_recipients", "الحد الأقصى للدفعة الواحدة 20 مستلمًا؛ حدّد قائمة أصغر");
    const id = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO secretary_outbox_batches(id,source_key,payload_hash,source_message_id,requester_id,requester_name,requester_phone,body,recipients_json,created_at,expires_at,receipt_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, sourceKey, payloadHash, source, requester.actor.id, requester.actor.name, requester.phone, text, JSON.stringify(recipients), now, now + PREVIEW_MS, "TITANIUMOUTSUMMARY" + id.toUpperCase());
    return publicPreview(batchById(db, id));
  });
}
function summarize(db: DatabaseSync, batch: Batch): SecretaryOutboxStatus {
  const raw = db.prepare("SELECT recipient_id AS userId,recipient_name AS name,state,message_id FROM secretary_outbox_deliveries WHERE batch_id=? ORDER BY recipient_name,recipient_id").all(batch.id) as Array<{ userId: string; name: string; state: DeliveryState; message_id: string }>;
  const rows = raw.map(row => { const evidence = readEvidence(db, row.message_id); return { userId: row.userId, name: row.name, state: evidenceState(evidence) || (row.state === "sent" ? "submitted" : row.state),
    submissionState: row.state, legacySubmission: row.state === "sent", evidence } as SecretaryOutboxRecipientStatus; });
  const count = (states: string[]) => rows.filter(row => states.includes(row.state)).length;
  const pendingCount = raw.filter(row => ["queued", "sending"].includes(row.state)).length;
  const acceptedCount = count(["server_ack", "delivered", "read"]), deliveredCount = count(["delivered", "read"]), readCount = count(["read"]);
  const submittedCount = count(["submitted"]), failedCount = count(["failed", "error"]), uncertainCount = count(["uncertain"]);
  const state: BatchState = batch.confirmed_at === null ? "preview" : pendingCount ? "queued" : uncertainCount ? "uncertain" : failedCount ? "failed" : submittedCount ? "submitted"
    : readCount === rows.length ? "read" : deliveredCount === rows.length ? "delivered" : "server_ack";
  return { batchId: batch.id, state, recipientCount: frozenRecipients(batch).length, acceptedCount, submittedCount, deliveredCount, readCount, failedCount, uncertainCount, pendingCount, recipients: rows };
}
export function confirmSecretaryOutboxPreview(db: DatabaseSync, input: Identity & { batchId: string; confirmationMessageId: string },
  config: SecretaryOutboxConfig, options: { now?: number | (() => number) } = {}): SecretaryOutboxStatus {
  migrateSecretaryOutbox(db);
  return atomic(db, () => {
    const requester = owner(db, input, config), now = timestamp(options.now), batch = batchById(db, identifier(input.batchId));
    const confirmation = identifier(input.confirmationMessageId);
    if (batch.requester_id !== requester.actor.id || batch.requester_name !== requester.actor.name || batch.requester_phone !== requester.phone) return fail(403, "wrong_owner", "هذا الطلب غير مرتبط بحسابك ورقمك الحالي");
    if (batch.confirmed_at !== null) return summarize(db, batch); // Duplicate confirmation can never enqueue twice.
    if (confirmation === batch.source_message_id) return fail(400, "confirmation_required", "يلزم تأكيد منفصل بعد عرض النص والمستلمين");
    if (now >= batch.expires_at) return fail(409, "expired", "انتهت مهلة المعاينة؛ اطلب معاينة جديدة قبل الإرسال");
    if (!validateFrozen(db, batch, config)) return fail(409, "stale_recipients", "تغيّر أحد الحسابات أو الأرقام؛ راجع معاينة جديدة قبل الإرسال");
    const recent = Number(db.prepare("SELECT count(*) AS n FROM secretary_outbox_batches WHERE requester_id=? AND confirmed_at>?").get(requester.actor.id, now - 60 * 60_000)?.n);
    const queued = Number(db.prepare("SELECT count(*) AS n FROM secretary_outbox_deliveries WHERE state IN ('queued','sending')").get()?.n);
    if (recent >= MAX_BATCHES_PER_HOUR || queued + frozenRecipients(batch).length > MAX_QUEUED_DELIVERIES) return fail(429, "outbox_limit", "بلغت حد الإرسال الحالي؛ انتظر اكتمال الرسائل أو انتهاء مهلة الحد ثم اطلب معاينة جديدة");
    const confirmationKey = digest([requester.actor.id, requester.phone, confirmation]);
    if (db.prepare("SELECT id FROM secretary_outbox_batches WHERE confirmation_key=?").get(confirmationKey)) return fail(409, "reused_confirmation", "استُخدمت هذه الموافقة لطلب آخر");
    for (const item of frozenRecipients(batch)) {
      const id = digest([batch.id, item.userId]);
      db.prepare("INSERT INTO secretary_outbox_deliveries(id,batch_id,recipient_id,recipient_name,recipient_phone,message_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, batch.id, item.userId, item.name, item.phone, "TITANIUMOUT" + id.toUpperCase(), now);
    }
    db.prepare("UPDATE secretary_outbox_batches SET state='queued',confirmed_at=?,confirmation_key=?,confirmation_message_id=?,receipt_state='queued' WHERE id=? AND confirmed_at IS NULL")
      .run(now, confirmationKey, confirmation, batch.id);
    return summarize(db, batchById(db, batch.id));
  });
}
export function getSecretaryOutboxStatus(db: DatabaseSync, input: Identity, config: SecretaryOutboxConfig): SecretaryOutboxStatus | null {
  owner(db, input, config);
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secretary_outbox_batches'").get()) return null;
  migrateSecretaryOutbox(db);
  return atomic(db, () => {
    const requester = owner(db, input, config);
    const batch = db.prepare("SELECT * FROM secretary_outbox_batches WHERE requester_id=? AND requester_phone=? AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC,rowid DESC LIMIT 1").get(requester.actor.id, requester.phone) as Batch | undefined;
    return batch ? summarize(db, batch) : null;
  });
}

type Job = { kind: "delivery" | "receipt"; id: string; batch: Batch; recipient?: Recipient; messageId: string };
export function createSecretaryOutboxJobs({ db, config, now = Date.now, timeoutMs = 15_000 }: {
  db: DatabaseSync; config: SecretaryOutboxConfig | (() => SecretaryOutboxConfig); now?: () => number; timeoutMs?: number;
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error("Invalid outbox deadline.");
  migrateSecretaryOutbox(db);
  let running = false;
  const current = () => typeof config === "function" ? config() : config;
  function claim(): Job | null {
    return atomic(db, () => {
      const at = timestamp(now);
      db.prepare("UPDATE secretary_outbox_deliveries SET state='uncertain',finished_at=?,outcome_code='interrupted' WHERE state='sending' AND sending_at<=?").run(at, at - STALE_SEND_MS);
      db.prepare("UPDATE secretary_outbox_batches SET receipt_state='uncertain' WHERE receipt_state='sending' AND receipt_sending_at<=?").run(at - STALE_SEND_MS);
      const batches = db.prepare("SELECT * FROM secretary_outbox_batches WHERE confirmed_at IS NOT NULL AND receipt_state='queued' ORDER BY confirmed_at,rowid").all() as Batch[];
      for (const batch of batches) {
        const summary = summarize(db, batch); if (summary.pendingCount) continue;
        db.prepare("UPDATE secretary_outbox_batches SET state=?,receipt_state='sending',receipt_sending_at=? WHERE id=? AND receipt_state='queued'").run(summary.state, at, batch.id);
        return { kind: "receipt", id: batch.id, batch, messageId: batch.receipt_message_id };
      }
      const row = db.prepare("SELECT * FROM secretary_outbox_deliveries WHERE state='queued' ORDER BY created_at,rowid LIMIT 1").get() as {
        id: string; batch_id: string; recipient_id: string; recipient_name: string; recipient_phone: string; message_id: string;
      } | undefined;
      if (!row) return null;
      const batch = batchById(db, row.batch_id);
      if (batch.confirmed_at === null) return null;
      if (Number(db.prepare("UPDATE secretary_outbox_deliveries SET state='sending',sending_at=? WHERE id=? AND state='queued'").run(at, row.id).changes) !== 1) return null;
      return { kind: "delivery", id: row.id, batch, recipient: { userId: row.recipient_id, name: row.recipient_name, phone: row.recipient_phone }, messageId: row.message_id };
    });
  }
  function finish(job: Job, state: "submitted" | "failed" | "uncertain", reason: string) {
    if (job.kind === "receipt") db.prepare("UPDATE secretary_outbox_batches SET receipt_state=? WHERE id=? AND receipt_state='sending'").run(state, job.id);
    else db.prepare("UPDATE secretary_outbox_deliveries SET state=?,finished_at=?,outcome_code=? WHERE id=? AND state='sending'").run(state, timestamp(now), reason, job.id);
  }
  function delivery(job: Job) {
    const cfg = current();
    if (!cfg.enabled || !validateFrozen(db, job.batch, cfg, job.kind === "receipt" ? null : job.recipient)) return null;
    if (job.kind === "delivery" && timestamp(now) - job.batch.confirmed_at! >= MAX_QUEUE_MS) return null;
    if (job.kind === "delivery") return { to: `${job.recipient!.phone}@s.whatsapp.net`, text: job.batch.body };
    const summary = summarize(db, job.batch);
    const outcomes = summary.recipients.map(recipient => {
      const name = recipient.name.replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, " ").slice(0, 60).trim() || "عضو الفريق";
      return `• ${name}: ${secretaryOutboxDeliveryLabel(recipient)}`;
    }).join("\n");
    return { to: `${job.batch.requester_phone}@s.whatsapp.net`, text: `نتيجة محاولة إرسال رسالتك الخاصة إلى الفريق:\nورد إقرار من خادم واتساب: ${summary.acceptedCount} من ${summary.recipientCount}.\nورد إيصال وصول: ${summary.deliveredCount}؛ وإيصال قراءة: ${summary.readCount}.\nسُلّمت للنقل بلا إيصال: ${summary.submittedCount}.\nتعذّر الإرسال: ${summary.failedCount}.\nالنتيجة غير مؤكدة: ${summary.uncertainCount}.\n\n${outcomes}\n\nنجاح محاولة النقل وحده لا يؤكد وصول الرسالة أو قراءتها. هذه أحدث الإيصالات المتاحة الآن؛ لن أعيد إرسال الحالات غير المؤكدة تلقائيًا.` };
  }
  return {
    getTransportBinding(messageId: string): SecretaryTransportBinding | null { const binding = transportBinding(db, messageId); return binding ? { messageId: binding.messageId, to: binding.to, kind: binding.kind } : null; },
    recordTransportUpdate(update: SecretaryTransportUpdate) { return recordTransportUpdate(db, update, timestamp(now)); },
    async deliverNext(send: (message: { to: string; text: string; messageId: string; signal: AbortSignal }) => Promise<unknown>) {
    if (running || db.isTransaction) return { status: "idle" as const };
    running = true;
    let job: Job | null = null;
    try {
      if (!current().enabled || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secretary_outbox_deliveries'").get()) return { status: "idle" as const };
      job = claim(); if (!job) return { status: "idle" as const };
      const message = delivery(job);
      if (!message) { finish(job, "failed", "authorization_changed_or_expired"); return { status: "failed" as const }; }
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([send({ ...message, messageId: job.messageId, signal: controller.signal }), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("uncertain")); }, timeoutMs);
        })]);
        finish(job, "submitted", "transport_submitted"); return { status: "submitted" as const };
      } catch (error) {
        if (error && typeof error === "object" && "definitelyNotSent" in error && error.definitelyNotSent === true && "code" in error
          && ["recipient_devices_unavailable", "transport_preflight_rejected"].includes(String(error.code))) {
          finish(job, "failed", "transport_preflight_rejected"); return { status: "failed" as const };
        }
        // Once the send callback was invoked, even a rejected promise may have reached WhatsApp.
        finish(job, "uncertain", "send_outcome_unknown"); return { status: "uncertain" as const };
      } finally { clearTimeout(timer); }
    } catch {
      // Do not include transport exceptions, phone numbers, message text or database paths.
      if (job) { try { finish(job, "uncertain", "worker_outcome_unknown"); } catch { /* Recovery marks a stale sending lease uncertain. */ } }
      return { status: "failed" as const };
    } finally { running = false; }
  } };
}
