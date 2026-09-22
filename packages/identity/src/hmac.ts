// packages/identity/src/hmac.ts — WBS 0.17.
//
// The one keyed-hash primitive this package stores secrets with — shared by otp.ts
// (identity.otp_codes.code_hash) and session.ts (identity.sessions.token_hash). It lives in its
// own file so that the security-critical hashing rule exists exactly once: two copies of it would
// be two things to drift apart, and a divergence would be silent.
//
// WBS 0.17 brief, Deliver: "Hash OTP codes and session tokens with a keyed HMAC (node:crypto
// createHmac('sha256', secret)), never a plain unsalted hash — a 6-digit OTP is a 1e6-space,
// brute-forceable under a bare SHA-256 lookup if the table ever leaked; a session token is
// high-entropy so this is defense in depth there."
//
// The secret is read from the environment on every call, never cached in a module-level constant:
// a cached value would freeze whatever the environment held at import time and would survive a
// credential rotation in the same process. There is no default and no fallback — an unset secret
// is a hard error, because hashing with a blank key is exactly the unsalted hash the brief
// forbids.

import { createHmac, timingSafeEqual } from 'node:crypto';

const HMAC_ALGORITHM = 'sha256';
const HMAC_DIGEST_ENCODING = 'hex';

/** Environment variable carrying the HMAC key. Supplied by the deployment environment in
 *  production and by vitest.config.ts (a self-describing non-secret) in tests. */
const HMAC_SECRET_ENV_VAR = 'OTP_HMAC_SECRET';

function hmacSecret(): string {
  const secret = process.env[HMAC_SECRET_ENV_VAR];
  if (secret === undefined || secret === '') {
    throw new Error(
      `${HMAC_SECRET_ENV_VAR} is not set — OTP codes and session tokens cannot be hashed with an ` +
        'empty key, and this package has no default (WBS 0.17 brief: keyed HMAC, never a plain ' +
        'unsalted hash).',
    );
  }
  return secret;
}

/**
 * Keyed HMAC-SHA256 of `plaintext`, hex-encoded — the value stored in
 * identity.otp_codes.code_hash / identity.sessions.token_hash. Deterministic for a fixed key,
 * which is what makes verification by lookup possible; one-way, which is what keeps the plaintext
 * unrecoverable from the table.
 */
export function keyedHash(plaintext: string): string {
  return createHmac(HMAC_ALGORITHM, hmacSecret()).update(plaintext, 'utf8').digest(
    HMAC_DIGEST_ENCODING,
  );
}

/**
 * Constant-time comparison of two hex digests produced by `keyedHash`.
 *
 * Used where a candidate hash is compared in JavaScript against one already fetched from the
 * database (verifyOtp): a plain `===` on strings short-circuits at the first differing character
 * and leaks, through timing, how much of the digest an attacker has guessed. Digests of unequal
 * byte length are rejected before `timingSafeEqual`, which throws on length mismatch.
 */
export function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, HMAC_DIGEST_ENCODING);
  const rightBytes = Buffer.from(right, HMAC_DIGEST_ENCODING);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}
