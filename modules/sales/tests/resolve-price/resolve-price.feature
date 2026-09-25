# modules/sales/tests/resolve-price/resolve-price.feature — WBS 1.4, pricing engine.
# Pasted verbatim from docs/notes/slice-briefs/_slice-1.4.brief.md. Every scenario below is
# executed 1:1 by modules/sales/tests/resolve-price/resolve-price.test.ts.

Feature: Resolve price (WBS 1.4, pricing engine)
  As the pricing engine, for a given client, service and quantity, resolve the price to charge by
  trying exception, then the client's active contract's own list, then the client's segment list,
  then the entity's standard list, in that order, and never invent a price

  Background:
    Given entity PST, a client account "ACC-1" in segment SEG-A, a client account "ACC-2" with no
      segment, seeded services HD-04, ST-01, OF-01, DL-11, IT-01 (min_price/standard_cost already
      set by the fixture, admin pool)

  Scenario: Standard list, two-tier ladder with free_units (manual calc case 1)
    Given the entity's standard list has HD-04 priced [0-50, free_units 5, 2.000] then [50-null, 1.500]
    When resolvePrice is called for ACC-2 / HD-04 / qty 120
    Then status is "priced", unitPriceSource is "standard_list", totalPrice is "195.000"
      # manual calc: (50-5)*2.000 + (120-50)*1.500 = 90.000 + 105.000 = 195.000

  Scenario: Segment list, three-tier ladder, no free_units (manual calc case 2)
    Given SEG-A's list has ST-01 priced [0-10, 5.000] [10-50, 4.000] [50-null, 3.000]
    When resolvePrice is called for ACC-1 / ST-01 / qty 80
    Then status is "priced", unitPriceSource is "segment_list", totalPrice is "300.000"
      # manual calc: 10*5.000 + 40*4.000 + 30*3.000 = 50.000 + 160.000 + 90.000 = 300.000

  Scenario: Contract annex, flat line (manual calc case 3)
    Given ACC-1 has an active contract at entity PST whose own price list prices OF-01 flat at 1.200
      (that list is DIFFERENT from ACC-1's segment list, which also has an OF-01 line at a different
      price, to prove the contract wins)
    When resolvePrice is called for ACC-1 / OF-01 / qty 25
    Then status is "priced", unitPriceSource is "contract", totalPrice is "30.000", contractId is set
      # manual calc: 25 * 1.200 = 30.000

  Scenario: Exception overrides everything, including a cheaper contract/segment/standard line
    Given ACC-1 has an approved price_exception for DL-11 at 9.500, valid today
    When resolvePrice is called for ACC-1 / DL-11 / qty 4
    Then status is "priced", unitPriceSource is "exception", totalPrice is "38.000", priceExceptionId is set

  Scenario: An expired exception is ignored, falling through to the next branch
    Given ACC-1's DL-11 exception's valid_to is yesterday
    When resolvePrice is called for ACC-1 / DL-11 / qty 4
    Then unitPriceSource is NOT "exception"

  Scenario: A contract exists but its list has no line for the service — falls through, not pending
    Given ACC-1's active contract's price list has no line for ST-01
    When resolvePrice is called for ACC-1 / ST-01 / qty 80
    Then status is "priced", unitPriceSource is "segment_list" (ACC-1's own segment list still resolves it)

  Scenario: No account segment, no matching list anywhere — pending, never zero
    When resolvePrice is called for ACC-2 / IT-01 / qty 1 (no exception, no contract, no segment,
      standard list has no IT-01 line)
    Then status is "pending" and no totalPrice field is present

  Scenario: An inactive (draft) contract's list is ignored
    Given ACC-1 has a DRAFT (not active) contract with its own OF-01 list
    When resolvePrice is called for ACC-1 / OF-01 / qty 25
    Then unitPriceSource is NOT "contract" (falls through to segment/standard)

  Scenario: An active contract whose price list is internal (is_internal=true) is ignored
    Given ACC-1 has an active contract whose price_list_id points at an INTERNAL price list pricing
      OF-01 far cheaper than ACC-1's own segment list
    When resolvePrice is called for ACC-1 / OF-01 / qty 25
    Then unitPriceSource is NOT "contract" (falls through to segment_list)

  Scenario: An internal standard list is skipped the same way
    Given the entity's standard list for IT-01 is internal (is_internal=true)
    When resolvePrice is called for ACC-2 / IT-01 / qty 1
    Then status is "pending" — the internal list is never used to resolve a client price

  Scenario: A non-KWD-only line is treated as no line for the service
    Given the entity's standard list has an IT-01 line, but priced in USD, not KWD
    When resolvePrice is called for ACC-2 / IT-01 / qty 1
    Then status is "pending" — the non-KWD line does not count (falls through per decision 3)

  Scenario: An RLS outsider is rejected the same as an unknown account
    Given a caller whose ctx has no identity.user_entities row for entity PST
    When resolvePrice is called for ACC-1 / HD-04 / qty 1, with an active standard list present
    Then it is rejected with AccountNotFoundError, never a leaked RLS error or artifact

  Scenario: A newer active contract with no price_list_id never shadows an older one with a real list
    Given ACC-1 has an OLDER active contract with a real price list pricing OF-01 flat at 1.200,
      and a NEWER active contract (later start_date) whose price_list_id is null
    When resolvePrice is called for ACC-1 / OF-01 / qty 25
    Then status is "priced", unitPriceSource is "contract", contractId is the OLDER contract's id

  Scenario: Tie-break — two active standard lists resolve to the one with the later valid_from
    Given two active standard lists both price HD-04, one valid_from 2021-06-01 (1.000) and one
      valid_from 2022-06-01 (9.000)
    When resolvePrice is called for ACC-2 / HD-04 / qty 1
    Then status is "priced", unitPriceSource is "standard_list", totalPrice is "9.000" (the later
      valid_from wins)

  Scenario: Unknown service is rejected
    When resolvePrice is called with a serviceId that does not exist
    Then it is rejected with ServiceNotFoundError

  Scenario: Unknown account is rejected
    When resolvePrice is called with an accountId that does not exist
    Then it is rejected with AccountNotFoundError

  Scenario: Zero quantity is rejected at the contract boundary
    When resolvePrice is called with qty "0"
    Then it is rejected at the contract (positive-quantity validation, same convention as 1.2)
