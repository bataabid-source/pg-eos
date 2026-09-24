# modules/hr/tests/register-employee/register-employee.feature — WBS 3.3.
# Every scenario below is executed by modules/hr/tests/register-employee/register-employee.test.ts
# and modules/hr/tests/register-employee/handlers.test.ts.
# Source: docs/notes/slice-briefs/_slice-3.3.brief.md (pasted verbatim from the brief's Scenario
# section), doc 40 §C4 line 273 (INV-C4-1), doc 40 §C7, bp06 §4.3.

Feature: Register employee, record documents, hard gate on expired documents (WBS 3.3, doc 40 INV-C4-1, bp06 §4.3)

  Background:
    Given an entity and a caller whose roles are read from platform.my_roles()
    And every write input carries an Idempotency-Key header and no performedBy field — the actor is ctx.userId

  Scenario: Register a driver
    Given the caller holds role "HR_MGR"
    When RegisterEmployee is called with code "PG-0001", name_ar, hire_date and employment_type "full_time"
    Then one hr.employees row exists with status "active", version 1, entity_id = ctx.entityId
    And exactly one "hr.employee.registered" row is in platform.outbox and one platform.audit_log row shares its correlation_id

  Scenario: A duplicate employee code is rejected
    Given an employee "PG-0001" exists
    When RegisterEmployee is called again with code "PG-0001"
    Then EmployeeCodeTakenError (409) and no second row is written

  Scenario: A code outside PG-#### is rejected at the contract
    When RegisterEmployee is called with code "X-1"
    Then the handler returns a 400 Problem and nothing is written

  Scenario: Record a residency document
    Given the caller holds role "PRO" and employee "PG-0001" at version 1
    When RecordEmployeeDocument is called with doc_type "residency", expiry_date 400 days from today and expectedVersion 1
    Then one hr.employee_documents row exists, hr.employees.version becomes 2
    And exactly one "hr.employee_document.recorded" outbox row and its audit_log row are written

  Scenario: A stale expectedVersion is rejected
    Given employee "PG-0001" at version 2
    When RecordEmployeeDocument is called with expectedVersion 1
    Then StaleVersionError (409) and no document row is written

  Scenario: issue_date after expiry_date is rejected
    When RecordEmployeeDocument is called with issue_date later than expiry_date
    Then DocumentDatesInvalidError (422) and nothing is written

  Scenario: Expired residency blocks task assignment (the acceptance criterion)
    Given a driver with a residency document whose expiry_date is yesterday and a licence valid for 300 days
    When CheckDriverAssignable is called with purpose "task"
    Then DriverDocumentExpiredError (422) naming doc_type "residency"

  Scenario: Expired licence blocks vehicle assignment but not task assignment
    Given a driver with a valid residency and a licence whose expiry_date is yesterday
    When CheckDriverAssignable is called with purpose "vehicle"
    Then DriverDocumentExpiredError (422) naming doc_type "license"
    When CheckDriverAssignable is called with purpose "task"
    Then the result is assignable = true

  Scenario: A document expiring today is still valid
    Given a driver whose residency expiry_date equals today
    When CheckDriverAssignable is called with purpose "task"
    Then the result is assignable = true

  Scenario: A renewal supersedes the expired document
    Given a driver whose only residency expired yesterday
    When RecordEmployeeDocument records a new residency valid for 400 days
    And CheckDriverAssignable is called with purpose "task"
    Then the result is assignable = true

  Scenario: A missing required document blocks assignment
    Given a driver with no residency document
    When CheckDriverAssignable is called with purpose "task"
    Then DriverDocumentMissingError (422) naming doc_type "residency"

  Scenario: A non-active employee is never assignable
    Given the caller holds role "HR_MGR" and ChangeEmployeeStatus moved "PG-0001" to "suspended"
    When CheckDriverAssignable is called with purpose "task"
    Then EmployeeNotActiveError (422)

  Scenario: Status machine edges
    Given employee "PG-0001" active
    Then ChangeEmployeeStatus to "on_leave" then back to "active" succeeds, each call bumping version
    And ChangeEmployeeStatus to "terminated" sets end_date = today and any further ChangeEmployeeStatus is IllegalTransitionError (422)
    And ChangeEmployeeStatus from "on_leave" to "suspended" is IllegalTransitionError

  Scenario: Role gates
    Given the caller holds only role "WH_MGR"
    Then RegisterEmployee, RecordEmployeeDocument, ChangeEmployeeStatus and CheckDriverAssignable each throw RoleRequiredError and write nothing

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When RegisterEmployee is called twice with K and the same body
    Then one employee row exists and the second call returns the first result
    When it is called with K and a different body
    Then IdempotencyConflictError (409)
