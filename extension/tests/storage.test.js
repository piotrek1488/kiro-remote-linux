const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const storage = require('../out/storagePaths');
const executions = require('../out/executionFiles');
const reader = require('../out/executionReader');
const { ChatWatcher } = require('../out/chatWatcher');
const { KiroSessionManager } = require('../out/sessionManager');

test('default Kiro directories respect XDG and preserve macOS paths', () => {
  assert.equal(storage.resolveKiroUserDataDir('linux', '/home/test', {}), '/home/test/.config/Kiro');
  assert.equal(storage.resolveKiroUserDataDir('linux', '/home/test', { XDG_CONFIG_HOME: '/data/config' }), '/data/config/Kiro');
  for (const value of ['', 'relative/config']) {
    assert.equal(storage.resolveKiroUserDataDir('linux', '/home/test', { XDG_CONFIG_HOME: value }), '/home/test/.config/Kiro');
  }
  assert.equal(storage.resolveKiroUserDataDir('darwin', '/Users/test', {}), '/Users/test/Library/Application Support/Kiro');
});

test('all disk readers and live chat use the storage location supplied by Kiro', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Keep the real ~/.kiro/sessions of the machine running the tests out of this legacy-layout test.
  storage.configureKiroHome(path.join(dir, 'kiro-home'));
  storage.configureKiroStorage(path.join(dir, 'custom data', 'User', 'globalStorage', 'kiro-remote-control.kiro-remote-control'));
  const workspacePath = '/home/test/my project';
  const key = Buffer.from(workspacePath).toString('base64').replace(/=+$/, m => '_'.repeat(m.length));
  const sessionsDir = path.join(storage.KIRO_SESSIONS_BASE, key);
  const execDir = path.join(storage.KIRO_AGENT_BASE, 'hash', executions.EXEC_SUBDIR);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(execDir, { recursive: true });
  const execFile = path.join(execDir, 'execution-id');
  fs.writeFileSync(execFile, JSON.stringify({ executionId: 'exec-id', actions: [{ actionType: 'say', output: { message: 'Ubuntu response' } }] }));
  fs.writeFileSync(path.join(execDir, '.pending.tmp'), '{');
  const sessionFile = path.join(sessionsDir, 'session-id.json');
  const session = { title: 'Ubuntu chat', sessionId: 'session-id', history: [
    { message: { id: 'user-id', role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
    { executionId: 'exec-id', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
  ] };
  fs.writeFileSync(sessionFile, JSON.stringify(session));
  fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify([{ sessionId: 'session-id', title: 'Ubuntu chat' }]));
  assert.equal(executions.findNewestExecutionFile().path, execFile);
  assert.equal(executions.findRecentExecutionFiles(60000).length, 1);
  reader.buildExecutionCache();
  assert.equal(reader.getExecutionResponse('exec-id'), 'Ubuntu response');
  assert.deepEqual(ChatWatcher.getAllWorkspaceDirs(), [{ path: workspacePath, key }]);
  const messages = [];
  const relay = { send: m => messages.push(m), sendChatMessage: m => messages.push(m) };
  new KiroSessionManager(relay).sendNow();
  assert.equal(messages[0].sessions[0].workspacePath, workspacePath);
  ChatWatcher.loadSessionHistory(relay, key, 'session-id');
  assert.ok(messages.some(m => m.text === 'Ubuntu response'));
  const watcher = new ChatWatcher(relay, workspacePath, key);
  t.after(() => watcher.stop());
  watcher.start();
  session.history.push({ message: { id: 'live-id', role: 'user', content: [{ type: 'text', text: 'Live update' }] } });
  fs.writeFileSync(sessionFile, JSON.stringify(session));
  const deadline = Date.now() + 4000;
  while (!messages.some(m => m.text === 'Live update') && Date.now() < deadline) await delay(50);
  assert.ok(messages.some(m => m.id === 'live-id' && m.text === 'Live update'));
});
