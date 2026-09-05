import { resolvePhone } from './identity.mjs';

export const groupJid = value => typeof value === 'string' && value.length <= 100 && /^\d+(?:-\d+)?@g\.us$/.test(value);

export async function withAbortSignal(work, signal) {
  if (signal.aborted) throw new Error('operation_cancelled');
  let onAbort;
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('operation_cancelled');
      return work();
    }), new Promise((_, reject) => {
      onAbort = () => reject(new Error('operation_cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

// Administrator-owned contact mapping plus a FRESH database check on every call.
// A disabled website account must not remain authorized by a worker's startup snapshot.
export function createContactAuthorizer({ db, contacts }) {
  return number => {
    try {
      const matches = contacts().filter(contact => typeof contact?.number === 'string' &&
        contact.number.replace(/\D/g, '').replace(/^00/, '') === number);
      if (matches.length !== 1 || matches[0].active === false || matches[0].verified === false ||
        typeof matches[0].userId !== 'string') return false;
      const user = db.prepare('SELECT role FROM users WHERE id = ? AND active = 1').get(matches[0].userId);
      return !!user && ['admin', 'member'].includes(user.role);
    } catch { return false; }
  };
}

export async function inspectGroupMembership(metadata, jid, config, identity, isActiveNumber) {
  const denied = reason => ({ allowed: false, reason, memberCount: Array.isArray(metadata?.participants) ? metadata.participants.length : 0 });
  if (!groupJid(jid) || metadata?.id !== jid || !Array.isArray(metadata.participants) ||
    metadata.participants.length < 2 || metadata.participants.length > 101 ||
    (metadata.size != null && metadata.size !== metadata.participants.length) ||
    metadata.isCommunity || metadata.isCommunityAnnounce) return denied('incomplete_membership');
  const phones = new Set();
  let botAdmin = false;
  for (const participant of metadata.participants) {
    if (!participant || typeof participant !== 'object') return denied('unresolved_member');
    const number = await resolvePhone(participant.id, participant.phoneNumber, identity);
    if (!number || phones.has(number)) return denied('unresolved_member');
    // Validate a separately supplied LID too; don't accept conflicting PN/LID pairs.
    if (participant.lid != null && await resolvePhone(participant.lid, participant.id, identity) !== number) {
      return denied('unresolved_member');
    }
    if (number !== config.botNumber && (!config.allowedNumbers.has(number) || !await isActiveNumber(number))) {
      return denied('unauthorized_member');
    }
    if (number === config.botNumber) botAdmin = participant.admin === 'admin' || participant.admin === 'superadmin';
    phones.add(number);
  }
  if (!phones.has(config.botNumber)) return denied('bot_not_member');
  if (metadata.announce && !botAdmin) return denied('group_read_only');
  return { allowed: true, reason: 'verified', memberCount: phones.size };
}

export function boundedPlainText(value) {
  if (typeof value !== 'string' || value.length > 4000) throw new Error('invalid_reply');
  // Preserve Arabic and ordinary WhatsApp formatting, but never emit terminal/bidi controls.
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}
