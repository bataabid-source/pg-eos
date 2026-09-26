// WBS 2.16 part 1a-4 — mock OtpLoginClient implementation (Master decision 4: no delivery channel
// simulated, the OTP code is never surfaced by the UI — the fixture code below exists only so
// pg-tester's own test has a known value to submit, matching handlers.ts's own "the code is never
// returned" rule). No backend endpoint exists yet — this fixture stands in until a real HTTP
// client exists (same precedent as decision-inbox/mock-client.ts).
import { RequestOtpCodeInputSchema } from '@pg-eos/contracts/identity/otp-login';

import type { OtpLoginClient } from './client';

// Dev-time contract check (Master decision 5 / decision-inbox precedent): the email is parsed
// through the same schema a real request's input would go through, so the mock and the future
// real payload are validated identically.
const RequestEmailSchema = RequestOtpCodeInputSchema.pick({ email: true });

// Fixed fixture code — never displayed anywhere in the UI (Master decision 4).
const FIXTURE_CODE = '123456';
// Fixed fixture expiry — no clock is injected into this mock (no domain/ code here), a hardcoded
// value avoids fabricating a "now" the fixture has no real basis for.
const FIXTURE_EXPIRES_AT = '2026-09-26T12:00:00.000Z';
// Fixed fixture expiry window and token, named alongside the fixture code/expiry above (no magic
// literals, CLAUDE.md).
const FIXTURE_EXPIRES_IN_MINUTES = 5;
const FIXTURE_TOKEN = 'tok-mock';

export const mockClient: OtpLoginClient = {
  requestOtpCode: (email: string) => {
    const parsed = RequestEmailSchema.safeParse({ email });
    if (!parsed.success) {
      return Promise.reject(new Error('the email did not verify. (Allowed: a valid email address)'));
    }
    return Promise.resolve({ expiresInMinutes: FIXTURE_EXPIRES_IN_MINUTES });
  },
  verifyOtpCode: (email: string, code: string) => {
    const parsed = RequestEmailSchema.safeParse({ email });
    if (!parsed.success) {
      return Promise.reject(new Error('the email and code did not verify.'));
    }
    if (code === FIXTURE_CODE) {
      return Promise.resolve({ token: FIXTURE_TOKEN, expiresAt: FIXTURE_EXPIRES_AT });
    }
    return Promise.reject(new Error('the email and code did not verify.'));
  },
};
