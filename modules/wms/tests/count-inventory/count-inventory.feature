# modules/wms/tests/count-inventory/count-inventory.feature — WBS 2.13 (lane 2).
# Every scenario below is executed by modules/wms/tests/count-inventory/count-inventory.test.ts.
# Source: docs/notes/slice-briefs/_slice-2.13.brief.md (verbatim), doc 40 INV-C3-7, doc 40 line 260
# (StartCount, CountLocation, Recount, AdjustCount — TakeOccupancySnapshot is WBS 2.14, not this
# slice).

Feature: Inventory count — blind, recount mandatory, adjustment by approval (WBS 2.13, INV-C3-7)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId
    And an existing wms.warehouses row with locations holding non-zero wms.stock_balance

  Scenario: Start a full count
    Given the caller holds role "WH_MGR"
    When StartCount is called with warehouseId, count_type "full"
    Then one wms.inventory_counts row exists with status "in_progress", version 1
    And one wms.inventory_count_lines row exists per (location, sku, batch) with non-zero stock, each with qty_system frozen and qty_counted null

  Scenario: A counter records a count without seeing the system quantity
    Given a count in progress with an uncounted line
    When CountLocation is called with lineId and qtyCounted
    Then the response carries no qtySystem, variance, or recountQty field
    And the line's qty_counted is set

  Scenario: Counting the same location twice is rejected
    Given a line that has already been counted
    When CountLocation is called again for the same lineId
    Then AlreadyCountedError (422) and the line is unchanged

  Scenario: Completing every line moves the count to review
    Given a count with exactly one uncounted line
    When CountLocation is called for that last line
    Then the count's status becomes "review" and its version increments

  Scenario: A variant line requires a mandatory recount (two variant lines, so "recount" is observed)
    Given a count in "review" with TWO lines whose qty_counted differs from qty_system
    When Recount is called for the first of them with a recountQty
    Then the count's status becomes "recount" (the second variant line is still awaiting its recount)
    And the response carries no qtySystem, variance, or the original qtyCounted

  Scenario: Recounting the LAST variant line returns the count directly to review
    Given a count with exactly ONE line whose qty_counted differs from qty_system (no other variant line pending)
    When Recount is called for that line with a recountQty
    Then the count's status becomes "review" — NOT "recount" — in the same call (both FLAG_RECOUNT and RECOUNT_COMPLETE fire together; version increments by one)
    And a platform.audit_log row is written for the count even though its status ends where it started (review -> recount -> review nets to the same value, but the row still changed and must still be audited)

  Scenario: Recounting a line with no variance is rejected
    Given a count in "review" with a line whose qty_counted equals qty_system
    When Recount is called for that line
    Then NotFlaggedForRecountError (422)

  Scenario: All variant lines recounted returns the count to review
    Given a count in "recount" with exactly one line still awaiting its recount
    When Recount is called for that line
    Then the count's status becomes "review" again

  Scenario: Adjusting before every variant line is recounted is rejected (INV-C3-7's "recount mandatory")
    Given a count in "review" with a line whose qty_counted differs from qty_system and recount_qty still null
    When AdjustCount is called
    Then RecountRequiredError (422) and no stock_movements row is posted

  Scenario: Starting a count on a warehouse with no matching stock lands directly in review
    Given a warehouse with zero non-zero wms.stock_balance rows
    When StartCount is called for that warehouse
    Then the count's status becomes "review" directly (not stuck in "in_progress" with zero lines) — START and COMPLETE fire together

  Scenario: Adjustment posts a stock movement and closes the gap
    Given a count in "review" with a line whose final quantity (recount_qty or qty_counted) is less than qty_system
    When AdjustCount is called by a caller holding role "WH_MGR" with expectedVersion matching
    Then the count's status becomes "adjusted", version increments
    And exactly one wms.stock_movements row exists for that line with movement_type "adjust", correct qty and direction
    And wms.stock_balance for that (client, sku, location, batch) reflects the adjustment
    And the line's adjusted_movement_id is set

  Scenario: A line with zero final variance is not adjusted
    Given a count in "review" where every line's final quantity equals qty_system
    When AdjustCount is called
    Then the count's status becomes "adjusted" and no wms.stock_movements row is posted

  Scenario: AdjustCount by a non-WH_MGR is rejected
    Given the caller holds only role "WH_SUP"
    When AdjustCount is called
    Then RoleRequiredError (422) and nothing is written

  Scenario: AdjustCount before review is rejected
    Given a count still "in_progress"
    When AdjustCount is called
    Then IllegalTransitionError (422)

  Scenario: A mismatched expectedVersion on AdjustCount is rejected
    Given a count whose current version does not equal the caller's expectedVersion (older OR newer than the row's actual version — StaleVersionError fires on any mismatch, not only a stale/older one)
    When AdjustCount is called with that mismatched expectedVersion
    Then StaleVersionError (409) and no column is written

  Scenario: Role gates on StartCount
    Given the caller holds only role "WH_OP"
    When StartCount is called
    Then RoleRequiredError (422) and nothing is written

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When StartCount is called twice with K and the same body
    Then one count exists and the second call returns the first result
