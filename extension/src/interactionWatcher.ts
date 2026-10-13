/**
 * InteractionWatcher — forwards Kiro's own tool-approval prompts to the phone
 * (current ~/.kiro/sessions layout) and applies the answer.
 *
 * Kiro 1.1.x writes a `pending_interaction` line to messages.jsonl when it asks
 * for permission and an `interaction_resolved` line once it is answered. There is
 * no command that takes a toolCallId; the chat view only exposes keyboard-style
 * commands that act on the prompt currently shown in the last active chat:
 *
 *   kiroAgent.execution.runOrAcceptAll → option of kind allow_once
 *   kiroAgent.execution.trust          → allow_always   (never offered to the phone)
 *   kiroAgent.execution.rejectAll      → reject option
 *
 * Because of that, the commands are only run when it is unambiguous which prompt
 * they will hit: exactly one prompt is pending, and it is re-checked right before
 * the command runs. Otherwise the prompt is left for the IDE.
 */
import { randomUUID } from 'crypto';
import { RelayClient } from './relayClient';
import { ApprovalRequestMessage } from './types';
import { agentState } from './agentState';
import { listV2PendingInteractions, V2PendingInteraction, V2PendingOption } from './kiroSessions';

function log(msg: string) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[kiro-remote:interaction ${ts}] ${msg}`);
}

/** Prompts older than this are considered abandoned (e.g. Kiro was closed). */
const MAX_AGE_MS = 10 * 60 * 1000;

export type RunCommand = (command: string) => Promise<unknown>;

const defaultRunCommand: RunCommand = async (command) => {
  const { commands } = await import('vscode');
  return commands.executeCommand(command);
};

/** Options the phone may choose from. "Always allow" is deliberately not offered. */
export function phoneOptions(options: V2PendingOption[]): V2PendingOption[] {
  const allow = options.find(o => o.kind === 'allow_once');
  const reject = options.find(o => o.kind === 'reject_once') ?? options.find(o => o.kind === 'reject_always');
  return [allow, reject].filter((o): o is V2PendingOption => !!o);
}

/** Pick the option answering the phone's response; denies when in doubt. */
export function chooseOption(
  offered: V2PendingOption[],
  result: { approved: boolean; answer?: string }
): V2PendingOption | undefined {
  if (result.answer) {
    const byAnswer = offered.find(o => o.name === result.answer || o.optionId === result.answer);
    if (byAnswer) return byAnswer;
  }
  return result.approved
    ? offered.find(o => o.kind === 'allow_once')
    : offered.find(o => o.kind.startsWith('reject'));
}

export function commandFor(option: V2PendingOption): string | undefined {
  if (option.kind === 'allow_once') return 'kiroAgent.execution.runOrAcceptAll';
  if (option.kind === 'reject_once' || option.kind === 'reject_always') return 'kiroAgent.execution.rejectAll';
  return undefined;
}

export class InteractionWatcher {
  private interval: NodeJS.Timeout | null = null;
  private handled = new Map<string, number>();
  private readonly pollMs = 800;

  constructor(
    private readonly relay: Pick<RelayClient, 'send' | 'sendApprovalRequest'>,
    private readonly timeoutSeconds: number,
    private readonly runCommand: RunCommand = defaultRunCommand,
    private readonly maxAgeMs: number = MAX_AGE_MS
  ) {}

  start() {
    this.interval = setInterval(() => this.poll(), this.pollMs);
    log('InteractionWatcher started');
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    log('InteractionWatcher stopped');
  }

  /** One scan; exposed for tests. Resolves when any started prompt has been handled. */
  poll(): Promise<void> {
    let pending: V2PendingInteraction[];
    try { pending = listV2PendingInteractions(this.maxAgeMs); }
    catch (e) { log(`poll error: ${e}`); return Promise.resolve(); }

    const approvals = pending.filter(p => p.interactionType === 'tool_approval');
    if (approvals.length > 1) {
      // The commands would hit whichever prompt is on screen; do not guess.
      for (const p of approvals) {
        if (!this.handled.has(p.toolCallId)) {
          this.handled.set(p.toolCallId, Date.now());
          log(`Several approvals are pending; leaving ${p.toolCallId} for the IDE`);
        }
      }
      return Promise.resolve();
    }

    const work: Promise<void>[] = [];
    for (const p of approvals) {
      if (this.handled.has(p.toolCallId)) continue;
      this.handled.set(p.toolCallId, Date.now());
      work.push(this.handle(p));
    }
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [id, at] of this.handled) if (at < cutoff) this.handled.delete(id);
    return Promise.all(work).then(() => undefined);
  }

  private stillPending(p: V2PendingInteraction): boolean {
    const now = listV2PendingInteractions(this.maxAgeMs).filter(x => x.interactionType === 'tool_approval');
    return now.length === 1 && now[0].toolCallId === p.toolCallId;
  }

  private async handle(p: V2PendingInteraction) {
    const offered = phoneOptions(p.options);
    if (!offered.some(o => o.kind === 'allow_once')) {
      log(`Approval ${p.toolCallId} has no "allow once" option; leaving it for the IDE`);
      return;
    }

    const message: ApprovalRequestMessage = {
      type: 'approval_request',
      id: randomUUID(),
      timestamp: Date.now(),
      command: p.question || 'Kiro asks for permission',
      toolName: 'Kiro approval',
      context: 'Kiro is waiting for your decision.',
      timeoutSeconds: this.timeoutSeconds,
      options: offered.map(o => ({ id: o.optionId, label: o.name })),
    };

    agentState.addPendingApproval(p.toolCallId);
    let result: { approved: boolean; answer?: string };
    try {
      log(`Sending approval ${p.toolCallId} to phone`);
      result = await this.relay.sendApprovalRequest(message);
    } finally {
      agentState.removePendingApproval(p.toolCallId);
    }

    const option = chooseOption(offered, result);
    const command = option && commandFor(option);
    if (!option || !command) { log(`No matching option for the phone's answer; leaving ${p.toolCallId}`); return; }

    // The IDE (or a newer prompt) may have changed things while the phone was thinking.
    if (!this.stillPending(p)) {
      log(`Approval ${p.toolCallId} was resolved or is no longer the only one; not applying "${option.name}"`);
      return;
    }
    try {
      await this.runCommand(command);
      log(`Applied "${option.name}" (${option.kind}) to ${p.toolCallId} via ${command}`);
    } catch (e) {
      log(`${command} failed: ${e}`);
    }
  }
}
