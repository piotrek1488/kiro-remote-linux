const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

function inbox(ws) {
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  return async (type, predicate = () => true) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const i = messages.findIndex(m => m.type === type && predicate(m));
      if (i !== -1) return messages.splice(i, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`No ${type} message received`);
  };
}

test('relay serves the PWA, streams chat, routes instructions and authorizes hook approvals', { timeout: 15000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-relay-'));
  const child = spawn(process.execPath, ['-e', `
    const {SessionManager} = require('./dist/session');
    const {createServer} = require('./dist/server');
    const manager = new SessionManager(60, 'TEST42'); manager.create();
    const server = createServer(manager);
    server.listen(0, '127.0.0.1', () => console.log('READY:'+server.address().port));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay startup timeout')), 5000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Relay exited ${code}`)); });
    child.stdout.on('data', data => {
      const match = data.toString().match(/READY:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await (await fetch(`${base}/health`)).json()).token, 'TEST42');
  assert.match(await (await fetch(base)).text(), /<html/);
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  assert.equal((await fetch(`${base}/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/hook/post-tool-use`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const bad = new WebSocket(`ws://127.0.0.1:${port}/mobile?token=WRONG`);
  await new Promise(resolve => bad.once('error', error => { assert.match(error.message, /401/); resolve(); }));
  const extension = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  const fromExtension = inbox(extension);
  await once(extension, 'open');
  t.after(() => extension.terminate());
  const mobile = new WebSocket(`ws://127.0.0.1:${port}/mobile?token=TEST42`);
  const fromMobile = inbox(mobile);
  await once(mobile, 'open');
  t.after(() => mobile.terminate());
  const send = (ws, type, fields) => ws.send(JSON.stringify({ type, id: type, timestamp: Date.now(), ...fields }));
  send(extension, 'chat_message', { text: 'Ubuntu stream', role: 'assistant', sessionId: 's1', sessionTitle: 'Test' });
  assert.equal((await fromMobile('chat_message')).text, 'Ubuntu stream');
  send(mobile, 'send_to_session', { sessionId: 's1', workspacePath: '/home/test/project', message: 'Continue' });
  assert.equal((await fromExtension('send_to_session')).message, 'Continue');
  for (const approved of [true, false]) {
    const response = fetch(`${base}/hook/pre-tool-use`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer TEST42' }, body: JSON.stringify({ tool_name: 'shell', tool_input: { command: 'echo test' } }) });
    const request = await fromMobile('approval_request');
    send(mobile, 'approval_response', { requestId: request.id, approved });
    assert.equal((await (await response).json()).action, approved ? 'allow' : 'deny');
  }
});

test('terminal QR is a single chunk that starts with a newline and has aligned rows', () => {
  const { renderTerminalQR } = require('../dist/qr');
  const out = renderTerminalQR('https://example.trycloudflare.com/?token=abc');
  assert.ok(out.startsWith('\n'));
  const rows = out.split('\n').filter(l => /^[█▀▄ ]+$/.test(l) && l.includes('█'));
  assert.ok(rows.length > 10);
  assert.equal(new Set(rows.map(r => [...r].length)).size, 1);   // every row has the same width
  assert.ok(out.includes('https://example.trycloudflare.com/?token=abc'));
});
