# modules/sales/tests/customer-profile/customer-profile.feature — WBS 1.9, M02 sales.
# Pasted verbatim from docs/notes/slice-briefs/_slice-1.9.brief.md ("Scenario" section, data track).
# Every scenario below is executed by modules/sales/tests/customer-profile/customer-profile.test.ts.

Feature: Customer profile (WBS 1.9, data track)
  As the aggregation query behind the Customer 360 screen, assemble one account's contracts,
  readiness gaps and finance facts from data already built by 1.5/1.7/1.8, with profitability as
  an honest placeholder

  Background:
    Given account "ACC-360" with cr_number set, credit_limit 5000.000, segment SEG-A,
      payment_terms_days 30, credit_hold false, and two contracts: one at entity PST with a
      price_list_id set, one at entity PDL with price_list_id null

  Scenario: A fully-ready account shows no gaps
    When getCustomerProfile is called for ACC-360
    Then every readiness item is present, contracts shows both entities (PST and PDL), finance
      shows creditLimit 5000.000 and creditHold false, profitability is { available: false }

  Scenario: Missing cr_number is a readiness gap owned by CFO
    Given ACC-360's cr_number is cleared
    When getCustomerProfile is called
    Then the "cr_number" readiness item is present:false, owner "CFO"

  Scenario: A zero credit limit is a readiness gap even though it is a legal value (S7)
    Given ACC-360's credit_limit is 0
    When getCustomerProfile is called
    Then the "credit_limit" readiness item is present:false

  Scenario: No priced contract anywhere is a readiness gap
    Given neither of ACC-360's contracts has a price_list_id
    When getCustomerProfile is called
    Then the "priced_contract" readiness item is present:false

  Scenario: An account with one priced contract among several has that gap closed
    Given ACC-360 has one contract with a price list and one without
    When getCustomerProfile is called
    Then the "priced_contract" readiness item is present:true

  Scenario: Finance reflects an active hold
    Given ACC-360 is on credit hold with reason "overdue"
    When getCustomerProfile is called
    Then finance.creditHold is true and finance.holdReason is "overdue"

  Scenario: An unknown account is rejected
    When getCustomerProfile is called with an accountId that does not exist
    Then it is rejected with AccountNotFoundError

  Scenario: RLS — a caller who cannot see the account gets a not-found
    When the same call runs as a user without visibility into ACC-360
    Then it is rejected with AccountNotFoundError

  Scenario: Contracts are ordered newest start_date first
    Given ACC-360 has three contracts with different start dates
    When getCustomerProfile is called
    Then the contracts array is ordered by start_date descending

  Scenario: A negative credit limit is a readiness gap, not a present one (round-1 review finding 1)
    Given ACC-360's credit_limit is -5.000 (no CHECK constraint prevents this)
    When getCustomerProfile is called
    Then the "credit_limit" readiness item is present:false

  Scenario: Readiness reflects only the caller's visible entities (round-1 review finding 4,
    accepted as documented behavior — sales.contracts has its own entity_scope RLS, separate
    from sales.accounts)
    Given ACC-360's only priced contract is at entity PDL, and the caller has
      identity.user_entities visibility into PST only, not PDL
    When getCustomerProfile is called as that caller
    Then the "priced_contract" readiness item is present:false, because the priced contract is
      outside what this caller can see — not a bug, the documented scope of this read
