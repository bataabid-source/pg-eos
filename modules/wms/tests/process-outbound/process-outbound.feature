Feature: Process outbound order — create, ten-condition check, approve, cancel, allocate,
  generate pick list (WBS 2.11, parts 1 + 2)
  # docs/notes/slice-briefs/_slice-2.11.brief.md. Part 1 (create/checks/approve/cancel from the
  # first four statuses) is above the part-2 marker below; part 2 (Allocate, GeneratePickList, the
  # allocated/partially_allocated cancel-and-release path) is below it. `chk_outbound_orders_status`
  # (13B) is authoritative for the 14-value enum; together parts 1+2 produce edges into draft,
  # checks_pending, credit_rejected, approved, allocated, partially_allocated, cancelled — every
  # other status (picking...delivered) still has no producing edge (2.12's job).

  As the warehouse system, create a draft outbound order, run all ten pre-dispatch conditions
  (condition 10, the per-contract per-SKU order limit, D-189, added part 5), let WH_MGR approve,
  and allow cancellation before allocation exists

  Background:
    Given entity PST, a qualified account "ACC-OUT" with an active priced contract, seeded
      services including OF-01, a warehouse with locations, and a WH_MGR user

  Scenario: Create a draft order
    When CreateOutbound is called for ACC-OUT
    Then status is "draft", version 1, doc_no from the OUT series

  Scenario: CreateOutbound refuses an unqualified client
    Given a client that is soft-deleted or not status="active"
    When CreateOutbound is called
    Then it is rejected with ClientNotQualifiedError and no order is written

  Scenario: All ten conditions pass — reaches checks_pending
    Given every condition's prerequisite is satisfied
    When RunOutboundChecks is called
    Then status is "checks_pending", credit_check_passed is true, credit_checked_at is set

  Scenario: Condition 1 fails — the client has no active contract at all
    Given the client has no sales.contracts row at all, or the client's only contract exists but
      its status is not "active" (for example "draft")
    When RunOutboundChecks is called
    Then it is rejected with ContractNotActiveError, never ContractExpiredError, carrying i18n key
      "wms.outbound.check.contractNotActive", status stays "draft", and nothing is written to the
      outbox or the audit log

  Scenario: Condition 1 fails — expired contract
    Given the order's contract end_date is in the past
    When RunOutboundChecks is called
    Then it is rejected with ContractExpiredError carrying i18n key
      "wms.outbound.check.contractExpired" and the expiry date, and status stays "draft"

  Scenario: Condition 1 resolves the contract by client/entity when the order carries no contractId
    Given CreateOutbound is called with no contractId and the client has an active priced contract
    When RunOutboundChecks is called
    Then condition 1 resolves the contract via the client and entity, does not fail, and status
      becomes "checks_pending"

  Scenario: Condition 2 fails — credit hold moves the order to its own status, not a thrown error
    Given ACC-OUT is on credit hold with reason "overdue"
    When RunOutboundChecks is called
    Then status becomes "credit_rejected", credit_check_passed is false, credit_checked_at is set,
      and the reason is recorded (no error is thrown, condition 2 is checked last)

  Scenario: Condition 2 — the credit_rejected result itself carries the i18n key and the reason
    Given ACC-OUT is on credit hold with a reason
    When RunOutboundChecks is called
    Then the returned result carries i18nKey "wms.outbound.check.creditHold" and params.reason
      equal to the account's hold reason; on a checks_pending outcome the result carries no i18n
      key and no params

  Scenario: Condition 3 fails — insufficient stock
    Given the warehouse holds less quantity of the line's SKU than ordered
    When RunOutboundChecks is called
    Then it is rejected with InsufficientStockError carrying i18n key
      "wms.outbound.check.insufficientStock" naming the SKU, available and ordered quantities

  Scenario: Condition 4 fails — SKU belongs to a different client
    Given an order line's SKU is owned by another client than the order's own client
    When RunOutboundChecks is called
    Then it is rejected with SkuClientMismatchError carrying i18n key
      "wms.outbound.check.skuClientMismatch"

  Scenario: Condition 5 fails — remaining shelf life too short
    Given the only candidate lot's remaining shelf life is below the SKU's minimum issue days
    When RunOutboundChecks is called
    Then it is rejected with ShelfLifeTooShortError carrying i18n key
      "wms.outbound.check.shelfLifeTooShort"

  Scenario: Condition 6 fails — SKU blocked
    Given the line's SKU status is not "active"
    When RunOutboundChecks is called
    Then it is rejected with SkuBlockedError carrying i18n key "wms.outbound.check.skuBlocked"
      naming the SKU and its actual status

  Scenario: Condition 7 fails — every candidate location is blocked
    Given every location holding stock of the line's SKU for this client is blocked
    When RunOutboundChecks is called
    Then it is rejected with OutboundLocationBlockedError carrying i18n key
      "wms.outbound.check.locationBlocked"

  Scenario: Condition 7 passes when an alternative non-blocked location holds enough stock
    Given one stocked location is blocked but another unblocked location alone covers the order
    When RunOutboundChecks is called
    Then condition 7 does not fail

  Scenario: Condition 8 fails — delivery order with an incomplete address
    Given the order type implies delivery and a required ship-to field is missing
    When RunOutboundChecks is called
    Then it is rejected with DeliveryAddressIncompleteError carrying i18n key
      "wms.outbound.check.deliveryAddressIncomplete" naming the missing fields

  Scenario: Condition 8 is skipped for a transfer order with no ship-to fields
    Given the order type is "transfer" and no ship-to fields are set
    When RunOutboundChecks is called
    Then condition 8 does not fail

  Scenario: Condition 9 fails — no price for OF-01 in the client's contract
    Given the client's active contract's price list has no priced line and no exception for OF-01
    When RunOutboundChecks is called
    Then it is rejected with NoServicePriceError carrying i18n key
      "wms.outbound.check.noServicePrice" quoting "OF-01"

  Scenario: Condition 9 fails when the only OF-01 price sits on a price list that is not in force
    Given the client's contract's price list carries an OF-01 line but the price list is status
      "draft", status "expired", or its valid_to has lapsed before the clock date
    When RunOutboundChecks is called
    Then it is rejected with NoServicePriceError carrying i18n key
      "wms.outbound.check.noServicePrice" quoting "OF-01", and status stays "draft"

  Scenario: Condition 10 passes when the SKU has no contract limit row
    Given the client's contract has no sales.contract_sku_limits row for this SKU
    When RunOutboundChecks is called
    Then condition 10 does not fail (no limit means no cap)

  Scenario: Condition 10 passes when the ordered quantity is within the limit
    Given a sales.contract_sku_limits row for this contract/SKU with max_order_qty 100
    And the line orders 50
    When RunOutboundChecks is called
    Then condition 10 does not fail

  Scenario: Condition 10 fails when the ordered quantity exceeds the limit
    Given a sales.contract_sku_limits row for this contract/SKU with max_order_qty 10
    And the line orders 15
    When RunOutboundChecks is called
    Then it is rejected with the order-quantity-exceeded error naming the SKU code, the ordered
      quantity, and the limit — status stays "draft", nothing written to outbox or audit

  Scenario: Condition 10's limit is exact — ordered equal to the limit still passes
    Given max_order_qty 10, the line orders exactly 10
    When RunOutboundChecks is called
    Then condition 10 does not fail (the limit is inclusive)

  # All ten conditions now have a failing test with the correct message (doc 38 row 2.11)

  Scenario: WH_MGR approves a checks_pending order
    When ApproveOutbound is called
    Then status is "approved"

  Scenario: ApproveOutbound without role WH_MGR is rejected
    When ApproveOutbound is called by a caller without WH_MGR
    Then it is rejected with RoleRequiredError and status stays unchanged

  Scenario: ApproveOutbound is illegal from "draft" (checks were never run)
    When ApproveOutbound is called on a still-draft order
    Then it is rejected with IllegalTransitionError and status stays "draft"

  Scenario Outline: Cancelling an order reachable in this part
    Given an order in status "<status>"
    When CancelOutbound is called with a reason
    Then status is "cancelled"

    Examples:
      | status         |
      | draft          |
      | checks_pending |
      | credit_rejected|
      | approved       |

  Scenario: CancelOutbound without role WH_MGR is rejected
    When CancelOutbound is called by a caller without WH_MGR
    Then it is rejected with RoleRequiredError and status stays unchanged

  Scenario: CancelOutbound without a reason is rejected
    When CancelOutbound is called with no reason
    Then it is rejected before any write

  Scenario: A failed ApproveOutbound writes ZERO outbox and ZERO audit rows (rollback proof)
    Given ApproveOutbound is attempted with an illegal transition, without role WH_MGR, or with a
      stale expectedVersion
    When the command is called
    Then it is rejected and writes zero platform.outbox rows and zero platform.audit_log rows for
      that correlationId

  Scenario: A failed CancelOutbound writes ZERO outbox and ZERO audit rows (rollback proof)
    Given CancelOutbound is attempted with no reason, without role WH_MGR, with a stale
      expectedVersion, or from an illegal source status
    When the command is called
    Then it is rejected and writes zero platform.outbox rows and zero platform.audit_log rows for
      that correlationId

  Scenario: Cancel from an unreachable status is illegal (picking onward — 2.12's job)
    Given an order whose status is "picking" (no CANCEL edge exists yet — allocated/
      partially_allocated GAIN one below, in part 2)
    When CancelOutbound is called
    Then it is rejected with IllegalTransitionError and status stays unchanged

  Scenario: Stale version is rejected on every mutating command
    Given a caller holds an expectedVersion older than the order's current version
    When RunOutboundChecks, ApproveOutbound or CancelOutbound is called
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: An unknown order is rejected
    When any command is called with an orderId that does not exist
    Then it is rejected with OrderNotFoundError

  Scenario: Idempotent replay and conflicting replay
    Given a command was already called once with an Idempotency-Key
    When the same key and same body are sent again
    Then the stored response is replayed and no second write happens
    When the same key is sent with a different body
    Then it is rejected with IdempotencyConflictError (409)

  Scenario: RLS — a caller scoped to another entity cannot see or write the order
    Given an order that belongs to entity PST
    When a caller with no user_entities row for PST queries or mutates the order
    Then the order is invisible to them and the mutating command fails with OrderNotFoundError

  # ================================================================================================
  # Part 2 — Allocate (FEFO/FIFO), GeneratePickList (shortest path), CancelOutbound's own
  # allocated/partially_allocated release path (Master decisions 1-7).
  # ================================================================================================

  # Allocation rule (Master ruling, verbatim — _slice-2.11.brief.md): "a line is allocated from a
  # single lot. FEFO/FIFO picks the first lot whose qty_available covers the line; if none covers
  # it, the best single lot supplies min(available, ordered) → `partially_allocated` with the
  # `insufficient_stock` variance constant; if no lot has stock the line stays unallocated; a line
  # is never split across two lots."

  Scenario: FEFO allocation picks the earliest-expiring lot first
    Given two lots of the same SKU with different expiry dates, picking_policy 'FEFO'
    When Allocate is called on an approved order
    Then the earlier-expiring lot alone is reserved, order_lines gets that lot's location/batch,
      status is "allocated"

  Scenario: FIFO allocation for a non-expiry SKU picks the oldest-moved lot first
    Given two lots of the same SKU with different last_movement_at, picking_policy 'FIFO'
    When Allocate is called on an approved order
    Then the lot with the earliest last_movement_at alone is reserved

  Scenario: A line fully covered by the FEFO-first lot is reserved from that lot alone
    Given two lots of a FEFO SKU, each large enough to cover the line on its own
    When Allocate is called on an approved order
    Then only the earlier-expiring lot's qty_allocated grows, by exactly the ordered quantity; the
      line is "complete" with that lot's location/batch and no variance reason; status is
      "allocated"; the later-expiring lot is untouched

  Scenario: When the FEFO-first lot cannot cover the line, the first lot that covers it whole is reserved
    Given a FEFO SKU whose earlier-expiring lot is smaller than the line and whose later-expiring
      lot covers the line on its own
    When Allocate is called on an approved order
    Then the later-expiring lot alone is reserved for the whole line, the line is "complete", and
      the earlier-expiring lot is untouched (a line is never split across two lots)

  Scenario: Partial allocation when stock runs out mid-line
    Given an approved order whose ordered quantity exceeds the warehouse's available stock
    When Allocate is called
    Then status is "partially_allocated", the line is "partial", the order is not auto-closed

  Scenario: A line larger than any single lot is partially allocated from one lot, the remainder unallocated
    Given two lots of the same SKU, neither of which covers the line alone although their sum would
    When Allocate is called on an approved order
    Then status is "partially_allocated", the line is "partial" with qty_actual equal to the best
      (first in FIFO order) lot's availability and variance reason "insufficient_stock", the line
      records that one lot's location/batch, and the other lot is untouched

  Scenario: A line with no stock stays unallocated
    Given an approved order whose line's SKU has no stock_balance row at all
    When Allocate is called
    Then status is "partially_allocated", the line stays "open" with no location and no batch, and
      no stock_balance row is created or changed

  Scenario: Two concurrent Allocates on the same lot never over-reserve it
    Given two approved orders whose lines each need the whole of the one lot that exists
    When Allocate is called on both at the same time
    Then the candidate stock_balance row is locked `for update`, exactly one order is "allocated",
      the other is "partially_allocated" with its line "open", and the lot's qty_allocated equals
      its own quantity — never more

  Scenario: Allocate's audit row records the reserved lot per line
    Given an approved order with one line covered by a lot and one line with no stock
    When Allocate is called
    Then the one audit row's lines carry, per line, the reserved lot's locationId and batchNo, or
      null for the unallocated line

  Scenario: Allocate writes outbox + audit, never a stock_movements row
    Given an approved order that Allocate will either fully or partially allocate
    When Allocate is called
    Then a full allocation writes exactly one "wms.outbound.allocated" outbox event and one audit
      row, and a partial allocation writes exactly one "wms.outbound.partially_allocated" outbox
      event and one audit row — in both cases zero wms.stock_movements rows are written

  Scenario: Allocate is illegal before approval (still draft or checks_pending)
    When Allocate is called on a draft or checks_pending order
    Then it is rejected with IllegalTransitionError

  Scenario: GeneratePickList orders by position_no (shortest path), not line order
    Given an allocated order whose lines sit at locations with different position_no
    When GeneratePickList is called
    Then the lines are returned ordered by location position_no ascending, ties broken by line_no

  Scenario: GeneratePickList is illegal before allocation
    When GeneratePickList is called on an approved-but-not-yet-allocated order
    Then it is rejected with IllegalTransitionError

  Scenario: Cancelling an allocated order releases the reservation
    When CancelOutbound is called on an allocated order
    Then qty_allocated on the single lot reserved for the line returns to its pre-allocation value,
      status is "cancelled"

  Scenario: Cancelling a partially_allocated order releases only the lot it reserved
    When CancelOutbound is called on a partially_allocated order
    Then only the one lot this order's line reserved is released; every other lot is unaffected

  Scenario: Cancel after allocation releases exactly the one reserved lot
    Given one lot reserved by two allocated orders and a second lot of the same SKU reserved by none
    When CancelOutbound is called on one of the two orders
    Then that lot's qty_allocated drops by exactly that order's reserved quantity, the other order's
      reservation on it stays, and the second lot is untouched

  Scenario: CancelOutbound's audit row records exactly the released lot per line
    When CancelOutbound is called on an allocated order, an approved order, or a partially_allocated
      order whose only line was never allocated
    Then the audit row's released entries are [{lineId, locationId, batchNo, qty}] matching the lot
      actually released, and empty when nothing was allocated

  Scenario: Stale version is rejected on Allocate and the extended CancelOutbound
    Given a caller holds an expectedVersion older than the order's current version
    When Allocate or CancelOutbound (from allocated/partially_allocated) is called
    Then it is rejected with StaleVersionError (409) and nothing changes, nothing is released

  Scenario: Idempotent replay and conflicting replay on Allocate
    Given Allocate was already called once with an Idempotency-Key
    When the same key and same body are sent again
    Then the stored response is replayed and no second write happens
    When the same key is sent with a different body
    Then it is rejected with IdempotencyConflictError (409)

  Scenario: RLS — a caller scoped to another entity cannot see or allocate the order
    Given an approved order that belongs to entity PST
    When a caller with no user_entities row for PST queries or calls Allocate on the order
    Then the order is invisible to them and Allocate fails with OrderNotFoundError

  # ================================================================================================
  # Part 3 — PickLine + CheckOrder (WBS 2.12 part 1, _slice-2.12.brief.md). Meets doc 38 row 2.12's
  # own acceptance criterion, verbatim: "Self-check rejected". New machine edges this part:
  # {allocated, partially_allocated} --START_PICKING--> picking, picking --COMPLETE_PICKING--> picked,
  # picked --CHECK--> checked. PackOrder/LoadOrder are part 2, not built here.
  # ================================================================================================

  Scenario: PickLine records the picked quantity and posts a pick ledger movement
    Given an allocated order with one line
    When PickLine is called for that line at the full ordered quantity
    Then a wms.stock_movements row (movement_type 'pick') is posted, stock_balance.qty_on_hand and
      qty_allocated both drop by that amount, the line is "complete"

  Scenario: The order transitions to picking on the first PickLine call, then picked when complete
    Given an allocated order with two lines
    When PickLine is called on the first line only
    Then the order status is "picking"
    When PickLine is then called on the second (last remaining) line
    Then the order status is "picked" and picked_by is set to the actor who completed it

  Scenario: A shortage on PickLine requires a variance_reason
    Given qty_actual less than qty_ordered on a line
    When PickLine is called with no variance_reason
    Then it is rejected before any write — the line status, stock_balance and stock_movements are
      unchanged

  Scenario: PickLine is illegal before allocation
    Given an order that is only "approved", not yet allocated
    When PickLine is called
    Then it is rejected with IllegalTransitionError

  Scenario: CheckOrder rejects a self-check
    Given the same actor who picked the order calls CheckOrder
    When CheckOrder is called
    Then it is rejected with SelfCheckNotAllowedError, status stays "picked"

  Scenario: CheckOrder succeeds when the checker differs from the picker
    Given a picked order whose picker is actor A
    When CheckOrder is called by actor B
    Then status is "checked", checked_by is set to actor B

  Scenario: CheckOrder is illegal before picking completes
    Given an order that is "allocated" or only partially "picking" (not every line complete)
    When CheckOrder is called
    Then it is rejected with IllegalTransitionError

  Scenario: Stale version is rejected on PickLine and CheckOrder
    Given a caller holds an expectedVersion older than the order's current version
    When PickLine or CheckOrder is called
    Then it is rejected with StaleVersionError (409) and nothing changes

  Scenario: Idempotent replay and conflicting replay on PickLine and CheckOrder
    Given a command was already called once with an Idempotency-Key
    When the same key and same body are sent again
    Then the stored response is replayed and no second write happens
    When the same key is sent with a different body
    Then it is rejected with IdempotencyConflictError (409)

  # ================================================================================================
  # Part 4 — WBS 2.12 part 2 (_slice-2.12.brief.md), item 3: the zero-qty repeat-pick-on-an-
  # unreserved-line logic gap. A never-allocated line's own `location_id` stays null and its
  # `qty_actual` is stamped `0` by Allocate itself, so neither of the double-pick guard's two
  # existing signals (a posted pick ledger row, or a reserved line's own qty_actual reading zero)
  # can ever catch a REPEAT zero-qty pick on it — today's guard wrongly re-accepts it.
  # ================================================================================================

  Scenario: PickLine rejects a repeat zero-qty pick on a line that was never allocated
    Given a partially_allocated order with one reserved line and one never-allocated line
      (location_id null)
    When PickLine is called on the never-allocated line with qtyActual 0 and a variance reason
    Then the first call succeeds, releases nothing, posts no ledger row, and sets the line to
      "partial"
    When PickLine is called again on the SAME never-allocated line with the same zero qtyActual and
      a variance reason
    Then the second call is rejected with LineAlreadyPickedError (422), nothing further is written

  # ================================================================================================
  # Part 5 — WBS 2.12 part 2, item 4: `picked_by` records only the LAST picker on a multi-person
  # pick, so self-check must reject a checker who is the `performed_by` of ANY pick movement on this
  # order, not just equal to `picked_by`. Proves `hasPickMovementByActor`'s own join/scope.
  # ================================================================================================

  Scenario: CheckOrder rejects a checker who posted a pick movement on the order but is not picked_by
    Given a two-line order where actor A picks the first line and actor B picks the second line
      and completes the order, so picked_by is actor B
    When actor A, who never was picked_by but posted a pick movement on this order, calls CheckOrder
    Then it is rejected with SelfCheckNotAllowedError, status stays "picked"

  Scenario: CheckOrder does not leak a pick movement from a different order
    Given actor A picks and completes order X, and a different actor picks and completes order Y
    When actor A, who has a pick movement on order X but never touched order Y, calls CheckOrder on
      order Y
    Then it succeeds, status becomes "checked", checked_by is set to actor A

  Scenario: RLS — a caller scoped to another entity cannot pick or check the order
    Given an allocated or picked order that belongs to entity PST
    When a caller with no user_entities row for PST calls PickLine or CheckOrder on the order
    Then the order is invisible to them and the command fails with OrderNotFoundError
