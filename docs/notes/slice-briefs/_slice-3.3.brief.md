# SLICE BRIEF — WBS 3.3 (lane 2 → pg-tester → pg-backend)

Task: 3.3 "`hr.employees` (drivers), documents, hard gate"      Lane: 2      Lock: `hr` (LANE_LOCKS row `hr | 2 | 3.3`)
Acceptance (doc 38): **Expired-doc driver cannot be assigned.**   Owner: HR_MGR.   Depends: 0.9 (DONE).

Read ONLY:
- `CLAUDE.md`
- `.claude/briefs/hr.brief.md`
- golden slice (shape only, the logic is unrelated): `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound/*` · `packages/contracts/wms/receive-inbound.ts`
- `docs/package/40-Build-Specification-EN.md` §C4 line 273 (INV-C4-1) and §C7 lines 326-329 (quoted below — do not re-read the document)
- `docs/package/D-blueprints/06-Administrative-HR-Housing.md` §4.3 (lines 218-240, quoted below)
- schema: `hr.employees`, `hr.employee_documents` (`database/schema/01-Data-Model.sql` 1267-1310), `chk_employees_status` (13B:2445), trigger `hr.close_driver_id_on_termination` (13:392-413 — exists, do not re-implement)
- Scaffold already run: `scripts/new-slice.sh hr register-employee` (files listed under Deliver; renamed copies of the golden slice, logic to be replaced)

Write ONLY: `modules/hr/**` · `packages/contracts/hr/register-employee.ts` · `tests/**` ·
`database/migrations/NNNN_2_employees-version.sql` (ONLY after the Master issues NNNN — see Migration).
pg-tester writes ONLY test files (`modules/hr/tests/**`, `*.feature`). pg-backend never edits a test.

## Facts (verified by the lane against the schema and the package — quote, do not re-derive)

- `hr.employees` columns: id, entity_id, code (unique), name_ar, name_en, civil_id, nationality, passport_no,
  job_title_ar, job_title_en, org_unit_id, reports_to, employment_type (default 'full_time'), hire_date, end_date,
  status (default 'active'; CHECK active · on_leave · suspended · terminated), assigned_client_id, phone, email,
  created_at. RLS `entity_scope`. **No `version` column today** → migration below.
- `hr.employee_documents` columns: id, employee_id (FK cascade), doc_type (01 comment: residency · passport ·
  license · health_card · contract — no CHECK in the schema; the contract enum carries the five values),
  doc_no, issue_date, expiry_date NOT NULL, file_url, alert_days_before (default 60). RLS `internal_only`.
- doc 40 INV-C4-1: "Hard gate: driver with expired residency/licence, or vehicle with expired document,
  cannot be assigned." doc 40 §C7: `employees` (`code PG-####`, `reports_to`, `assigned_client_id`, `status`),
  `employee_documents` (`expiry_date`, alert ladder 90/45/30/15 — the ladder is the ALERT ENGINE's job, WBS 5.13, NOT this slice).
- bp06 §4.3: PRO uploads the document (`doc_type` · `expiry_date` NOT NULL · `file_url` · `alert_days_before`);
  expired document = hard gate: expired residency ⇒ the employee is not assigned to a task; expired licence ⇒
  the driver is not assigned to a vehicle. bp06 KPI "active expired documents" = `expiry_date < current_date`
  for `status = 'active'` employees — that comparison IS the definition of expired (valid through the expiry day).
- Roles (identity.roles seeded in 13B:560-567): `HR_MGR`, `PRO`, `GM`, `DEL_MGR`, `FLEET_MGR`.
- `writeOutboxEvent(tx, { entityId, aggregateType, aggregateId, eventType, payload, correlationId, actorId })`
  (`@pg-eos/events`); outbox row in the SAME transaction as the state change; matching `platform.audit_log` row (G9) as the golden slice does.
- Vehicle documents (`tms.vehicle_documents`) are WBS 3.1/3.4 (lane 1) — NOT this slice. Assignment tables
  (`tms.delivery_tasks.driver_id`, `imile.driver_id_assignments`) are 3.4 / 3.12 — NOT this slice: they will
  CALL this slice's gate. This slice delivers the gate as a domain invariant + application query + api handler.
- Entity resolution is fail-closed (D9 amended, review round 1): `cardinality(platform.allowed_entities()) = 1` else `EntityScopeAmbiguousError` 422 (`WithContextCtx` has no `entityId` — batched Master task to add it, `packages/db` frozen).

## Defaults taken by the lane (CHANGELOG lines; batched to the GM in the closing report)

D1. Use case name `register-employee`; four commands: `RegisterEmployee`, `RecordEmployeeDocument`,
    `ChangeEmployeeStatus` (XState machine over `employees.status`), `CheckDriverAssignable` (the hard gate; read-only, no Idempotency-Key).
D2. Employee `code` is caller-supplied and validated `^PG-\d{4}$` (doc 40 §C7 `PG-####`); uniqueness by the DB constraint → `EmployeeCodeTakenError` (409). It is not a document series (no `platform.next_doc_no`).
D3. A renewal is a NEW `employee_documents` row (history kept); the gate reads, per `doc_type`, the row with the greatest `expiry_date`.
D4. Gate: `purpose = 'task'` requires a valid `residency`; `purpose = 'vehicle'` requires valid `residency` AND `license`.
    Expired = `expiry_date < today` (today = the Asia/Kuwait business date of the injected Clock, `businessDateOf` — 01-Data-Model.sql:8). A MISSING required document blocks like an expired one (`DriverDocumentMissingError`) — the gate cannot prove validity.
D5. Only `status = 'active'` employees are assignable (`EmployeeNotActiveError`): suspended/terminated follow 13 §imile.close_assignment_on_suspension; `on_leave` blocked by default (question to GM).
D6. Roles: RegisterEmployee / ChangeEmployeeStatus → `HR_MGR` or `GM`; RecordEmployeeDocument → `PRO`, `HR_MGR` or `GM` (bp06 D08);
    CheckDriverAssignable → any of `DEL_MGR`, `FLEET_MGR`, `HR_MGR`, `GM` (the assigning roles).
D7. Status machine (XState v5, `machine.ts`): `active → on_leave → active`, `active → suspended → active`, `{active, on_leave, suspended} → terminated` (sets `end_date` = today; terminal). No other edge. Every ChangeEmployeeStatus carries `expectedVersion`.
D8. Events (names requested from the Master for `packages/events/catalog.ts` — frozen path): `hr.employee.registered` (aggregate `hr.employees`, once per RegisterEmployee), `hr.employee_document.recorded` (aggregate `hr.employee_documents`, once per RecordEmployeeDocument). ChangeEmployeeStatus writes an audit_log row only (no event; the driver-ID release on termination is a 13 trigger and 3.12's concern). No consumed events.
D9. `entity_id` = `ctx.entityId` (never caller-supplied); actor = `ctx.userId` (never `performedBy`).

## Scenario (Gherkin — pg-tester pastes into `modules/hr/tests/register-employee/register-employee.feature`)

```gherkin
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
```

Property tests (fast-check, `invariants.property.test.ts`):
- P1 for any set of documents and any today: `isExpired(doc, today) ⇔ doc.expiry_date < today` (date-only comparison, no time-of-day effect).
- P2 for any employee record: assignable(purpose) ⇔ status = 'active' ∧ every required doc_type for that purpose has a latest row with expiry_date ≥ today; required('task') = {residency}, required('vehicle') = {residency, license}.
- P3 for any sequence of status events, the machine never leaves `terminated` and never reaches `suspended` from `on_leave` or vice-versa without passing `active`.
Unit test (`employee-machine.unit.test.ts`): every edge in D7 and every non-edge rejected.

## Contract (`packages/contracts/hr/register-employee.ts`)

One `<Command>InputSchema` per command (the sed-rename convention): `RegisterEmployeeInputSchema`,
`RecordEmployeeDocumentInputSchema`, `ChangeEmployeeStatusInputSchema`, `CheckDriverAssignableInputSchema`, plus
`CheckDriverAssignableResultSchema` (`{ assignable: true }` — a failure is a Problem, never `false`). Derive every
field from the two tables above; `docType` enum = the five values; `purpose` enum = `task` · `vehicle`;
`expectedVersion` on RecordEmployeeDocument and ChangeEmployeeStatus; `correlationId` on every command; dates `z.iso.date()`.
No `entityId`, no `performedBy`, no `status` on RegisterEmployee (always active).

Screen/Board spec: none (backend only, like the golden slice — the D08 screen is a later UI slice).

## Deliver (from `new-slice.sh`, rename the golden-only files to the counterparts below; delete files with no counterpart — precedent: 5.13 brief)

```
modules/hr/domain/register-employee/{errors.ts,invariants.ts,machine.ts}            (delete suggest-location-ranking.ts)
modules/hr/application/register-employee/{ports.ts,index.ts,register-employee.ts,record-employee-document.ts,change-employee-status.ts,check-driver-assignable.ts}
modules/hr/infrastructure/register-employee/{repository.ts,logger.ts}                (delete ledger.ts)
modules/hr/api/register-employee/{composition.ts,handlers.ts}
modules/hr/tests/register-employee/{register-employee.feature,register-employee.test.ts,employee-machine.unit.test.ts,invariants.property.test.ts,handlers.test.ts}   (delete suggest-location-ranking.property.test.ts)
packages/contracts/hr/register-employee.ts
modules/hr/{package.json,tsconfig.json,tsconfig.test.json,vitest.config.ts,index.ts}   (scaffold, already produced; index.ts exports the application + errors like modules/wms/index.ts)
database/migrations/NNNN_2_employees-version.sql   (number from the Master; shape = 0008)
```

Migration number: **issued — 0014** (`database/migrations/0014_2_employees-version.sql`, Master 2026-09-24, pre-migration review APPROVED, applied locally).

Test run: `pnpm --filter @pg-eos/hr test` (vitest per module, low memory — never the full suite) with `PG_APP_USER=pgeos_app`, admin pool from PGUSER for fixtures, as the golden `receive-inbound.test.ts` header describes. Guards: `pnpm guards:run`.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 or in the Facts above.
Agent tiers (docs/MODEL_ROUTING.md): pg-tester sonnet ≤ 30k · pg-backend sonnet ≤ 40k · pg-reviewer opus ≤ 30k · pg-scribe sonnet ≤ 10k.
