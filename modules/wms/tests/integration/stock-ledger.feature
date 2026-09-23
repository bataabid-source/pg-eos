# WBS 2.8 — Stock ledger + derived balance + wms.verify_balance_integrity()
# Copied from .claude/briefs/_slice-2.8.brief.md "Scenario (Gherkin first)" section, verbatim,
# split so every clause is its own step (Given/When/Then/And). Written RED-first by pg-tester on
# 2026-09-23 (BOOTSTRAP-v5 §5), ahead of modules/wms/src/stock-ledger/*, which implements exactly
# this feature; it is now the permanent scenario-by-scenario reference for
# modules/wms/tests/integration/stock-ledger.test.ts.

Feature: Stock ledger is append-only and the derived balance always equals the ledger
  # WBS 2.8; doc 40 P3 (append-only ledgers) / P4 (derived, rebuildable balances);
  # INV-C3-1, INV-C3-2 (doc 40 lines 244-245).

  Background:
    Given the schema is applied
    And fixture entity PST exists
    And warehouse WH1 storage locations exist
    And a fixture client exists
    And fixture SKUs exist

  Scenario: a receipt is written to the ledger and raises the balance at its location
    When postMovement posts a receipt of 12.500 to location L1
    Then wms.stock_movements has one new row with to_location_id L1, from_location_id null, qty 12.500
    And wms.stock_balance (client, sku, L1, '') has qty_on_hand 12.500 and last_movement_at set
    And platform.outbox has one row wms.stock.moved for that movement with the given correlation_id
    And platform.audit_log has one row (wms, stock_movements, that record_id, insert) with the same correlation_id
    And wms.verify_balance_integrity() returns zero rows

  Scenario: the ledger cannot be edited (append-only)
    Given a non-superuser, NOBYPASSRLS role with select and insert on wms.stock_movements
    When that role updates the receipt row's qty
    Then the statement fails with SQLSTATE 42501
    When that role deletes the receipt row
    Then the statement fails with SQLSTATE 42501
    And the row is unchanged

  Scenario: a zero quantity is rejected before the database
    When postMovement is called with qty 0
    Then InvalidQuantityError is thrown
    When postMovement is called with a negative qty
    Then InvalidQuantityError is thrown
    And no ledger row, no outbox row and no audit row were written

  Scenario: a movement that would make stock negative is rejected atomically
    Given on-hand 12.500 at L1
    When postMovement posts a pick of 20.000 from L1
    Then NegativeStockError is thrown
    And on-hand at L1 is still 12.500
    And no ledger row exists for that attempt
    And no outbox row exists for that attempt
    And no audit row exists for that attempt

  Scenario: a transfer moves stock between locations as two single-sided rows
    When postTransfer moves 5.000 from L1 to L2
    Then two ledger rows exist, one out at L1 and one in at L2
    And both rows are movement_type transfer
    And both rows share the same correlation_id
    And on-hand is 7.500 at L1
    And on-hand is 5.000 at L2
    And wms.verify_balance_integrity() returns zero rows

  Scenario: a reversal is a counter-entry, never an edit
    When reverseMovement is called for the transfer's in-row at L2
    Then one adjust row exists with from_location_id L2, qty 5.000
    And that row has ref_table wms.stock_movements
    And that row has ref_id equal to the original row's id
    And that row has reason_code reversal
    And the original row is unchanged
    And on-hand at L2 is 0.000
    When reverseMovement is called for a random unknown id
    Then MovementNotFoundError is thrown

  Scenario: the guard detects any deviation and the balance is rebuildable
    Given the balance row at L1 is tampered by adding 1.000 directly
    Then wms.verify_balance_integrity() returns exactly one row for client, sku, L1
    And that row's diff is -1.000
    When rebuildBalance runs for client, sku
    Then wms.verify_balance_integrity() returns zero rows
    And on-hand at L1 equals the ledger fold

  Scenario: 1,000 random movements under concurrency leave zero rows
    # doc 38 row 2.8 acceptance, verbatim: "Zero rows after 1,000 random movements; property test green"
    Given a printed fast-check seed
    And at least 3 fixture SKUs and at least 5 fixture locations
    When 1,000 random movements are posted with at least 20 in flight at a time
    Then every rejection is a NegativeStockError
    And every rejection is counted, not treated as a failure
    And no other error occurred
    And wms.verify_balance_integrity() returns zero rows
    And for every fixture client, sku, location and batch, qty_on_hand equals deriveBalances of the ledger rows

  Scenario: G1 stays green after the whole suite
    Then select count(*) from wms.verify_balance_integrity() equals 0
