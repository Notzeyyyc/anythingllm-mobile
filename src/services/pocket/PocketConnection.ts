/**
 * AnythingPocket M1 — HP-side WS client for the Harness Companion sidecar.
 * Transport: plain ws:// (Tailscale/LAN). WSS + cert pinning is M3 (spec §9).
 * Handshake: first message {type:'auth', token} — pairing (hbk_) or session
 * (hbs_) token. Session token comes back once in auth.ok and lives in the
 * keychain (never in AsyncStorage or logs). Reconnect reuses the session
 * token with exponential backoff 1s..30s, reset on successful auth.
 */
import { v4 as uuidv4 } from 'uuid';

export type PocketStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected';

export interface TraceEvent {
  type: string; // e.g. tool.call.start, turn.start, llm.call.start
  turnId?: string;
  payload?: Record<string, unknown>;
}

export interface ApprovalRequest {
  approvalId: string;
  turnId: string;
  tool: string;
  path?: string;
  contentPreview?: string;
  ttlMs: number;
}

export interface TurnEnd {
  turnId: string;
  ok: boolean;
  text?: string;
  error?: string;
}

export interface PocketHandlers {
  onStatusChange: (status: PocketStatus) => void;
  onSessionStarted: (sessionId: string) => void;
  /** Fresh session token issued on pairing — store it in the keychain. */
  onSessionToken: (sessionToken: string) => void;
  onDelta: (turnId: string, delta: string) => void;
  onTurnEnd: (end: TurnEnd) => void;
  onApprovalRequest: (req: ApprovalRequest) => void;
  onTrace: (ev: TraceEvent) => void;
  onError: (message: string) => void;
}

/** Narrow the union of server messages; unknown/invalid frames return null. */
export function parsePocketMessage(raw: unknown): Record<string, any> | null {
  if (typeof raw !== 'string') return null;
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg === 'object' && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}

/** Backoff sequence for reconnects: 1s doubling, capped at 30s. */
export function backoffMs(attempt: number, maxMs = 30_000): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), maxMs);
}

export interface PocketConnectionOpts {
  url: string;
  /** Pairing (hbk_) token for the first connect, if no session token exists yet. */
  pairingToken: string;
  /** Saved session token (hbs_), if any. Reconnects always prefer it. */
  sessionToken?: string | null;
  handlers: PocketHandlers;
  /** Test hooks. */
  WebSocketCtor?: any;
  timer?: {
    set: (fn: (...args: any[]) => void, ms: number) => any;
    clear: (handle: any) => void;
  };
  heartbeatIntervalMs?: number;
}

const PING_INTERVAL_MS = 20_000;
/** Failed reconnects before surfacing an explicit offline state (~2min backoff). */
export const MAX_RECONNECT_ATTEMPTS = 6;

export class PocketConnection {
  private ws: any = null;
  private url: string;
  private pairingToken: string;
  private sessionToken: string | null;
  private handlers: PocketHandlers;
  private WS: any;
  private timer: {
    set: (fn: (...args: any[]) => void, ms: number) => any;
    clear: (handle: any) => void;
  };
  private heartbeatIntervalMs: number;

  private status: PocketStatus = 'disconnected';
  private attempt = 0;
  private wantConnected = false;
  private reconnectHandle: ReturnType<typeof setTimeout> | null = null;
  private heartbeatHandle: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private sessionStarted = false;
  private approvals = new Map<
    string,
    { turnId: string; handle: ReturnType<typeof setTimeout> }
  >();

  constructor(opts: PocketConnectionOpts) {
    this.url = opts.url;
    this.pairingToken = opts.pairingToken;
    this.sessionToken = opts.sessionToken ?? null;
    this.handlers = opts.handlers;
    this.WS = opts.WebSocketCtor ?? (global as any).WebSocket;
    this.timer = opts.timer ?? { set: setTimeout, clear: clearTimeout };
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? PING_INTERVAL_MS;
  }

  getStatus() {
    return this.status;
  }

  private setStatus(s: PocketStatus) {
    if (s === this.status) return;
    this.status = s;
    this.handlers.onStatusChange(s);
  }

  connect() {
    if (this.wantConnected) return;
    this.wantConnected = true;
    this.open();
  }

  private open() {
    if (!this.wantConnected || this.ws) return;
    this.setStatus(this.sessionToken ? 'connecting' : 'connecting');
    const token = this.sessionToken ?? this.pairingToken;
    let ws: any;
    try {
      ws = new this.WS(this.url);
    } catch (err) {
      this.handlers.onError(String(err));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    };
    ws.onmessage = (ev: any) => this.handleMessage(ev.data);
    ws.onerror = () => {
      /* close event follows; reconnect handled there */
    };
    ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      this.sessionStarted = false;
      this.sessionId = null;
      if (!this.wantConnected) {
        this.setStatus('disconnected');
        return;
      }
      // Give up after MAX_RECONNECT_ATTEMPTS failed closes so the UI can show
      // an explicit offline state instead of "connecting…" forever.
      if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
        this.setStatus('disconnected');
        return;
      }
      this.setStatus('connecting');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectHandle || !this.wantConnected) return;
    const wait = backoffMs(this.attempt);
    this.attempt += 1;
    this.reconnectHandle = this.timer.set(() => {
      this.reconnectHandle = null;
      this.open();
    }, wait);
  }

  private handleMessage(raw: unknown) {
    const msg = parsePocketMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'auth.ok':
        // Successful handshake: reset backoff, keep the session token if issued
        // (pairing flow — the sidecar sends it exactly once).
        this.attempt = 0;
        this.setStatus('connected');
        if (typeof msg.sessionToken === 'string' && msg.sessionToken) {
          this.sessionToken = msg.sessionToken;
          this.handlers.onSessionToken(msg.sessionToken);
        }
        this.startHeartbeat();
        this.send({ type: 'session.start' });
        break;
      case 'session.started':
        this.sessionId = msg.sessionId;
        this.sessionStarted = true;
        this.handlers.onSessionStarted(msg.sessionId);
        break;
      case 'turn.delta':
        this.handlers.onDelta(msg.turnId, String(msg.delta ?? ''));
        break;
      case 'turn.end': {
        this.clearApprovalTimers(msg.turnId);
        this.handlers.onTurnEnd({
          turnId: msg.turnId,
          ok: !!msg.ok,
          text: typeof msg.text === 'string' ? msg.text : undefined,
          error: typeof msg.error === 'string' ? msg.error : undefined,
        });
        break;
      }
      case 'approval.request': {
        const req: ApprovalRequest = {
          approvalId: msg.approvalId,
          turnId: msg.turnId,
          tool: msg.tool,
          path: msg.path,
          contentPreview: msg.contentPreview,
          ttlMs: Number(msg.ttlMs ?? 0),
        };
        // TTL hard, default REJECT (spec §6): local countdown auto-rejects,
        // mirroring the server-side sweep.
        if (req.ttlMs > 0) {
          const handle = this.timer.set(() => {
            this.approvals.delete(req.approvalId);
            if (this.wantConnected && this.ws) {
              this.send({
                type: 'approval.response',
                approvalId: req.approvalId,
                decision: 'reject',
              });
            }
          }, req.ttlMs);
          this.approvals.set(req.approvalId, { turnId: req.turnId, handle });
        }
        this.handlers.onApprovalRequest(req);
        break;
      }
      case 'error':
        this.handlers.onError(msg.message);
        break;
      default:
        // Everything else is a trace event envelope, e.g. tool.call.start.
        this.handlers.onTrace({ type: msg.type, turnId: msg.turnId, payload: msg.payload });
        break;
    }
  }

  private clearApprovalTimers(turnId: string) {
    for (const [id, pending] of this.approvals) {
      if (pending.turnId === turnId) {
        this.timer.clear(pending.handle);
        this.approvals.delete(id);
      }
    }
  }

  private stopApprovalTimer(approvalId: string) {
    const pending = this.approvals.get(approvalId);
    if (pending) {
      this.timer.clear(pending.handle);
      this.approvals.delete(approvalId);
    }
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    const interval = setInterval(() => {
      // Application-level ping — the sidecar answers with {"type":"pong"} and
      // never having to reach native WebSocket ping frames from JS.
      this.send({ type: 'ping' });
    }, this.heartbeatIntervalMs);
    this.heartbeatHandle = interval;
  }

  private stopHeartbeat() {
    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  /** Retry after a give-up: reset backoff and open again. */
  retry() {
    this.attempt = 0;
    this.wantConnected = true;
    this.open();
  }

  /** True once auth.ok + session.started have both landed. */
  isReady() {
    return this.status === 'connected' && this.sessionStarted;
  }

  /** Send a prompt; returns the generated turnId. No-op if not ready. */
  sendTurn(prompt: string): string | null {
    if (!this.isReady() || !prompt.trim()) return null;
    const turnId = uuidv4();
    this.send({ type: 'turn.request', turnId, prompt });
    return turnId;
  }

  respondApproval(approvalId: string, decision: 'grant' | 'reject') {
    this.stopApprovalTimer(approvalId);
    this.send({ type: 'approval.response', approvalId, decision });
  }

  /** Persist the session token issued by auth.ok (call from the keychain store). */
  setSessionToken(token: string | null) {
    this.sessionToken = token;
  }

  /** Close for good — no further reconnect attempts. */
  disconnect() {
    this.wantConnected = false;
    if (this.reconnectHandle) {
      this.timer.clear(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.stopHeartbeat();
    for (const { handle } of this.approvals.values()) this.timer.clear(handle);
    this.approvals.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.close();
    }
    this.setStatus('disconnected');
  }
}
