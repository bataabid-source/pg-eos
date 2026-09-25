# modules/sales/tests/manage-quote/manage-quote.feature — WBS 1.6, M02 sales.
#
# Pasted VERBATIM from docs/notes/slice-briefs/_slice-1.6.brief.md "Scenario (Gherkin)" section.
# Executed 1:1 by ./manage-quote.test.ts (one `it` per scenario, in this same order).

Feature: Manage quote (WBS 1.6, M02 sales)
  As a sales rep I build a quote whose lines never go below floor without a GM-approved exception,
  route it through sales-manager and finance review, and once it is sent it is frozen — any further
  change creates a brand-new quote

  Background:
    Given entity PST, a qualified account "ACC-1" (cr_number set, status active), seeded services
      ST-01 (min_price set) and HD-04 (min_price set), a SALES_REP user, a SALES_MGR user, a CFO
      user and a GM user, all scoped to PST

  Scenario: Create a draft quote and add a line at or above the floor
    When CreateQuote is called by the SALES_REP for ACC-1
    Then a sales.quotes row exists, status "draft", version 1
    When UpsertQuoteLine is called for ST-01 at price = min_price(ST-01), qty 3
    Then the line exists, subtotal/total reflect qty*price, version is 2

  Scenario: A line below the floor is rejected without an exception
    When UpsertQuoteLine is called with price below min_price(ST-01) and no exceptionId
    Then it is rejected with InvalidPriceExceptionError and no line is written

  Scenario: A line below the floor is accepted with a valid GM-granted exception
    Given a GM-approved price_exception for ACC-1 / ST-01 below min_price, valid today
    When UpsertQuoteLine cites that exceptionId with the exception's approved price
    Then the line is written and below_min is true

  Scenario: An expired exception is rejected
    Given ACC-1's ST-01 exception's valid_to is yesterday
    When UpsertQuoteLine cites it
    Then it is rejected with InvalidPriceExceptionError

  Scenario: Submit for review requires at least one line
    When SubmitForReview is called on a quote with zero lines
    Then it is rejected with EmptyQuoteError

  Scenario: Full happy path to approved (no exception, healthy margin)
    When SubmitForReview then ApproveCommercial (SALES_MGR) then ApproveFinance (CFO) are called
    Then status ends "approved", exactly one "sales.quote.approved" outbox row and one audit row
      share a correlation_id

  Scenario: CFO cannot approve a quote with a below-floor exception line — only GM can
    Given the quote has one line with a valid exceptionId
    When ApproveFinance is called by the CFO
    Then it is rejected with RoleRequiredError
    When ApproveFinance is called by the GM
    Then it succeeds

  Scenario: CFO cannot approve a quote whose estimated margin is below 10% — only GM can
    Given the quote's lines yield estimatedMarginPct < 10
    When ApproveFinance is called by the CFO
    Then it is rejected with RoleRequiredError
    When ApproveFinance is called by the GM
    Then it succeeds

  Scenario: A sales manager returns a quote to draft for changes
    When ReturnToDraft is called from commercial_review
    Then status is "draft" and lines are editable again

  Scenario: Lines are frozen outside draft
    When UpsertQuoteLine is called while status is commercial_review
    Then it is rejected with QuoteFrozenError

  Scenario: Send freezes the quote
    Given status is "approved"
    When SendQuote is called
    Then status is "sent", frozen_snapshot is set, sent_at is set

  Scenario: Any edit after send is rejected and steered to revise
    When UpsertQuoteLine (or ApproveFinance, or SubmitForReview) is called on a "sent" quote
    Then it is rejected with QuoteFrozenError

  Scenario: Revising a sent quote creates a brand-new quote, untouched original
    When ReviseQuote is called on the sent quote
    Then a NEW quote exists with status "draft", a new doc_no, the same lines cloned (fresh
      min_price_at_quote), and the ORIGINAL quote's row is completely unchanged

  Scenario: Recording the client's decision
    When RecordDecision "accepted" is called on the sent quote
    Then status is "accepted" and decided_at is set

  Scenario: Stale version is rejected on every mutating command
    When any mutating command is called with a stale expectedVersion
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: An unqualified account is rejected at creation
    When CreateQuote is called for an account with no cr_number
    Then it is rejected with AccountNotQualifiedError

  Scenario: Idempotent replay and conflicting replay
    When a write is replayed with the same Idempotency-Key and body
    Then the stored response is returned and no second row is written
    When the same key is sent with a different body
    Then IdempotencyConflictError (409)

  Scenario: RLS — a caller scoped to another entity cannot see or write the quote
    When the same commands run as a user whose entity scope excludes PST
    Then the quote is not found and nothing is written
