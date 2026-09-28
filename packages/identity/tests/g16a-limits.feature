# packages/identity/tests/g16a-limits.feature — WBS 2.16 part 1a-5 (G-16a authentication limits).
#
# Every scenario below is executed by:
#   - ./g16a-limits.test.ts               (integration, fixed values from the real migration 0042
#                                           seed — same convention as ../tests/otp.test.ts)
#   - ./g16a-limits.property.test.ts      (fast-check, arbitrary small threshold values set INSIDE
#                                           a rolled-back transaction — D8)
#   - modules/identity/tests/otp-login/g16a-refusals.test.ts (endpoint layer — handlers /
#                                           requestOtpCode / verifyOtpCode)
# — named per scenario below, same convention as ./otp-login.feature's own header
# ("Every scenario below is executed by ...").
#
# Ground truth quoted verbatim from the slice brief (docs/notes/slice-briefs/_slice-2.16-1a-5.brief.md):
#   G-16a (EXECUTION-MASTER-v4 §1.8): "OTP 6 digits · TTL 5 min · single-use · 5 attempts · resend
#   60 s · 5/email/hour. Lockout 10 fails/15 min → 15→30→60 min; 3 lockouts/24 h → alert. Rate
#   limits: login 5/min/IP + 20/h/email"
#
# SCHEMA GAP, carried into every scenario below that needs it (brief, Decision 3): identity.otp_codes
# has no created_at column (01-Data-Model.sql:289-296) — the issue instant is derived as
# expires_at - identity.otp.expiry_minutes.
#
# OUT OF SCOPE (pre-build review round 1, finding 1) — SCR-IDENTITY-AUTH-01: the lockout ladder
# (10 fails/15 min -> 15->30->60 min), the "3 lockouts/24h -> alert" clause, the per-IP login rate
# limit (5/min/IP) and the per-email login rate limit (20/h/email) are NOT scenario-tested here —
# the schema has no per-failure timestamp, no lockout record and no IP column, and a lockout-ladder
# test built against the OTP hourly cap could never go green (issuing enough fresh codes to
# accumulate the ladder's failures collides with identity.otp.requests_per_email_per_hour within
# the ladder's own ~17-minute first stage). See docs/notes/SCR-IDENTITY-AUTH-01.md.

Feature: G-16a authentication limits (WBS 2.16 part 1a-5)

  Scenario: After 5 wrong codes the 6th, correct code is refused
    # Executed by: g16a-limits.test.ts (D2, fixed identity.otp.max_attempts) ·
    # g16a-limits.property.test.ts (D8, arbitrary max_attempts) ·
    # g16a-refusals.test.ts (D6, exhausted-attempts refusal shape)
    Given a live, unconsumed, unexpired OTP code
    When the wrong code is submitted identity.otp.max_attempts times
    Then even the correct code is refused on the next verification
    And the row is not consumed

  Scenario: A new request invalidates the previous live code
    # Executed by: g16a-limits.test.ts (D3) · g16a-refusals.test.ts (D6, invalidated-code refusal shape)
    Given a live, unconsumed, unexpired OTP code for an email
    When a second OTP is requested for the same email, at least identity.otp.resend_seconds later
    Then the first code is refused even though it is correct and unexpired
    And the second code verifies successfully

  Scenario: A resend inside 60 s is refused
    # Executed by: g16a-limits.test.ts (D4, resend window) ·
    # g16a-limits.property.test.ts (D8, arbitrary resend_seconds) ·
    # g16a-refusals.test.ts (D7, the "refused request" step of the log-redaction sequence)
    Given an OTP was just requested for an email
    When another OTP is requested for the same email before identity.otp.resend_seconds has elapsed
    Then the request is refused, no identity.otp_codes row is written for it, and the earlier live
      code is not invalidated
    And at the endpoint, the refusal still returns 200 { expiresInMinutes } — the same shape as an
      accepted or unknown-email request (anti-enumeration is preserved)

  Scenario: The 6th request in an hour for one email is refused
    # Executed by: g16a-limits.test.ts (D4, hourly cap) ·
    # g16a-limits.property.test.ts (D8, arbitrary requests_per_email_per_hour)
    Given identity.otp.requests_per_email_per_hour accepted requests already issued for an email
      within the last hour
    When one more OTP is requested for that email
    Then it is refused, and no identity.otp_codes row is written for it

  # NOT COVERED — SCR-IDENTITY-AUTH-01: lockout ladder 10 fails/15 min → 15→30→60 min; 3 lockouts/
  # 24 h → alert; login 5/min/IP; login 20/h/email. (Pre-build review round 1, finding 1 — ruled out
  # of scope: the schema has no per-failure timestamp, no lockout record, and no IP column, and a
  # ladder test built on top of the OTP mechanism could never go green — see the header.)

  Scenario: Every refusal has the same problem shape to the caller
    # Executed by: g16a-refusals.test.ts (D6)
    Given a wrong code, an exhausted-attempts code, and an invalidated code
    When each is verified through the endpoint (handleVerifyOtpCode)
    Then every one of them returns the identical HTTP status, error class (title) and message — no
      field distinguishes which case occurred

  Scenario: No OTP code, hash or email appears in any log line
    # Executed by: g16a-refusals.test.ts (D7)
    Given the injected logger used by the otp-login handlers and login flows
    When a request, a wrong verify, a correct verify, a refused (rate-limited) request, and an
      unexpected (500) failure all occur in sequence
    Then no emitted log line contains the plaintext OTP code, its keyed hash, or the email address

  Scenario: Every limit is read from platform.thresholds, never a literal
    # Executed by: g16a-limits.test.ts (D1, migration 0042 seeds every G-16a number exactly) ·
    # g16a-limits.property.test.ts (D8, every invariant proven for arbitrary threshold values, not
    # just the seeded ones)
    Given migration 0042 has seeded every G-16a number into platform.thresholds
    When each key is read back
    Then its value is exactly the G-16a number, and every enforcement path (attempts cap, resend,
      hourly cap) still behaves correctly when the threshold value is changed to something else
