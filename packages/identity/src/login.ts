// packages/identity/src/login.ts — Master task P6c.
//
// The two pre-authentication login FLOWS a transport (lane 1's OTP-login endpoint, 2.16 part 1a-3)
// calls. They own the path end to end under this package's own internal context, so a caller never
// holds — and never has to forge — an `isInternal` context (the identity tables are `internal_only`
// under RLS, 13B:3033-3038; context.ts header).
//
// ONE POOL CONNECTION AT A TIME. Each flow runs SEQUENTIAL, never nested, transactions: a short
// lookup transaction that is released before the idempotent write transaction opens. The write
// transaction calls the package-internal *InTx functions on its own `tx`, so no second connection is
// acquired while one is held — the bounded-pool deadlock P6c exists to remove.
//
// ANTI-ENUMERATION. Every outcome that could separate a known email from an unknown one collapses
// to the unknown-email result:
//   - requestLoginOtp returns `{ expiresInMinutes, code }` on every path, where expiresInMinutes is
//     the LIVE threshold read after the attempt — never a stored expiresAt, which a replay of a
//     known email's key would otherwise reveal. `code` is null for an unknown/inactive email, a
//     replay, or an absorbed failure.
//   - IdempotencyConflictError (@pg-eos/db — a key reused with another request, or in flight) is
//     DELIBERATELY ABSORBED: requestLoginOtp answers `code: null`, verifyLoginOtp `{ valid: false }`.
//     Only a known email's subject ever reaches withIdempotentContext, so a surfaced 409 would itself
//     be the oracle. The throwing transaction has already rolled back — nothing is written.
//   - UnknownOrInactiveUserError from generateOtpInTx / issueSessionInTx (the account was
//     deactivated between the lookup transaction and the write transaction) is absorbed the same way.
//
// SECRETS ARE NEVER PERSISTED. withIdempotentContext stores the wrapped function's result as
// platform.idempotency_keys.response_body. The OTP code and the session token must never reach the
// database in plaintext (otp.ts, session.ts headers), so the persisted result carries only
// non-secret fields; the secret is handed to the caller from the first, executing call only. A
// REPLAY therefore returns `code: null` / `token: null` — the secret was already delivered by the
// original call, and a replay must not mint or reveal a second one.

import { IdempotencyConflictError, withIdempotentContext, type IdempotencyInput } from '@pg-eos/db';

import { internalCtxForSubject } from './context.js';
import {
  findActiveUserIdByEmail,
  generateOtpInTx,
  otpExpiryMinutes,
  UnknownOrInactiveUserError,
  verifyOtpInTx,
  type OtpClockOptions,
} from './otp.js';
import { issueSessionInTx } from './session.js';

/**
 * Result of requestLoginOtp — identical fields AND identical non-secret values for a known and an
 * unknown/inactive email. `expiresInMinutes` is the live OTP-expiry threshold. `code` is the
 * plaintext OTP for the caller to deliver out of band (never to echo in an HTTP response); it is
 * null when there is no active account, on an idempotent replay, or when a conflict/race was
 * absorbed (see the header).
 */
export interface LoginOtpRequestResult {
  readonly expiresInMinutes: number;
  readonly code: string | null;
}

/**
 * Result of verifyLoginOtp. `token` is the raw session token, returned by the executing call only;
 * null on an idempotent replay (see the header). ISO-8601 strings, not Date: the persisted form is
 * plain JSON.
 */
export type LoginOtpVerification =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly userId: string;
      readonly sessionId: string;
      readonly token: string | null;
      readonly issuedAt: string;
      readonly expiresAt: string;
    };

/** What requestLoginOtp persists as the idempotent response: nothing secret, nothing that differs
 *  from the unknown-email path. */
interface PersistedOtpRequest {
  readonly issued: true;
}

type PersistedVerification =
  | { readonly valid: false }
  | {
      readonly valid: true;
      readonly userId: string;
      readonly sessionId: string;
      readonly issuedAt: string;
      readonly expiresAt: string;
    };

/** The two failures the flows absorb into the unknown-email result (see the header). */
function isAbsorbedFailure(error: unknown): boolean {
  return error instanceof IdempotencyConflictError || error instanceof UnknownOrInactiveUserError;
}

/**
 * Requests a login OTP for `email`.
 *
 * (a) looks up the active user id in its own short transaction (released); (b) if found, issues the
 * OTP inside withIdempotentContext under the package-internal context for that subject; (c) on
 * every path, reads the live OTP-expiry threshold in its own short transaction. An unknown or
 * inactive email, an idempotency conflict and a deactivation race all return `code: null` with
 * nothing written. `idem.requestHash` is computed by the caller over the request body.
 *
 * @throws Error when platform.thresholds has no row for the OTP expiry key.
 */
export async function requestLoginOtp(
  email: string,
  idem: IdempotencyInput,
  opts: OtpClockOptions = {},
): Promise<LoginOtpRequestResult> {
  let deliveredCode: string | null = null;

  const userId = await findActiveUserIdByEmail(email);
  if (userId !== null) {
    try {
      await withIdempotentContext<PersistedOtpRequest>(
        internalCtxForSubject(userId),
        idem,
        async (tx) => {
          const otp = await generateOtpInTx(tx, email, opts);
          deliveredCode = otp.code;
          return { issued: true };
        },
      );
    } catch (error) {
      if (!isAbsorbedFailure(error)) {
        throw error;
      }
      // The throwing transaction rolled back: no OTP row exists, so no code may be handed out.
      deliveredCode = null;
    }
  }

  return { expiresInMinutes: await otpExpiryMinutes(), code: deliveredCode };
}

/**
 * Verifies a login OTP and, on a valid code only, issues a session — both in ONE idempotent
 * transaction, so a session never exists without the code having been consumed in the same commit.
 *
 * An unknown or inactive email, an idempotency conflict and a deactivation race all return
 * `{ valid: false }`; nothing is written in those cases. `idem.requestHash` is computed by the
 * caller and EXCLUDES the code (lane 1 reviewer ruling), so a same-key retry replays the stored
 * outcome.
 *
 * @throws Error when platform.thresholds has no row for the session lifetime key.
 */
export async function verifyLoginOtp(
  email: string,
  code: string,
  idem: IdempotencyInput,
  opts: OtpClockOptions = {},
): Promise<LoginOtpVerification> {
  const userId = await findActiveUserIdByEmail(email);
  if (userId === null) {
    return { valid: false };
  }

  let deliveredToken: string | null = null;
  let persisted: PersistedVerification;
  try {
    persisted = await withIdempotentContext<PersistedVerification>(
      internalCtxForSubject(userId),
      idem,
      async (tx) => {
        const verification = await verifyOtpInTx(tx, email, code, opts);
        if (!verification.valid) {
          return { valid: false };
        }
        const session = await issueSessionInTx(tx, verification.userId, opts);
        deliveredToken = session.token;
        return {
          valid: true,
          userId: session.userId,
          sessionId: session.sessionId,
          issuedAt: session.issuedAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
        };
      },
    );
  } catch (error) {
    if (!isAbsorbedFailure(error)) {
      throw error;
    }
    return { valid: false };
  }

  if (!persisted.valid) {
    return { valid: false };
  }
  return { ...persisted, token: deliveredToken };
}
