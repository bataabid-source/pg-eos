Task: 3.12 `imile.driver_ids` + time-bounded assignments + termination trigger (doc 38, owner DEL_MGR, deps 3.3 DONE)
Lane: 3          Lock: imile (existing whole-module lock, claimed by the Master this session)
Read ONLY:
  - CLAUDE.md
  - .claude/briefs/imile.brief.md
  - modules/imile/application/evaluate-dtl-problem/{ports.ts,evaluate-dtl-problem.ts} (nearest own-module precedent: idempotency-first ordering, audit-row + outbox pattern, typed-error mapping)
  - modules/imile/domain/evaluate-dtl-problem/invariants.ts (domain style precedent: pure functions, never throws on malformed input)
  - database/schema/13-Schema-Additions.sql lines 280-308 (`imile.driver_ids`, `imile.driver_id_assignments`, the two partial-unique indexes), 332-346 (`imile.verify_attribution()`, the guard function doc 38's acceptance names), 414-431 (`hr.close_driver_id_on_termination()` — the termination trigger doc 38's acceptance names, ALREADY BUILT at the DB level, this slice never touches it — round-1 review finding 8: this line range was previously misquoted as 416-430/`imile.close_assignment_on_suspension()`; corrected)
  - database/schema/13B-Schema-Reference-Consolidation.sql lines 2513-2516 (`chk_driver_ids_status` — the LIVE, authoritative CHECK: only `available`/`assigned`/`suspended`; verified against `pg_policies`/`pg_constraint` on the live DB, not just this static file)

P2/P7 budget: 8 files, 954 lines — at the ceiling, no further Read ONLY growth without trimming. **Review cap (CLAUDE.md · OPERATING RULES): round 1 FAIL → one fix round → round 2. Round 2 FAIL → STOP, commit only the PASS subset, every open finding becomes a `3.12 part 2` row — no round 3, no opus escalation unless a finding is genuinely unsplittable (security/audit-chain/RLS) and is the last round.**

**Scope decision, read before objecting to anything "missing":** doc 38's row title bundles three things — `driver_ids`, time-bounded assignments, and the termination trigger. The termination trigger (`hr.close_driver_id_on_termination()`) and the suspension-close trigger (`imile.close_assignment_on_suspension()`) are ALREADY BUILT, at the schema level (13-Schema-Additions.sql, already applied, already live) — this slice does not rebuild, re-test at the SQL level, or touch either trigger. What doc 38's acceptance actually needs FROM APPLICATION CODE is: a real way to CREATE an assignment (so `verify_attribution()` has assignment rows to find, and so the termination trigger has something to auto-release). This slice delivers exactly that: one command, `AssignDriverId`. Registering a NEW `imile.driver_ids` row (the `imile_code` allocation itself, externally sourced from iMile per the D-147/D-148 scenario notes) is a SEPARATE concern this slice does not build — tests create their own `imile.driver_ids` fixture rows directly via SQL, the same way every prior slice's fixtures create their own prerequisite rows without going through a command that doesn't exist yet.

**Known, pre-existing schema inconsistency, NOT introduced by this slice, NOT this slice's to fix:** `imile.close_assignment_on_suspension()`'s trigger body checks `new.status in ('suspended','blocked')`, and `imile.driver_id_dashboard` references a `days_suspended` concept — but the live `chk_driver_ids_status` CHECK constraint only allows `'available'|'assigned'|'suspended'`, never `'blocked'`. Similarly `hr.close_driver_id_on_termination()` checks `new.status in ('terminated','resigned')` but `hr.employees`' own live CHECK only allows `'active'|'on_leave'|'suspended'|'terminated'`, never `'resigned'`. Both are dead/unreachable trigger branches, verified against `pg_constraint` on the live DB — filed as a G-01 observation in this slice's own commit (comment-only note, no code change, not blocking).

Write ONLY: modules/imile/{domain,application,infrastructure,api,tests}/assign-driver-id/** · packages/contracts/imile/assign-driver-id.ts · packages/contracts/package.json (its own `./imile/assign-driver-id` export entry ONLY, additive, same convention as every prior imile slice's own contract-export line — round-1 review finding 10: this was missing from Write ONLY, added here; `packages/*` stays otherwise frozen) · tests/…
Scenario:
```gherkin
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
```
Contract: packages/contracts/imile/assign-driver-id.ts — one command `AssignDriverId`, input `{ driverIdRef: uuid, employeeId: uuid, correlationId: uuid }` — `assignedBy`/`approvedBy` come from `ctx.userId`/not caller-supplied (no `approvedBy` this slice — nothing in doc 38's acceptance requires an approval step, `approved_by` stays null, a future slice's concern if one is ever specified). Derive every field from `imile.driver_id_assignments` (driver_id_ref, employee_id, assigned_from, assigned_by) — never invent a field not in that table; `handover_doc_id` stays null this slice (document handover tracking is a separate, unbuilt concern). Result schema `AssignDriverIdResult { assignmentId: uuid }`.
Screen/Board spec: none (internal command, no UI this slice)
Deliver (mirrors evaluate-dtl-problem's own file set, the nearest single-command precedent in this module):
  - modules/imile/domain/assign-driver-id/{errors.ts,invariants.ts} — `invariants.ts` exports whatever pure precondition checks are needed (e.g. validating the input shape) — no state-machine is built here: this command performs exactly ONE transition (`available` → `assigned`) guarded by a precondition check, not a dispatched set of transitions, so a full XState machine is not warranted (same precedent as `RegisterVehicle` leaving `tms.vehicles.status` at its column default with no machine) — if pg-reviewer disagrees, that's a legitimate finding to fix, not a brief error to stop over.
  - modules/imile/application/assign-driver-id/{index.ts,ports.ts,assign-driver-id.ts}
  - modules/imile/infrastructure/assign-driver-id/{repository.ts,logger.ts}
  - modules/imile/api/assign-driver-id/{composition.ts,handlers.ts}
  - modules/imile/tests/assign-driver-id/{assign-driver-id.feature,assign-driver-id.test.ts,invariants.property.test.ts,handlers.test.ts}
  - packages/contracts/imile/assign-driver-id.ts
`DriverIdNotAvailableError` (driver_ids.status is not 'available' at read time) and `EmployeeAlreadyAssignedError` (the DB's own partial-unique-index violation on `employee_id` where `assigned_to is null`, translated the same way `register-vehicle`'s `DuplicatePlateNoError` translates a unique-violation) are the two typed errors this slice needs; both map to 409 at the API layer (a real conflict, not a validation failure).
No `version` column, no migration this slice — `imile.driver_ids`/`imile.driver_id_assignments` already exist with `internal_only` RLS on both (verified live against `pg_policies`), and this command only INSERTs the assignment row plus one UPDATE (`driver_ids.status = 'assigned'`) guarded by the precondition read — no optimistic-lock concern since the two partial unique indexes already serialize the only contention that matters (one active assignment per driver_id, one per employee).
Event: none this slice — `imile.driver_id_assignments`/`imile.driver_ids` have no `entity_id` column (confirmed against the schema cited above), so an outbox write would hit `outbox_business_needs_entity` the same way `imile.dtl_problems`/`imile.shipments` did in prior slices — file a new G-01 row for this in `docs/notes/2026-09-24-imile-agent-scenario.md` §4 (row l), same class as rows g/k, no invented workaround.
Audit row: one `platform.audit_log` insert for the assignment insert, one for the `driver_ids` status update, same hash-chain mechanism every prior imile slice already replicated.
Idempotency-Key required at the API layer, same 400/409/200 shape as every prior slice.
Migration number: none.
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40.
