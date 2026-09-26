// modules/identity/tests/otp-login/errors.unit.test.ts — WBS 2.16 part 1a-3 (pg-tester, RED phase).
//
// Unit skeleton for the ONE domain type this slice adds (modules/identity/domain/otp-login/
// errors.ts — brief: "InvalidOtpError only. No state machine, no XState... a stateless
// request/verify pair with no transition to model"). RED: the module does not exist yet.
//
// Why InvalidOtpError is its own class and not a reuse of UnknownOrInactiveUserError (Master
// decision 2, brief): an unmatched code and an unknown user must be INDISTINGUISHABLE to the
// caller — proven at the integration level in ./otp-login.test.ts; this file only pins down the
// class's own shape (name, message carried through, `instanceof Error`) — no domain unit coverage
// beyond that is possible for a plain typed-error class with no invariants of its own.

import { describe, expect, it } from 'vitest';

import { InvalidOtpError } from '../../domain/otp-login/errors.js';

describe('InvalidOtpError (modules/identity/domain/otp-login/errors.ts)', () => {
  it('is an instance of Error with name "InvalidOtpError"', () => {
    const error = new InvalidOtpError('verifyOtp: no live OTP row matched this (email, code) pair.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidOtpError');
  });

  it('carries the message it was constructed with, verbatim — never a fabricated or default message', () => {
    const message = `probe-${Math.random().toString(36).slice(2)}`;
    const error = new InvalidOtpError(message);
    expect(error.message).toBe(message);
  });

  it('is distinct from UnknownOrInactiveUserError — never reused for "unmatched code" (Master decision 2)', async () => {
    const { UnknownOrInactiveUserError } = await import('@pg-eos/identity-mechanisms');
    const invalidOtp = new InvalidOtpError('probe');
    expect(invalidOtp).not.toBeInstanceOf(UnknownOrInactiveUserError);
  });
});
