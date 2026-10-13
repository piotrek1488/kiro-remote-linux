import { ChildProcess, spawn } from 'child_process';

export function sleepPreventionCommand(platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'caffeinate', args: ['-i', '-s', '-m'] };
  if (platform === 'linux') {
    return {
      command: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--who=Kiro Remote', '--why=Remote session active', '--mode=block', 'sleep', 'infinity'],
    };
  }
  return null;
}

/** Own one inhibitor for the lifetime of a remote session. Failures are optional. */
export class SleepPrevention {
  private child: ChildProcess | null = null;

  constructor(private readonly log: (message: string) => void) {}

  start(): void {
    if (this.child) return;
    const spec = sleepPreventionCommand();
    if (!spec) return;
    // A separate process group lets us stop both systemd-inhibit and its sleep
    // child, which may otherwise retain the inhibitor after its parent exits.
    const child = spawn(spec.command, spec.args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    child.stderr?.on('data', (data: Buffer) => this.log(`Sleep prevention: ${data.toString().trim()}`));
    child.on('error', (error) => {
      if (this.child === child) this.child = null;
      this.log(`Sleep prevention unavailable (${spec.command}): ${error.message}`);
    });
    child.on('spawn', () => this.log(`Sleep prevention started (${spec.command}, pid ${child.pid})`));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.log(`Sleep prevention ended (code=${code}, signal=${signal}); check systemd-logind permissions on Linux`);
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.log(`Could not stop sleep prevention: ${error}`);
      }
    }
    this.log('Sleep prevention OFF');
  }
}
