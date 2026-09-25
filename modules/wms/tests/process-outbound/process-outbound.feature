Feature: Process outbound order — part 1: create, ten-condition check, approve, cancel (WBS 2.11)
  # docs/notes/slice-briefs/_slice-2.11.brief.md — part 1 of a split brief (D-179). Allocate,
  # GeneratePickList and the allocated/partially_allocated cancel path are part 2 — NOT in this
  # feature file. `chk_outbound_orders_status` (13B) is authoritative for the 14-value enum; this
  # part's machine only produces edges into draft, checks_pending, credit_rejected, approved,
  # cancelled.

  As the warehouse system, create a draft outbound order, run nine of the ten pre-dispatch
  conditions (the tenth is blocked, no schema source), let WH_MGR approve, and allow cancellation
  before allocation exists

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

  Scenario: All nine conditions pass — reaches checks_pending
    Given every condition's prerequisite is satisfied
    When RunOutboundChecks is called
    Then status is "checks_pending", credit_check_passed is true, credit_checked_at is set

  Scenario: Condition 1 fails — expired contract
    Given the order's contract end_date is in the past
    When RunOutboundChecks is called
    Then it is rejected with ContractExpiredError carrying i18n key
      "wms.outbound.check.contractExpired" and the expiry date, and status stays "draft"

  Scenario: Condition 2 fails — credit hold moves the order to its own status, not a thrown error
    Given ACC-OUT is on credit hold with reason "overdue"
    When RunOutboundChecks is called
    Then status becomes "credit_rejected", credit_check_passed is false, credit_checked_at is set,
      and the reason is recorded (no error is thrown, condition 2 is checked last)

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
    Then it is rejected with LocationBlockedError carrying i18n key
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

  Scenario: Condition 10 is never evaluated — documents the deliberate gap
    Given an order whose ordered quantity would exceed any plausible per-order limit
    When RunOutboundChecks is called
    Then it is NOT rejected on account of condition 10 — condition 10 has no implementation this
      slice (BLOCKED, no schema source, G-01 batched)

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

  Scenario: Cancel from an unreachable status is illegal (part 2's statuses don't exist yet)
    Given an order whose status is "allocated" (no CANCEL edge exists in this part's machine)
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
