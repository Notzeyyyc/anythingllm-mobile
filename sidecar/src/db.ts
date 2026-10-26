/**
 * AnythingPocket sidecar — state store (spec §3.1, §6).
 * node:sqlite (stdlib, Node >=22.5) — no better-sqlite3, no ORM.
 * events table is append-only (trace log). Approvals default REJECT + TTL.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, resolve, join } from 'node:path';
import type { EventType, TraceEvent } from './schema.ts';
import { sanitizePayload } from './schema.ts';

export const DATA_DIR = resolve(import.meta.dirname, '../data');
export const DB_PATH = resolve(DATA_DIR, 'sidecar.db');

let db: DatabaseSync;

export function openDb(path: string = DB_PATH): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  // Ephemeral DB (:memory:, tests) → ephemeral key; file-backed DB → key file next to it.
  keyFile = path === ':memory:' ? null : resolve(dirname(path), 'history.key');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      token_hash  TEXT NOT NULL UNIQUE,   -- sha256 hex of active session token; raw token never stored
      created_at  TEXT NOT NULL,
      expires_at  TEXT,                   -- session token expiry
      revoked_at  TEXT                    -- NULL = active
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      device_id   TEXT REFERENCES devices(id),
      created_at  TEXT NOT NULL,
      rev         INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      id          TEXT PRIMARY KEY,
      ts          TEXT NOT NULL,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      turn_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,          -- JSON
      rev         INTEGER NOT NULL,       -- monotonic per session (trace ordering)
      UNIQUE(session_id, rev)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      turn_id     TEXT NOT NULL,
      tool        TEXT NOT NULL,
      command     TEXT,
      diff        TEXT,
      ttl_ms      INTEGER NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','granted','rejected','expired'))
    );
    CREATE TABLE IF NOT EXISTS session_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      turn_id     TEXT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session_rev ON events(session_id, rev);
  `);
  return db;
}

// --- events (append-only trace) -------------------------------------------

export function insertEvent(
  sessionId: string,
  turnId: string,
  type: EventType,
  payload: Record<string, unknown> = {},
): TraceEvent {
  const id = randomUUID();
  const ts = new Date().toISOString();
  const rev = (db.prepare('SELECT COALESCE(MAX(rev), 0) + 1 AS r FROM events WHERE session_id = ?').get(sessionId) as { r: number }).r;
  db.prepare(
    'INSERT INTO events (id, ts, session_id, turn_id, type, payload, rev) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, ts, sessionId, turnId, type, JSON.stringify(sanitizePayload(type, payload)), rev);
  return { id, ts, sessionId, turnId, type, payload, rev };
}

export function getSessionRev(sessionId: string): number {
  const r = db.prepare('SELECT MAX(rev) AS rev FROM events WHERE session_id = ?').get(sessionId) as { rev: number | null };
  return r.rev ?? 0;
}

export function listEvents(sessionId: string): TraceEvent[] {
  return db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY rev').all(sessionId).map(rowToEvent);
}

function rowToEvent(r: Record<string, unknown>): TraceEvent {
  return {
    id: r.id as string, ts: r.ts as string, sessionId: r.session_id as string,
    turnId: r.turn_id as string, type: r.type as EventType,
    payload: JSON.parse(r.payload as string), rev: r.rev as number,
  };
}

// --- sessions --------------------------------------------------------------

export function createSession(deviceId: string | null): string {
  const id = randomUUID();
  db.prepare('INSERT INTO sessions (id, device_id, created_at) VALUES (?, ?, ?)')
    .run(id, deviceId, new Date().toISOString());
  return id;
}

// --- devices (token per device, revoke per device) -------------------------

export function createDevice(name: string, tokenHash: string, expiresAt: string | null = null): string {
  const id = randomUUID();
  db.prepare('INSERT INTO devices (id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, tokenHash, new Date().toISOString(), expiresAt);
  return id;
}

/** Replace the device's active credential hash (pairing → session token rotation). */
export function setDeviceCredential(deviceId: string, tokenHash: string, expiresAt: string): void {
  db.prepare('UPDATE devices SET token_hash = ?, expires_at = ? WHERE id = ?')
    .run(tokenHash, expiresAt, deviceId);
}

export function findDeviceByTokenHash(tokenHash: string): { id: string; name: string; revoked: boolean } | null {
  const r = db.prepare('SELECT id, name, revoked_at FROM devices WHERE token_hash = ?').get(tokenHash) as
    | { id: string; name: string; revoked_at: string | null } | undefined;
  if (!r) return null;
  return { id: r.id, name: r.name, revoked: r.revoked_at !== null };
}

export function revokeDevice(deviceId: string): boolean {
  const r = db.prepare(
    "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).run(new Date().toISOString(), deviceId);
  return r.changes > 0;
}

// --- session history (Full-mode session serialization, minimal) ------------
// Content (prompt user + jawaban agent) dienkripsi at-rest AES-256-GCM
// (docs/m3-hardening.md): key 256-bit di data/history.key (0600), di luar DB.
let historyKey: Buffer | null = null;
let keyFile: string | null = null;
function getHistoryKey(): Buffer {
  if (historyKey) return historyKey;
  const kf = keyFile ?? join(os.tmpdir(), `apocket-history-${process.pid}.key`);
  if (existsSync(kf)) historyKey = Buffer.from(readFileSync(kf, 'utf8').trim(), 'hex');
  else {
    historyKey = randomBytes(32);
    mkdirSync(dirname(kf), { recursive: true });
    writeFileSync(kf, historyKey.toString('hex'), { mode: 0o600 });
    chmodSync(kf, 0o600);
  }
  return historyKey;
}
function enc(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', getHistoryKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + ct.toString('base64');
}
function dec(stored: string): string {
  if (!stored.startsWith('enc1:')) return stored; // legacy plaintext row
  const [, ivB64, tagB64, ctB64] = stored.split(':');
  const d = createDecipheriv('aes-256-gcm', getHistoryKey(), Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

export function appendHistory(sessionId: string, turnId: string, role: 'user' | 'assistant', content: string): void {
  db.prepare(
    'INSERT INTO session_history (session_id, turn_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sessionId, turnId, role, enc(content.slice(0, 50_000)), new Date().toISOString());
}

export function listHistory(sessionId: string): { turnId: string; role: 'user' | 'assistant'; content: string }[] {
  return (db.prepare(
    'SELECT turn_id, role, content FROM session_history WHERE session_id = ? ORDER BY id',
  ).all(sessionId) as { turn_id: string; role: 'user' | 'assistant'; content: string }[])
    .filter((r) => { try { dec(r.content); return true; } catch { console.error('history: record gagal dekripsi (key berubah?) — dilewati'); return false; } })
    .map((r) => ({ turnId: r.turn_id, role: r.role, content: dec(r.content) }));
}

// --- approvals (pending with TTL, default REJECT) ---------------------------

export function createApproval(sessionId: string, turnId: string, tool: string,
  opts: { command?: string; diff?: string; ttlMs?: number } = {}): { id: string; expiresAt: string } {
  const ttlMs = opts.ttlMs ?? 30_000; // hard TTL default 30s
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO approvals (id, session_id, turn_id, tool, command, diff, ttl_ms, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
  ).run(id, sessionId, turnId, tool, opts.command ?? null, opts.diff ?? null, ttlMs,
    new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  return { id, expiresAt: new Date(now + ttlMs).toISOString() };
}

/** Idempotent resolve (spec: approval gate idempotent). Returns resolved status. */
export function resolveApproval(id: string, status: 'granted' | 'rejected' | 'expired'): 'granted' | 'rejected' | 'expired' | null {
  const r = db.prepare(
    "UPDATE approvals SET status = ? WHERE id = ? AND status = 'pending'",
  ).run(status, id);
  return r.changes > 0 ? status : null; // null = already resolved (or unknown)
}

export function getApproval(id: string): { id: string; sessionId: string; turnId: string; status: string; expiresAt: string } | null {
  const r = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
    | { id: string; session_id: string; turn_id: string; status: string; expires_at: string } | undefined;
  if (!r) return null;
  return { id: r.id, sessionId: r.session_id, turnId: r.turn_id, status: r.status, expiresAt: r.expires_at };
}

/**
 * Sweep pending approvals whose TTL passed → expire (default REJECT path).
 * Called on a timer by ws.ts; expired ones get trace events emitted by caller.
 */
export function expireStaleApprovals(): { id: string; sessionId: string; turnId: string }[] {
  const stale = db.prepare(
    "SELECT id, session_id, turn_id FROM approvals WHERE status = 'pending' AND expires_at <= ?",
  ).all(new Date().toISOString()) as { id: string; session_id: string; turn_id: string }[];
  for (const a of stale) {
    resolveApproval(a.id, 'expired');
  }
  return stale.map((a) => ({ id: a.id, sessionId: a.session_id, turnId: a.turn_id }));
}

export function closeDb(): void {
  db?.close();
}

/** Test-only: raw db handle. */
export function _db(): DatabaseSync {
  return db;
}
