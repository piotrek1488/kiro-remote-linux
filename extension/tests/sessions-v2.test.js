const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const storage = require('../out/storagePaths');
const executions = require('../out/executionFiles');
const { ChatWatcher } = require('../out/chatWatcher');
const { KiroSessionManager } = require('../out/sessionManager');

// Fixture for the Kiro 1.1.x layout: ~/.kiro/sessions/<hash>/sess_<id>/{session.json,messages.jsonl}
const KEY = '0123456789abcdef';
const SESSION = 'sess_11111111-2222-3333-4444-555555555555';
const WORKSPACE = '/home/test/my project';

const line = (id, timestamp, payload) => JSON.stringify({ id, timestamp, payload }) + '\n';
const user = (id, text) => line(id, '2026-10-13T10:00:00.000Z', { type: 'user', content: text });
const start = (exec) => line(`s-${exec}`, '2026-10-13T10:00:01.000Z', { type: 'turn_start', executionId: exec });
const say = (id, exec, text) => line(id, '2026-10-13T10:00:02.000Z', { type: 'assistant', operationType: 'Say', executionId: exec, content: text });
const reason = (id, exec, text) => line(id, '2026-10-13T10:00:03.000Z', { type: 'assistant', operationType: 'Reasoning', executionId: exec, content: text });
const tool = (id, exec, title) => line(id, '2026-10-13T10:00:04.000Z', { type: 'tool_call', executionId: exec, toolName: 'readFile', title });
const end = (exec) => line(`e-${exec}`, '2026-10-13T10:00:05.000Z', { type: 'turn_end', executionId: exec, stopReason: 'end_turn' });

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  storage.configureKiroHome(home);
  const dir = path.join(storage.KIRO_SESSIONS_V2_BASE, KEY, SESSION);
  fs.mkdirSync(dir, { recursive: true });
  // The CLI keeps its own sessions here; they must not be mistaken for a workspace.
  fs.mkdirSync(path.join(storage.KIRO_SESSIONS_V2_BASE, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    id: SESSION, title: 'Ubuntu chat', workspacePaths: [WORKSPACE],
    createdAt: '2026-10-13T10:00:00.000Z', lastModifiedAt: '2026-10-13T10:00:05.000Z',
  }));
  const log = path.join(dir, 'messages.jsonl');
  return { dir, log };
}

test('reads sessions, history and the latest run from ~/.kiro/sessions', (t) => {
  const { log } = setup(t);
  fs.writeFileSync(log,
    user('u1', 'Hello') + start('ex1') + reason('r1', 'ex1', 'thinking about it') +
    say('a1', 'ex1', 'First part') + tool('t1', 'ex1', 'Read file') + say('a2', 'ex1', 'Second part') + end('ex1') +
    user('u2', 'Again') + start('ex2') + reason('r2', 'ex2', 'thinking again') + tool('t2', 'ex2', 'Run tests'));

  assert.deepEqual(ChatWatcher.getAllWorkspaceDirs(), [{ path: WORKSPACE, key: KEY }]);

  const messages = [];
  const relay = { send: m => messages.push(m), sendChatMessage: m => messages.push(m) };
  ChatWatcher.loadSessionHistory(relay, KEY, SESSION);
  assert.deepEqual(messages.map(m => [m.id, m.role, m.text]), [
    ['user-u1', 'user', 'Hello'],
    ['exec-ex1', 'assistant', 'First part\n\nSecond part'],   // Reasoning is not part of history
    ['user-u2', 'user', 'Again'],
  ]);
  assert.equal(messages[0].sessionTitle, 'Ubuntu chat');

  messages.length = 0;
  new KiroSessionManager(relay).sendNow();
  const [s] = messages[0].sessions;
  assert.equal(s.sessionId, SESSION);
  assert.equal(s.workspacePath, WORKSPACE);
  assert.equal(s.workspaceName, 'my project');
  assert.equal(s.workspaceKey, KEY);
  assert.equal(s.messageCount, 3);

  // The watchers share the legacy "execution" shape.
  const newest = executions.findNewestExecutionFile();
  assert.equal(path.basename(newest.path), 'messages.jsonl');
  assert.equal(executions.findRecentExecutionFiles(60000).length, 1);
  const run = executions.readExecutionFile(newest.path);
  assert.equal(run.executionId, 'ex2');
  assert.equal(run.chatSessionId, SESSION);
  assert.deepEqual(run.actions.map(a => [a.actionType, a.actionState]), [['reasoning', 'Running'], ['tool', 'Running']]);
  assert.equal(run.actions[0].output.message, 'thinking again');
  assert.equal(run.actions[1].toolName, 'Run tests');
  // Approvals are never reported for this layout (they cannot be answered via commands).
  assert.ok(!run.actions.some(a => a.actionState === 'PendingAction'));
});

test('parses appended lines incrementally and ignores a half-written last line', (t) => {
  const { log } = setup(t);
  fs.writeFileSync(log, user('u1', 'Hello') + start('ex1') + say('a1', 'ex1', 'Part one'));
  const messages = [];
  const relay = { send: m => messages.push(m), sendChatMessage: m => messages.push(m) };
  ChatWatcher.loadSessionHistory(relay, KEY, SESSION);
  assert.equal(messages.at(-1).text, 'Part one');

  const partial = say('a2', 'ex1', 'Part two');
  fs.appendFileSync(log, partial.slice(0, 20));            // writer is mid-line
  messages.length = 0;
  ChatWatcher.loadSessionHistory(relay, KEY, SESSION);
  assert.equal(messages.at(-1).text, 'Part one');

  fs.appendFileSync(log, partial.slice(20));               // line completed
  messages.length = 0;
  ChatWatcher.loadSessionHistory(relay, KEY, SESSION);
  assert.equal(messages.at(-1).text, 'Part one\n\nPart two');

  fs.writeFileSync(log, user('u9', 'Rewritten'));          // truncated / replaced file
  messages.length = 0;
  ChatWatcher.loadSessionHistory(relay, KEY, SESSION);
  assert.deepEqual(messages.map(m => m.text), ['Rewritten']);
});

test('ChatWatcher streams new messages from the current layout', async (t) => {
  const { log } = setup(t);
  fs.writeFileSync(log, user('u1', 'Hello') + start('ex1') + say('a1', 'ex1', 'Hi there'));
  const messages = [];
  const relay = { send: m => messages.push(m), sendChatMessage: m => messages.push(m) };
  const watcher = new ChatWatcher(relay, WORKSPACE, KEY);
  t.after(() => watcher.stop());
  watcher.start();
  assert.ok(messages.some(m => m.id === 'exec-ex1' && m.text === 'Hi there'));

  fs.appendFileSync(log, say('a2', 'ex1', 'More') + user('u2', 'Live update'));
  const deadline = Date.now() + 4000;
  while (!messages.some(m => m.text === 'Live update') && Date.now() < deadline) await delay(50);
  assert.ok(messages.some(m => m.id === 'user-u2' && m.text === 'Live update'));
  assert.ok(messages.some(m => m.id === 'exec-ex1' && m.text === 'Hi there\n\nMore'));
});
