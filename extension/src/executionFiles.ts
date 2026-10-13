/**
 * Shared helpers for locating Kiro's on-disk execution log files.
 *
 * Kiro writes each agent run to:
 *   <Kiro user-data>/User/globalStorage/
 *     kiro.kiroagent/<hash>/414d1636299d2b9e4ce7e17fb11f63e9/<uuid>
 *
 * The file Kiro is actively writing is the one with the newest mtime. Detecting
 * activity from mtime (rather than from the kiroAgent.* commands, which aren't
 * always available) is what makes streaming + status detection reliable.
 */
import * as fs from 'fs';
import * as path from 'path';

import { KIRO_AGENT_BASE } from './storagePaths';
import { listV2LogFiles, readV2LatestExecution, V2_LOG_NAME } from './kiroSessions';
export { KIRO_AGENT_BASE } from './storagePaths';
export const EXEC_SUBDIR = '414d1636299d2b9e4ce7e17fb11f63e9';

export interface NewestExecution {
  path: string;
  mtimeMs: number;
}

/** Find the execution file with the newest mtime across all execution dirs. */
export function findNewestExecutionFile(): NewestExecution | null {
  let newestFile: string | null = null;
  let newestMtime = 0;

  // Current layout: ~/.kiro/sessions/<ws>/sess_*/messages.jsonl
  for (const f of listV2LogFiles()) {
    if (f.mtimeMs > newestMtime) { newestMtime = f.mtimeMs; newestFile = f.path; }
  }

  let dirs: string[] = [];
  try { dirs = fs.readdirSync(KIRO_AGENT_BASE); }
  catch { /* legacy storage missing */ }

  for (const hashDir of dirs) {
    const execDir = path.join(KIRO_AGENT_BASE, hashDir, EXEC_SUBDIR);
    let files: string[];
    try { files = fs.readdirSync(execDir); }
    catch { continue; }

    for (const file of files) {
      // Kiro writes atomically as ".<name>.tmp" then renames. Skip temp/hidden
      // files — locking onto a half-written temp file breaks streaming.
      if (file.startsWith('.')) continue;
      const fpath = path.join(execDir, file);
      try {
        const stat = fs.statSync(fpath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = fpath;
        }
      } catch { /* skip */ }
    }
  }

  if (!newestFile) return null;
  return { path: newestFile, mtimeMs: newestMtime };
}

/** Find all execution files modified within `maxAgeMs` (newest first). */
export function findRecentExecutionFiles(maxAgeMs: number): NewestExecution[] {
  const cutoff = Date.now() - maxAgeMs;
  const out: NewestExecution[] = [];

  for (const f of listV2LogFiles()) {
    if (f.mtimeMs >= cutoff) out.push({ path: f.path, mtimeMs: f.mtimeMs });
  }

  let dirs: string[] = [];
  try { dirs = fs.readdirSync(KIRO_AGENT_BASE); }
  catch { /* legacy storage missing */ }

  for (const hashDir of dirs) {
    const execDir = path.join(KIRO_AGENT_BASE, hashDir, EXEC_SUBDIR);
    let files: string[];
    try { files = fs.readdirSync(execDir); }
    catch { continue; }

    for (const file of files) {
      if (file.startsWith('.')) continue; // skip ".<name>.tmp" atomic writes
      const fpath = path.join(execDir, file);
      try {
        const stat = fs.statSync(fpath);
        if (stat.isFile() && stat.mtimeMs >= cutoff) {
          out.push({ path: fpath, mtimeMs: stat.mtimeMs });
        }
      } catch { /* skip */ }
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export interface ParsedExecution {
  executionId?: string;
  chatSessionId?: string;
  actions?: Array<{ actionType?: string; actionState?: string; emittedAt?: number; output?: { message?: string }; [k: string]: unknown }>;
}

/**
 * Reads an execution. For the current layout (messages.jsonl) the latest agent
 * run is converted to the same shape as the legacy execution files, so the
 * watchers need no format-specific code. Pending approvals are intentionally
 * not mapped: they cannot be answered through the legacy kiroAgent commands.
 */
export function readExecutionFile(file: string): ParsedExecution | null {
  if (path.basename(file) === V2_LOG_NAME) {
    const run = readV2LatestExecution(file);
    if (!run) return null;
    const running = run.ended ? 'Done' : 'Running';
    const actions: NonNullable<ParsedExecution['actions']> = [];
    if (run.reasoning) {
      actions.push({ actionType: 'reasoning', actionState: running, emittedAt: run.reasoningAt, output: { message: run.reasoning } });
    }
    for (const message of run.say) {
      actions.push({ actionType: 'say', actionState: running, emittedAt: run.lastSayAt, output: { message } });
    }
    if (run.lastTool && !run.ended) {
      actions.push({ actionType: 'tool', toolName: run.lastTool, actionState: 'Running' });
    }
    return { executionId: run.executionId, chatSessionId: run.sessionId, actions };
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ParsedExecution;
  } catch {
    return null;
  }
}
