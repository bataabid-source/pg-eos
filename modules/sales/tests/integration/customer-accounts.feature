Feature: Customer accounts — one per client across entities, duplicate detection fires (WBS 1.5 proof, ADR-0001)
  Background: schema applied; fixture accounts A, B, C (and contacts) created with synthetic values

  Scenario: an account is a group-level record
    Then information_schema.columns has no entity_id column for sales.accounts (doc 40 §A2 l.46)

  Scenario: the same account code cannot be registered twice
    When a second account with A's code is inserted
    Then the insert fails with SQLSTATE 23505 and sales.accounts still has one row with that code

  Scenario: the same CR number cannot be live twice
    When a second live account with A's cr_number is inserted
    Then the insert fails with SQLSTATE 23505
    When A is soft-deleted (deleted_at set) and the same cr_number is inserted again
    Then the insert succeeds (01 l.435 partial index) and the new row is removed in cleanup

  Scenario: two null cr_numbers coexist
    Then two live fixture accounts (B and C) with cr_number null coexist without violating the partial unique index

  Scenario: the CR-number path of duplicate detection is closed by the index itself
    Then two LIVE rows with one cr_number cannot exist (01 l.435 partial unique index — proven by the 23505 scenario above)
    And the view's cr_number branch (13B l.2135) can therefore only ever match a pair that the index already forbids — cite both lines, prove nothing more

  Scenario: duplicate detection fires on identical names
    Given two live accounts D and E with cr_number null and identical name_ar
    Then sales.possible_duplicates returns exactly the pair (D, E) with sim = 1.000

  Scenario: duplicate detection fires on name similarity above 0.85
    Given two live accounts F and G whose name_ar differ by one trailing character and similarity(F,G) > 0.85 (asserted in SQL)
    Then sales.possible_duplicates returns exactly the pair (F, G) with sim = round(similarity, 3)

  Scenario: a soft-deleted twin is not reported
    Given G is soft-deleted
    Then sales.possible_duplicates returns no row for (F, G)

  Scenario: the doc-40 boundary at exactly 0.85 — the view text (ADR-0001 known discrepancy, GM directive phase D migration 0006)
    Then pg_get_viewdef('sales.possible_duplicates') contains ">= 0.85" and not the bare "> 0.85" text (RED before migration 0006, GREEN after)

  Scenario: the doc-40 boundary at exactly 0.85 — non-regression (ADR-0001 known discrepancy)
    Given the fixed pair name_ar = 'premiumlogistics' and name_ar = 'premiumlogistics co', whose similarity() is exactly 0.85
    Then sales.possible_duplicates reports the pair with sim 0.850 on both the old and the new view text (float4 rounding — never a weakened test)

  Scenario: RLS is enabled with the client-portal policy (shape proof, 0.18 pattern)
    Then sales.accounts has relrowsecurity = true and a client_portal_scope SELECT policy using platform.is_internal() / platform.current_client_id()

  Scenario: contacts belong to their account
    Given account A has a primary contact
    When a throw-away fixture account with one contact is deleted
    Then its contact row is gone (on delete cascade, 01)

  Scenario: nothing fixture-like remains
    Then after cleanup sales.accounts has zero rows with code like '_sales_fixture_%'
