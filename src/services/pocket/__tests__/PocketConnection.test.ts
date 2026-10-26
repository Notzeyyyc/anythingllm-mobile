/* eslint-env jest */
import {
  PocketConnection,
  backoffMs,
  parsePocketMessage,
} from '../PocketConnection';
import type { PocketHandlers } from '../PocketConnection';

jest.mock('uuid', () => ({ v4: () => 'test-turn-id' }));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
  /** Test helper: simulate a server frame. */
  emit(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function makeHandlers(): jest.Mocked<PocketHandlers> {
  return {
    onStatusChange: jest.fn(),
    onSessionStarted: jest.fn(),
    onSessionToken: jest.fn(),
    onDelta: jest.fn(),
    onTurnEnd: jest.fn(),
    onApprovalRequest: jest.fn(),
    onTrace: jest.fn(),
    onError: jest.fn(),
  };
}

const TIMER = { set: setTimeout, clear: clearTimeout };

function makeConnection(overrides: Partial<any> = {}) {
  MockWebSocket.instances = [];
  const handlers = makeHandlers();
  const conn = new PocketConnection({
    url: 'ws://100.0.0.1:7443/ws',
    pairingToken: 'hbk_pair',
    sessionToken: null,
    handlers,
    WebSocketCtor: MockWebSocket,
    // Resolve setTimeout lazily so jest fake timers (installed in beforeEach) are used.
    timer: { set: (fn: any, ms: number) => setTimeout(fn, ms), clear: (h: any) => clearTimeout(h) },
    heartbeatIntervalMs: 1000,
    ...overrides,
  });
  return { conn, handlers };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('parsePocketMessage', () => {
  it('parses valid frames and rejects the rest', () => {
    expect(parsePocketMessage('{"type":"turn.delta","delta":"hi"}')).toEqual({
      type: 'turn.delta',
      delta: 'hi',
    });
    expect(parsePocketMessage('not json')).toBeNull();
    expect(parsePocketMessage('{"noType":1}')).toBeNull();
    expect(parsePocketMessage(42)).toBeNull();
  });
});

describe('backoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(20)).toBe(30_000);
  });
});

describe('handshake', () => {
  it('sends auth with the pairing token, stores the issued session token', () => {
    const { conn, handlers } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    expect(ws.sent[0]).toEqual(JSON.stringify({ type: 'auth', token: 'hbk_pair' }));
    ws.emit({ type: 'auth.ok', deviceId: 'd1', sessionToken: 'hbs_session' });
    expect(handlers.onSessionToken).toHaveBeenCalledWith('hbs_session');
    expect(ws.sent[1]).toEqual(JSON.stringify({ type: 'session.start' }));
    ws.emit({ type: 'session.started', sessionId: 's1' });
    expect(conn.isReady()).toBe(true);
  });

  it('reconnect uses the session token instead of the pairing token', () => {
    const { conn } = makeConnection({ sessionToken: 'hbs_saved' });
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    expect(ws.sent[0]).toContain('hbs_saved');
    expect(ws.sent[0]).not.toContain('hbk_pair');
  });
});

describe('sendTurn', () => {
  it('requires a started session and sends turn.request with a uuid', () => {
    const { conn } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });
    // not ready yet (no session.started)
    expect(conn.sendTurn('hi')).toBeNull();
    ws.emit({ type: 'session.started', sessionId: 's1' });
    expect(conn.sendTurn('  ')).toBeNull();
    expect(conn.sendTurn('hello')).toBe('test-turn-id');
    expect(ws.sent.at(-1)).toEqual(
      JSON.stringify({ type: 'turn.request', turnId: 'test-turn-id', prompt: 'hello' }),
    );
  });
});

describe('events', () => {
  it('routes deltas, trace events and turn.end to handlers', () => {
    const { conn, handlers } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });
    ws.emit({ type: 'session.started', sessionId: 's1' });
    ws.emit({ type: 'turn.delta', turnId: 't1', delta: 'he' });
    ws.emit({ type: 'turn.delta', turnId: 't1', delta: 'llo' });
    ws.emit({ type: 'tool.call.start', turnId: 't1', payload: { tool: 'read_file' } });
    ws.emit({ type: 'turn.end', turnId: 't1', ok: true, text: 'hello' });
    expect(handlers.onDelta).toHaveBeenNthCalledWith(1, 't1', 'he');
    expect(handlers.onDelta).toHaveBeenNthCalledWith(2, 't1', 'llo');
    expect(handlers.onTrace).toHaveBeenCalledWith({
      type: 'tool.call.start',
      turnId: 't1',
      payload: { tool: 'read_file' },
    });
    expect(handlers.onTurnEnd).toHaveBeenCalledWith({
      turnId: 't1',
      ok: true,
      text: 'hello',
      error: undefined,
    });
  });
});

describe('approval', () => {
  it('auto-rejects when the TTL runs out (default reject, spec §6)', () => {
    const timers: any[] = [];
    const set = (fn: any, ms: number) => {
      timers.push({ fn, ms });
      return timers.length - 1 as unknown as ReturnType<typeof setTimeout>;
    };
    const { conn } = makeConnection({
      timer: { set, clear: jest.fn() },
    });
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });
    ws.emit({ type: 'session.started', sessionId: 's1' });
    ws.emit({
      type: 'approval.request',
      approvalId: 'a1',
      turnId: 't1',
      tool: 'write_file',
      path: '/tmp/x',
      contentPreview: '...',
      ttlMs: 30_000,
    });
    const pending = timers.filter(t => t.ms === 30_000);
    expect(pending).toHaveLength(1);
    pending[0].fn(); // TTL expired
    expect(ws.sent.at(-1)).toEqual(
      JSON.stringify({ type: 'approval.response', approvalId: 'a1', decision: 'reject' }),
    );
  });

  it('respondApproval sends the decision and cancels the auto-reject', () => {
    const cleared: unknown[] = [];
    const { conn } = makeConnection({
      timer: { set: (fn: any, ms: number) => 42 as any, clear: (h: any) => cleared.push(h) },
    });
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });
    ws.emit({ type: 'session.started', sessionId: 's1' });
    ws.emit({ type: 'approval.request', approvalId: 'a2', turnId: 't1', tool: 'bash', ttlMs: 30_000 });
    conn.respondApproval('a2', 'grant');
    expect(cleared).toContain(42);
    expect(ws.sent.at(-1)).toEqual(
      JSON.stringify({ type: 'approval.response', approvalId: 'a2', decision: 'grant' }),
    );
  });
});

describe('reconnect', () => {
  it('schedules reconnects with growing backoff and resets after auth.ok', () => {
    const { conn } = makeConnection();
    conn.connect();
    jest.advanceTimersByTime(0);
    let ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });

    // Drop the connection -> backoff 1s before retry.
    ws.close();
    jest.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
    ws = MockWebSocket.instances[1];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });

    // Drop again after a successful handshake -> backoff restarted at 1s.
    ws.close();
    jest.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('does not reconnect after disconnect()', () => {
    const { conn } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    conn.disconnect();
    jest.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(conn.getStatus()).toBe('disconnected');
  });
});

describe('heartbeat', () => {
  it('sends app-level pings after connect', () => {
    jest.useFakeTimers();
    const { conn } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });
    const sentBeforeHeartbeat = ws.sent.length;
    jest.advanceTimersByTime(1000);
    expect(ws.sent.length).toBe(sentBeforeHeartbeat + 1);
    expect(ws.sent.at(-1)).toBe('{"type":"ping"}');
    conn.disconnect();
    jest.useRealTimers();
  });

  it('tracks pong: a pong resets the dead-link timer', () => {
    const { conn } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });
    jest.advanceTimersByTime(1000); // ping 1
    ws.emit({ type: 'pong' });
    jest.advanceTimersByTime(1000); // ping 2
    ws.emit({ type: 'pong' });
    jest.advanceTimersByTime(1000); // 1s since last pong — still alive, ping again
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(ws.sent.at(-1)).toBe('{"type":"ping"}');
    conn.disconnect();
  });

  it('closes the socket after 2 consecutive heartbeats without pong', () => {
    const { conn } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });
    jest.advanceTimersByTime(1000); // ping 1 — no pong
    jest.advanceTimersByTime(1000); // 2s without a pong (2 missed) → close
    expect(MockWebSocket.instances).toHaveLength(1);
    jest.advanceTimersByTime(1000); // backoff 1s → new socket
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('never routes pong/auth.deny to onTrace', () => {
    const { conn, handlers } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.ok' });
    ws.emit({ type: 'pong' });
    ws.emit({ type: 'auth.deny', reason: 'invalid token' });
    expect(handlers.onTrace).not.toHaveBeenCalled();
  });
});

describe('auth.deny', () => {
  it('surfaces the error immediately and does not reconnect', () => {
    const { conn, handlers } = makeConnection();
    conn.connect();
    const ws = MockWebSocket.instances[0];
    ws.onopen!();
    ws.emit({ type: 'auth.deny', reason: 'invalid token' });
    expect(handlers.onError).toHaveBeenCalledWith('invalid token');
    // Server closes right after auth.deny.
    ws.close();
    expect(conn.getStatus()).toBe('disconnected');
    jest.advanceTimersByTime(120_000);
    expect(MockWebSocket.instances).toHaveLength(1); // no retry loop with a bad token
  });
});
