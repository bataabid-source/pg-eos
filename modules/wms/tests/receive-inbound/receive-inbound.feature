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

  Scenario: A zero-quantity line with a reason completes, but CloseInbound is no longer legal from "received"
    When ReceiveLine is called with qty_actual = 0 and a varianceReason
    Then no stock movement is posted, the line counts complete, and ConfirmPutaway is never required
      for that line
    And a "wms.inbound.variance" event is still written for that line (it is a variance)
    But CloseInbound from "received" is now rejected with IllegalTransitionError — the machine no
      longer offers that edge — and CancelInbound (no line has qty_actual > 0) sets status "cancelled"

  Scenario: An all-zero order reaches "received" with no GRN and no wms.inbound.received event (SCR-WMS-INB-01 §6)
    Given a TWO-line order where every line is receipted at qty_actual = 0
    When the LAST open line is receipted
    Then the order status becomes "received" and its version is bumped
    But no platform.documents row is recorded for the order and no "wms.inbound.received" event is
      written — a "wms.inbound.variance" event IS still written for each zero line
    And CancelInbound still sets status "cancelled"

  Scenario: A mixed order (one zero-qty line, one non-zero line) reaches "putaway" through its non-zero line
    Given an order with one zero-qty line and one non-zero line, both receipted
    Then exactly one GRN document and exactly one "wms.inbound.received" event ARE written, as for
      any order that is not all-zero
    When ConfirmPutaway is called only for the non-zero line
    Then the order status becomes "putaway" and CloseInbound then succeeds

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
    When CancelInbound is called after at least one line has qty_actual > 0
    Then it is rejected with CancelBlockedError (stock has physically moved)

  Scenario: CancelInbound is legal from "received" when every line is qty 0
    Given every receipted line has qty_actual = 0 and the order has reached "received"
    When CancelInbound is called
    Then the order status becomes "cancelled"

  Scenario: CancelInbound on an order still "receiving" is rejected
    Given the order has at least one line still open (not every line has been receipted)
    When CancelInbound is called
    Then it is rejected with IllegalTransitionError — the machine has no receiving --CANCEL-->
      cancelled edge

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

  Scenario: ApproveInbound is idempotent — same Idempotency-Key and body replays the stored result
    Given an Idempotency-Key and a request body already used once for ApproveInbound
    When ApproveInbound is called again with the SAME key and the SAME body
    Then the second call returns the stored result without re-running the command, the order's
      version bumps exactly once, and only one audit row exists for the first correlationId

  Scenario: The same Idempotency-Key with a different request body is rejected
    Given an Idempotency-Key already used once for ApproveInbound
    When ApproveInbound is called again with the SAME key but a DIFFERENT body
    Then it is rejected with IdempotencyConflictError (maps to HTTP 409)

  Scenario: ReceiveLine is idempotent — the PDA-retry double-post case
    Given a caller sends the same Idempotency-Key and body for ReceiveLine twice (a PDA retry that
      never saw the first response)
    When ReceiveLine is called again with the SAME key and the SAME body
    Then exactly one stock_movements row is posted for that line and correlation, the second call
      returns the stored result, and the order's version bumps exactly once

  Scenario: A variance receipt may carry a photo pair; a non-variance receipt may not
    When ReceiveLine is called on a variance receipt with variancePhotoUrl and variancePhotoSha256
    Then both columns are persisted on the order line
    When ReceiveLine is called on a NON-variance receipt with a photo pair
    Then it is rejected with VariancePhotoWithoutVarianceError
    And an invalid variancePhotoSha256 is rejected by the contract schema before either command runs

  # ================================================================================================
  # WBS 2.10 — Put-away with automatic location suggestion (conditions + ABC), an in-place
  # enhancement of this file's own SuggestLocation command (doc 38 row 2.10, doc 40 §C3 "A2:
  # conditions, ABC, proximity to shipping, capacity, client assignment").
  # ================================================================================================

  Scenario: A class-A SKU prefers a closer, slightly tighter location over a roomier, farther one
    Given SKU "SKU-A1" has abc_class 'A'
    And location "L-NEAR" (position_no 1) has 60% remaining capacity for this SKU/qty
    And location "L-FAR" (position_no 20) has 90% remaining capacity for the same SKU/qty
    When SuggestLocation is called for SKU-A1
    Then L-NEAR is ranked before L-FAR (proximity outranks capacity for class A)

  Scenario: A class-C SKU keeps the 2.9 capacity-first order
    Given SKU "SKU-C1" has abc_class 'C', the same two candidate locations as above
    When SuggestLocation is called for SKU-C1
    Then L-FAR is ranked before L-NEAR (capacity outranks proximity, unchanged from 2.9)

  Scenario: A SKU with no abc_class set behaves exactly like 2.9 (regression guarantee)
    Given SKU "SKU-NULL" has abc_class null
    When SuggestLocation is called for SKU-NULL against the same two candidates
    Then the ranking is identical to the class-C case

  Scenario: A temperature-sensitive SKU excludes an incompatible zone
    Given SKU "SKU-COLD" requires temp_min -18, temp_max -18 (frozen)
    And zone "Z-AMBIENT" has no temp_min/temp_max set (ambient, no cold chain)
    And zone "Z-FROZEN" has temp_min -25, temp_max -15 (covers the SKU's requirement)
    When SuggestLocation is called for SKU-COLD against locations in both zones
    Then only the Z-FROZEN location(s) appear in the candidate list; the Z-AMBIENT location is
      absent entirely, not merely ranked last

  Scenario: A temperature-sensitive SKU excludes a zone with BOTH bounds set that does not cover its range
    Given SKU "SKU-COLD" requires temp_min -18, temp_max -18 (frozen)
    And zone "Z-CHILLED" has temp_min 0, temp_max 8 (a chilled zone, both bounds set, but does not
      cover a -18 requirement)
    When SuggestLocation is called for SKU-COLD against a location in Z-CHILLED
    Then the Z-CHILLED location is absent entirely — having both bounds set is not enough; the
      range itself must cover the SKU's requirement

  Scenario: A SKU with no temperature requirement is unaffected by zone temperature
    Given SKU "SKU-AMBIENT" has temp_min and temp_max both null
    When SuggestLocation is called against the same Z-AMBIENT and Z-FROZEN locations
    Then both appear as candidates (no temperature filter applies)

  Scenario: A SKU with only ONE temperature bound set matches on that bound independently
    Given SKU "SKU-MIN-ONLY" requires temp_min -18 with temp_max left null (no upper requirement)
    And zone "Z-FROZEN" has temp_min -25, temp_max -15 (compatible on the min bound)
    When SuggestLocation is called for SKU-MIN-ONLY against a location in Z-FROZEN
    Then the Z-FROZEN location appears as a candidate — the SKU's unset temp_max imposes no
      constraint on the zone's own temp_max, each bound is compared independently

  # WBS 2.10 — every existing 2.9 SuggestLocation scenario above this marker still passes
  # unmodified; this is the existing suite (receive-inbound.test.ts) re-run in full, not a new
  # scenario — no Given/When/Then steps belong here (the brief's own regression-guarantee gate).
