/**
 * AnythingPocket sidecar — agent runtime over WS (spec §4.1, §6; WS protocol v1).
 * Bridges lite/agent.ts to the WS server: turn.request starts the agent loop
 * async (never blocks the WS event loop), text deltas stream as turn.delta,
 * approvals go to the device as approval.request with a hard server-side TTL —
 * no response before ttlMs = auto REJECT (db sweep records approval.expired).
 * One device = one active turn; a second turn.request gets "turn in progress".
 */
import * as fs from 'node:fs';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { insertEvent, createApproval, resolveApproval, getApproval, appendHistory } from './db.ts';
import { runLiteAgent } from './lite/agent.ts';
import type { HarnessRuntime, RunTurnResult } from './full/HarnessRuntime.ts';
import type { EventType } from './schema.ts';

export interface RuntimeOpts {
  workspace: string;
  model?: LanguageModel;        // default: env-configured provider (lazy, on first turn)
  ttlMs?: number;               // approval hard TTL, default 30s (spec §6)
  /** Router decision (spec §4.3): 'lite' | 'full'. Default 'lite'. */
  runtimeChoice?: 'lite' | 'full';
  /** Full-mode runtime (PiRuntime). Required when runtimeChoice === 'full'. */
  harnessRuntime?: HarnessRuntime;
}

export type ApprovalRequest = { tool: string; path: string; content: string; diff: string | null };
export type ApprovalDecision = { approved: boolean; approvalId: string };
/** Approval handler interface: stdin (CLI) and ws (runtime) both implement this. */
export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** Default model from env (same contract as the CLI). Key read from file, never logged. */
export function envModel(): LanguageModel {
  const model = process.env.POCKET_MODEL ?? 'ngd/ngodeai/gemini-3.8-flash';
  const baseURL = process.env.POCKET_BASE_URL ?? 'http://127.0.0.1:20128/v1';
  const keyFile = process.env.POCKET_API_KEY_FILE ?? '/root/.secrets/9router_local_key.txt';
  const apiKey = fs.readFileSync(keyFile, 'utf8').trim();
  return createOpenAICompatible({ name: 'pocket', baseURL, apiKey })(model);
}

export class DeviceRuntime {
  private readonly opts: RuntimeOpts;
  private readonly sessionId: string;
  private readonly send: (msg: Record<string, unknown>) => void;
  private activeTurnId: string | null = null;
  private activeAbort: AbortController | null = null;
  private readonly pending = new Map<string, (approved: boolean) => void>();

  constructor(opts: RuntimeOpts, sessionId: string, send: (msg: Record<string, unknown>) => void) {
    this.opts = opts;
    this.sessionId = sessionId;
    this.send = send;
  }

  emit(turnId: string, type: EventType, payload: Record<string, unknown> = {}): void {
    insertEvent(this.sessionId, turnId, type, payload);
  }

  /** Returns false (and sends the protocol error) when a turn is already active. */
  startTurn(turnId: string, prompt: string): boolean {
    if (this.activeTurnId) {
      this.send({ type: 'error', message: 'turn in progress' });
      return false;
    }
    this.activeTurnId = turnId;
    this.activeAbort = new AbortController();
    this.emit(turnId, 'turn.start', { prompt });
    appendHistory(this.sessionId, turnId, 'user', prompt);
    void this.run(turnId, prompt); // async: WS event loop stays free
    return true;
  }

  get busy(): boolean {
    return this.activeTurnId !== null;
  }

  private async run(turnId: string, prompt: string): Promise<void> {
    try {
      let result: RunTurnResult | { text: string };
      if (this.opts.runtimeChoice === 'full') {
        if (!this.opts.harnessRuntime) throw new Error('full runtime not configured');
        result = await this.opts.harnessRuntime.runTurn({
          turnId, prompt, sessionId: this.sessionId, workspace: this.opts.workspace,
          approvalHandler: (req) => this.requestApproval(turnId, req),
          emit: (type, payload) => this.emit(turnId, type, payload),
          onDelta: (delta) => this.send({ type: 'turn.delta', turnId, delta }),
          signal: this.activeAbort!.signal,
        });
      } else {
        result = await runLiteAgent({
          model: this.opts.model ?? envModel(),
          prompt,
          sessionId: this.sessionId,
          turnId,
          workspace: this.opts.workspace,
          approvalHandler: (req) => this.requestApproval(turnId, req),
          emit: (type, payload) => this.emit(turnId, type, payload),
          onDelta: (delta) => this.send({ type: 'turn.delta', turnId, delta }),
          signal: this.activeAbort!.signal,
        });
      }
      const ok = !('ok' in result) || result.ok !== false;
      const reason = 'reason' in result ? result.reason : undefined;
      if (this.opts.runtimeChoice === 'full') {
        this.emit(turnId, 'turn.end', { ok, reason }); // lite path emits its own turn.end
      }
      // Minimal session serialization (spec §4.2): history lives in SQLite.
      if (ok && (result as { text?: string | null }).text) {
        appendHistory(this.sessionId, turnId, 'assistant', String((result as { text?: string | null }).text));
      }
      this.send({
        type: 'turn.end', turnId, ok, text: (result as { text?: string | null }).text ?? null,
        error: ok ? null : reason === 'interrupted' ? 'interrupted' : (result as { error?: string }).error ?? 'error',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const wasInterrupted = this.activeAbort?.signal.aborted === true;
      this.send({
        type: 'turn.end', turnId, ok: false, text: null,
        error: wasInterrupted ? 'interrupted' : msg.slice(0, 500),
      });
    } finally {
      this.activeTurnId = null;
      this.activeAbort = null;
    }
  }

  /** Interrupt the active turn mid-run (WS turn.interrupt, protocol v1.1). */
  interrupt(): boolean {
    if (!this.activeTurnId || !this.activeAbort) return false;
    if (this.opts.runtimeChoice === 'full') this.opts.harnessRuntime?.interrupt(this.activeTurnId);
    this.activeAbort.abort(); // lite path: streamText aborts via signal
    return true;
  }

  private async requestApproval(turnId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    const ttlMs = this.opts.ttlMs ?? 30_000;
    const ap = createApproval(this.sessionId, turnId, req.tool, {
      command: req.path, diff: req.diff ?? req.content, ttlMs,
    });
    this.emit(turnId, 'approval.requested', {
      approvalId: ap.id, tool: req.tool, command: req.path,
      diff: req.diff ?? undefined, ttlMs,
    });
    this.send({
      type: 'approval.request', approvalId: ap.id, turnId, tool: req.tool,
      path: req.path, contentPreview: req.content.slice(0, 2000), ttlMs,
    });
    // TTL hard, default REJECT: no approval.response in time → false. The db
    // sweep (ws.ts) expires the row + records approval.expired in the trace.
    const approved = await new Promise<boolean>((res) => {
      this.pending.set(ap.id, res);
      const t = setTimeout(() => { if (this.pending.delete(ap.id)) res(false); }, ttlMs);
      t.unref?.();
    });
    return { approved, approvalId: ap.id };
  }

  /** Wire approval.response → pending waiter. Unknown/late/foreign ids are ignored (idempotent). */
  onApprovalResponse(approvalId: string, decision: 'grant' | 'reject'): void {
    const res = this.pending.get(approvalId);
    if (!res) return; // idempotent: second response or already expired → ignored
    const status = resolveApproval(approvalId, decision === 'grant' ? 'granted' : 'rejected');
    if (!status) return; // sweep expired it in the meantime → stays REJECT
    this.pending.delete(approvalId);
    res(decision === 'grant');
  }
}
