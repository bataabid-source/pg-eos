# modules/wms/tests/receive-inbound/expiry-balance.feature — WBS 2.9 part 3 (FEFO step of S1).
# Sources: slice brief _slice-2.9-p3-fefo-expiry, doc 40 Part E S1 scenario 2, GM decision D-204
# (SCR-WMS-BATCH-EXPIRY-01 option 1 APPROVED: one expiry per (client, SKU, batch) across ALL locations).
Feature: The stock balance carries the batch expiry (WBS 2.9 part 3)

  Scenario: A received batch line with an expiry writes that expiry on its stock_balance row
    Given a client SKU with no stock
    When a receipt of batch "B1" with expiry "2027-03-01" is posted to location L1
    Then the wms.stock_balance row (client, SKU, L1, "B1") has expiry_date "2027-03-01"
    And the receipt movement row carries expiry_date "2027-03-01"

  Scenario: A second receipt of the same batch keeps the recorded expiry and adds quantity
    Given a balance row for batch "B1" at L1 with expiry "2027-03-01" and qty 10.000
    When a second receipt of batch "B1" with expiry "2027-03-01" and qty 5.000 is posted to L1
    Then the balance row has expiry_date "2027-03-01" and qty_on_hand 15.000
    And a second receipt of batch "B1" with no expiry keeps expiry_date "2027-03-01"

  Scenario: A receipt without expiry leaves expiry_date null; a later one with expiry fills it
    Given a receipt of batch "B2" without expiry is posted to L1
    Then the balance row has expiry_date null
    When a later receipt of batch "B2" with expiry "2027-06-15" is posted to L1
    Then the balance row has expiry_date "2027-06-15"

  Scenario: A different expiry for the same batch is refused at the same location
    Given a balance row for batch "B3" at L1 with expiry "2027-03-01"
    When a receipt of batch "B3" with expiry "2027-04-01" is posted to L1
    Then it is refused with InvalidLedgerEntryError
    And no wms.stock_movements row, no wms.stock_balance change and no outbox row is written by the refused receipt

  Scenario: A different expiry for the same batch is refused at another location (SCR-WMS-BATCH-EXPIRY-01, D-204)
    Given a balance row for batch "B4" at L1 with expiry "2027-03-01"
    When a receipt of batch "B4" with expiry "2027-04-01" is posted to L2
    Then it is refused with InvalidLedgerEntryError
    And no wms.stock_movements row, no wms.stock_balance change and no outbox row is written by the refused receipt
    But a receipt of batch "B4" with expiry "2027-03-01" at L2 is accepted and its balance row carries "2027-03-01"

  Scenario: A put-away transfer carries the source expiry to the destination balance row
    Given a receipt of batch "T1" with expiry "2027-03-01" at the dock location L2
    When 5.000 of batch "T1" is transferred by put-away from L2 to L1
    Then the L1 balance row has expiry_date "2027-03-01" and qty_on_hand 5.000

  Scenario: A put-away transfer of a batch with no expiry leaves the destination expiry null
    Given a receipt of batch "T2" without expiry at the dock location L2
    When 5.000 of batch "T2" is transferred by put-away from L2 to L1
    Then the L1 balance row has expiry_date null and qty_on_hand 5.000

  Scenario: The line expiryDate reaches the stock_balance row through receiveLine and confirmPutaway
    Given an approved inbound order with one line of 10.000 for a client SKU
    When receiveLine receipts the line with batch "H1" and expiryDate "2027-03-01"
    Then the receipt balance row of batch "H1" has expiry_date "2027-03-01"
    When confirmPutaway puts the line away to a suggested storage location
    Then the storage balance row of batch "H1" has expiry_date "2027-03-01"

  Scenario: A receiveLine call whose expiry conflicts with the batch at another location is refused with 422 and writes nothing
    Given batch "H2" already carries expiry "2027-04-01" at another location
    And an approved inbound order with one line of 10.000
    When handleReceiveLine receipts the line with batch "H2" and expiryDate "2027-03-01"
    Then the response is HTTP 422 with title "InvalidLedgerEntryError"
    And the order line and the order version are unchanged
    And no platform.documents row, no wms.stock_movements row, no wms.stock_balance change and no outbox row is written
