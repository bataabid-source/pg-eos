Feature: Customer accounts — one per client across entities, duplicate detection fires (WBS 1.5 proof, ADR-0001)
  Background: schema applied; fixture accounts A, B, C (and contacts) created with synthetic values

  Scenario: an account is a group-level record
    Then information_schema.columns has no entity_id column for sales.accounts (doc 40 §A2, "One sales.accounts row per client across all entities")

  Scenario: the same account code cannot be registered twice
    When a second account with A's code is inserted
    Then the insert fails with SQLSTATE 23505 and sales.accounts still has one row with that code

  Scenario: the same CR number cannot be live twice
    When a second live account with A's cr_number is inserted
    Then the insert fails with SQLSTATE 23505
    When A is soft-deleted (deleted_at set) and the same cr_number is inserted again
    Then the insert succeeds (01 partial unique index on sales.accounts (cr_number) where deleted_at is null) and the new row is removed in cleanup

  Scenario: two accounts without a CR number coexist
    When two live accounts B and C are inserted with cr_number null
    Then both inserts succeed (the 01 partial unique index ignores nulls)

  Scenario: the CR-number path of duplicate detection is closed by the index itself
    Then two LIVE rows with one cr_number cannot exist (01 partial unique index on sales.accounts (cr_number) — proven by the 23505 scenario above)
    And the view's cr_number branch (13B §13B-19 sales.possible_duplicates) can therefore only ever match a pair that the index already forbids — cite both, prove nothing more

  Scenario: duplicate detection fires on identical names
    Given two live accounts D and E with cr_number null and identical name_ar
    Then sales.possible_duplicates returns exactly the pair (D, E) with sim = 1.000

  Scenario: duplicate detection fires on name similarity above 0.85
    Given two live accounts F and G whose name_ar differ by one trailing character
    And similarity(F,G) is above 0.85 and below 1 (asserted in SQL)
    Then sales.possible_duplicates returns exactly the pair (F, G) with sim = round(similarity, 3)

  Scenario: a soft-deleted twin is not reported
    Given G is soft-deleted
    Then sales.possible_duplicates returns no row for (F, G)

  # Written RED first on 2026-09-23 against a database created with the plain C ctype (decision 7,
  # SCR-TRGM-01): datctype read C, not C.UTF-8, and similarity() of Arabic text with itself read 0,
  # not 1, because a plain-C ctype carries zero trigrams for non-ASCII text. Green after SCR-TRGM-01
  # option A (GM-approved 2026-09-23) recreated the database with lc_ctype C.UTF-8, lc_collate C —
  # the same reason every Arabic name-similarity scenario in this feature was RED until then.
  Scenario: Arabic names produce trigrams in this database (SCR-TRGM-01)
    Then the database ctype is C.UTF-8
    And similarity of an Arabic name with itself is 1

  # Written RED first on 2026-09-23 against the pre-0006 view (decision 3(a)): the normalized view
  # definition read "similarity(a.name_ar, b.name_ar) > (0.85)::double precision", not ">=". Green
  # after migration 0006 (13B §13B-19 sales.possible_duplicates, doc 40 §C2 INV-C2-3) landed.
  Scenario: the view compares similarity with >= 0.85 (doc 40 §C2 INV-C2-3; migration 0006)
    Then the normalized view definition contains "similarity(a.name_ar, b.name_ar) >= (0.85)::double precision"
    And it does not contain "similarity(a.name_ar, b.name_ar) > (0.85)::double precision"

  Scenario: an Arabic pair at exactly 0.85 is reported (non-regression; float4 rounding explained in the test)
    Given two live accounts named اختبارمكررتجريبي and اختبارمكررتجريبي كو
    Then their similarity is exactly 0.850000
    And sales.possible_duplicates returns the pair with sim = 0.850

  Scenario: RLS is enabled with the client-portal policy (shape proof, 0.18 pattern)
    Then sales.accounts has relrowsecurity = true and a client_portal_scope SELECT policy using platform.is_internal() / platform.current_client_id()

  Scenario: contacts belong to their account
    Given account A has a primary contact
    When a throw-away fixture account with one contact is deleted
    Then its contact row is gone (on delete cascade, 01)

  Scenario: nothing fixture-like remains
    Then after cleanup sales.accounts has zero rows with code like '_sales_fixture_%'
