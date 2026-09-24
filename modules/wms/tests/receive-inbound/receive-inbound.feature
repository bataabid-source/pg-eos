# modules/wms/tests/receive-inbound/receive-inbound.feature — WBS 2.9, THE GOLDEN SLICE.
# Every scenario below is executed by modules/wms/tests/receive-inbound/receive-inbound.test.ts.

Feature: Receive inbound order (WBS 2.9, golden slice)
  As a warehouse manager and warehouse operator
  I want an inbound order to move draft -> approved -> receiving -> received -> putaway -> closed
  So that stock physically received at the dock ends up correctly located, billed and audited

  Background:
    Given a WH1 warehouse and a client with an active account
    And an inbound order "INB" in status "draft" with one or more order lines, each for a SKU
      owned by that client
    And every command input carries an expectedVersion and no performedBy field — the actor is
      always ctx.userId

  Scenario: Full happy path with a TWO-line order
    Given the caller holds roles "WH_MGR" and "WH_SUP"
    When ApproveInbound is called
    Then the order status becomes "approved"
    When ReceiveLine is called for line 1 at qty_ordered
    Then the order status becomes "receiving" and arrived_at/received_by are set
    When ReceiveLine is called for line 2 (the LAST open line) at qty_ordered
    Then the order status becomes "received", exactly one GRN document (DOC series, "PST-DC-"
      prefix) is recorded, and exactly one "wms.inbound.received" event is written
    When ConfirmPutaway is called for both lines
    Then the order status becomes "putaway"
    When CloseInbound is called
    Then the order status becomes "closed" and only status/closed_at/closed_by change — no new
      document, no new event

  Scenario: A quantity variance emits wms.inbound.variance
    When ReceiveLine is called with qty_actual != qty_ordered and a varianceReason
    Then exactly one "wms.inbound.variance" event and a matching audit_log row (same
      correlation_id) are written, and no variance document is created

  Scenario: A non-variance receipt emits no variance event
    When ReceiveLine is called with qty_actual = qty_ordered
    Then no "wms.inbound.variance" row is written

  Scenario: A zero-quantity line with a reason completes without putaway
    When ReceiveLine is called with qty_actual = 0 and a varianceReason
    Then no stock movement is posted, the line counts complete for CloseInbound, and ConfirmPutaway
      is never required for that line

  Scenario: A cross-order line is rejected
    When ReceiveLine is called with a lineId that belongs to a DIFFERENT order
    Then it is rejected with LineNotFoundError and nothing is written

  Scenario: Re-receiving an already-receipted line is rejected
    When ReceiveLine is called again for a line already receipted
    Then it is rejected with LineAlreadyReceivedError and no second ledger row is posted

  Scenario: Re-putaway of an already-put-away line is rejected
    When ConfirmPutaway is called again for a line already put away
    Then it is rejected with LineAlreadyPutAwayError and no second transfer is posted

  Scenario: A stale expectedVersion is rejected (every command bumps version)
    When any command is called with an expectedVersion that no longer matches the order's current
      version
    Then it is rejected with StaleVersionError (maps to HTTP 409) and nothing changes

  Scenario: An illegal state transition is rejected
    Given the order is still in status "draft"
    When ReceiveLine is called
    Then it is rejected with IllegalTransitionError (maps to HTTP 422) and nothing is written

  Scenario: A SKU belonging to a different client is rejected
    When ReceiveLine references a SKU owned by a different client than the order
    Then it is rejected with a typed SKU-client-mismatch error and nothing is written

  Scenario: A quantity variance without a reason is rejected before any write
    When ReceiveLine is called with qty_actual != qty_ordered and no varianceReason
    Then it is rejected with a typed variance-reason-required error and nothing is written

  Scenario: ConfirmPutaway into an over-weight location is rejected (inherited invariant)
    When ConfirmPutaway is called with a location whose resulting load would exceed its weight
      limit
    Then it is rejected with LocationLimitExceededError and the line stays un-put-away

  Scenario: CloseInbound is refused while any line is still open
    Given at least one line is not yet complete-with-location or cancelled
    When CloseInbound is called
    Then it is rejected with CloseBlockedError and the order stays "putaway"

  Scenario: CancelInbound from draft is allowed
    When CancelInbound is called on a draft order
    Then the order status becomes "cancelled"

  Scenario: CancelInbound after any line has been received is rejected
    When CancelInbound is called after at least one line has been receipted
    Then it is rejected with CancelBlockedError

  Scenario: ApproveInbound without role WH_MGR is rejected
    Given the caller holds no special role
    When ApproveInbound is called
    Then it is rejected with RoleRequiredError

  Scenario: CloseInbound without role WH_SUP is rejected
    Given a received order and a caller who holds no special role
    When CloseInbound is called
    Then it is rejected with RoleRequiredError
    And the order's status and version are unchanged

  Scenario: CancelInbound without role WH_MGR is rejected
    Given a draft order and a caller who holds no special role
    When CancelInbound is called
    Then it is rejected with RoleRequiredError
    And the order's status and version are unchanged

  Scenario: RLS — an outsider cannot see or approve an order outside their entity
    Given a caller with no identity.user_entities row for the order's entity
    When that caller queries or calls ApproveInbound on the order
    Then the order is invisible to their query
    And ApproveInbound is rejected with OrderNotFoundError, the same answer as a missing order
    And the order's status and version are unchanged

  Scenario: Two concurrent ReceiveLines on the last two lines leave the order received
    Given an order with its first line already receipted (status "receiving")
    When the last two lines are receipted concurrently (racing the same expectedVersion)
    Then the order ends up "received", never stuck in "receiving"

  Scenario: Two concurrent ApproveInbound calls with the same expectedVersion
    When two callers call ApproveInbound at once with the same expectedVersion
    Then exactly one succeeds and the other is rejected with StaleVersionError (409)
