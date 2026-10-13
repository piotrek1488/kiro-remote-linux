/**
 * Reader for Kiro's current chat storage (verified on Kiro 1.1.14):
 *
 *   ~/.kiro/sessions/<workspace-hash>/sess_<uuid>/
 *     session.json     ← title, workspacePaths, createdAt, lastModifiedAt, ...
 *     messages.jsonl   ← one JSON object per line: { id, timestamp, payload }
 *
 * <workspace-hash> is the first 16 hex chars of sha256(workspace path). We never
 * compute it; the workspace path is read from session.json instead.
 *
 * payload.type values used here:
 *   user         { content }                       → user message
 *   turn_start   { executionId }                   → a new agent run begins
 *   assistant    { executionId, operationType, content }
 *                  operationType "Say" = visible answer, "Reasoning" = thinking
 *   tool_call    { executionId, title, toolName }  → current activity
 *   turn_end     { executionId, stopReason }       → the run is finished
 *
 * messages.jsonl files reach several MB, so each file is parsed incrementally:
 * we remember the byte offset of the last complete line and only read the tail.
 */
import * as fs from 'fs';
import * as path from 'path';
import { KIRO_SESSIONS_V2_BASE } from './storagePaths';

export const V2_LOG_NAME = 'messages.jsonl';
const WORKSPACE_KEY_RE = /^[0-9a-f]{16}$/;

export interface V2Session {
  sessionId: string;
  title: string;
  workspaceKey: string;
  workspacePath: string;
  createdAt: number;
  lastModifiedAt: number;
  logFile: string;
}

export interface V2Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  executionId?: string;
}

export interface V2PendingOption { optionId: string; name: string; kind: string }

/** An approval/question Kiro is waiting on (pending_interaction without interaction_resolved). */
export interface V2PendingInteraction {
  toolCallId: string;
  sessionId: string;
  logFile: string;
  interactionType: string;
  question: string;
  options: V2PendingOption[];
  executionId?: string;
  timestamp: number;
}

export interface V2Execution {
  executionId: string;
  sessionId: string;
  reasoning?: string;
  reasoningAt: number;
  say: string[];
  lastSayAt: number;
  lastTool?: string;
  ended: boolean;
}

interface ExecState {
  say: string[];
  firstSayAt: number;
  lastSayAt: number;
  reasoning?: string;
  reasoningAt: number;
  lastTool?: string;
  ended: boolean;
}

type OrderItem = { kind: 'user'; message: V2Message } | { kind: 'exec'; executionId: string };

/** Incremental model of one messages.jsonl file. */
class SessionLog {
  private offset = 0;
  private order: OrderItem[] = [];
  private execs = new Map<string, ExecState>();
  private lastExecutionId: string | undefined;
  private pending = new Map<string, Omit<V2PendingInteraction, 'sessionId' | 'logFile'>>();

  constructor(private readonly file: string) {}

  refresh(): void {
    let size: number;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) this.reset();       // file was rewritten/truncated
    if (size === this.offset) return;

    let buf: Buffer;
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
      } finally { fs.closeSync(fd); }
    } catch { return; }

    // Only consume complete lines; a half-written last line is read next time.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return;
    this.offset += end + 1;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (line.trim()) this.apply(line);
    }
  }

  messages(): V2Message[] {
    const out: V2Message[] = [];
    for (const item of this.order) {
      if (item.kind === 'user') { out.push(item.message); continue; }
      const exec = this.execs.get(item.executionId);
      const text = exec?.say.join('\n\n').trim();
      if (exec && text) {
        out.push({
          id: `exec-${item.executionId}`,
          role: 'assistant',
          text,
          timestamp: exec.firstSayAt,
          executionId: item.executionId,
        });
      }
    }
    return out;
  }

  pendingInteractions(): Array<Omit<V2PendingInteraction, 'sessionId' | 'logFile'>> {
    return [...this.pending.values()];
  }

  latestExecution(sessionId: string): V2Execution | null {
    if (!this.lastExecutionId) return null;
    const e = this.execs.get(this.lastExecutionId);
    if (!e) return null;
    return {
      executionId: this.lastExecutionId,
      sessionId,
      reasoning: e.reasoning,
      reasoningAt: e.reasoningAt,
      say: e.say,
      lastSayAt: e.lastSayAt,
      lastTool: e.lastTool,
      ended: e.ended,
    };
  }

  private reset() {
    this.offset = 0;
    this.order = [];
    this.execs.clear();
    this.pending.clear();
    this.lastExecutionId = undefined;
  }

  private exec(executionId: string): ExecState {
    let e = this.execs.get(executionId);
    if (!e) {
      e = { say: [], firstSayAt: 0, lastSayAt: 0, reasoningAt: 0, ended: false };
      this.execs.set(executionId, e);
      this.order.push({ kind: 'exec', executionId });
    }
    return e;
  }

  private apply(line: string) {
    let entry: { id?: string; timestamp?: string; payload?: Record<string, unknown> };
    try { entry = JSON.parse(line); } catch { return; }
    const p = entry.payload;
    if (!p || typeof p.type !== 'string') return;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) || 0 : 0;
    const executionId = typeof p.executionId === 'string' ? p.executionId : undefined;

    switch (p.type) {
      case 'user': {
        const text = typeof p.content === 'string' ? p.content.trim() : '';
        if (!text) return;
        this.order.push({
          kind: 'user',
          message: { id: `user-${entry.id ?? this.order.length}`, role: 'user', text, timestamp: ts },
        });
        return;
      }
      case 'turn_start':
        if (executionId) { this.exec(executionId); this.lastExecutionId = executionId; }
        return;
      case 'turn_end':
        if (executionId) this.exec(executionId).ended = true;
        return;
      case 'assistant': {
        if (!executionId || typeof p.content !== 'string' || !p.content.trim()) return;
        const e = this.exec(executionId);
        this.lastExecutionId = executionId;
        if (p.operationType === 'Say') {
          if (!e.say.length) e.firstSayAt = ts;
          e.say.push(p.content.trim());
          e.lastSayAt = ts;
        } else if (p.operationType === 'Reasoning') {
          e.reasoning = p.content.trim();
          e.reasoningAt = ts;
        }
        return;
      }
      case 'tool_call': {
        if (!executionId) return;
        const e = this.exec(executionId);
        this.lastExecutionId = executionId;
        const label = typeof p.title === 'string' && p.title ? p.title
          : typeof p.toolName === 'string' ? p.toolName : undefined;
        if (label) e.lastTool = label;
        return;
      }
      case 'pending_interaction': {
        if (typeof p.toolCallId !== 'string') return;
        const options = Array.isArray(p.options) ? (p.options as Array<Record<string, unknown>>)
          .filter(o => typeof o.optionId === 'string' && typeof o.kind === 'string')
          .map(o => ({ optionId: String(o.optionId), name: String(o.name ?? o.optionId), kind: String(o.kind) })) : [];
        this.pending.set(p.toolCallId, {
          toolCallId: p.toolCallId,
          interactionType: typeof p.interactionType === 'string' ? p.interactionType : 'unknown',
          question: typeof p.question === 'string' ? p.question : '',
          options,
          executionId,
          timestamp: ts,
        });
        return;
      }
      case 'interaction_resolved':
        if (typeof p.toolCallId === 'string') this.pending.delete(p.toolCallId);
        return;
      default:
        return;
    }
  }
}

const logs = new Map<string, SessionLog>();

function getLog(file: string): SessionLog {
  let l = logs.get(file);
  if (!l) { l = new SessionLog(file); logs.set(file, l); }
  l.refresh();
  return l;
}

/** True if `key` is a workspace directory in the current (~/.kiro/sessions) layout. */
export function isV2WorkspaceKey(key: string): boolean {
  return WORKSPACE_KEY_RE.test(key) && fs.existsSync(path.join(KIRO_SESSIONS_V2_BASE, key));
}

export function listV2WorkspaceKeys(): string[] {
  try {
    return fs.readdirSync(KIRO_SESSIONS_V2_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory() && WORKSPACE_KEY_RE.test(d.name))
      .map(d => d.name);
  } catch { return []; }
}

/** Sessions of one workspace, newest first. */
export function listV2Sessions(workspaceKey: string): V2Session[] {
  const base = path.join(KIRO_SESSIONS_V2_BASE, workspaceKey);
  let names: string[];
  try { names = fs.readdirSync(base); } catch { return []; }

  const out: V2Session[] = [];
  for (const name of names) {
    if (!name.startsWith('sess_')) continue;
    const dir = path.join(base, name);
    const logFile = path.join(dir, V2_LOG_NAME);
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); }
    catch { continue; }

    const workspacePaths = Array.isArray(meta.workspacePaths) ? meta.workspacePaths as unknown[] : [];
    const workspacePath = typeof workspacePaths[0] === 'string' ? workspacePaths[0] : workspaceKey;
    const created = typeof meta.createdAt === 'string' ? Date.parse(meta.createdAt) || 0 : 0;
    let modified = typeof meta.lastModifiedAt === 'string' ? Date.parse(meta.lastModifiedAt) || 0 : created;
    try { modified = Math.max(modified, fs.statSync(logFile).mtimeMs); } catch { /* no log yet */ }

    out.push({
      sessionId: typeof meta.id === 'string' ? meta.id : name,
      title: typeof meta.title === 'string' && meta.title ? meta.title : 'Chat',
      workspaceKey,
      workspacePath,
      createdAt: created,
      lastModifiedAt: modified,
      logFile,
    });
  }
  out.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
  return out;
}

export function readV2Messages(session: V2Session): V2Message[] {
  return getLog(session.logFile).messages();
}

/** Look up one session by id inside a workspace. */
export function findV2Session(workspaceKey: string, sessionId: string): V2Session | undefined {
  return listV2Sessions(workspaceKey).find(s => s.sessionId === sessionId);
}

export interface V2LogFile { path: string; mtimeMs: number }

/** All messages.jsonl files with their mtime (for activity detection). */
export function listV2LogFiles(): V2LogFile[] {
  const out: V2LogFile[] = [];
  for (const key of listV2WorkspaceKeys()) {
    const base = path.join(KIRO_SESSIONS_V2_BASE, key);
    let names: string[];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('sess_')) continue;
      const file = path.join(base, name, V2_LOG_NAME);
      try { out.push({ path: file, mtimeMs: fs.statSync(file).mtimeMs }); } catch { /* skip */ }
    }
  }
  return out;
}

/** Latest agent run of the session whose log is `file` (session id = directory name). */
export function readV2LatestExecution(file: string): V2Execution | null {
  return getLog(file).latestExecution(path.basename(path.dirname(file)));
}

/**
 * Unanswered approvals/questions in sessions whose log changed within `maxAgeMs`.
 * Entries older than `maxAgeMs` are treated as abandoned (e.g. Kiro was closed).
 */
export function listV2PendingInteractions(maxAgeMs: number): V2PendingInteraction[] {
  const cutoff = Date.now() - maxAgeMs;
  const out: V2PendingInteraction[] = [];
  for (const f of listV2LogFiles()) {
    if (f.mtimeMs < cutoff) continue;
    const sessionId = path.basename(path.dirname(f.path));
    for (const p of getLog(f.path).pendingInteractions()) {
      if (p.timestamp && p.timestamp < cutoff) continue;
      out.push({ ...p, sessionId, logFile: f.path });
    }
  }
  return out;
}
