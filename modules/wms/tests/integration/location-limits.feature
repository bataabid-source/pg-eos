# WBS 2.4 — Set max_weight_kg (1,000 pallet / 750 shelf) and max_volume_cbm per location
# doc 38 row 2.4 acceptance, verbatim: "Over-weight put-away rejected". Written RED-first by
# pg-tester (BOOTSTRAP-v5 §5) ahead of the enforcement this feature describes being added to
# modules/wms/src/stock-ledger/post-movement.ts's postMovement/postTransfer. Database 019
# (019-Warehouse-WH1-Setup.sql) already sets max_weight_kg/max_volume_cbm on all 3,153 storage
# locations and defines wms.check_location_limits(p_location, p_weight, p_volume) (019:343-365) —
# a hard barrier, no warning (19 §3-3) — but nothing calls it yet.
#
# Master design defaults binding these scenarios (slice brief, verbatim):
#   D1 enforcement runs for every movement row that ADDS stock to a location (toLocationId not
#      null), whatever its movement_type — postMovement, both legs of postTransfer, and
#      reverseMovement. Weight/volume limits apply to STORAGE locations only (location_type
#      pallet/shelf, 19 §3-3; Master default, review finding 9); the blocked check applies to
#      every location;
#   D2 the value checked is the RESULTING total at the location — existing wms.stock_balance
#      (all clients/SKUs) plus the incoming qty, by weight (sku.gross_weight_kg) and volume
#      (sku.volume_cbm) — checked inside the same transaction, before the ledger insert; on
#      violation nothing is written (no ledger row, no balance change, no outbox, no audit);
#   D3 a SKU with a null gross_weight_kg (or null volume_cbm) is rejected into a location that has
#      a max_weight_kg (or max_volume_cbm) set — a hard barrier can't be verified without a number;
#   D4 two concurrent put-aways into the same location that together exceed the limit: the builder
#      serialises per location so exactly one succeeds.

Feature: A location's max_weight_kg / max_volume_cbm is a hard barrier on put-away
  # WBS 2.4; doc 19 §3-3 (hard barrier, no warning); doc 38 row 2.4 acceptance
  # "Over-weight put-away rejected"; 019-Warehouse-WH1-Setup.sql:343-365
  # (wms.check_location_limits).

  Background:
    Given the schema is applied, including 019-Warehouse-WH1-Setup.sql
    And fixture entity PST exists
    And real WH1 pallet and shelf storage locations exist
    And a fixture client exists
    And fixture SKUs with named gross_weight_kg / volume_cbm exist
    # Every rejection below also asserts: no new wms.stock_movements row, balance unchanged,
    # no new platform.outbox row and no new platform.audit_log row (review finding 4).

  Scenario: a put-away within the pallet limit (1,000 kg) is accepted and the balance rises
    When postMovement posts a receipt whose resulting load stays under 1,000 kg at a pallet location
    Then the movement is accepted
    And wms.stock_balance at that location rises by the posted qty

  Scenario: an over-weight put-away onto a pallet location is rejected
    When postMovement posts a receipt whose resulting load would exceed 1,000 kg at a pallet location
    Then LocationLimitExceededError is thrown
    And no new wms.stock_movements row was written
    And the balance at that location is unchanged
    And no new platform.outbox row exists for that correlation_id

  Scenario: an over-weight put-away onto a shelf location (750 kg) is rejected
    When postMovement posts a receipt whose resulting load would exceed 750 kg at a shelf location
    Then LocationLimitExceededError is thrown

  Scenario: the check uses the resulting load, not the incoming quantity alone
    Given a location already loaded to most of its remaining headroom
    When postMovement posts a receipt that alone would fit under the limit
    But combined with the existing load would exceed the limit
    Then LocationLimitExceededError is thrown

  Scenario: an over-volume put-away is rejected
    When postMovement posts a receipt whose resulting volume would exceed a pallet location's max_volume_cbm
    Then LocationLimitExceededError is thrown

  Scenario: a SKU with no gross_weight_kg cannot be put away into a weight-limited location
    Given a fixture SKU with gross_weight_kg null
    When postMovement posts a receipt of that SKU into a pallet location
    Then LocationLimitExceededError is thrown

  Scenario: a SKU with gross weight but no volume_cbm is rejected in a volume-limited location
    Given a fixture SKU with gross_weight_kg set and volume_cbm null
    When postMovement posts a receipt of that SKU into a pallet location with max_volume_cbm set
    Then LocationLimitExceededError is thrown (the missing_volume branch)

  Scenario: an operational location is not weight-checked
    Given an operational WH1 location (e.g. RCV-1), location_type 'operational'
    When postMovement posts a receipt over 1,000 kg into it
    Then the movement is accepted
    And a SKU with gross_weight_kg null is also accepted into it

  Scenario: the resulting load counts other clients' stock
    Given client X's SKU fills a pallet location close to its limit
    When client Y posts a put-away into the same location that alone would fit
    Then LocationLimitExceededError is thrown

  Scenario: a put-away into a blocked (structural) location is rejected
    Given a blocked structural WH1 location
    When postMovement posts a receipt into that location
    Then LocationBlockedError is thrown

  Scenario: a transfer whose destination would exceed the limit is rejected atomically
    When postTransfer moves stock whose destination load would exceed the destination's limit
    Then LocationLimitExceededError is thrown
    And no new wms.stock_movements row was written at either the source or the destination
    And the source and destination balances of the moved SKU are unchanged

  Scenario: reversing a pick whose stock no longer fits the location is rejected
    Given a pick from location L, after which L is filled up to its limit
    When reverseMovement posts the counter-entry back into L
    Then LocationLimitExceededError is thrown and nothing is written

  Scenario: two concurrent put-aways that together exceed the limit
    Given two put-aways into the same pallet location, each fitting alone, together exceeding 1,000 kg
    When both are posted concurrently
    Then exactly one succeeds and the other is rejected with LocationLimitExceededError

  Scenario: the limits in wms.locations match 019
    Then every pallet location has max_weight_kg = 1,000 (019-Warehouse-WH1-Setup.sql:236-237)
    And every shelf location has max_weight_kg = 750 (019-Warehouse-WH1-Setup.sql:240-245)
