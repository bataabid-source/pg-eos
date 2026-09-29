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

  Scenario: Each table has exactly one policy, internal_read (SELECT, platform.is_internal()), and an external context reads 0 rows
    Given the database schema with all migrations applied
    And one identity.sessions row and one identity.otp_codes row
    When I read pg_policies for identity.sessions and identity.otp_codes
    Then each table has exactly one policy: internal_read, cmd SELECT, qual "platform.is_internal()"
    And a select on each table in a context with isInternal false returns 0 rows

  Scenario: Each of the six identity functions is SECURITY DEFINER, volatile, owned by a superuser/bypassrls role, returns its stated type, has search_path exactly pg_catalog, pg_temp and is not executable by PUBLIC
    Given the functions identity.otp_lock_candidates(text, timestamptz, numeric), identity.otp_issue(text, text, timestamptz, timestamptz), identity.otp_record_failure(uuid[]), identity.otp_consume(uuid, timestamptz), identity.session_issue(uuid, text, timestamptz, timestamptz) and identity.session_revoke(uuid, timestamptz)
    When I read pg_proc, pg_roles and has_function_privilege for each
    Then prosecdef is true and provolatile is "v"
    And the owner has rolsuper or rolbypassrls
    And the return type is record (set-returning, TABLE(id uuid, code_hash text, user_id uuid, is_active boolean)) for otp_lock_candidates, uuid for otp_issue and session_issue, void for the other three
    And proconfig is exactly ["search_path=pg_catalog, pg_temp"]
    And PUBLIC has no EXECUTE and pgeos_app has EXECUTE

  Scenario: Each function refuses a non-internal context (42501)
    Given a withContext call with isInternal false
    When each of the six functions is called
    Then each call fails with SQLSTATE 42501

  Scenario: The OTP issue → verify → session issue → revoke flow still succeeds as pgeos_app through withContext
    Given an active identity user
    When I generateOtp, verifyOtp with the code, issueSession, verifySession and revokeSession
    Then the code verifies, the session verifies valid, and after revoke the session verifies invalid

  Scenario: A wrong code still increments attempts on every live candidate; a new request still consumes the earlier live code at exactly its issue instant
    Given two live otp_codes rows for one email
    When verifyOtp is called with a wrong code
    Then attempts is 1 on both rows and neither is consumed
    Given a second request for another email after the resend window
    Then the earlier live code has consumed_at equal to the issue instant of the new request and the new code is live
