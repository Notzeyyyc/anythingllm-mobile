/**
 * AnythingPocket sidecar — pairing & session token auth (spec §5, §6).
 * Pairing token: hbk_<64 hex> (256-bit), expiry default 7 days, single-use per device.
 * Handshake: client sends pairing token → server issues long-lived session token
 * per device (spec §5.2). Reconnect uses session token, no re-pair (§5.3).
 * Fail2ban-style lockout: 5 failed handshakes per IP → block. In-memory (M1).
 * Tokens NEVER logged raw — redact() everywhere.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PAIRING_PREFIX = 'hbk_';
const SESSION_PREFIX = 'hbs_';
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 10 * 60_000; // 10 min cool-down after 5 failures
const PAIRING_TTL_MS = 7 * 24 * 3600_000; // default 7 days (spec §5.1)

export interface IssuedPairing {
  token: string;
  expiresAt: number; // epoch ms
}
export interface AuthResult {
  ok: boolean;
  reason?: string;
  deviceId?: string;
  sessionToken?: string; // raw, returned once to the device; only hash is stored
}

// --- in-memory pairing token store (M1; single process) --------------------
// ponytail: pairing tokens in memory = restart kills them; upgrade path is a
// pairings table in db.ts (hash + expiry) when persistence matters (M2).
const pairings = new Map<string, { expiresAt: number }>();

export function issuePairingToken(ttlMs: number = PAIRING_TTL_MS): IssuedPairing {
  const token = PAIRING_PREFIX + randomBytes(32).toString('hex');
  pairings.set(token, { expiresAt: Date.now() + ttlMs });
  return { token, expiresAt: Date.now() + ttlMs };
}

export function redact(token: string): string {
  if (!token || token.length <= 10) return '<redacted>';
  return token.slice(0, 6) + '...';
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// --- fail2ban (in-memory, per IP) ------------------------------------------

const fails = new Map<string, { count: number; blockedUntil: number }>();

export function isLockedOut(ip: string): boolean {
  const f = fails.get(ip);
  return !!f && f.blockedUntil > Date.now();
}

function recordFail(ip: string): void {
  const f = fails.get(ip) ?? { count: 0, blockedUntil: 0 };
  f.count += 1;
  if (f.count >= LOCKOUT_THRESHOLD) {
    f.blockedUntil = Date.now() + LOCKOUT_MS;
    f.count = 0; // counter reset; the cool-down window is the punishment
  }
  fails.set(ip, f);
}

/** Test hook: clear lockout state. */
export function _resetLockout(): void {
  fails.clear();
}

// --- handshake --------------------------------------------------------------

/**
 * Validate a presented token. Routing:
 *  - pairing token (hbk_): consume → create device + issue session token
 *  - session token (hbs_): look up device by token hash → allow reconnect
 * Caller (ws.ts) must check isLockedOut(ip) BEFORE calling this.
 */
export function authenticate(ip: string, presented: string,
  dbapi: typeof import('./db.ts')): AuthResult {
  if (isLockedOut(ip)) return { ok: false, reason: 'locked out (too many failed attempts)' };

  if (
    typeof presented !== 'string' ||
    (!presented.startsWith(PAIRING_PREFIX) && !presented.startsWith(SESSION_PREFIX))
  ) {
    recordFail(ip);
    return { ok: false, reason: 'malformed token' };
  }

  if (presented.startsWith(PAIRING_PREFIX)) {
    const p = pairings.get(presented);
    if (!p || p.expiresAt <= Date.now()) {
      recordFail(ip);
      pairings.delete(presented);
      return { ok: false, reason: 'invalid or expired pairing token' };
    }
    pairings.delete(presented); // single-use: QR dies after first connect (spec §5.1)
    const deviceId = dbapi.createDevice('device-' + sha256(presented).slice(0, 8), sha256(presented));
    const sessionToken = SESSION_PREFIX + randomBytes(32).toString('hex');
    // The session token is the device's long-lived credential; store its hash.
    // The pairing token itself is consumed and never needed again.
    dbapi.setDeviceCredential(deviceId, sha256(sessionToken), new Date(Date.now() + 365 * 24 * 3600_000).toISOString());
    return { ok: true, deviceId, sessionToken };
  }

  // session token reconnect
  const d = dbapi.findDeviceByTokenHash(sha256(presented));
  if (!d || d.revoked) {
    recordFail(ip);
    return { ok: false, reason: d ? 'device revoked' : 'invalid session token' };
  }
  return { ok: true, deviceId: d.id };
}

/** Test hook: constant-time compare exposed for e2e sanity. */
export const _safeEqual = safeEqual;
