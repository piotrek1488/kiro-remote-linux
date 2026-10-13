import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);
const INSTALL_DIR = path.join(os.homedir(), '.kiro-remote');
const BIN = path.join(INSTALL_DIR, 'cloudflared');

/** Linux releases are raw executables; macOS releases are tar archives. */
export function cloudflaredRelease(platform: NodeJS.Platform = process.platform, arch = os.arch()): { url: string; archive: boolean } {
  if (platform !== 'linux' && platform !== 'darwin') throw new Error(`Unsupported cloudflared platform: ${platform}`);
  const suffix = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (!suffix) throw new Error(`Unsupported cloudflared architecture: ${arch}`);
  const archive = platform === 'darwin';
  return {
    url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${platform}-${suffix}${archive ? '.tgz' : ''}`,
    archive,
  };
}

/** Returns a path to a working cloudflared, downloading+extracting if needed. */
export async function ensureCloudflared(): Promise<string | null> {
  // 1. Already on PATH
  try {
    await execFileAsync('cloudflared', ['--version'], { timeout: 5000 });
    return 'cloudflared';
  } catch { /* not on PATH */ }

  // 2. Already downloaded and working
  if (fs.existsSync(BIN)) {
    try {
      await execFileAsync(BIN, ['--version'], { timeout: 5000 });
      return BIN;
    } catch {
      try { fs.unlinkSync(BIN); } catch { /* ignore */ }
    }
  }

  // 3. Download to a private staging directory, verify, then publish atomically.
  let staging: string | undefined;
  try {
    const release = cloudflaredRelease();
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    staging = fs.mkdtempSync(path.join(INSTALL_DIR, '.cloudflared-'));
    const binary = path.join(staging, 'cloudflared');
    const download = release.archive ? path.join(staging, 'cloudflared.tgz') : binary;
    console.log(`📥 Downloading cloudflared (${process.platform}/${os.arch()})...`);
    await execFileAsync('curl', ['-fsSL', '--connect-timeout', '10', '--max-time', '120', '-o', download, release.url], { timeout: 130000 });
    if (release.archive) {
      await execFileAsync('tar', ['-xzf', download, '-C', staging, 'cloudflared'], { timeout: 10000 });
    }
    fs.chmodSync(binary, 0o755);
    await execFileAsync(binary, ['--version'], { timeout: 5000 });
    fs.renameSync(binary, BIN);
    console.log('✅ cloudflared installed');
    return BIN;
  } catch (e) {
    console.warn(`Could not install cloudflared: ${(e as Error).message}`);
    return null;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

export class TunnelManager {
  private tunnelProcess: ReturnType<typeof spawn> | null = null;
  private publicUrl: string | null = null;

  async start(port: number): Promise<string> {
    const bin = await ensureCloudflared();
    if (!bin) {
      throw new Error('cloudflared unavailable; install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ and restart the session');
    }

    return new Promise((resolve, reject) => {
      this.publicUrl = null;
      const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`]);
      this.tunnelProcess = child;
      let settled = false;
      const timer = setTimeout(() => fail(new Error('Tunnel startup timeout')), 20000);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stop();
        reject(error);
      };
      let output = '';
      const onData = (data: Buffer) => {
        if (settled) return;
        output = (output + data.toString()).slice(-16384);
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !this.publicUrl) {
          this.publicUrl = match[0];
          settled = true;
          clearTimeout(timer);
          resolve(this.publicUrl);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', fail);
      child.on('exit', (code, signal) => {
        fail(new Error(`cloudflared exited before opening a tunnel (code=${code}, signal=${signal})`));
        if (this.tunnelProcess === child) {
          this.tunnelProcess = null;
          this.publicUrl = null;
        }
      });
    });
  }

  stop(): void {
    this.tunnelProcess?.kill();
    this.tunnelProcess = null;
    this.publicUrl = null;
  }

  getUrl(): string | null {
    return this.publicUrl;
  }
}
