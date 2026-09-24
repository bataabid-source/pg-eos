# modules/catalog/tests/maintain-price-list/maintain-price-list.feature — WBS 1.2, M03 catalog.
# Pasted verbatim from docs/notes/slice-briefs/_slice-1.2.brief.md ("Scenario" section).
# Every scenario below is executed by ./maintain-price-list.test.ts (and, for the two
# contract/handler-only legs, ./handlers.test.ts).

Feature: Maintain price list (WBS 1.2, M03 catalog)
  As the CFO I create segment/client/standard price lists whose every line respects the service floor,
  so that nothing is ever sold below min_price without a GM-approved exception

  Background:
    Given entity PST, a CFO user and a GM user scoped to PST, and a SALES_MGR user scoped to PST
    And seeded services ST-01 and HD-04 with min_price set by the fixture (admin pool) and OF-01 with min_price NULL
    And segment SEG-A exists (seed)

  Scenario: Create a draft segment price list
    When CreatePriceList is called by the CFO for PST / SEG-A with code "PL-SEG-A-2026"
    Then a catalog.price_lists row exists with status "draft" and version 1, and one audit row is written

  Scenario: A line at or above the floor is accepted and bumps the list version
    When UpsertPriceListLine is called with price = min_price(ST-01) and expectedVersion 1
    Then the line exists, the list version is 2, and an audit row is written

  Scenario: A line below the floor is rejected from the API (acceptance)
    When UpsertPriceListLine is called with price = min_price(ST-01) - 0.001
    Then it is rejected with PriceBelowFloorError (HTTP 422 through the handler), no line is written and the version is unchanged

  Scenario: A zero price is rejected (A3 "never price at zero")
    When UpsertPriceListLine is called with price = 0
    Then it is rejected at the contract (400 through the handler) — the contract requires a positive numeric string

  Scenario: A service without a floor cannot be priced (INV-C1-1)
    When UpsertPriceListLine is called for OF-01 (min_price NULL)
    Then it is rejected with ServiceNotPriceableError and nothing is written

  Scenario: Import — all rows at or above the floor succeed atomically
    When ImportPriceListLines is called with 3 rows (ST-01 flat, HD-04 tier 0-100, HD-04 tier 100-null)
    Then 3 lines exist, the list version is bumped exactly once, and one audit row is written

  Scenario: Import — one row below the floor rejects the whole import (acceptance)
    When ImportPriceListLines is called with 3 rows where row 2 is below floor
    Then it is rejected with PriceBelowFloorError { rowIndex: 1 } and ZERO lines are written

  Scenario: A broken tier ladder is rejected (INV-C1-3)
    When ImportPriceListLines is called with HD-04 tiers 0-100 and 150-null
    Then it is rejected with TierLadderError and nothing is written

  # Fix round 1 (pg-reviewer F1) — the (price_list_id, service_id, tier_from) unique key means a
  # second UpsertPriceListLine for the same flat line (tier_from null) must UPDATE in place, never
  # INSERT a second row.
  Scenario: Re-upserting a flat line replaces it, never duplicates it
    Given a draft list with a flat ST-01 line at price P1
    When UpsertPriceListLine is called again for ST-01 (still flat) at price P2 with the new expectedVersion
    Then exactly ONE price_list_lines row exists for (list, ST-01), its price is P2, and ActivatePriceList then succeeds

  Scenario: Activate a list with lines
    Given the list has >= 1 valid line
    When ActivatePriceList is called with the current version
    Then status is "active", version is bumped, exactly one "catalog.price_list.activated" outbox row and one audit row share a correlation_id

  Scenario: An empty list cannot be activated
    When ActivatePriceList is called on a list with no lines
    Then it is rejected with EmptyPriceListError

  Scenario: Lines on an active list are refused
    When UpsertPriceListLine is called on an active list
    Then it is rejected with PriceListLockedError

  Scenario: Expire an active list
    When ExpirePriceList is called
    Then status is "expired" and valid_to is today (fixed clock)

  Scenario: Illegal transition
    When ExpirePriceList is called on a draft list
    Then it is rejected with IllegalTransitionError

  # Fix round 1 (pg-reviewer F4) — an active list whose validFrom has not yet arrived cannot be
  # expired: "today" would be before the list was ever meant to take effect.
  Scenario: Expiring a list whose validFrom is after today is rejected
    Given an active list whose validFrom is 30 days after today (fixed clock)
    When ExpirePriceList is called
    Then it is rejected with InvalidValidityError and status stays "active"

  Scenario: Stale version
    When any mutating command (UpsertPriceListLine, ImportPriceListLines, ActivatePriceList,
      ExpirePriceList) is called with a stale expectedVersion
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: Role gate — SALES_MGR cannot write prices (INV-C1-4)
    When CreatePriceList or UpsertPriceListLine is called by the SALES_MGR
    Then it is rejected with RoleRequiredError

  Scenario: GM grants a price exception below the floor
    When GrantPriceException is called by the GM for client C / ST-01 with approved_price = min_price - 1
    Then a price_exceptions row exists with min_price_at_approval = min_price(ST-01), approved_by = GM user id,
      one "catalog.price_exception.granted" outbox row and one audit row share a correlation_id

  Scenario: Only the GM grants exceptions
    When GrantPriceException is called by the CFO
    Then it is rejected with RoleRequiredError and nothing is written

  Scenario: Idempotent replay and conflicting replay
    When a write is replayed with the same Idempotency-Key and body
    Then the stored response is returned and no second row is written
    When the same key is sent with a different body
    Then IdempotencyConflictError (409)

  Scenario: RLS — a CFO scoped to another entity cannot see or write the PST list
    When the same commands run as a CFO whose user_entities excludes PST
    Then the list is not found (PriceListNotFoundError) and nothing is written
