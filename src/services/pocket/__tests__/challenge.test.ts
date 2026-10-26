/* eslint-env jest */
import {
  hmacSha256Hex,
  normalizeFp,
  sha256Hex,
  verifyChallenge,
} from '../challenge';

describe('pure JS SHA-256/HMAC (M3 TOFU challenge — no crypto dep in Hermes)', () => {
  it('matches FIPS 180 vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // > 1 block, forces the padding + multi-block path
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });

  it('matches RFC 4231-style HMAC vectors', () => {
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
    // Long key (>64 bytes) forces the key-hashing branch — verified against
    // node:crypto HMAC-SHA256 of the same input.
    expect(hmacSha256Hex('k'.repeat(100), 'msg')).toBe(
      'bd56a1782c2830e8abc6ed866a57a1230661e650b84c62f7ee3accc5fa5af491',
    );
  });

  it('normalizes fingerprint display forms', () => {
    expect(normalizeFp('SHA256:AB:CD:ef')).toBe('abcdef');
    expect(normalizeFp('  abcd  ')).toBe('abcd');
  });

  it('verifies a correct challenge and rejects tampered/unknown ones', () => {
    const fp = 'a'.repeat(64);
    const nonce = 'nonce-123';
    const mac = hmacSha256Hex(fp, nonce);
    expect(verifyChallenge({ type: 'auth.challenge', nonce, mac }, fp)).toBe(true);
    expect(verifyChallenge({ type: 'auth.challenge', nonce, mac }, 'sha256:' + fp.toUpperCase())).toBe(true);
    expect(verifyChallenge({ type: 'auth.challenge', nonce, mac: 'deadbeef' }, fp)).toBe(false);
    expect(verifyChallenge({ type: 'auth.challenge', nonce: 'other', mac }, fp)).toBe(false);
    expect(verifyChallenge({ type: 'auth.challenge', nonce, mac }, null)).toBe(false);
    expect(verifyChallenge({ type: 'ping', nonce, mac }, fp)).toBe(false);
  });
});
