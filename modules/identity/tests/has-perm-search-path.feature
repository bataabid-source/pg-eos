# modules/identity/tests/has-perm-search-path.feature — WBS 2.16 part 1a-7 (SCR-IDENTITY-RLS-01 delta 4).
# Each Scenario title matches its `it(...)` title in integration/has-perm-search-path.test.ts.
Feature: platform.has_perm runs with a pinned search_path (SCR-IDENTITY-RLS-01 delta 4)

  Scenario: has_perm carries search_path=pg_catalog, pg_temp in proconfig
    Given the database schema with all migrations applied
    When I read pg_proc.proconfig of platform.has_perm(text)
    Then it contains exactly the entry "search_path=pg_catalog, pg_temp"

  Scenario: No SECURITY DEFINER function in the database lacks a pinned search_path
    Given every non-system schema (not pg_catalog, information_schema, pg_toast)
    When I list the SECURITY DEFINER functions whose proconfig has no "search_path=" entry
    Then the list is empty

  Scenario: has_perm still returns true for a held permission and false otherwise, under pgeos_app via withContext
    Given a fixture user holding the seeded GM role, which carries "hr.commission.read_all"
    And a fixture user holding no role
    When each calls platform.has_perm through withContext as pgeos_app
    Then the GM holder gets true for "hr.commission.read_all"
    And the user without a role gets false for "hr.commission.read_all"
    And the GM holder gets false for an unknown code

  Scenario: A temp-schema object named like has_perm's dependencies cannot change its answer
    Given a fixture user holding the GM role
    And a scratch schema with an operator =(text, text) that behaves as equality but also matches the unknown probe code
    And the session role is pgeos_app and its search_path puts the scratch schema before pg_catalog
    When the user calls platform.has_perm with an unknown code
    Then the answer is false
