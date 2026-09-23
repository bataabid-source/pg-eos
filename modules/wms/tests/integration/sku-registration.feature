Feature: A SKU is always owned by exactly one client; registering it under the wrong client is rejected (WBS 2.6; doc 40 §C3, INV-C3-3)
  Background: schema applied; fixture sales.accounts rows for client A and client B exist

  Scenario: an internal caller registers a SKU for client A
    When registerSku (internal ctx) registers a SKU for client A with required fields plus dimensions, storage conditions and tracking policy
    Then wms.skus has one new row with client_id = client A and every supplied field stored as given
    And units_per_pallet on that row equals the packaging fields' product (descriptive check of the existing generated column)
    And platform.audit_log has one row (wms, skus, that record_id, insert) with the same correlation_id
    And platform.outbox has NO row for that correlation_id (decision 9 — no entity_id on wms.skus, G-01 open item)

  Scenario: a portal caller registers a SKU for their own client
    When registerSku (client A portal ctx) registers a SKU with clientId = client A
    Then the row is written (no CrossClientSkuError)

  Scenario: a portal caller cannot register a SKU for a different client
    When registerSku (client A portal ctx) is called with clientId = client B
    Then CrossClientSkuError is thrown
    And no wms.skus row, no outbox row and no audit row were written for that attempt

  Scenario: the same code is rejected only within the same client
    Given client A already has a SKU with code "SKU-001"
    When registerSku (internal ctx) registers another SKU with code "SKU-001" and clientId = client A
    Then DuplicateSkuCodeError is thrown
    When registerSku (internal ctx) registers a SKU with code "SKU-001" and clientId = client B
    Then the row is written (no error) — the same code under a different client is not a mix

  Scenario: an unknown client is rejected
    When registerSku (internal ctx) registers a SKU with clientId = a random uuid with no sales.accounts row
    Then UnknownClientError is thrown

  Scenario: invalid status or picking policy is rejected before the database
    When registerSku is called with status "closed" (outside SKU_STATUSES)
    Then InvalidSkuInputError is thrown and no DB call was made
    When registerSku is called with pickingPolicy "LEFO" (outside PICKING_POLICIES)
    Then InvalidSkuInputError is thrown and no DB call was made

  Scenario: the RLS policy itself rejects a cross-client insert under a genuine non-superuser role
    Given an ephemeral, non-superuser, NOBYPASSRLS role scoped to client A (app.client_id = client A, app.is_internal = false)
    When that role inserts a wms.skus row with client_id = client B directly
    Then the insert fails with SQLSTATE 42501
    And that role selecting wms.skus rows sees none belonging to client B
