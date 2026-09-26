# modules/billing/tests/chart-of-accounts/chart-of-accounts.feature — WBS 4.1a (lane 2).
#
# CoA structure X-XX-XXX-XXX + class 1-9; synthetic pilot chart. NOT a multi-command lifecycle —
# `billing.gl_accounts` (01:1177-1187) is a single reference table with no state machine (brief:
# "An account has no lifecycle in 01"). Every Scenario below matches its
# `chart-of-accounts.test.ts` `describe` title EXACTLY.
#
# Acceptance (doc 38 v4.6 row 4.1a, verbatim): "Off-format code rejected by CHECK; no
# account-code literal in `modules/`."
# ADR-0004 lines served: D1 6 (entity_id stays a hard column) · D2 (c) (per-entity chart,
# `unique (entity_id, code)`, 01:1186) · D3 OD-10 (adopt X-XX-XXX-XXX + 9 classes).
# SCR-ACC-01 rows served: #1 `billing.gl_accounts.code` — CHECK on X-XX-XXX-XXX, class 1-9 from
# the first segment. #2 `billing.gl_accounts.account_type` — values for Cost of Revenue, Other
# Income/Expense, Tax, Control/Memorandum (added to the existing asset/liability/equity/revenue/
# expense list, 01:1183).

Feature: Chart of accounts structure (WBS 4.1a)
  As the CFO (owner, doc 38 v4.6 row 4.1a)
  I want billing.gl_accounts.code to be enforced as X-XX-XXX-XXX with class 1-9 taken from its
    first segment, and account_type restricted to the allowed list
  So that no off-format or out-of-class account code, and no disallowed account_type, can ever
    reach the ledger (doc 38 v4.1a acceptance)

  Background:
    Given a synthetic pilot entity (D-127) — no real account name or code is ever composed by
      this slice; every account row used below is a test/synthetic fixture, never seeded by a
      migration (ADR-0004 D3: no account is seeded)

  Scenario: An account code in the X-XX-XXX-XXX format is accepted and its class is its first segment
    Given a code shaped "1-01-001-001" (class 1, asset) and a valid account_type
    When the account row is inserted through the application pool
    Then the insert succeeds
    And the account's class, read from the first segment of the code, is 1

  Scenario: An off-format account code is rejected by the database CHECK, not only by the domain
    Given a code that does NOT match X-XX-XXX-XXX (wrong segment lengths, missing hyphen, or
      extra characters)
    When the row is inserted directly through an admin/bypass pool, skipping the domain layer
      entirely
    Then the insert is rejected by the database CHECK constraint on billing.gl_accounts.code
    And nothing is written

  Scenario: A first segment outside class 1-9 is rejected by the database CHECK
    Given a code whose first segment is "0" or a value that is not a single digit 1-9 (for
      example "0-01-001-001" or "10-01-001-001")
    When the row is inserted directly through an admin/bypass pool, skipping the domain layer
      entirely
    Then the insert is rejected by the database CHECK constraint on billing.gl_accounts.code
    And nothing is written

  Scenario: An account_type outside the allowed list is rejected
    Given a well-formed code and an account_type string that is not a member of the database's
      allowed account_type list
    When the row is inserted directly through an admin/bypass pool, skipping the domain layer
      entirely
    Then the insert is rejected by the database CHECK constraint on billing.gl_accounts.account_type
    And nothing is written

  Scenario: The same code may exist once per entity and never twice in one entity (unique (entity_id, code))
    Given a well-formed code already inserted for one entity
    When the same code is inserted again for the SAME entity
    Then the second insert is rejected by the unique constraint on (entity_id, code)
    And exactly one row exists for that (entity_id, code) pair
    But the same code inserted for a DIFFERENT entity succeeds (the chart is per-entity, D2 (c))

  Scenario: No account-code literal appears under modules/ (static scan test over the source tree)
    Given every file under modules/ (excluding test/fixture files)
    When the source tree is scanned for a string literal shaped like an X-XX-XXX-XXX account code
    Then no such literal is found outside modules/**/tests/** or modules/**/*.test.*
