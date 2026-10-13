const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { SleepPrevention, sleepPreventionCommand } = require('../out/sleepPrevention');

test('sleep commands cover Linux and retain macOS behavior', () => {
  assert.equal(sleepPreventionCommand('linux').command, 'systemd-inhibit');
  assert.ok(sleepPreventionCommand('linux').args.includes('--what=idle:sleep'));
  assert.deepEqual(sleepPreventionCommand('darwin'), { command: 'caffeinate', args: ['-i', '-s', '-m'] });
  assert.equal(sleepPreventionCommand('win32'), null);
});

test('stopping a Linux session terminates the inhibitor and its child', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-inhibit-'));
  const oldPath = process.env.PATH;
  const pidFile = path.join(dir, 'child.pid');
  fs.writeFileSync(path.join(dir, 'systemd-inhibit'), `#!/bin/sh\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${oldPath}`;
  const logs = [];
  const inhibitor = new SleepPrevention(m => logs.push(m));
  t.after(() => { inhibitor.stop(); process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); });
  inhibitor.start();
  inhibitor.start(); // repeated start must not leave a second inhibitor
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await delay(20);
  assert.ok(fs.existsSync(pidFile));
  // The 'spawn' event is delivered asynchronously; under load it can lag behind the pid file.
  while (!logs.some(m => m.includes('Sleep prevention started')) && Date.now() < deadline) await delay(20);
  const pid = fs.readFileSync(pidFile, 'utf8').trim();
  inhibitor.stop();
  const isRunning = () => {
    try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
    catch { return false; }
  };
  const stopDeadline = Date.now() + 3000;
  while (isRunning() && Date.now() < stopDeadline) await delay(20);
  assert.equal(isRunning(), false);
  assert.equal(logs.filter(m => m.includes('Sleep prevention started')).length, 1);
});
