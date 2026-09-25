# modules/fleet/tests/register-vehicle/register-vehicle.feature — WBS 3.1.
# Every scenario below is executed by modules/fleet/tests/register-vehicle/register-vehicle.test.ts.
# Source: docs/notes/slice-briefs/_slice-3.1.brief.md "Scenario" block (verbatim);
# docs/package/40-Build-Specification-EN.md lines 266-278 (§C4, INV-C4-1 vehicle half);
# database/schema/01-Data-Model.sql:843-866 (tms.vehicles, tms.vehicle_documents).

Feature: Register a vehicle and its documents, computing the expired-document assignment gate

  Scenario: A vehicle registered with no expired documents can be assigned
    Given a new vehicle with plate number "KWT-12345" and two documents, both with a future expiry_date
    When the vehicle is registered
    Then a new tms.vehicles row is inserted with status at its own column default
    And both tms.vehicle_documents rows are inserted, linked to the new vehicle
    And the result's canBeAssigned is true

  Scenario: A vehicle registered with one expired document cannot be assigned
    Given a new vehicle with plate number "KWT-67890" and two documents, one with a past expiry_date and one with a future expiry_date
    When the vehicle is registered
    Then both documents are still inserted as given — registration itself is never blocked by an expired document
    And the result's canBeAssigned is false — the hard gate (doc 38 acceptance; doc 40 INV-C4-1) fires on ANY expired document, not just all of them

  Scenario: A vehicle registered with zero documents can be assigned
    Given a new vehicle with plate number "KWT-00000" and no documents
    When the vehicle is registered
    Then the vehicle is inserted with no tms.vehicle_documents rows
    And the result's canBeAssigned is true — vacuously true, doc 40 INV-C4-1 has nothing to gate on

  Scenario: Registration publishes one domain event carrying the vehicle's entity
    Given a new vehicle with a valid entity context
    When the vehicle is registered
    Then one platform.outbox row is written in the same transaction, event_type "fleet.vehicle.registered", aggregate_type "fleet.vehicles", aggregate_id the new vehicle's id, entity_id the vehicle's own entity_id
    And one platform.audit_log row is written for the vehicle insert, recording every field actually written

  Scenario: A duplicate plate number is rejected
    Given a vehicle already registered with plate number "KWT-12345"
    When another registration is attempted with the same plate number
    Then the command fails with a mapped error (tms.vehicles.plate_no is UNIQUE, doc 07/40 give no other business rule for the collision — the DB constraint is the source of truth) and no row is written

  Scenario: A non-internal actor cannot write vehicle_documents (RLS, not application logic)
    Given a registration attempt by an actor whose session is not internal
    And the vehicle carries at least one document
    When the vehicle is registered
    Then the command fails — tms.vehicle_documents' own internal_only RLS policy (`using (platform.is_internal())`) rejects the write; this is NOT reimplemented as an application-level check, the database is the enforcement layer (CLAUDE.md ARCHITECTURE: "All DB access goes through withContext(ctx, fn), which sets RLS session variables")
