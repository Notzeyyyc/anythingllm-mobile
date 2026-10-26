/**
 * AnythingPocket sidecar — single trace event schema (spec §7.1).
 * One schema normalizes both Lite & Full modes. Plain TS types + manual
 * validators (zod skipped: 10 lines of checks beat a new dep here).
 * ponytail: payload validated shallowly (type + shape); add zod when
 * third-party producers join the bus.
 */
export type EventType =
  | 'session.start'
  | 'turn.start'
  | 'llm.call.start'
  | 'llm.call.end'
  | 'tool.call.start'
  | 'tool.call.end'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.rejected'
  | 'approval.expired'
  | 'route.decided'
  | 'turn.end'
  | 'error';

export const EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.start', 'turn.start', 'llm.call.start', 'llm.call.end',
  'tool.call.start', 'tool.call.end',
  'approval.requested', 'approval.granted', 'approval.rejected', 'approval.expired',
  'route.decided', 'turn.end', 'error',
]);

export interface TraceEvent {
  id: string;        // uuid v4
  ts: string;        // ISO 8601
  sessionId: string; // uuid v4
  turnId: string;    // uuid v4
  type: EventType;
  payload: Record<string, unknown>;
  rev: number;       // monotonic per session, set by db layer on insert
}

/** Runtime check for events coming over the wire (trust boundary). */
export function isValidEvent(e: unknown): e is TraceEvent {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' && o.id.length > 0 &&
    typeof o.ts === 'string' && !Number.isNaN(Date.parse(o.ts)) &&
    typeof o.sessionId === 'string' && o.sessionId.length > 0 &&
    typeof o.turnId === 'string' && o.turnId.length > 0 &&
    typeof o.type === 'string' && EVENT_TYPES.has(o.type) &&
    typeof o.payload === 'object' && o.payload !== null && !Array.isArray(o.payload) &&
    (typeof o.rev === 'number' || o.rev === undefined)
  );
}

/** Whitelist of payload keys per event type — rejects secrets-by-typo at the boundary. */
const PAYLOAD_KEYS: Record<EventType, string[]> = {
  'session.start': ['device', 'mode'],
  'turn.start': ['prompt'],
  'llm.call.start': ['model'],
  'llm.call.end': ['model', 'durationMs', 'tokensIn', 'tokensOut'],
  'tool.call.start': ['tool', 'argsHash'],
  'tool.call.end': ['tool', 'ok', 'durationMs'],
  'approval.requested': ['approvalId', 'tool', 'command', 'diff', 'ttlMs'],
  'approval.granted': ['approvalId'],
  'approval.rejected': ['approvalId', 'reason'],
  'approval.expired': ['approvalId'],
  'route.decided': ['runtime', 'reason'],
  'turn.end': ['ok', 'reason'],
  'error': ['message'],
};

/** Secret-looking keys never allowed into trace payloads. */
const SECRET_KEY = /(token|secret|password|apikey|api_key|authorization|cookie|cvc|card)/i;

/**
 * Enforce whitelist + strip secret-looking keys. Payloads crossing the wire
 * must pass this before being persisted or echoed.
 */
export function sanitizePayload(type: EventType, payload: Record<string, unknown>): Record<string, unknown> {
  const allowed = PAYLOAD_KEYS[type];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(payload)) {
    if (SECRET_KEY.test(k)) continue; // hard drop, never logged
    if (allowed.includes(k)) out[k] = payload[k];
  }
  return out;
}
