const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cloudflaredRelease } = require('../dist/tunnel');

test('cloudflared release selection supports Linux and macOS x64/arm64', () => {
  for (const platform of ['linux', 'darwin']) for (const arch of ['x64', 'arm64']) {
    const release = cloudflaredRelease(platform, arch);
    assert.ok(release.url.endsWith(`cloudflared-${platform}-${arch === 'x64' ? 'amd64' : 'arm64'}${platform === 'darwin' ? '.tgz' : ''}`));
    assert.equal(release.archive, platform === 'darwin');
  }
  assert.throws(() => cloudflaredRelease('linux', 'ia32'), /architecture/);
  assert.throws(() => cloudflaredRelease('win32', 'x64'), /platform/);
});

test('shell installer handles raw Linux binaries and macOS archives, and leaves no partial installs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'cloudflared'), '#!/bin/sh\necho "cloudflared test version"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo "$TEST_OS";; -m) echo "$TEST_ARCH";; esac\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
if [ "$TEST_FAIL" = 1 ]; then exit 22; fi
while [ "$#" -gt 0 ]; do
  case "$1" in -o) DEST="$2"; shift;; https://*) URL="$1";; esac
  shift
done
echo "$URL" > "$TEST_DIR/url"
case "$URL" in
  *.tgz) tar -czf "$DEST" -C "$TEST_DIR" cloudflared;;
  *) cp "$TEST_DIR/cloudflared" "$DEST";;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TEST_DIR: dir };
  for (const [platform, arch, asset] of [['Linux', 'x86_64', 'linux-amd64'], ['Linux', 'aarch64', 'linux-arm64'], ['Darwin', 'x86_64', 'darwin-amd64.tgz'], ['Darwin', 'arm64', 'darwin-arm64.tgz']]) {
    const home = path.join(dir, platform + arch);
    execFileSync('/bin/sh', [path.join(__dirname, '../scripts/install.sh')], { env: { ...env, HOME: home, TEST_OS: platform, TEST_ARCH: arch } });
    assert.ok(fs.readFileSync(path.join(dir, 'url'), 'utf8').trim().endsWith(`cloudflared-${asset}`));
    assert.match(execFileSync(path.join(home, '.kiro-remote/cloudflared'), ['--version'], { encoding: 'utf8' }), /test version/);
    assert.deepEqual(fs.readdirSync(path.join(home, '.kiro-remote')), ['cloudflared']);
  }
  const failedHome = path.join(dir, 'failure');
  assert.throws(() => execFileSync('/bin/sh', [path.join(__dirname, '../scripts/install.sh')], { env: { ...env, HOME: failedHome, TEST_OS: 'Linux', TEST_ARCH: 'x86_64', TEST_FAIL: '1' } }));
  assert.deepEqual(fs.readdirSync(path.join(failedHome, '.kiro-remote')), []);

  // Exercise the automatic Node installer in an isolated home too.
  const runtimeHome = path.join(dir, 'runtime');
  const modulePath = path.join(__dirname, '../dist/tunnel');
  const output = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).ensureCloudflared().then(p => { if (!p) process.exitCode=1; else console.log('INSTALLED'); })`], { env: { ...env, HOME: runtimeHome }, encoding: 'utf8' });
  assert.match(output, /INSTALLED/);
  assert.deepEqual(fs.readdirSync(path.join(runtimeHome, '.kiro-remote')), ['cloudflared']);
});
