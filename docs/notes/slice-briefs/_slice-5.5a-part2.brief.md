# SLICE BRIEF — WBS 5.5a part 2 (lane 2 → pg-tester → pg-backend)

Task: 5.5a part 2 "`hr.shifts` / `hr.shift_groups` / `hr.shift_assignments` (SCR-HR-SHIFT-01 §2.1–§2.3)"      Lane: 2      Lock: `hr` (LANE_LOCKS row `hr | 2 | 5.5a`).
Acceptance (doc 38 row 5.5a, the parts this slice completes — part 1 already delivered `platform.sites`): "One active shift assignment per employee per date (exclusion constraint on the date range); ... a shift group carries its own attendance site and lead driver; every state change → outbox + audit in one transaction; G1, G6, G9, G11 green." Owner: HR_MGR.   Depends: 5.5a part 1 (`platform.sites`, DONE) and 3.3 (`hr.employees`, DONE).
**This is the final part of 5.5a** — once this slice is reviewed PASS, 5.5a as a whole is DONE.

Read ONLY:
- `CLAUDE.md`
- `.claude/briefs/hr.brief.md`
- golden slice (shape only): `modules/wms/domain/receive-inbound/{errors.ts,invariants.ts}` — **no `machine.ts`**: none of the three tables have a status-style lifecycle column (D1 below), so `modules/hr/domain/maintain-shift/machine.ts` is deleted, same as part 1 deleted its own.
- `modules/platform/application/maintain-site/{ports.ts,create-site.ts,update-site.ts}` (nearest precedent: this session's own WBS 5.5a part 1 — same entity-scoped aggregate + audit/outbox pattern, and the exact same "domain re-validates what the DB CHECK already enforces" discipline pg-reviewer required there)
- `modules/platform/api/maintain-site/handlers.ts` (Problem envelope / Idempotency-Key / role-gate shape to replicate)
- `docs/notes/SCR-HR-SHIFT-01-shifts-groups-sites-devices.md` §2.1–§2.3 (quoted verbatim below — do not re-read the document)
- schema: `database/migrations/0016_2_hr-shifts-groups-assignments.sql` (the delivered tables, already applied locally and verified: 35/35 columns classified, RLS `entity_scope` active on all three, the exclusion constraint and the composite group/shift FK both functionally tested)
- `packages/contracts/platform/maintain-site.ts` (contract shape precedent from this session's own part 1)
- `packages/contracts/_shared/{problem.ts,headers.ts}` (Problem envelope, `Idempotency-Key` header)
- `packages/events/catalog.ts` (frozen — see Events below; request additions from the Master before pg-backend needs them, same as part 1 did)
- Scaffold already run: `scripts/new-slice.sh hr maintain-shift` (files listed under Deliver; renamed copies of the golden slice, logic to be replaced)

Write ONLY: `modules/hr/{domain,application,infrastructure,api}/maintain-shift/**` (do not touch `modules/hr/{domain,application,infrastructure,api}/register-employee/**`, the 3.3 slice, except to ADD an export line to `modules/hr/index.ts`) · `packages/contracts/hr/maintain-shift.ts` · `tests/**` ·
`database/migrations/0016_2_hr-shifts-groups-assignments.sql` — **already written, reviewed and applied; do not edit it** (forward-only; a fix is a NEW migration).
pg-tester writes ONLY test files (`modules/hr/tests/maintain-shift/**`, `*.feature`). pg-backend never edits a test.

## Facts (verified by the lane against the schema and the package — quote, do not re-derive)

- `hr.shifts` columns (migration 0016, applied): `id, entity_id, code (unique), name_ar, name_en, starts_at time, ends_at time, crosses_midnight bool default false, grace_minutes int (NOT NULL, no default — CHECK >= 0), days_of_week int[] (CHECK 0-6, non-empty), site_id -> platform.sites (NOT NULL), is_active, version`. RLS `entity_scope`.
- `hr.shift_groups` columns: `id, entity_id, shift_id -> hr.shifts (NOT NULL), code (unique), name_ar, group_type (CHECK transport/warehouse/other), lead_employee_id -> hr.employees (NOT NULL), vehicle_id -> tms.vehicles (nullable), site_id -> platform.sites (NOT NULL), starts_at/ends_at time (both nullable, independently — no pairing rule), is_active, version`. Also carries `unique (id, shift_id)` (supports the composite FK below). RLS `entity_scope`.
- `hr.shift_assignments` columns: `id, entity_id, employee_id -> hr.employees (NOT NULL), shift_id -> hr.shifts (NOT NULL), group_id (nullable, NO plain FK), valid_from date (NOT NULL), valid_to date (nullable = open-ended/current), assigned_by -> identity.users (NOT NULL), version`. Two DB-layer invariants the domain MUST re-validate before ever reaching the database (doc 36 §5-4 #2):
  1. **`shift_assignments_no_overlap`** (exclusion constraint, `EXCLUDE USING gist (employee_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)`): the DB raises Postgres `23P01` (`exclusion_violation`) on any overlap for the same employee, including against an existing open-ended (`valid_to IS NULL`) row. The domain layer must check for an overlapping existing assignment (a repository query) BEFORE the write and throw a typed error, not let a raw `23P01` reach the API as a 500.
  2. **`shift_assignments_group_shift_fk`** (composite FK `(group_id, shift_id) -> hr.shift_groups(id, shift_id)`, MATCH SIMPLE — satisfied trivially when `group_id IS NULL`): when a caller supplies a `groupId`, its `shiftId` input MUST equal that group's own `shift_id`, or the raw FK violation (`23503`) reaches the API. The domain must look up the group's `shift_id` and compare before the write, throwing a typed error on mismatch.
- Both invariants above were functionally verified by the lane directly against Postgres (not just read from the migration file): an overlapping open-ended assignment was rejected by the exclusion constraint, and a `group_id`/`shift_id` mismatch was rejected by the composite FK, in isolated transactions rolled back afterward.
- SCR-HR-SHIFT-01 §2.1–§2.3 (verbatim, GM-approved under D-144 item 5 "أدرجها داخل الـpilot" — quoting so the worker never re-reads the SCR):
  - **§2.1** "`hr.shifts` — `id · entity_id · code · name_ar · name_en · starts_at time · ends_at time · crosses_midnight bool · grace_minutes int · days_of_week int[] · site_id → sites · is_active · version`. Replaces the free-text `hr.teams.shift` (kept, marked legacy until migrated)."
  - **§2.2** "`hr.shift_assignments` — `id · entity_id · employee_id → hr.employees · shift_id · group_id → hr.shift_groups (nullable) · valid_from date · valid_to date · assigned_by · version`. One active assignment per employee per date (exclusion constraint on the date range)."
  - **§2.3** "`hr.shift_groups` — the GM's 'transport group': `id · entity_id · shift_id → hr.shifts · code · name_ar · group_type ∈ {transport · warehouse · other} · lead_employee_id → hr.employees (the driver) · vehicle_id → tms.vehicles (nullable) · site_id → sites (the group's own attendance site) · starts_at / ends_at (override of the shift's times, nullable) · is_active · version`. Members are the `shift_assignments` rows carrying `group_id`."
- `writeOutboxEvent(tx, { entityId, aggregateType, aggregateId, eventType, payload, correlationId, actorId })` (`@pg-eos/events`); outbox row in the SAME transaction as the state change; matching `platform.audit_log` row (G9), same as parts 1 and 3.3.
- Entity resolution is fail-closed (3.3/part-1 precedent): `cardinality(platform.allowed_entities()) = 1` else `EntityScopeAmbiguousError` 422 (`WithContextCtx` has no `entityId` — still a batched Master task, `packages/db` frozen).
- pg-reviewer's part-1 note (not a finding, recorded here so this slice doesn't repeat the question): a foreign key check ignores RLS, so e.g. a shift could reference a site belonging to a different entity. No same-entity rule exists in 01/13/13B for this pattern (part 1's `account_id`/`warehouse_id` on `platform.sites` accepted the same gap). **Do not add a same-entity check** — it would be inventing a rule beyond the SCR; if the GM wants one, it is a future G-01 request.
- Out of scope (other D-144 slices, do NOT build here): device custody link, employee requests/leaves (§2.5–§2.6 → 5.3b), vehicle QR (§2.8, tms), the driver-at-client-site presence view (`hr.driver_site_presence`, §2.4, needs attendance WBS 5.3).

## Defaults taken by the lane (CHANGELOG lines; batched to the GM in the closing report)

D1. No XState machine: none of the three tables has a status-style column with edges (`hr.shifts.is_active` and `hr.shift_groups.is_active` are plain flags, same reasoning as part 1's D1 for `platform.sites.is_active`). `modules/hr/domain/maintain-shift/machine.ts` is deleted.
D2. Four commands: `CreateShift`, `CreateShiftGroup`, `AssignShift` (creates one `hr.shift_assignments` row), `EndShiftAssignment` (sets `valid_to` on an open-ended assignment — without it, an employee with one open-ended assignment could never be reassigned, since the exclusion constraint would reject any new overlapping row and nothing in this slice could ever close the old one). No `UpdateShift`/`UpdateShiftGroup` command (lean design, GM speed directive; the SCR gives no field-update scenario for shifts/groups the way it does sites' `is_active` toggle — a later slice can add one if the GM asks).
D3. Role gate: all four commands → `HR_MGR` or `GM` only (unlike part 1's `platform.sites`, which also included `OPS_DIR` since sites serve warehouse/office purposes too — shifts and shift groups are HR-administrative by the SCR's own framing, "the GM's transport group" notwithstanding; batched GM question: should `FLEET_MGR` also create/manage transport-type shift groups?).
D4. `AssignShift`'s domain-layer overlap check: query all of the employee's existing `hr.shift_assignments` rows and test for date-range overlap in the domain layer (pure function, property-tested) BEFORE the repository issues the INSERT — mirrors the pattern pg-reviewer required in part 1 (finding 2, the "effective value" check) rather than relying on catching the DB's `23P01`. The DB exclusion constraint stays as the belt-and-braces layer (doc 36 §5-4 #2's "both, not one").
D5. `AssignShift`'s group/shift consistency check: when `groupId` is supplied, the repository looks up that group's `shift_id` and the domain compares it to the input's `shiftId` BEFORE the write (same reasoning as D4, for the composite FK).
D6. `entity_id` = `ctx.entityId` (never caller-supplied, same as 3.3/part-1); actor = `ctx.userId`.
D7. Events (requested from the Master for `packages/events/catalog.ts` — frozen path, request sent before pg-backend starts, same as part 1): `hr.shift.created` (once per `CreateShift`), `hr.shift_group.created` (once per `CreateShiftGroup`), `hr.shift.assigned` (once per `AssignShift` — this exact name is already named in SCR §2.9's proposed event list, so it is not a new invention), `hr.shift_assignment.ended` (once per `EndShiftAssignment`).
D8. `EndShiftAssignment` requires `expectedVersion` (optimistic lock, `StaleVersionError` 409 on mismatch, same mechanics as part 1's `UpdateSite`). `CreateShift`/`CreateShiftGroup`/`AssignShift` require none (new rows, `version` starts at 1 per each table's column default).
D9. `grace_minutes` has no DB default (pg-reviewer part-2 pre-migration finding 2: no `platform.thresholds` key exists for it, so a default would be a fabricated number) — the `CreateShift` contract makes `graceMinutes` a REQUIRED field (`z.number().int().min(0)`), not optional.

## Scenario (Gherkin — pg-tester pastes into `modules/hr/tests/maintain-shift/maintain-shift.feature`)

```gherkin
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

  Scenario: Idempotent replay
    Given an Idempotency-Key K
    When CreateShift is called twice with K and the same body
    Then one shift row exists and the second call returns the first result
    When it is called with K and a different body
    Then IdempotencyConflictError (409)
```

Property tests (fast-check, `invariants.property.test.ts`):
- P1 for any set of an employee's existing assignments and any candidate `(validFrom, validTo)`: `overlaps(existing, candidate) ⇔` the date ranges genuinely intersect (including an open-ended existing or candidate range) — this is the SAME logic the DB's `daterange(...) &&` operator implements; the property test must cover an open-ended existing assignment, an open-ended candidate, and both bounded.
- P2 for any `(groupShiftId, inputShiftId)` pair: `groupShiftMismatch(groupShiftId, inputShiftId) ⇔ groupShiftId ≠ inputShiftId` (only evaluated when a `groupId` is actually supplied).
- P3 for any `daysOfWeek` array: `isValidDaysOfWeek(arr) ⇔ arr.length > 0 ∧ every element ∈ [0,6]` (mirrors `chk_shifts_dow`).

## Contract (`packages/contracts/hr/maintain-shift.ts`)

`CreateShiftInputSchema`, `CreateShiftGroupInputSchema`, `AssignShiftInputSchema`, `EndShiftAssignmentInputSchema` (`.meta({id})` each). `daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1)`. `graceMinutes: z.number().int().min(0)` (required, no default — D9). `groupType` enum (3 values). `groupId` optional UUID on `AssignShiftInputSchema`. `validTo` optional `z.iso.date()` on `AssignShiftInputSchema` (omitted = open-ended); required on `EndShiftAssignmentInputSchema`. `expectedVersion` on `EndShiftAssignmentInputSchema` only. `correlationId` on every command. No `entityId`, no `performedBy`.

Screen/Board spec: none (backend only, like part 1, 3.3, and the golden slice).

## Deliver (from `new-slice.sh`, rename the golden-only files to the counterparts below; delete files with no counterpart)

```
modules/hr/domain/maintain-shift/{errors.ts,invariants.ts}                            (delete machine.ts — D1 — and suggest-location-ranking.ts)
modules/hr/application/maintain-shift/{ports.ts,index.ts,create-shift.ts,create-shift-group.ts,assign-shift.ts,end-shift-assignment.ts}   (delete approve-inbound.ts, cancel-inbound.ts, close-inbound.ts, confirm-putaway.ts, receive-line.ts, suggest-location.ts)
modules/hr/infrastructure/maintain-shift/{repository.ts,logger.ts}                    (delete ledger.ts)
modules/hr/api/maintain-shift/{composition.ts,handlers.ts}
modules/hr/tests/maintain-shift/{maintain-shift.feature,maintain-shift.test.ts,invariants.property.test.ts,handlers.test.ts}   (delete inbound-machine.unit.test.ts — D1 — and suggest-location-ranking.property.test.ts)
packages/contracts/hr/maintain-shift.ts
modules/hr/index.ts   (ADD an export line for maintain-shift's application barrel, alongside the existing register-employee export — do not remove that line)
```

Migration number: **issued — 0016** (`database/migrations/0016_2_hr-shifts-groups-assignments.sql`, Master 2026-09-25 (pre-reserved under GM directive D-176), pre-migration review APPROVED WITH CHANGES, 6 findings applied, applied locally and verified — including a live functional test of both the exclusion constraint and the composite FK).

Test run: `pnpm --filter @pg-eos/hr test` (vitest per module, low memory — never the full suite) with `PG_APP_USER=pgeos_app`, admin pool from PGUSER for fixtures. **Also confirm `modules/hr/tests/register-employee/**` (the 3.3 slice) still passes** — this slice shares the `hr` module with an already-shipped slice. Guards: `pnpm guards:run`.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 / SCR-HR-SHIFT-01 §2.1–§2.3 (D-144-approved) or in the Facts above.
Agent tiers (docs/MODEL_ROUTING.md): pg-tester sonnet ≤ 30k · pg-backend sonnet ≤ 40k · pg-reviewer opus ≤ 30k · pg-scribe sonnet ≤ 10k.
