import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { inspectGroupMembership, createContactAuthorizer, boundedPlainText } from '../src/group-privacy.mjs';

const bot = '15551234568';
const member = '15551234567';
const group = '120363000000000000@g.us';
const identity = { normalizeJid: jid => jid.replace(/:\d+@/, '@'), lookupPhoneForLid: async () => null };
const config = { botNumber: bot, allowedNumbers: new Set([member]), allowedGroups: new Set([group]) };
const metadata = () => ({ id: group, size: 2, participants: [
  { id: `${bot}:4@s.whatsapp.net`, admin: 'admin' }, { id: `${member}@s.whatsapp.net` }] });
const check = (value, active = () => true, ids = identity) => inspectGroupMembership(value, group, config, ids, active);

test('only complete known membership including actual bot can receive group replies', async () => {
  assert.deepEqual(await check(metadata()), { allowed: true, reason: 'verified', memberCount: 2 });
  for (const change of [ { size: 3 }, { id: '120363999@g.us' }, { participants: [] },
    { isCommunity: true }, { isCommunityAnnounce: true },
    { participants: [{ id: `${member}@s.whatsapp.net` }, { id: '15559999999@s.whatsapp.net' }] },
    { participants: [...metadata().participants, { id: '15559999999@s.whatsapp.net' }], size: 3 },
    { participants: [...metadata().participants, { id: `${member}@s.whatsapp.net` }], size: 3 } ]) {
    assert.equal((await check({ ...metadata(), ...change })).allowed, false);
  }
  assert.equal((await check(metadata(), () => false)).allowed, false);
});

test('LID membership resolves only from authenticated metadata/learned mappings without conflicting phones', async () => {
  const m = metadata();
  m.participants[1] = { id: '999999999@lid', phoneNumber: `${member}@s.whatsapp.net` };
  assert.equal((await check(m)).allowed, true);
  assert.equal((await check(m, () => true, { ...identity,
    lookupPhoneForLid: async () => '15559999999@s.whatsapp.net' })).allowed, false);
  m.participants[1] = { id: `${member}@lid` };
  assert.equal((await check(m)).allowed, false, 'LID digits are not a phone');
  m.participants[1] = { id: `${member}@s.whatsapp.net`, lid: '999@lid' };
  assert.equal((await check(m, () => true, { ...identity,
    lookupPhoneForLid: async () => '15559999999@s.whatsapp.net' })).allowed, false);
});

test('announcement group requires bot admin', async () => {
  const m = { ...metadata(), announce: true };
  assert.equal((await check(m)).allowed, true);
  m.participants[0].admin = null;
  assert.equal((await check(m)).reason, 'group_read_only');
});

test('fresh website account status overrides startup mapping immediately, malformed and duplicate contacts deny', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, active INTEGER); INSERT INTO users VALUES('member','member',1)");
    let contacts = [{ userId: 'member', number: `+1 (555) 123-4567` }];
    const eligible = createContactAuthorizer({ db, contacts: () => contacts });
    assert.equal(eligible(member), true);
    db.prepare('UPDATE users SET active=0 WHERE id=?').run('member');
    assert.equal(eligible(member), false);
    db.prepare('UPDATE users SET active=1 WHERE id=?').run('member');
    contacts[0].verified = false; assert.equal(eligible(member), false);
    contacts[0].verified = true; contacts[0].active = false; assert.equal(eligible(member), false);
    contacts[0].active = true; contacts.push({ ...contacts[0] }); assert.equal(eligible(member), false);
  } finally { db.close(); }
});

test('plain-text cards preserve Arabic, newlines and safe text, reject oversize and remove controls', () => {
  assert.equal(boundedPlainText('  *بطاقة المهمة*\r\n\u202eالتقرير\u0000\n\nالحالة: جديد  '), '*بطاقة المهمة*\nالتقرير\n\nالحالة: جديد');
  assert.throws(() => boundedPlainText('x'.repeat(4001)));
  assert.throws(() => boundedPlainText({ buttons: [] }));
});
