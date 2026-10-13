import * as os from 'os';
import * as path from 'path';

/** Default Electron user-data directory, used before the extension activates. */
export function resolveKiroUserDataDir(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Kiro');
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME;
    // XDG requires an absolute path; ignore an empty or relative value.
    return path.join(configHome && path.isAbsolute(configHome) ? configHome : path.join(home, '.config'), 'Kiro');
  }
  throw new Error(`Kiro Remote supports Linux and macOS; unsupported platform: ${platform}`);
}

export let KIRO_AGENT_BASE = path.join(resolveKiroUserDataDir(), 'User', 'globalStorage', 'kiro.kiroagent');
export let KIRO_SESSIONS_BASE = path.join(KIRO_AGENT_BASE, 'workspace-sessions');

/** Use Kiro's actual storage location, including profiles and --user-data-dir. */
export function configureKiroStorage(extensionGlobalStoragePath: string): void {
  KIRO_AGENT_BASE = path.join(path.dirname(extensionGlobalStoragePath), 'kiro.kiroagent');
  KIRO_SESSIONS_BASE = path.join(KIRO_AGENT_BASE, 'workspace-sessions');
}

/**
 * Newer Kiro releases (verified on 1.1.14) keep chats outside the Electron
 * user-data directory: ~/.kiro/sessions/<workspace-hash>/sess_<uuid>/
 * (session.json + messages.jsonl). The location is the same on Linux and macOS.
 */
export let KIRO_HOME = path.join(os.homedir(), '.kiro');
export let KIRO_SESSIONS_V2_BASE = path.join(KIRO_HOME, 'sessions');

/** Override the Kiro home directory (used by tests). */
export function configureKiroHome(kiroHome: string): void {
  KIRO_HOME = kiroHome;
  KIRO_SESSIONS_V2_BASE = path.join(KIRO_HOME, 'sessions');
}
