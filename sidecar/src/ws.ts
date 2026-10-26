/**
 * AnythingPocket sidecar — WS server (spec §3.1, §5.2, §6).
 * Path /ws, first message must be {type:'auth', token} (handshake).
 * Pairing token (hbk_) → issues session token (hbs_); reconnect uses session
 * token, no re-pair. Lockout 5 failed handshakes per IP (fail2ban, in-memory).
 * Ping/pong keepalive. Approval sweep enforces TTL hard, default REJECT.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import * as path from 'node:path';
import type { LanguageModel } from 'ai';
import {
  insertEvent, createSession, createApproval, resolveApproval,
  expireStaleApprovals, getApproval,
} from './db.ts';
import { authenticate, isLockedOut } from './auth.ts';
import { DeviceRuntime } from './runtime.ts';
import { notifyDevice, addSubscription, removeSubscription } from './notify.ts';
import { routeTurn } from './router.ts';
import type { HarnessRuntime } from './full/HarnessRuntime.ts';
import type { EventType } from './schema.ts';
import { isValidEvent, EVENT_TYPES as EVENT_TYPES_SET } from './schema.ts';

export interface ServerOpts {
  port?: number;   // default 7443 (env PORT)
  bind?: string;   // default 127.0.0.1 (env BIND)
  /** Agent runtime (WS protocol v1). model default: env-configured provider, lazy. */
  model?: LanguageModel;
  workspace?: string;           // sandbox root for the agent's file tools
  approvalTtlMs?: number;       // hard approval TTL, default 30s (spec §6)
  /** Full-mode runtime (PiRuntime). When absent, router 'full' falls back to Lite (traced). */
  fullRuntime?: HarnessRuntime;
  /** User pin (spec §4.3): env POCKET_FORCE_RUNTIME wired here; beats heuristics. */
  forceRuntime?: string | null;
  /** Direct-mode TLS fingerprint (spec §5.1/§6). Sent in auth.ok + HMAC challenge. */
  certFp?: string;
  /** External http/https server (direct TLS mode, spec §3.3): attach /ws to it instead of binding our own. */
  server?: HttpServer;
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

  const wss = opts.server
    ? new WebSocketServer({ server: opts.server, path: '/ws' }) // direct TLS mode (M3)
    : new WebSocketServer({ host: bind, port, path: '/ws' });

  type Ctx = { deviceId: string; sessionId: string | null; alive: boolean; runtime: DeviceRuntime | null };
  const authed = new Map<WebSocket, Ctx>();
  const online = new Set<string>(); // deviceIds with a live socket (background-jobs notify gate, §7.6)
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
    ws.on('close', () => {
      clearTimeout(authTimer); authed.delete(ws);
      if (ctx.deviceId && ![...authed.values()].some((c) => c.deviceId === ctx.deviceId)) online.delete(ctx.deviceId);
    });
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
        online.add(res.deviceId!);
        clearTimeout(authTimer);
        send(ws, {
          type: 'auth.ok',
          deviceId: res.deviceId,
          // session token sent exactly once, on pairing; reconnect uses it
          ...(res.sessionToken ? { sessionToken: res.sessionToken } : {}),
          ...(opts.certFp ? { certFp: opts.certFp } : {}),
        });
        if (opts.certFp) {
          // App-level TOFU challenge (docs/pocket-m3-routing-pinning.md): prove
          // we know the verified fingerprint. mac = HMAC-SHA256(fp-hex, nonce).
          const nonce = randomBytes(32).toString('hex');
          const fpHex = opts.certFp.trim().toLowerCase().replace(/^sha256:/, '').replace(/[\s:]/g, '');
          const mac = createHmac('sha256', fpHex).update(nonce).digest('hex');
          send(ws, { type: 'auth.challenge', nonce, mac });
        }
        return;
      }

      // --- post-auth messages ---
      if (!ctx.sessionId) {
        const t = msg.type;
        if (t !== 'session.start' && t !== 'ping' && t !== 'turn.request' && t !== 'approval.response'
            && t !== 'push.subscribe' && t !== 'push.unsubscribe'
            && !(typeof t === 'string' && EVENT_TYPES_SET.has(t))) {
          send(ws, { type: 'error', message: 'unknown message type: ' + String(t) }); return;
        }
      }
      switch (msg.type) {
        case 'ping': send(ws, { type: 'pong' }); return;

        // --- push subscriptions (spec §7.6): per-device WebPush endpoint storage
        case 'push.subscribe': {
          const s = objOf(msg.subscription);
          const endpoint = typeof s.endpoint === 'string' ? s.endpoint : '';
          const keys = objOf(s.keys);
          if (!endpoint || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
            send(ws, { type: 'error', message: 'push.subscribe needs subscription{endpoint, keys{p256dh,auth}}' }); return;
          }
          addSubscription(ctx.deviceId, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
          send(ws, { type: 'push.subscribed', endpoint });
          return;
        }
        case 'push.unsubscribe': {
          const endpoint = typeof msg.endpoint === 'string' ? msg.endpoint : '';
          removeSubscription(ctx.deviceId, endpoint);
          send(ws, { type: 'push.unsubscribed' });
          return;
        }

        case 'session.start': {
          ctx.sessionId = createSession(ctx.deviceId);
          trace(ctx.sessionId, ctx.sessionId, 'session.start', { device: ctx.deviceId });
          ctx.runtime = new DeviceRuntime(
            { workspace: workspaceDir, model: opts.model, ttlMs: opts.approvalTtlMs, onEvent: offlineNotifier(ctx) },
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
          if (ctx.runtime?.busy) { send(ws, { type: 'error', message: 'turn in progress' }); return; }
          // Deterministic router (spec §4.3): decision traced, one-sentence reason.
          const decision = routeTurn(prompt, { forceRuntime: opts.forceRuntime });
          const effective = decision.runtime === 'full' && !opts.fullRuntime
            ? { runtime: 'lite' as const, reason: decision.reason + ' — full runtime tidak terkonfigurasi, fallback Lite' }
            : decision;
          trace(sid, turnId, 'route.decided', { runtime: effective.runtime, reason: effective.reason });
          // (Re)build the device runtime for this turn with the routed choice.
          ctx.runtime = new DeviceRuntime(
            {
              workspace: workspaceDir, model: opts.model, ttlMs: opts.approvalTtlMs,
              runtimeChoice: effective.runtime,
              ...(effective.runtime === 'full' ? { harnessRuntime: opts.fullRuntime } : {}),
              onEvent: offlineNotifier(ctx),
            },
            sid,
            (m) => send(ws, m),
          );
          ctx.runtime.startTurn(turnId, prompt); // false → already sent {type:'error',message:'turn in progress'}
          return;
        }

        // WS protocol v1.1 (additive, non-breaking): interrupt the active turn mid-run.
        case 'turn.interrupt': {
          const turnId = typeof msg.turnId === 'string' ? msg.turnId : undefined;
          const interrupted = ctx.runtime?.busy
            ? ctx.runtime.interrupt()
            : (trace(ctx.sessionId ?? '', turnId ?? randomUUID(), 'error', { message: 'no active turn' }), false);
          send(ws, { type: 'turn.interrupt.ack', ...(turnId ? { turnId } : {}), interrupted });
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

  /** Notify the device's push subscriptions ONLY when it has no live socket (§7.6). */
  function offlineNotifier(ctx: Ctx) {
    return (type: 'turn.end' | 'approval.requested'): void => {
      if (ctx.sessionId && !online.has(ctx.deviceId)) void notifyDevice(ctx.deviceId, type, ctx.sessionId);
    };
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
