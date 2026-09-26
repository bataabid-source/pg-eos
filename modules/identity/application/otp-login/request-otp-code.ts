// modules/identity/application/otp-login/request-otp-code.ts — WBS 2.16 part 1a-3.
//
// RequestOtpCode: ask for a login OTP for an email, over @pg-eos/identity-mechanisms'
// `requestLoginOtp` flow (Master task P6c) — never reimplemented here.
//
// The flow owns the whole path: account lookup, idempotency (scoped by the package to the
// account's subject), OTP issue, the live expiry-threshold read, and anti-enumeration — a known,
// an unknown/inactive email, a replay and an absorbed idempotency conflict all return the same
// `{ expiresInMinutes }` (packages/identity/src/login.ts header). This command adds no branch of
// its own on top of it.
//
// THE CODE IS NEVER RETURNED (brief, POST-P6c rule 1). `result.code` is dropped here and is not
// logged or stored: no delivery channel exists yet (recorded gap, MASTER_BACKLOG). The future
// channel is invoked asynchronously, outside the request path (see the handlers.ts header).
//
// `idem` is REQUIRED: the api layer builds it from the Idempotency-Key header and the sha256 of the
// canonical parsed body (../../api/otp-login/handlers.ts).

import type { IdempotencyInput } from '@pg-eos/db';
import { requestLoginOtp } from '@pg-eos/identity-mechanisms';

import type { OtpLoginDeps } from './ports.js';

export interface RequestOtpCodeInput {
  readonly email: string;
  readonly correlationId: string;
  readonly idem: IdempotencyInput;
}

export interface RequestOtpCodeResult {
  readonly expiresInMinutes: number;
}

export async function requestOtpCode(
  input: RequestOtpCodeInput,
  deps: OtpLoginDeps,
): Promise<RequestOtpCodeResult> {
  const result = await requestLoginOtp(input.email, input.idem, { now: () => deps.clock.now() });
  return { expiresInMinutes: result.expiresInMinutes };
}
