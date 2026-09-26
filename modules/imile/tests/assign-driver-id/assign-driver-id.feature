# modules/imile/tests/assign-driver-id/assign-driver-id.feature — WBS 3.12.
# Every scenario below is executed by
# modules/imile/tests/assign-driver-id/assign-driver-id.test.ts.
# Source: docs/notes/slice-briefs/_slice-3.12.brief.md "Scenario" block (verbatim);
# database/schema/13-Schema-Additions.sql:280-308 (imile.driver_ids, imile.driver_id_assignments,
# the two partial-unique indexes), 332-346 (imile.verify_attribution()), 391-413
# (hr.close_driver_id_on_termination() / trg_close_driver_id — already built, not touched by this
# slice), 415-430 (imile.close_assignment_on_suspension() / trg_close_on_suspension — 3.12 part 2
# review finding 1: the two functions' own line ranges were swapped in this citation, corrected);
# database/schema/13B-Schema-Reference-Consolidation.sql:2513-2516 (chk_driver_ids_status).

Feature: Assign an iMile driver ID to an employee, time-bounded, respecting the termination trigger

  Scenario: An available driver ID is assigned to an employee with no prior active assignment
    Given an imile.driver_ids row with status "available"
    And an hr.employees row with no active imile.driver_id_assignments row
    When AssignDriverId is called for that driver ID and employee
    Then a new imile.driver_id_assignments row is inserted with assigned_from now and assigned_to null
    And the driver_ids row's status becomes "assigned"
    And one platform.audit_log row is written for both the assignment insert and the driver_ids status update

  Scenario: A driver ID that is not available cannot be assigned
    Given an imile.driver_ids row with status "assigned" (already actively assigned to someone else)
    When AssignDriverId is called for that driver ID and a different employee
    Then the command fails with a mapped DriverIdNotAvailableError and no row is written

  Scenario: An employee who already holds an active assignment cannot receive a second one
    Given an employee with an existing imile.driver_id_assignments row where assigned_to is null
    And a different imile.driver_ids row with status "available"
    When AssignDriverId is called for that employee and the new driver ID
    Then the command fails with a mapped EmployeeAlreadyAssignedError (the DB's own partial-unique-index violation on employee_id, translated) and no row is written

  Scenario: verify_attribution() finds no unattributed deliveries once an assignment exists
    Given a delivered imile.shipments row whose driver_code matches a driver_ids row
    And AssignDriverId has created an active assignment covering the shipment's ofd_at instant
    When imile.verify_attribution() is queried for the relevant date range
    Then it returns zero rows for that shipment

  Scenario: Terminating the employee auto-releases the driver ID (proving the existing trigger, not rebuilding it)
    Given an active assignment created by AssignDriverId
    When the employee's hr.employees.status is updated to "terminated" (direct SQL, exercising the ALREADY-BUILT trg_close_driver_id trigger)
    Then the assignment row's assigned_to is set and end_reason is "terminated"
    And the driver_ids row's status returns to "available"
