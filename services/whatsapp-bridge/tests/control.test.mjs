import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openControl, processControlJob, GROUP_INTRO } from '../src/control.mjs';

const group = '120363000000000000@g.us';
const other = '120363111111111111@g.us';
const subject = 'تطوير شركة تيتانيوم';
const now = 1_800_000_000_000;
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'titanium-control-test-'));
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  let clock = now;
  let control = openControl(directory, { now: () => clock });
  t.after(() => {
    control.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('titanium-control-test-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  return { get control() { return control; }, advance: ms => { clock += ms; },
    reopen() { control.close(); control = openControl(directory, { now: () => clock }); return control; } };
}

test('discovery returns exact matching group and safe counts, never other group metadata/roster', async t => {
  const f = fixture(t);
  const job = f.control.request('discover', subject);
  const calls = [];
  await processControlJob({ control: f.control, now: () => now, config: { allowedGroups: new Set() },
    socket: { groupFetchAllParticipating: async () => ({
      [group]: { id: group, subject, participants: [{ phoneNumber: 'PRIVATE_PHONE' }] },
      [other]: { id: other, subject: 'PRIVATE_OTHER_SUBJECT', description: 'PRIVATE_DATA' },
    }) },
    inspectGroup: async (...args) => { calls.push(args); return { allowed: true, reason: 'verified', memberCount: 4 }; },
  });
  assert.deepEqual(calls, [[group, false]]);
  const result = f.control.get(job.id);
  assert.equal(result.state, 'done');
  assert.equal(result.result.matches.length, 1);
  assert.equal(result.result.matches[0].groupId, group);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('intro is allowlisted and explicitly requested once, retry/reopen cannot duplicate a successful send', async t => {
  const f = fixture(t);
  const job = f.control.request('intro', group);
  const sends = [];
  await processControlJob({ control: f.control, now: () => now, config: { allowedGroups: new Set([group]) },
    sendGroup: async (...args) => sends.push(args) });
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], group);
  assert.equal(sends[0][1], GROUP_INTRO);
  assert.equal(f.reopen().request('intro', group).id, job.id);
  assert.equal(f.control.claim(), null);
});

test('ambiguous intro failure and interrupted running job are terminal without automatic retransmission', async t => {
  const f = fixture(t);
  const job = f.control.request('intro', group);
  await processControlJob({ control: f.control, now: () => now, config: { allowedGroups: new Set([group]) },
    sendGroup: async () => { throw new Error('accepted-but-connection-lost'); } });
  assert.equal(f.control.get(job.id).state, 'failed');
  assert.equal(f.control.request('intro', group).state, 'failed');
  const next = f.control.request('intro', other);
  f.control.claim();
  f.reopen();
  assert.equal(f.control.get(next.id).state, 'running', 'reading CLI never recovers jobs');
  f.control.recover();
  assert.equal(f.control.get(next.id).state, 'failed');
  assert.equal(f.control.claim(), null);
});

test('intro refuses non-allowlisted groups and disabled task service', async t => {
  for (const config of [{ allowedGroups: new Set() }, { allowedGroups: new Set([group]), tasksEnabled: false }]) {
    const f = fixture(t);
    const job = f.control.request('intro', group);
    let sent = false;
    await processControlJob({ control: f.control, now: () => now, config,
      sendGroup: async () => { sent = true; } });
    assert.equal(sent, false);
    assert.equal(f.control.get(job.id).state, 'failed');
  }
});

test('control targets, backlog/expiry and private refusal rate limits are bounded', t => {
  const f = fixture(t);
  assert.throws(() => f.control.request('send-anything', group));
  assert.throws(() => f.control.request('intro', '15551234567@s.whatsapp.net'));
  assert.throws(() => f.control.request('discover', 'x'.repeat(101)));
  const job = f.control.request('status', group);
  f.advance(300001);
  assert.equal(f.control.claim(), null);
  assert.equal(f.control.get(job.id).state, 'failed');
  assert.equal(f.control.reservePrivacyAlert(group, '15551234567'), true);
  assert.equal(f.reopen().reservePrivacyAlert(group, '15551234567'), false);
  f.advance(3_600_000);
  assert.equal(f.control.reservePrivacyAlert(group, '15551234567'), true);
});
