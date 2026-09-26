// modules/identity/application/otp-login/verify-otp-code.ts — WBS 2.16 part 1a-3.
//
// VerifyOtpCode: exchange a live (email, code) pair for a session token, over
// @pg-eos/identity-mechanisms' `verifyLoginOtp` flow (Master task P6c) — which verifies the code
// and issues the session in ONE idempotent transaction under the package's own internal context.
// Nothing is reimplemented here.
//
// UNIFORM REJECTION (brief, POST-P6c rules 3 and 4). Every outcome that is not a freshly issued
// token becomes the same InvalidOtpError with the same message:
//   - `{ valid: false }` — unknown/inactive email, wrong/expired/consumed code, an absorbed
//     idempotency conflict or deactivation race (login.ts collapses all of them);
//   - `{ valid: true, token: null }` — login.ts's replay signal: the token was delivered by the
//     original call only, so a replay is NOT a successful login. There is no 200 without a token.
//
// THE RESPONSE CARRIES ONLY `token` AND `expiresAt` (brief, POST-P6c rule 2) — never `userId` or
// `sessionId`.
//
// `idem` is REQUIRED and its requestHash EXCLUDES `code` (hashed over `{ email, correlationId }`
// only — login.ts's own contract for its replay semantics); the api layer builds it
// (../../api/otp-login/handlers.ts).

import type { IdempotencyInput } from '@pg-eos/db';
import { verifyLoginOtp } from '@pg-eos/identity-mechanisms';

import { InvalidOtpError } from '../../domain/otp-login/errors.js';
import type { OtpLoginDeps } from './ports.js';

/** One message for every rejection — the message must not distinguish the cases either. */
const INVALID_OTP_MESSAGE =
  'the email and code did not verify. (Allowed: a live, unconsumed code issued to this email for ' +
  'an active user, entered before it expires)';

export interface VerifyOtpCodeInput {
  readonly email: string;
  readonly code: string;
  readonly correlationId: string;
  readonly idem: IdempotencyInput;
}

export interface VerifyOtpCodeResult {
  readonly token: string;
  /** ISO-8601 — the session's expiry exactly as the flow returns it. */
  readonly expiresAt: string;
}

export async function verifyOtpCode(
  input: VerifyOtpCodeInput,
  deps: OtpLoginDeps,
): Promise<VerifyOtpCodeResult> {
  const result = await verifyLoginOtp(input.email, input.code, input.idem, {
    now: () => deps.clock.now(),
  });
  if (!result.valid || result.token === null) {
    throw new InvalidOtpError(INVALID_OTP_MESSAGE);
  }
  return { token: result.token, expiresAt: result.expiresAt };
}
