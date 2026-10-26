/**
 * AnythingPocket M3 — application-level TOFU challenge (spec §6 trade-off).
 *
 * RN WebSocket cannot do transport-level cert pinning without native patches.
 * As an additive layer, the sidecar may send after auth.ok:
 *   { type: 'auth.challenge', nonce, mac }
 * where mac = HMAC-SHA256(key = cert fingerprint hex, msg = nonce). The phone
 * recomputes it with the fingerprint the user verified (TOFU). This proves the
 * peer knows the verified fingerprint — it blocks a naive proxy that opens its
 * OWN TLS session without forwarding app frames. It is NOT a substitute for
 * TLS pinning (the fingerprint is not a secret); see docs/pocket-m3-routing-pinning.md.
 *
 * Pure JS SHA-256/HMAC — no new dependency (AGENTS.md §5); stdlib node:crypto
 * is unavailable in Hermes. Verified against FIPS 180 test vectors.
 */

/** SHA-256 over raw bytes, returns hex. FIPS 180-4. */
export function sha256Bytes(bytes: number[]): string {
  const rr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const data = [...bytes];
  const bitLen = data.length * 8;
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  for (let i = 7; i >= 0; i--) data.push(Math.floor(bitLen / 2 ** (8 * i)) & 0xff);

  const w = new Array<number>(64);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++)
      w[i] =
        (data[off + 4 * i] << 24) |
        (data[off + 4 * i + 1] << 16) |
        (data[off + 4 * i + 2] << 8) |
        data[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H = [
      (H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0,
      (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0,
    ];
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of unescape(encodeURIComponent(s))) out.push(ch.charCodeAt(0));
  return out;
}

/** SHA-256 of a UTF-8 string, hex. */
export function sha256Hex(msg: string): string {
  return sha256Bytes(utf8Bytes(msg));
}

function xorPad(keyBytes: number[], byte: number): number[] {
  const k = keyBytes.length > 64 ? sha256Bytes(keyBytes) : null;
  const kb: number[] = k
    ? (k.match(/../g) ?? []).map(h => parseInt(h, 16))
    : keyBytes;
  return Array.from({ length: 64 }, (_, i) => (kb[i] ?? 0) ^ byte);
}

/** HMAC-SHA256 (RFC 2104) over UTF-8 key and message, hex. */
export function hmacSha256Hex(key: string, msg: string): string {
  const kb = utf8Bytes(key);
  const inner = sha256Bytes([...xorPad(kb, 0x36), ...utf8Bytes(msg)]);
  const outer = sha256Bytes([...xorPad(kb, 0x5c), ...(inner.match(/../g) ?? []).map(h => parseInt(h, 16))]);
  return outer;
}

/** Normalize `sha256:ABCD…` / spaced forms to plain lowercase hex. */
export function normalizeFp(fp: string): string {
  return fp.trim().toLowerCase().replace(/^sha256:/, '').replace(/[\s:]/g, '');
}

export interface ChallengeMsg {
  type: 'auth.challenge';
  nonce: string;
  mac: string;
}

/**
 * Verify the sidecar's challenge against the TOFU-verified fingerprint.
 * Returns true only for a well-formed message with a matching HMAC.
 */
export function verifyChallenge(msg: unknown, certFp: string | null): boolean {
  if (!certFp) return false;
  const m = msg as Partial<ChallengeMsg>;
  if (m?.type !== 'auth.challenge') return false;
  if (typeof m.nonce !== 'string' || typeof m.mac !== 'string' || !m.nonce) return false;
  const expected = hmacSha256Hex(normalizeFp(certFp), m.nonce);
  // Constant-time-ish compare to avoid trivial byte-diff timing leaks.
  let diff = expected.length ^ m.mac.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m.mac.charCodeAt(i);
  return diff === 0;
}
