# modules/identity/tests/identity-write-definers.feature — WBS 2.16 part 1a-8 (SCR-IDENTITY-RLS-01 delta 2).
# Each Scenario title matches its `it(...)` title in integration/identity-write-definers.test.ts.
Feature: identity.sessions and identity.otp_codes are written only through definer functions (WBS 2.16 part 1a-8)

  Scenario: pgeos_app cannot insert, update or delete identity.sessions directly (42501)
    Given the database schema with all migrations applied
    And an active identity user with one identity.sessions row
    When pgeos_app runs a direct INSERT, UPDATE and DELETE on identity.sessions in an internal context
    Then each statement fails with SQLSTATE 42501

  Scenario: pgeos_app cannot insert, update or delete identity.otp_codes directly (42501)
    Given the database schema with all migrations applied
    And one identity.otp_codes row
    When pgeos_app runs a direct INSERT, UPDATE and DELETE on identity.otp_codes in an internal context
    Then each statement fails with SQLSTATE 42501

  Scenario: pgeos_app can still select both tables in an internal context
    Given one identity.sessions row and one identity.otp_codes row
    When pgeos_app runs SELECT on both tables in an internal context
    Then each SELECT returns the fixture row

  Scenario: Each of the five identity write functions is SECURITY DEFINER with search_path pinned to pg_catalog, pg_temp and is not executable by PUBLIC
    Given the functions identity.otp_issue(text, text, timestamptz, timestamptz), identity.otp_record_failure(uuid[]), identity.otp_consume(uuid, timestamptz), identity.session_issue(uuid, text, timestamptz, timestamptz) and identity.session_revoke(uuid, timestamptz)
    When I read pg_proc and has_function_privilege for each
    Then prosecdef is true, proconfig is exactly "search_path=pg_catalog, pg_temp", PUBLIC has no EXECUTE and pgeos_app has EXECUTE

  Scenario: Each write function refuses a non-internal context (42501)
    Given a withContext call with isInternal false
    When each of the five write functions is called
    Then each call fails with SQLSTATE 42501

  Scenario: The OTP issue → verify → session issue → revoke flow still succeeds as pgeos_app through withContext
    Given an active identity user
    When I generateOtp, verifyOtp with the code, issueSession, verifySession and revokeSession
    Then the code verifies, the session verifies valid, and after revoke the session verifies invalid

  Scenario: A wrong code still increments attempts on every live candidate; a new request still consumes the earlier live code
    Given two live otp_codes rows for one email
    When verifyOtp is called with a wrong code
    Then attempts is 1 on both rows and neither is consumed
    Given a second request for another email after the resend window
    Then the earlier live code has consumed_at set and the new code is live
