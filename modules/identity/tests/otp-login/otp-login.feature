# modules/identity/tests/otp-login/otp-login.feature — WBS 2.16 part 1a-3 (identity's first
# use-case). Every scenario below is executed by ./otp-login.test.ts (integration) and
# ./handlers.test.ts (api-layer mapping) — same convention as
# modules/wms/tests/receive-inbound/receive-inbound.feature ("Every scenario below is executed
# by modules/wms/tests/receive-inbound/receive-inbound.test.ts").
#
# POST-P6c REWRITE (Master task P6c merged @ b18c0ca/69899c5): the pre-authentication path is now
# owned end to end by @pg-eos/identity-mechanisms' requestLoginOtp/verifyLoginOtp flows
# (packages/identity/src/login.ts) — this module never builds an RLS context of any kind, so the
# original "ctx.userId is null" framing no longer applies (there is no ctx parameter left anywhere
# in this use case). requestOtpCode's response is `{ expiresInMinutes }` (a number of minutes, not a
# timestamp); a replayed verification is rejected the same as an invalid one (422), never a 409.

Feature: OTP login endpoint (WBS 2.16 part 1a-3)
  As an unauthenticated caller with an identity.users email
  I want to request a one-time code and exchange it for a session
  So that I can authenticate without a password, over the existing WBS 0.17 OTP/session mechanism

  Background:
    Given identity.users, identity.otp_codes, identity.sessions and platform.thresholds already
      exist and are used exactly as WBS 0.17 (packages/identity) defines them
    And the whole pre-authentication path — account lookup, idempotency, OTP issue/verify, session
      issue — is owned end to end by @pg-eos/identity-mechanisms' requestLoginOtp/verifyLoginOtp
      flows; this module builds no RLS context and holds no mechanism port of its own
    And every write command requires an Idempotency-Key header, which is now REQUIRED input to both
      flows (never optional)

  Scenario: Requesting a code for a known, active email returns 200 with only an expiry, in minutes
    Given an active identity.users row for "user-a@example.invalid"
    When requestOtpCode is called for that email with a valid Idempotency-Key
    Then it returns 200 with a body of exactly { expiresInMinutes }
    And the response never carries the OTP code itself

  Scenario: Requesting a code for an unknown or inactive email is indistinguishable from a known one
    Given no identity.users row for "nobody@example.invalid"
    When requestOtpCode is called for that email with a valid Idempotency-Key
    Then it returns 200 with a body of exactly { expiresInMinutes } — never an error, never a
      different shape
    And no identity.otp_codes row is created for that email

  Scenario: Requesting a code with the same Idempotency-Key but a different body never leaks whether the email is known
    Given a request already made once under an Idempotency-Key
    When the same key is reused with a different request body, for a known email or an unknown one
    Then both cases return 200 with { expiresInMinutes } — login.ts absorbs the idempotency
      conflict internally; no 409, no distinguishable behaviour between the two cases

  Scenario: Verifying the correct, live code issues a session
    Given a code was requested for "user-a@example.invalid" and its plaintext value is known
    When verifyOtpCode is called with that email and code
    Then it returns 200 with { token, expiresAt } — an ISO-8601 string — and nothing else
      (never userId, never sessionId)
    And the token was minted by the existing issueSession mechanism (WBS 0.17), via login.ts

  Scenario: Verifying a wrong or unmatched code is rejected uniformly
    When verifyOtpCode is called with an email and a code that does not match any live OTP row
    Then it is rejected with InvalidOtpError (maps to HTTP 422)
    And no session is issued

  Scenario: Replaying an already-completed verification is rejected the same as an invalid code
    Given a verification already succeeded once under a given Idempotency-Key, code and body
    When verifyOtpCode is called again with the SAME key, body and code
    Then it is rejected with InvalidOtpError (422) — login.ts's own replay signal is
      { valid: true, token: null }, treated identically to { valid: false }
    And there is no 409, and no second session is issued

  Scenario: User A's live code can never issue a session for user B
    Given user A and user B each have their own live, outstanding OTP code
    When verifyOtpCode is called with user B's email and user A's code
    Then it is rejected with InvalidOtpError
    And no session naming user B (or user A) is issued from that call
    When verifyOtpCode is called with user A's email and user B's code
    Then it is rejected with InvalidOtpError
    And no session naming user A (or user B) is issued from that call

  Scenario: Every write requires an Idempotency-Key
    When requestOtpCode or verifyOtpCode is called with no Idempotency-Key header
    Then it is rejected with a 400 Problem before the command runs

  Scenario: A malformed request body is rejected before any command runs
    When requestOtpCode or verifyOtpCode is called with a body missing its required fields
    Then it is rejected with a 400 Problem (ZodError)

  Scenario: An unexpected failure is logged, never leaked to the caller
    Given the underlying mechanism throws an error no typed mapping recognises
    When requestOtpCode or verifyOtpCode is called
    Then it returns a generic 500 Problem and the real error is logged via the injected logger,
      never via console.log
