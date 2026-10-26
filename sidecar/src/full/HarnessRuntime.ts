/**
 * AnythingPocket sidecar — HarnessRuntime abstraction (spec §4.2).
 * Contract in front of any Full-mode agent runtime (Pi today). Exit criteria:
 * if Pi breaks >2x/quarter, swap the implementation behind this interface in
 * <1 sprint. Event + approval contracts are IDENTICAL to Lite (lite/agent.ts):
 * emit() uses the single trace schema, approvalHandler is Promise-based with
 * the same ApprovalRequest/ApprovalDecision shape (default REJECT upstream).
 */

/** Same shape as runtime.ts ApprovalHandler — one contract for Lite & Full. */
export type RuntimeApprovalHandler = (req: {
  tool: string; path: string; content: string; diff: string | null;
}) => Promise<{ approved: boolean; approvalId: string }>;

export interface RunTurnInput {
  turnId: string;
  prompt: string;
  sessionId: string;
  workspace: string;
  approvalHandler: RuntimeApprovalHandler;
  /** Trace sink — bound to session/turn by the caller (db.insertEvent). */
  emit: (type: import('../schema.ts').EventType, payload: Record<string, unknown>) => void;
  /** Stream text deltas (WS turn.delta). */
  onDelta?: (delta: string) => void;
  /** Abort signal — aborted = interrupt mid-run. */
  signal?: AbortSignal;
}

export interface RunTurnResult {
  ok: boolean;
  text: string | null;
  /** 'interrupted' when the run was aborted mid-turn (turn.end reason). */
  reason?: 'interrupted';
  error?: string;
}

export interface HarnessRuntime {
  readonly name: string;
  runTurn(input: RunTurnInput): Promise<RunTurnResult>;
  /** Interrupt the in-flight turn (mid-run). No-op when turnId isn't running. */
  interrupt(turnId: string): void;
}
