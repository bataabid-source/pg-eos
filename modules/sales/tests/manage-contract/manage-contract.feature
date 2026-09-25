# modules/sales/tests/manage-contract/manage-contract.feature — WBS 1.7, M02 sales.
#
# Pasted VERBATIM from docs/notes/slice-briefs/_slice-1.7.brief.md "Scenario (Gherkin)" section.
# Executed 1:1 by ./manage-contract.test.ts (one `it` per scenario, in this same order), except the
# "unrecognised SLA metric" scenario, whose "(400)" assertion is a Zod contract-boundary check
# (asserted directly in manage-contract.test.ts via AddContractSlaInputSchema.parse, and again at
# the HTTP-status level in ./handlers.test.ts).

Feature: Manage contract (WBS 1.7, M02 sales)
  As the CFO I create and activate client contracts with a price annex and SLA terms, and any
  future order-placing path rejects an order against a contract that is not active

  Background:
    Given entity PST, a qualified account "ACC-1", a CFO user scoped to PST, a standard active
      catalog.price_lists row for PST (from WBS 1.2's fixtures), a segment price list for ACC-1's
      segment, and a price list belonging to a DIFFERENT client

  Scenario: Create a draft contract
    When CreateContract is called for ACC-1 with startDate today
    Then a sales.contracts row exists, status "draft", version 1

  Scenario: Sign the contract
    When SignContract is called with signedByClient "Ahmed Al-Sabah"
    Then status is "signed", signed_at is set

  Scenario: Cannot activate without a price list (INV-C2-2)
    When ActivateContract is called with no price_list_id set
    Then it is rejected with ContractNotPriceableError

  Scenario: Attach a price annex belonging to another client is rejected
    When SetContractPriceList cites the OTHER client's price list
    Then it is rejected with PriceListNotApplicableError

  Scenario: Attach a valid price annex and activate
    When SetContractPriceList cites ACC-1's own segment list, then ActivateContract is called
    Then status is "active"

  Scenario: A qualifying order succeeds against an active contract
    When getContractForOrder is called for ACC-1 / PST / today
    Then it returns the contract with status "active"

  Scenario: An order against an expired contract is rejected (the acceptance line)
    Given the contract's end_date is yesterday
    When ExpireContract is called
    Then status is "expired"
    When getContractForOrder is called for ACC-1 / PST / today
    Then it is rejected with ContractNotActiveError { status: "expired" }

  Scenario: An order against a draft, signed, or suspended contract is rejected the same way
    When getContractForOrder is called against a contract in each of those statuses in turn
    Then each is rejected with ContractNotActiveError naming its own status

  Scenario: A contract cannot expire before its end date
    When ExpireContract is called on an active contract whose end_date is in the future
    Then it is rejected with ContractNotYetExpirableError

  Scenario: Suspend and resume
    When SuspendContract then ResumeContract are called on an active contract
    Then status ends "active" again, version bumped twice

  Scenario: Adding an SLA line requires sla_enabled
    Given the contract has sla_enabled = false
    When AddContractSla is called
    Then it is rejected with SlaNotEnabledError

  Scenario: Adding a valid SLA line
    Given sla_enabled = true
    When AddContractSla is called with metric "otd_pct", targetValue 95, direction "min"
    Then a sales.contract_sla row exists

  Scenario: An unrecognised SLA metric is rejected at the contract boundary
    When AddContractSla is called with metric "not_a_real_metric"
    Then it is rejected at the contract (400)

  Scenario: Billing flags default OFF and are settable at creation
    When CreateContract is called with bills_failed_attempt true and the rest omitted
    Then bills_failed_attempt is true and every other billing flag is false

  Scenario: Stale version is rejected on every mutating command
    When any mutating command is called with a stale expectedVersion
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: An unqualified account is rejected at creation
    When CreateContract is called for an account with no cr_number
    Then it is rejected with AccountNotQualifiedError

  Scenario: Idempotent replay and conflicting replay
    When a write is replayed with the same Idempotency-Key and body
    Then the stored response is returned and no second row is written
    When the same key is sent with a different body
    Then IdempotencyConflictError (409)

  Scenario: RLS — a caller scoped to another entity cannot see or write the contract
    When the same commands run as a user whose entity scope excludes PST
    Then the contract is not found and nothing is written
