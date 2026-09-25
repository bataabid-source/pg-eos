# modules/sales/tests/manage-account-credit/manage-account-credit.feature — WBS 1.8, M02 sales.
#
# Pasted verbatim from docs/notes/slice-briefs/_slice-1.8.brief.md ("Scenario (Gherkin ...)").
# Executed 1:1 by ./manage-account-credit.test.ts (one `it` per scenario).

Feature: Manage account credit (WBS 1.8, group-level credit limit and hold)
  As the CFO I set a group-level credit limit and can place or release a hold that blocks a
  future order-placing path in every operating entity, because the account carries no entity_id
  at all

  Background:
    Given a qualified account "ACC-1" (no entity scoping — the account itself has no entity_id
      column), a CFO user, a GM user, and a SALES_REP user (none of whom hold CFO/GM)

  Scenario: Set the group-level credit limit
    When SetCreditLimit is called for ACC-1 with creditLimit 15000.000
    Then sales.accounts.credit_limit is 15000.000, version bumped

  Scenario: A zero credit limit is legal (S7 trial-client case)
    When SetCreditLimit is called with creditLimit 0
    Then it succeeds, credit_limit is 0.000

  Scenario: A negative credit limit is rejected
    When SetCreditLimit is called with creditLimit -1
    Then it is rejected at the contract (400)

  Scenario: CFO places a hold with a reason
    When SetCreditHold is called by the CFO with reason "overdue PST invoice above limit"
    Then credit_hold is true, hold_reason matches, hold_set_by is the CFO's id, hold_set_at is set

  Scenario: A non-CFO/GM cannot place a hold
    When SetCreditHold is called by the SALES_REP
    Then it is rejected with RoleRequiredError

  Scenario: A hold reason is required
    When SetCreditHold is called with an empty reason
    Then it is rejected at the contract (400)

  Scenario: The guard blocks the account the SAME way from all four entity contexts (the
    acceptance line — S6)
    Given the account is on hold
    When getAccountCreditStatus is called for ACC-1 under a PST context, then under a PDL
      context, then under a PCC context, then under a POR context
    Then EVERY call is rejected with AccountOnCreditHoldError carrying the same reason — the
      guard never once consults which entity is asking

  Scenario: The guard passes when there is no hold
    Given the account is not on hold
    When getAccountCreditStatus is called
    Then it returns { accountId, creditLimit, creditHold: false }

  Scenario: Only GM or CFO can release a hold
    When ReleaseCreditHold is called by the SALES_REP
    Then it is rejected with RoleRequiredError

  Scenario: GM releases a hold with a reason
    Given the account is on hold
    When ReleaseCreditHold is called by the GM with reason "payment received, exposure cleared"
    Then credit_hold is false, hold_reason matches the release reason, hold_set_by is the GM's id

  Scenario: CFO can also release a hold
    Given the account is on hold
    When ReleaseCreditHold is called by the CFO
    Then it succeeds

  Scenario: Releasing a hold that isn't there is rejected
    Given the account is NOT on hold
    When ReleaseCreditHold is called
    Then it is rejected with NotOnHoldError

  Scenario: Re-placing a hold that is already active updates the reason
    Given the account is already on hold with reason "A"
    When SetCreditHold is called again with reason "B"
    Then credit_hold is still true, hold_reason is now "B", version bumped

  Scenario: Stale version is rejected on every mutating command
    When any mutating command is called with a stale expectedVersion
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: An unknown account is rejected
    When any command is called with an accountId that does not exist
    Then it is rejected with AccountNotFoundError

  Scenario: Idempotent replay and conflicting replay
    When a write is replayed with the same Idempotency-Key and body
    Then the stored response is returned and no second row is written
    When the same key is sent with a different body
    Then IdempotencyConflictError (409)

  Scenario: RLS — a caller who cannot see the account gets a not-found, never a leaked artifact
    When the same commands run as a user without visibility into ACC-1
    Then the account is not found and nothing is written
