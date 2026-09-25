Feature: Shifts, shift groups, and shift assignments (WBS 5.5a part 2, SCR-HR-SHIFT-01 §2.1-§2.3)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId
    And an existing platform.sites row and an existing hr.employees row

  Scenario: Create a shift
    Given the caller holds role "HR_MGR"
    When CreateShift is called with code, name_ar, starts_at "08:00", ends_at "16:00", graceMinutes 10, daysOfWeek [0,1,2,3,4], siteId
    Then one hr.shifts row exists with version 1, entity_id = ctx.entityId
    And exactly one "hr.shift.created" outbox row and one platform.audit_log row share its correlation_id

  Scenario: An empty daysOfWeek is rejected
    When CreateShift is called with daysOfWeek []
    Then the handler returns a 400 Problem and nothing is written

  Scenario: Create a shift group
    Given the caller holds role "HR_MGR" and an existing hr.shifts row and its own site
    When CreateShiftGroup is called with shiftId, code, name_ar, group_type "transport", leadEmployeeId, siteId
    Then one hr.shift_groups row exists with version 1
    And exactly one "hr.shift_group.created" outbox row and its audit_log row are written

  Scenario: Assign an employee to a shift
    Given the caller holds role "HR_MGR" and an employee with no current assignment
    When AssignShift is called with employeeId, shiftId, validFrom today, no validTo
    Then one hr.shift_assignments row exists with version 1
    And exactly one "hr.shift.assigned" outbox row and its audit_log row are written

  Scenario: Assigning the same employee to an overlapping date range is rejected
    Given an employee with an open-ended assignment from today
    When AssignShift is called for the same employee with validFrom 5 days from today
    Then ShiftAssignmentOverlapError (422) and no row is written

  Scenario: Assigning with a group whose shift does not match is rejected
    Given a shift group belonging to shift A
    When AssignShift is called with shiftId = shift B's id and groupId = that group's id
    Then ShiftGroupShiftMismatchError (422) and no row is written

  Scenario: Assigning with a group whose shift matches succeeds
    Given a shift group belonging to shift A
    When AssignShift is called with shiftId = shift A's id and that group's groupId
    Then one hr.shift_assignments row exists with that group_id

  Scenario: End a shift assignment
    Given an open-ended assignment at version 1
    When EndShiftAssignment is called with validTo today and expectedVersion 1
    Then the row's valid_to is set and version becomes 2
    And exactly one "hr.shift_assignment.ended" outbox row and its audit_log row are written

  Scenario: A stale expectedVersion on EndShiftAssignment is rejected
    Given an assignment at version 2
    When EndShiftAssignment is called with expectedVersion 1
    Then StaleVersionError (409) and no column is written

  Scenario: After ending an assignment, a new overlapping one is allowed
    Given an assignment ended (valid_to = yesterday)
    When AssignShift is called for the same employee starting today
    Then one new hr.shift_assignments row exists

  Scenario: Role gates
    Given the caller holds only role "WH_OP"
    Then CreateShift, CreateShiftGroup, AssignShift and EndShiftAssignment each throw RoleRequiredError and write nothing

  Scenario: EndShiftAssignment with a validTo earlier than the assignment's valid_from is rejected
    Given an open-ended assignment at version 1
    When EndShiftAssignment is called with a validTo earlier than the assignment's valid_from
    Then ShiftAssignmentRangeInvalidError (422) and no column is written

  Scenario: AssignShift with a validTo earlier than validFrom is rejected
    When AssignShift is called with validTo earlier than validFrom
    Then ShiftAssignmentRangeInvalidError (422) and no row is written

  Scenario: EndShiftAssignment called twice on the same assignment is rejected
    Given an assignment already ended by a first EndShiftAssignment call
    When EndShiftAssignment is called again on the same assignment
    Then ShiftAssignmentAlreadyEndedError (422), not the exclusion constraint's raw error

  Scenario: CreateShift with a negative grace_minutes is rejected
    When CreateShift is called with graceMinutes -1
    Then ShiftGraceMinutesInvalidError (422) and no row is written

  Scenario: CreateShiftGroup with an invalid group_type is rejected
    When CreateShiftGroup is called with group_type "not_a_real_group_type"
    Then ShiftGroupTypeInvalidError (422) and no row is written

  Scenario: CreateShift with a duplicate code is rejected
    Given an existing hr.shifts row with code C
    When CreateShift is called again with code C
    Then ShiftCodeTakenError (409) and no second row is written

  Scenario: CreateShiftGroup with a duplicate code is rejected
    Given an existing hr.shift_groups row with code C
    When CreateShiftGroup is called again with code C
    Then ShiftGroupCodeTakenError (409) and no second row is written

  Scenario: Cross-entity isolation
    Given a caller scoped only to entity A and an hr.shift_assignments row belonging to entity B
    When EndShiftAssignment is called against that entity-B assignment
    Then ShiftAssignmentNotFoundError, since RLS hides it exactly like a missing id
    Given an hr.shift_groups row belonging to entity B
    When AssignShift is called with that entity-B group's id
    Then ShiftGroupNotFoundError, since RLS hides it exactly like a missing id
    When CreateShift is called with a caller-supplied entityId of entity B
    Then the written row's entity_id is ctx.entityId (entity A), never the caller-supplied value

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When CreateShift is called twice with K and the same body
    Then one shift row exists and the second call returns the first result
    When it is called with K and a different body
    Then IdempotencyConflictError (409)
