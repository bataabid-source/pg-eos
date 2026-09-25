Feature: Daily occupancy snapshot and overflow (ST-12) billable event (WBS 2.14)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId
    And a warehouse with pallet-type locations and clients holding stock in some of them

  Scenario: Snapshotting a warehouse within contracted capacity
    Given the caller holds role "WH_MGR"
    And a client occupying 5 pallet locations with an active 10-pallet space_allocations row for that block
    When TakeOccupancySnapshot is called for that warehouse
    Then one wms.occupancy_snapshots row exists for that client/warehouse/date with pallets_occupied 5
    And one billing.billable_events row exists for service "ST-01" with qty 5
    And no billing.billable_events row exists for service "ST-12"

  Scenario: Snapshotting a warehouse over contracted capacity generates the overflow event
    Given a client occupying 12 pallet locations with an active 10-pallet space_allocations row for that block
    When TakeOccupancySnapshot is called for that warehouse
    Then one wms.occupancy_snapshots row exists with pallets_occupied 12
    And one billing.billable_events row exists for service "ST-01" with qty 12
    And one billing.billable_events row exists for service "ST-12" with qty 2 (the excess over 10)

  Scenario: A client with no active allocation is fully in overflow
    Given a client occupying 3 pallet locations with no active space_allocations row for that block
    When TakeOccupancySnapshot is called for that warehouse
    Then one billing.billable_events row exists for service "ST-12" with qty 3 (the whole occupied count, since contracted = 0)

  Scenario: A client with zero occupied locations is skipped entirely
    Given a client with no stock_balance rows in the warehouse
    When TakeOccupancySnapshot is called for that warehouse
    Then no wms.occupancy_snapshots row is written for that client

  Scenario: Re-running the snapshot for an already-taken day is a pure no-op, even if stock changed since
    Given a snapshot already taken for a client/block/warehouse/date, with its ST-01 and ST-12 billing rows already written
    And stock for that client changes after the first snapshot (a new receipt into the same block)
    When TakeOccupancySnapshot is called again for the same warehouse and date
    Then the wms.occupancy_snapshots row is UNCHANGED (same id, same pallets_occupied as the first run — the new stock is not reflected)
    And no second billing.billable_events row is written for the same (source_id, service_id) pair, and the existing rows' qty is unchanged

  Scenario: Re-running the snapshot for an already-taken day after the contracted allocation itself shrank writes no overflow row
    Given a client occupying 12 pallet locations with an active 15-pallet space_allocations row for that block
    And TakeOccupancySnapshot has already been called for that warehouse and date, writing one ST-01 row with qty 12 and no ST-12 row
    And the client's space_allocations row for that block is then reduced to 10 pallets, still active
    When TakeOccupancySnapshot is called again for the same warehouse and date
    Then the wms.occupancy_snapshots row is UNCHANGED (same id, pallets_occupied 12)
    And still no billing.billable_events row exists for service "ST-12" for that snapshot
    And the single ST-01 row is unchanged with qty 12
    And the second call's result reports clientsInOverflow 0, matching the billing rows that stand

  Scenario: Re-running the snapshot for an already-taken day after the contracted allocation grew still reports the existing overflow row
    Given a client occupying 12 pallet locations with an active 10-pallet space_allocations row for that block
    And TakeOccupancySnapshot has already been called for that warehouse and date, writing one ST-01 row (qty 12) and one ST-12 row (qty 2)
    And the client's space_allocations row for that block is then raised to 15 pallets, still active
    When TakeOccupancySnapshot is called again for the same warehouse and date
    Then the wms.occupancy_snapshots row is UNCHANGED (same id, pallets_occupied 12)
    And the existing billing.billable_events row for service "ST-12" is UNCHANGED (same id, qty 2) — a re-run never retracts a charge any more than it adds one
    And the call's own result still reports clientsInOverflow 1, matching the ST-12 row that stands

  Scenario: locations_used counts every location type, not just pallet-type
    Given a client occupying 2 pallet locations and 1 shelf location, all in the same block, in the warehouse
    When TakeOccupancySnapshot is called for that warehouse
    Then the snapshot's pallets_occupied is 2 and locations_used is 3

  Scenario: A client occupying two different blocks gets two snapshot rows
    Given a client occupying locations in space_block A and separately in space_block B, both in the warehouse, each with its own space_allocations row
    When TakeOccupancySnapshot is called for that warehouse
    Then two wms.occupancy_snapshots rows exist for that client — one per block, per occupancy_snapshots_grain_uq (snapshot_date, entity_id, client_id, warehouse_id, space_block_id)
    And each block's overflow is evaluated independently against that block's own contracted capacity

  Scenario: Role gate
    Given the caller holds only role "WH_SUP"
    When TakeOccupancySnapshot is called
    Then RoleRequiredError (422) and nothing is written

  Scenario: An audit row is written once per call
    Given a warehouse with two clients holding stock
    When TakeOccupancySnapshot is called for that warehouse
    Then exactly one platform.audit_log row is written for the command's own correlation_id, aggregate wms.occupancy_snapshots

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When TakeOccupancySnapshot is called twice with K and the same body
    Then the second call returns the first result without recomputing
