/**
 * AnythingPocket sidecar — direct-mode TLS (spec §3.3, §5.1, §6, M3).
 * Self-signed cert via openssl CLI (node:crypto cannot mint X.509), stored in
 * dataDir (0600). cert_fp = SHA-256 over the DER cert, format spec §5.1:
 * "sha256:<hex>" — shown at pairing for double-display verification; the app
 * pins it (TOFU for manual entry). Default stays plain ws://127.0.0.1 (M1
 * compat); TLS activates when a cert exists (POCKET_TLS=auto) or on demand.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { networkInterfaces, hostname } from 'node:os';
import { X509Certificate } from 'node:crypto';

export const CERT_NAME = 'cert.pem';
export const KEY_NAME = 'key.pem';
const CERT_DAYS = 3650; // long-lived; revocation = delete + re-pair

export interface TlsMaterial {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
  certFp: string; // "sha256:<hex>" (spec §5.1)
}

export function certFpOf(pem: string): string {
  const der = new X509Certificate(pem).raw;
  return 'sha256:' + createHash('sha256').update(der).digest('hex');
}

/** First non-internal IPv4 (pairing payload host), or 127.0.0.1. */
export function primaryIp(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

export function tlsMode(): 'auto' | 'on' | 'off' {
  const v = (process.env.POCKET_TLS ?? 'auto').toLowerCase();
  return v === 'on' || v === 'off' ? v : 'auto';
}

/**
 * Load the self-signed cert, or generate one (idempotent) when mode allows.
 * SAN: env POCKET_SAN (comma-separated, e.g. "IP:203.0.113.42,DNS:home.example")
 * — default covers loopback + primary LAN/public IP.
 */
export function ensureCert(dataDir: string, mode: 'auto' | 'on' | 'off' = tlsMode()): TlsMaterial | null {
  const certPath = join(dataDir, CERT_NAME);
  const keyPath = join(dataDir, KEY_NAME);
  if (mode === 'off') return null; // explicit off → plain ws:// even if a cert exists
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8');
    return { cert, key: readFileSync(keyPath, 'utf8'), certPath, keyPath, certFp: certFpOf(cert) };
  }
  if (mode !== 'on') return null; // auto without a cert → stay plain (M1 compat)
  mkdirSync(dataDir, { recursive: true });
  const san = process.env.POCKET_SAN ?? `IP:127.0.0.1,IP:${primaryIp()},DNS:${hostname()}`;
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, `-days`, String(CERT_DAYS),
    '-subj', '/CN=AnythingPocket', '-addext', `subjectAltName=${san}`,
  ], { stdio: 'pipe' });
  chmodSync(certPath, 0o600);
  chmodSync(keyPath, 0o600);
  const cert = readFileSync(certPath, 'utf8');
  return { cert, key: readFileSync(keyPath, 'utf8'), certPath, keyPath, certFp: certFpOf(cert) };
}

export const DEFAULT_DATA_DIR = resolve(import.meta.dirname, '../data');

/** Pairing payload (spec §5.1) — identical shape for direct/tailscale/cloudflare. */
export function buildPairingPayload(opts: {
  token: string;
  expiresAt: number;
  tls: TlsMaterial | null;
  port: number;
  host?: string; // override (tailscale 100.x / cloudflare domain)
  name?: string;
}): Record<string, unknown> {
  const useTls = !!opts.tls;
  const host = opts.host ?? `${useTls ? 'wss' : 'ws'}://${useTls ? primaryIp() : '127.0.0.1'}${opts.port === 443 ? '' : ':' + opts.port}`;
  return {
    v: 1,
    name: opts.name ?? hostname(),
    host,
    mode: useTls ? 'direct' : 'tailscale',
    token: opts.token,
    ...(opts.tls ? { cert_fp: opts.tls.certFp } : {}),
    expires: opts.expiresAt,
  };
}
