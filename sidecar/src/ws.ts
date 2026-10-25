/**
 * AnythingPocket sidecar — WS server (spec §3.1, §5.2, §6).
 * Path /ws, first message must be {type:'auth', token} (handshake).
 * Pairing token (hbk_) → issues session token (hbs_); reconnect uses session
 * token, no re-pair. Lockout 5 failed handshakes per IP (fail2ban, in-memory).
 * Ping/pong keepalive. Approval sweep enforces TTL hard, default REJECT.
 */
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import * as path from 'node:path';
import type { LanguageModel } from 'ai';
import {
  insertEvent, createSession, createApproval, resolveApproval,
  expireStaleApprovals, getApproval,
} from './db.ts';
import { authenticate, isLockedOut } from './auth.ts';
import { DeviceRuntime } from './runtime.ts';
import type { EventType } from './schema.ts';
import { isValidEvent, EVENT_TYPES as EVENT_TYPES_SET } from './schema.ts';

export interface ServerOpts {
  port?: number;   // default 7443 (env PORT)
  bind?: string;   // default 127.0.0.1 (env BIND)
  /** Agent runtime (WS protocol v1). model default: env-configured provider, lazy. */
  model?: LanguageModel;
  workspace?: string;           // sandbox root for the agent's file tools
  approvalTtlMs?: number;       // hard approval TTL, default 30s (spec §6)
}

const AUTH_TIMEOUT_MS = 5_000;
const PING_INTERVAL_MS = 20_000;
const APPROVAL_SWEEP_MS = 250;
const MAX_TTL_MS = 5 * 60_000;

function ipOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

export function startServer(opts: ServerOpts = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 7443);
  const bind = opts.bind ?? process.env.BIND ?? '127.0.0.1';

  const wss = new WebSocketServer({ host: bind, port, path: '/ws' });

  type Ctx = { deviceId: string; sessionId: string | null; alive: boolean; runtime: DeviceRuntime | null };
  const authed = new Map<WebSocket, Ctx>();
  const workspaceDir = opts.workspace ?? path.resolve(import.meta.dirname, '../workspace');

  function send(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function trace(sessionId: string, turnId: string, type: EventType, payload: Record<string, unknown> = {}) {
    return insertEvent(sessionId, turnId, type, payload);
  }

  // Approval TTL sweep — hard TTL, default REJECT (status 'expired'), recorded in trace.
  const sweep = setInterval(() => {
    for (const a of expireStaleApprovals()) {
      trace(a.sessionId, a.turnId, 'approval.expired', { approvalId: a.id });
      for (const [ws, ctx] of authed) {
        if (ctx.sessionId === a.sessionId) send(ws, { type: 'approval.expired', approvalId: a.id });
      }
    }
  }, APPROVAL_SWEEP_MS);
  sweep.unref();

  // Ping/pong keepalive.
  const keepalive = setInterval(() => {
    for (const [ws, ctx] of authed) {
      if (!ctx.alive) { ws.terminate(); authed.delete(ws); continue; }
      ctx.alive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  keepalive.unref();

  wss.on('connection', (ws, req) => {
    const ip = ipOf(req);
    let ctx: Ctx = { deviceId: '', sessionId: null, alive: true, runtime: null };
    let authedOk = false;

    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);
    ws.on('close', () => { clearTimeout(authTimer); authed.delete(ws); });
    ws.on('pong', () => { if (ctx) ctx.alive = true; });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)); } catch { send(ws, { type: 'error', message: 'bad JSON' }); return; }

      // --- handshake: first message must be auth ---
      if (!authedOk) {
        if (msg.type !== 'auth') { ws.close(4003, 'first message must be auth'); return; }
        if (isLockedOut(ip)) {
          send(ws, { type: 'auth.deny', reason: 'locked out (too many failed attempts)' });
          ws.close(4029, 'locked out');
          return;
        }
        const token = typeof msg.token === 'string' ? msg.token : '';
        const res = authenticate(ip, token, dbApi);
        if (!res.ok) {
          send(ws, { type: 'auth.deny', reason: res.reason });
          ws.close(4003, res.reason ?? 'auth failed');
          return;
        }
        ctx.deviceId = res.deviceId!;
        ctx.alive = true;
        authedOk = true;
        authed.set(ws, ctx);
        clearTimeout(authTimer);
        send(ws, {
          type: 'auth.ok',
          deviceId: res.deviceId,
          // session token sent exactly once, on pairing; reconnect uses it
          ...(res.sessionToken ? { sessionToken: res.sessionToken } : {}),
        });
        return;
      }

      // --- post-auth messages ---
      if (!ctx.sessionId) {
        const t = msg.type;
        if (t !== 'session.start' && t !== 'ping' && t !== 'turn.request' && t !== 'approval.response'
            && !(typeof t === 'string' && EVENT_TYPES_SET.has(t))) {
          send(ws, { type: 'error', message: 'unknown message type: ' + String(t) }); return;
        }
      }
      switch (msg.type) {
        case 'ping': send(ws, { type: 'pong' }); return;

        case 'session.start': {
          ctx.sessionId = createSession(ctx.deviceId);
          trace(ctx.sessionId, ctx.sessionId, 'session.start', { device: ctx.deviceId });
          ctx.runtime = new DeviceRuntime(
            { workspace: workspaceDir, model: opts.model, ttlMs: opts.approvalTtlMs },
            ctx.sessionId,
            (m) => send(ws, m),
          );
          send(ws, { type: 'session.started', sessionId: ctx.sessionId });
          return;
        }

        // --- WS protocol v1: agent runtime --------------------------------
        case 'turn.request': {
          const sid = ctx.sessionId;
          if (!sid) { send(ws, { type: 'error', message: 'start a session first (session.start)' }); return; }
          const prompt = typeof msg.prompt === 'string' ? msg.prompt : '';
          if (!prompt) { send(ws, { type: 'error', message: 'prompt required' }); return; }
          const turnId = typeof msg.turnId === 'string' && msg.turnId ? msg.turnId : randomUUID();
          ctx.runtime!.startTurn(turnId, prompt); // false → already sent {type:'error',message:'turn in progress'}
          return;
        }

        case 'approval.response': {
          const sid = ctx.sessionId;
          if (!sid) { send(ws, { type: 'error', message: 'start a session first (session.start)' }); return; }
          const approvalId = typeof msg.approvalId === 'string' ? msg.approvalId : '';
          // Ownership check: only approvals of THIS device's session. Unknown or
          // foreign ids are silently ignored (idempotent, no info leak).
          const ap = approvalId ? getApproval(approvalId) : null;
          if (!ap || ap.sessionId !== sid) return;
          const decision = msg.decision === 'grant' ? 'grant' : 'reject'; // anything else = REJECT
          ctx.runtime!.onApprovalResponse(approvalId, decision);
          return;
        }

        // Trace events travel as their own type, e.g. {"type":"tool.call.start",
        // "turnId":"...","payload":{...}} — one envelope, same shape as the trace
        // schema. Control verbs (auth/session.start/approval.*) are reserved names.
        case 'turn.start':
        case 'turn.end':
        case 'llm.call.start':
        case 'llm.call.end':
        case 'tool.call.start':
        case 'tool.call.end': {
          const sid = ctx.sessionId;
          if (!sid) { send(ws, { type: 'error', message: 'start a session first (session.start)' }); return; }
          const turnId = typeof msg.turnId === 'string' && msg.turnId ? msg.turnId : randomUUID();
          const payload = objOf(msg.payload);
          const ev = trace(sid, turnId, msg.type as EventType, payload);
          send(ws, { type: 'event.accepted', eventType: msg.type, id: ev.id, rev: ev.rev });
          return;
        }

        case 'event': { // deprecated alias for trace events with explicit msg.type
          const sid = ctx.sessionId;
          if (!sid) { send(ws, { type: 'error', message: 'start a session first (session.start)' }); return; }
          const candidate = { ...objOf(msg), id: 'x', ts: new Date().toISOString(), sessionId: sid, rev: 0 };
          if (!isValidEvent(candidate)) { send(ws, { type: 'error', message: 'invalid event' }); return; }
          const ev = trace(sid, candidate.turnId, candidate.type, candidate.payload);
          send(ws, { type: 'event.accepted', eventType: candidate.type, id: ev.id, rev: ev.rev });
          return;
        }

        case 'approval.create': {
          const sid = ctx.sessionId;
          if (!sid) { send(ws, { type: 'error', message: 'start a session first (session.start)' }); return; }
          const p = objOf(msg.payload);
          const turnId = typeof msg.turnId === 'string' && msg.turnId ? msg.turnId : randomUUID();
          const tool = String(p.tool ?? 'unknown');
          const ttlMs = typeof p.ttlMs === 'number' && p.ttlMs > 0 ? Math.min(p.ttlMs, MAX_TTL_MS) : undefined;
          const ap = createApproval(sid, turnId, tool, {
            command: typeof p.command === 'string' ? p.command : undefined,
            diff: typeof p.diff === 'string' ? p.diff : undefined,
            ttlMs,
          });
          trace(sid, turnId, 'approval.requested', {
            approvalId: ap.id, tool,
            command: typeof p.command === 'string' ? p.command : undefined,
            diff: typeof p.diff === 'string' ? p.diff : undefined,
            ttlMs,
          });
          send(ws, { type: 'approval.pending', approvalId: ap.id, turnId, expiresAt: ap.expiresAt });
          return;
        }

        case 'approval.resolve': {
          const sid = ctx.sessionId;
          if (!sid) { send(ws, { type: 'error', message: 'start a session first (session.start)' }); return; }
          const approvalId = String(msg.approvalId ?? '');
          const decision = msg.decision === 'granted' ? 'granted' : 'rejected'; // anything else = REJECT
          const ap = getApproval(approvalId);
          if (!ap || ap.sessionId !== sid) { send(ws, { type: 'error', message: 'unknown approval' }); return; }
          // Late resolve (TTL already fired) never grants — idempotent resolve returns null.
          const status = resolveApproval(approvalId, decision) ?? getApproval(approvalId)!.status;
          trace(sid, ap.turnId, status === 'granted' ? 'approval.granted' : 'approval.rejected',
            { approvalId, reason: decision === 'granted' ? undefined : String(msg.reason ?? 'rejected') });
          send(ws, { type: 'approval.resolved', approvalId, status });
          return;
        }

        default:
          send(ws, { type: 'error', message: `unknown message type: ${String(msg.type)}` });
      }
    });
  });

  function objOf(v: unknown): Record<string, unknown> {
    return (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  }

  return {
    wss,
    port,
    bind,
    close(): Promise<void> {
      clearInterval(sweep); clearInterval(keepalive);
      return new Promise((res) => wss.close(() => res()));
    },
  };
}

// Injected by index.ts/test setup before startServer(): db module handle.
// ponytail: param-passing instead of a shared singleton keeps ws.ts testable;
// fold into a proper app-context object when the agent runtime lands (M1 next task).
export let dbApi: typeof import('./db.ts');
export function setDbApi(m: typeof import('./db.ts')): void { dbApi = m; }
