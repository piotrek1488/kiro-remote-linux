const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const storage = require('../out/storagePaths');
const { InteractionWatcher, phoneOptions, chooseOption, commandFor } = require('../out/interactionWatcher');

const KEY = 'fedcba9876543210';
const OPTIONS = [
  { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
  { optionId: 'trust', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
];
const now = () => new Date().toISOString();
const line = (id, payload) => JSON.stringify({ id, timestamp: now(), payload }) + '\n';
const pending = (id, extra = {}) => line(`${id}-pending`, {
  type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: id,
  question: 'Run `ls`?', options: OPTIONS, executionId: 'ex1', ...extra,
});
const resolved = (id) => line(`${id}-resolved`, { type: 'interaction_resolved', toolCallId: id, outcome: 'selected', executionId: 'ex1' });

function setup(t, name = 'sess_aaaaaaaa') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  storage.configureKiroHome(home);
  const logFor = (n) => {
    const dir = path.join(storage.KIRO_SESSIONS_V2_BASE, KEY, n);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id: n, title: n, workspacePaths: ['/w'] }));
    return path.join(dir, 'messages.jsonl');
  };
  return { log: logFor(name), logFor };
}

function harness(answer) {
  const sent = [];
  const commands = [];
  const relay = { send: () => {}, sendApprovalRequest: async (m) => { sent.push(m); return typeof answer === 'function' ? answer(m) : answer; } };
  const watcher = new InteractionWatcher(relay, 30, async (c) => { commands.push(c); });
  return { sent, commands, watcher };
}

test('option mapping never offers "always allow" and denies when in doubt', () => {
  assert.deepEqual(phoneOptions(OPTIONS).map(o => o.kind), ['allow_once', 'reject_once']);
  const offered = phoneOptions(OPTIONS);
  assert.equal(chooseOption(offered, { approved: true }).kind, 'allow_once');
  assert.equal(chooseOption(offered, { approved: false }).kind, 'reject_once');
  assert.equal(chooseOption(offered, { approved: true, answer: 'Reject' }).kind, 'reject_once');
  assert.equal(chooseOption(offered, { approved: false, answer: 'Always allow' }).kind, 'reject_once');
  assert.equal(commandFor(OPTIONS[0]), 'kiroAgent.execution.runOrAcceptAll');
  assert.equal(commandFor(OPTIONS[2]), 'kiroAgent.execution.rejectAll');
  assert.equal(commandFor(OPTIONS[1]), undefined);
});

test('a single pending approval is sent to the phone and applied once', async (t) => {
  const { log } = setup(t);
  fs.writeFileSync(log, pending('tc1'));
  const h = harness({ approved: true, answer: 'Allow' });
  await h.watcher.poll();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].command, 'Run `ls`?');
  assert.deepEqual(h.sent[0].options.map(o => o.label), ['Allow', 'Reject']);
  assert.deepEqual(h.commands, ['kiroAgent.execution.runOrAcceptAll']);
  await h.watcher.poll();                                   // same prompt is not asked twice
  assert.equal(h.sent.length, 1);
});

test('a denial runs rejectAll', async (t) => {
  const { log } = setup(t);
  fs.writeFileSync(log, pending('tc1'));
  const h = harness({ approved: false });
  await h.watcher.poll();
  assert.deepEqual(h.commands, ['kiroAgent.execution.rejectAll']);
});

test('nothing is applied if the IDE answered first', async (t) => {
  const { log } = setup(t);
  fs.writeFileSync(log, pending('tc1'));
  const h = harness(async () => { fs.appendFileSync(log, resolved('tc1')); return { approved: true }; });
  await h.watcher.poll();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.commands, []);
});

test('already resolved prompts are ignored', async (t) => {
  const { log } = setup(t);
  fs.writeFileSync(log, pending('tc1') + resolved('tc1'));
  const h = harness({ approved: true });
  await h.watcher.poll();
  assert.equal(h.sent.length, 0);
});

test('with several pending prompts the commands are never run', async (t) => {
  const { log, logFor } = setup(t);
  fs.writeFileSync(log, pending('tc1'));
  fs.writeFileSync(logFor('sess_bbbbbbbb'), pending('tc2'));
  const h = harness({ approved: true });
  await h.watcher.poll();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.commands, []);
});

test('questions needing typed answers and abandoned prompts are left alone', async (t) => {
  const { log } = setup(t);
  fs.writeFileSync(log, pending('tc1', { interactionType: 'user_input' }));
  const h = harness({ approved: true });
  await h.watcher.poll();
  assert.equal(h.sent.length, 0);

  const old = new Date(Date.now() - 3600_000);
  fs.writeFileSync(log, JSON.stringify({ id: 'x', timestamp: old.toISOString(), payload: { type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'old', question: 'q', options: OPTIONS } }) + '\n');
  fs.utimesSync(log, old, old);
  await h.watcher.poll();
  assert.equal(h.sent.length, 0);
});
