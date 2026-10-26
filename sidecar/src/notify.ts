/**
 * AnythingPocket sidecar — background-job notifications (spec §7.6, §6, M3).
 * Long-running turns keep running on the server when the phone disconnects
 * (turn loop is async, history lands in SQLite); when turn.end /
 * approval.requested fires for an OFFLINE device, a push is sent.
 *
 * Transports: WebPush VAPID (dep web-push, spec §8) + ntfy (env
 * POCKET_NTFY_URL + POCKET_NTFY_TOPIC). FCM deliberately absent.
 *
 * PAYLOAD SANITIZATION (spec §6): title is one of two fixed strings, body is
 * the sessionId only. NEVER prompt/turn content, commands, or diffs — push
 * services are third parties.
 */
import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type NotifKind = 'turn.end' | 'approval.requested';
const TITLES: Record<NotifKind, string> = {
  'turn.end': 'Turn selesai / Turn finished',
  'approval.requested': 'Approval dibutuhkan / Approval needed',
};

export interface PushSubscription { endpoint: string; p256dh: string; auth: string }

let db: DatabaseSync;
let configured = false;

export function initNotify(dbapi: DatabaseSync): void {
  db = dbapi;
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_subs (
      device_id TEXT NOT NULL,
      endpoint  TEXT NOT NULL,
      p256dh    TEXT NOT NULL,
      auth      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (device_id, endpoint)
    );
  `);
  if (!getKv('vapid.public')) {
    const keys = webpush.generateVAPIDKeys();
    setKv('vapid.public', keys.publicKey);
    setKv('vapid.private', keys.privateKey);
  }
  webpush.setVapidDetails('mailto:sidecar@anythingpocket.local', getKv('vapid.public')!, getKv('vapid.private')!);
  configured = true;
}

export function vapidPublicKey(): string | null {
  return configured ? getKv('vapid.public') ?? null : null;
}

export function addSubscription(deviceId: string, sub: PushSubscription): void {
  db.prepare(
    'INSERT OR REPLACE INTO push_subs (device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(deviceId, sub.endpoint, sub.p256dh, sub.auth, new Date().toISOString());
}

export function removeSubscription(deviceId: string, endpoint: string): void {
  db.prepare('DELETE FROM push_subs WHERE device_id = ? AND endpoint = ?').run(deviceId, endpoint);
}

function subsFor(deviceId: string): PushSubscription[] {
  return (db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE device_id = ?').all(deviceId) as any[])
    .map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
}

/** Injected push sender (tests use a mock; default = web-push). */
type Sender = (sub: PushSubscription, payload: object) => void | Promise<void>;
let pushSender: Sender | null = null;
export function setPushSender(fn: Sender | null): void { pushSender = fn; }

export function ntfyEnabled(): boolean {
  return !!process.env.POCKET_NTFY_URL;
}

/** Sanitized notification (spec §6). Content NEVER included. */
function sanitizedPayload(kind: NotifKind, sessionId: string): object {
  return { title: TITLES[kind], body: sessionId, sessionId }; // body = sessionId only
}

export async function notifyDevice(deviceId: string, kind: NotifKind, sessionId: string): Promise<void> {
  if (!configured) return;
  const payload = sanitizedPayload(kind, sessionId);
  const sender = pushSender ?? defaultSender;
  await Promise.allSettled(subsFor(deviceId).map((sub) => sender(sub, payload)));
  if (ntfyEnabled()) {
    // ponytail: fire-and-forget ntfy POST, no retry — upgrade path is a queue if deliveries matter.
    const url = process.env.POCKET_NTFY_URL!.replace(/\/$/, '') + '/' + (process.env.POCKET_NTFY_TOPIC ?? 'anythingpocket');
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload as object }),
    }).catch(() => {}); // never crash a turn over a notification
  }
}

async function defaultSender(sub: PushSubscription, payload: object): Promise<void> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
  } catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint); // gone — prune
    }
    // other failures: log-free by design (payload has no secrets anyway); swallow
  }
}

function getKv(k: string): string | undefined {
  return (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined)?.v;
}
function setKv(k: string, v: string): void {
  db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v);
}
export { getKv, setKv };
