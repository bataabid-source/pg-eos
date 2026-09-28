# WBS 2.9 part 2 (fix) — the ledger writes wms.stock_balance.expiry_date
# Copied from docs/notes/slice-briefs/_slice-2.9-p2.brief.md "RED tests" Gherkin block, verbatim,
# split so every clause is its own step (Given/When/Then/And). Written RED-first by pg-tester
# (BOOTSTRAP-v5 §5) ahead of the fix to modules/wms/src/stock-ledger/post-movement.ts and
# rebuild-balance.ts; it is now the permanent scenario-by-scenario reference for
# ./expiry-balance.test.ts.

Feature: The stock balance carries the batch expiry (WBS 2.9 part 2)
  # Backlog acceptance, verbatim: "S1's FEFO step turns green; stock_balance.expiry_date populated
  # for every received batch line". Balance key is (client_id, sku_id, location_id, batch_no) —
  # decision 2: the expiry belongs to the batch.

  Background:
    Given the schema is applied
    And a fixture entity exists
    And a fixture client and SKU exist
    And a fixture WH1 storage location exists

  Scenario: A received batch line with an expiry writes that expiry on its stock_balance row
    When a receipt of the batch is posted with an expiry date
    Then wms.stock_balance for (client, sku, location, batch) has that expiry_date
    And qty_on_hand equals the posted quantity

  Scenario: A second receipt of the same batch keeps the recorded expiry and adds quantity
    Given a receipt of the batch has already been posted with an expiry date
    When a second receipt of the same batch is posted with the same expiry date
    Then wms.stock_balance still has that same expiry_date
    And qty_on_hand equals the sum of both receipts

  Scenario: A receipt without expiry leaves expiry_date null; a later one with expiry fills it
    When a receipt of the batch is posted with no expiry date
    Then wms.stock_balance's expiry_date is null
    When a second receipt of the same batch is posted with an expiry date
    Then wms.stock_balance's expiry_date is now that expiry date
    And qty_on_hand equals the sum of both receipts

  Scenario: A conflicting expiry for the same batch is refused, never overwritten silently
    Given a receipt of the batch has already been posted with expiry date A
    When a second receipt of the same batch is posted with a different, non-null expiry date B
    Then the second receipt is refused
    And wms.stock_balance still has expiry date A, unchanged
    And qty_on_hand still equals only the first receipt's quantity
    And no new wms.stock_movements row was written for the refused receipt

  Scenario: rebuild-balance reproduces the same expiry_date as the incremental path
    Given a batch has been built up by more than one receipt, ending with a non-null expiry date
    When rebuildBalance runs for that client and SKU
    Then wms.stock_balance's expiry_date for that batch equals the incremental path's expiry_date

  Scenario: rebuild-balance refuses a key whose ledger holds two different expiries, before deleting anything
    Given a batch's ledger holds two movement rows with two different non-null expiry dates
    When rebuildBalance runs for that client and SKU
    Then it is refused with ConflictingExpiryError
    And the wms.stock_balance row still exists with its original qty_on_hand and expiry_date

  Scenario: A transfer onto a destination row holding a different expiry is refused
    Given the source balance row of a batch has expiry date A at location 1
    And the destination balance row of the same batch has expiry date B at location 2
    When the batch is transferred from location 1 to location 2
    Then the transfer is refused with ConflictingExpiryError
    And both balance rows keep their qty_on_hand and expiry_date
    And no new wms.stock_movements row was written

  Scenario: A line received through receive-inbound with an expiry carries it on its RCV balance row and, after put-away, on its storage balance row
    Given a draft inbound order line for a client and SKU
    When the line is received with an expiry date
    Then wms.stock_balance for the RCV staging location has that expiry_date
    When the line is put away to a storage location
    Then wms.stock_balance for the storage location also has that expiry_date

  # Property test (./expiry-balance.property.test.ts): for any generated sequence of
  # receipts/transfers of ONE batch with a single expiry, wms.stock_balance.expiry_date equals
  # that expiry after incremental posting (postMovementInTx) and after rebuild-balance, at every
  # location the batch touches.
