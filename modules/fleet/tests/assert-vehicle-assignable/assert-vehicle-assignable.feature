# modules/fleet/tests/assert-vehicle-assignable/assert-vehicle-assignable.feature — WBS 3.1.
# Every scenario below is executed by
# modules/fleet/tests/assert-vehicle-assignable/assert-vehicle-assignable.test.ts.
# Source: docs/notes/slice-briefs/_slice-3.1.brief.md "Master design correction (2026-09-25...)"
# section, second Gherkin Feature block (verbatim);
# docs/package/40-Build-Specification-EN.md lines 266-278 (§C4, INV-C4-1 vehicle half);
# database/schema/01-Data-Model.sql:843-866 (tms.vehicles, tms.vehicle_documents).

Feature: Assert a vehicle is assignable — the real hard gate on expired documents

  Scenario: A vehicle with no expired documents passes the gate
    Given a registered vehicle whose documents all have a future expiry_date
    When AssertVehicleAssignable is called for that vehicle at the current time
    Then it resolves with no value — no error is thrown

  Scenario: A vehicle with any expired document fails the gate
    Given a registered vehicle with one document whose expiry_date is in the past
    When AssertVehicleAssignable is called for that vehicle at the current time
    Then it throws VehicleNotAssignableError
    And the error carries the vehicle's plateNo and the expired document's docType and expiryDate as params, never a hardcoded message

  Scenario: A vehicle with zero documents passes the gate
    Given a registered vehicle with no documents at all
    When AssertVehicleAssignable is called for that vehicle at the current time
    Then it resolves with no value — vacuously true, same as registration's own canBeAssigned

  Scenario: The gate is evaluated at the given instant, not "now" implicitly
    Given a registered vehicle with one document expiring at a specific future date
    When AssertVehicleAssignable is called for that vehicle at an instant AFTER that expiry date
    Then it throws VehicleNotAssignableError — the caller's own `at` governs, the command never reads the wall clock itself
