Feature: Space management — allocations, reservations, check_space_available() guard (WBS 2.15, INV-C3-8)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId
    And an existing wms.space_blocks row with a known capacity_pallets

  Scenario: Allocate space within sellable capacity
    Given the caller holds role "SALES_MGR"
    And a block with capacity 100 pallets, no existing allocations/reservations/out-of-service rows
    When AllocateSpace is called with qty 40
    Then one wms.space_allocations row exists with status "active", qty 40

  Scenario: Allocating beyond sellable capacity is rejected with the exact available qty
    Given a block with capacity 100 pallets and an existing active allocation of 70
    When AllocateSpace is called with qty 40
    Then SpaceNotAvailableError (422) whose message states the sellable qty is 30
    And no wms.space_allocations row is written

  Scenario: Reserve space within sellable capacity
    Given the caller holds role "SALES_MGR"
    And a block with capacity 100 pallets and no existing allocations/reservations
    When ReserveSpace is called with qty 25, reservedFrom today, expiresAt 10 days from today, reason "quote_pending"
    Then one wms.space_reservations row exists with status "active", qty 25

  Scenario: Reserving beyond sellable capacity is rejected
    Given a block with capacity 100 pallets and an existing active reservation of 80 that has not expired
    When ReserveSpace is called with qty 30
    Then SpaceNotAvailableError (422) and no wms.space_reservations row is written

  Scenario: A reservation longer than the threshold is rejected
    Given the platform.thresholds key space.reservation_max_days is 30
    When ReserveSpace is called with reservedFrom today and expiresAt 45 days from today
    Then ReservationTooLongError (422) and no wms.space_reservations row is written

  Scenario: An expired reservation no longer counts against sellable capacity
    Given a block with capacity 100 pallets and a reservation of 80 whose expires_at is yesterday (status still "active" — never flipped by any job)
    When AllocateSpace is called with qty 90
    Then the allocation succeeds — the expired reservation's qty does not reduce sellable capacity

  Scenario: Allocating with a non-positive qty is rejected at the contract
    When AllocateSpace is called with qty 0
    Then the handler returns a 400 Problem and nothing is written

  Scenario: Reserving with a non-positive qty is rejected by the domain
    When ReserveSpace is called with qty -5
    Then a typed 422 error and nothing is written

  Scenario: Role gates
    Given the caller holds only role "WH_MGR"
    Then AllocateSpace and ReserveSpace each throw RoleRequiredError and write nothing

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When AllocateSpace is called twice with K and the same body
    Then one allocation row exists and the second call returns the first result

  # Round-1 review findings (added post-review, before pg-backend's fix round):

  Scenario: Concurrent allocations on the same block serialize (finding 1)
    Given a block with capacity 100 pallets, no existing allocations/reservations
    When AllocateSpace is called twice simultaneously, each with qty 60
    Then exactly one call succeeds and the other fails with SpaceNotAvailableError (422)
    And exactly one wms.space_allocations row exists, with qty 60

  Scenario: A zero/negative-duration reservation is a distinct typed error (finding 3)
    Given a block with capacity 100 pallets
    When ReserveSpace is called with expiresAt equal to or before reservedFrom
    Then ReservationDateRangeInvalidError (422) is thrown, never ReservationTooLongError
    And no wms.space_reservations row is written

  Scenario: A block belonging to an entity the caller isn't linked to is invisible (finding 5)
    Given a block whose entity is NOT one of the caller's own entities (platform.allowed_entities())
    When AllocateSpace or ReserveSpace is called with that block's id
    Then EntityScopeAmbiguousError (422) is thrown
    And nothing is written to wms.space_allocations/wms.space_reservations/platform.audit_log
