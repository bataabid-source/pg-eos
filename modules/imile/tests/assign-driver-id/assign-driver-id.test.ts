// modules/imile/tests/assign-driver-id/assign-driver-id.test.ts — WBS 3.12.
//
// Integration tests, one per scenario in ./assign-driver-id.feature, against the real database as
// pgeos_app (RLS genuinely enforced — every command call goes through withContext/
// withIdempotentContext, same discipline as this module's own evaluate-dtl-problem precedent).
// Sources: docs/notes/slice-briefs/_slice-3.12.brief.md "Scenario"/"Contract" blocks (verbatim);
// database/schema/13-Schema-Additions.sql:280-308 (imile.driver_ids, imile.driver_id_assignments,
// the two partial-unique indexes), 332-346 (imile.verify_attribution()), 388-430
// (hr.close_driver_id_on_termination() / imile.close_assignment_on_suspension() — ALREADY BUILT,
// this slice never touches either trigger, only proves the termination one fires);
// database/schema/13B-Schema-Reference-Consolidation.sql:2513-2516 (chk_driver_ids_status: only
// 'available'/'assigned'/'suspended'), 2445-2447 (chk_employees_status: only
// 'active'/'on_leave'/'suspended'/'terminated' — 'resigned' is NOT a live status, brief's own
// documented, pre-existing schema inconsistency, not this slice's to fix).
//
// Expected new surface (RED until it exists — same "test pins the contract" discipline as this
// module's own evaluate-dtl-problem/register-vehicle precedents):
//   modules/imile/domain/assign-driver-id/errors.ts
//     - DriverIdNotAvailableError, EmployeeAlreadyAssignedError.
//   modules/imile/application/assign-driver-id/index.ts (re-exports assignDriverId)
//     - assignDriverId(ctx, input, deps): Promise<AssignDriverIdResult> — result { assignmentId }.
//   modules/imile/api/assign-driver-id/composition.ts
//     - createAssignDriverIdDeps(overrides).
//
// Binding behaviour this suite asserts (brief, Scenario block):
//   - an available driver_ids row + an employee with no active assignment -> one
//     imile.driver_id_assignments row inserted (assigned_from = now, assigned_to = null,
//     assigned_by = ctx.userId, approved_by = null, handover_doc_id = null — brief, Contract:
//     "no approvedBy this slice"), the driver_ids row's status becomes 'assigned', and ONE
//     platform.audit_log row per table (driver_id_assignments insert + driver_ids status update).
//   - a driver_ids row that is not 'available' at read time -> DriverIdNotAvailableError, no row
//     written at all (no new assignment row, driver_ids status unchanged).
//   - an employee who already holds an active assignment -> EmployeeAlreadyAssignedError (the DB's
//     own partial-unique-index violation on employee_id, translated), no row written for the NEW
//     driver_id (its status stays 'available').
//   - imile.verify_attribution() returns zero rows for a shipment once AssignDriverId has created an
//     assignment covering the shipment's ofd_at instant.
//   - terminating the employee (direct SQL on hr.employees.status) auto-releases the driver ID via
//     the ALREADY-BUILT trg_close_driver_id trigger — this slice only proves it, never rebuilds it.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus a real
// identity.users row for a dedicated internal actor. PG_APP_USER=pgeos_app is REQUIRED to run this
// suite (every command call goes through withContext(ctx, fn) as pgeos_app, genuinely subject to
// RLS — brief: "internal_only RLS on both" imile.driver_ids/imile.driver_id_assignments).
// D-183: a DELETE against the shared database is only allowed in this suite's own `afterAll`, never
// in `beforeAll` — `beforeAll` only ever upserts the fixture actor.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { AssignDriverIdInputSchema } from '@pg-eos/contracts/imile/assign-driver-id';

// The modules under test — do not exist yet (RED).
import { assignDriverId } from '../../application/assign-driver-id/index.js';
import { createAssignDriverIdDeps } from '../../api/assign-driver-id/composition.js';
import {
  DriverIdNotAvailableError,
  EmployeeAlreadyAssignedError,
  // WBS 3.12 part 2c-i — new typed errors from the INV-C4-1 gate (imile's own copy of hr's
  // assertDriverAssignable, doc 40 INV-C4-1). Do not exist yet (RED).
  EmployeeNotActiveError,
  DriverDocumentMissingError,
  DriverDocumentExpiredError,
} from '../../domain/assign-driver-id/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const ASSIGNER_ACTOR_UUID = '00000000-0000-4000-8000-0000003120a1';
// round-2 fix round, finding 5: a dedicated outsider actor — no identity.user_entities row granting
// access to imile, isInternal: false — same fixture pattern as
// modules/imile/tests/report-agent-health/report-agent-health.test.ts:104's `outsiderCtx`.
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000003120a2';

const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
const ids = new SequentialIdGenerator(3120);
const ctx = { userId: ASSIGNER_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: false };

let entityId: string;
const fixtureDriverIdIds: string[] = [];
const fixtureEmployeeIds: string[] = [];
const fixtureShipmentIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

// Test isolation only: one module-level FixedClock shared by every scenario, mirroring the
// evaluate-dtl-problem precedent's `beginScenario`.
const SCENARIO_CLOCK_STEP_MS = 5_000;
function beginScenario(): void {
  clock.advance(SCENARIO_CLOCK_STEP_MS);
}

async function createFixtureDriverId(status: 'available' | 'assigned' = 'available'): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.driver_ids (imile_code, allocated_at, status)
       values ($1, current_date, $2) returning id::text as id`,
    [`DRV-${randomUUID()}`, status],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture imile.driver_ids row');
  fixtureDriverIdIds.push(id);
  return id;
}

// Migration 0029 (SCR-HR-EMP-01, doc 40 §C7) adds chk_employees_code_format on hr.employees:
// code ~ '^PG-[0-9]{4}$'. This suite's own fixture codes stay in the PG-5000-PG-5999 range
// (disjoint from handlers.test.ts's PG-6xxx and hr's own 1xxx-4xxx/9xxx and 7xxx ranges) and use a
// module-level counter for uniqueness within this file's own inserts (no afterEach cleanup here —
// all fixture rows persist until this suite's own afterAll, so every call site in this file needs a
// distinct code).
let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (100 + employeeCodeCounter++).toString();
  return `PG-5${suffix}`;
}

// WBS 3.12 part 2c-i — one 'residency' hr.employee_documents row, mirroring
// modules/hr/tests/register-employee/register-employee.test.ts's own insertDocumentDirect fixture
// helper (same table, same doc_type constant).
const DOC_TYPE_RESIDENCY = 'residency';
// Kuwait business "today" stays '2024-01-01' for this whole suite: the module-level clock starts
// at 2024-01-01T00:00:00.000Z and each beginScenario() only advances it by 5s — Kuwait (UTC+3, no
// DST) is at most a few minutes into 2024-01-01, never crossing into 2024-01-02.
const FIXTURE_TODAY = '2024-01-01';
const FIXTURE_YESTERDAY = '2023-12-31';
const FIXTURE_FAR_FUTURE = '2030-01-01';

async function insertResidencyDocument(employeeId: string, expiryDate: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employee_documents (employee_id, doc_type, expiry_date) values ($1, $2, $3) returning id::text as id`,
    [employeeId, DOC_TYPE_RESIDENCY, expiryDate],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employee_documents row');
  return id;
}

// WBS 3.12 part 2c-i, finding 11 / INV-C4-1: once the new assertDriverAssignable gate lands, EVERY
// successful assignment (every EXISTING scenario in this suite that expects success) requires the
// employee to be 'active' AND to carry a current 'residency' document. `withResidency` defaults to
// true so every pre-existing call site in this file (all of which expect a successful assignment)
// keeps a valid fixture without editing every call site individually; the three new
// gate-rejection scenarios below pass `withResidency: false` or insert their own
// missing/expired/current document directly instead.
async function createFixtureEmployee(
  status: string = 'active',
  options: { withResidency?: boolean } = {},
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, $4) returning id::text as id`,
    [entityId, nextEmployeeCode(), 'موظف اختبار إسناد معرّف — WBS 3.12', status],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  if (options.withResidency ?? true) {
    await insertResidencyDocument(id, FIXTURE_FAR_FUTURE);
  }
  return id;
}

async function getDriverIdRow(
  id: string,
): Promise<{ status: string } | undefined> {
  const result: QueryResult<{ status: string }> = await pool.query(
    `select status from imile.driver_ids where id = $1`,
    [id],
  );
  return result.rows[0];
}

async function getActiveAssignment(
  driverIdRef: string,
): Promise<
  | {
      id: string;
      employee_id: string;
      assigned_from: Date;
      assigned_to: Date | null;
      assigned_by: string;
      approved_by: string | null;
      handover_doc_id: string | null;
      end_reason: string | null;
    }
  | undefined
> {
  const result = await pool.query(
    `select id::text as id, employee_id::text as employee_id, assigned_from, assigned_to,
            assigned_by::text as assigned_by, approved_by::text as approved_by,
            handover_doc_id::text as handover_doc_id, end_reason
       from imile.driver_id_assignments where driver_id_ref = $1 and assigned_to is null`,
    [driverIdRef],
  );
  return result.rows[0];
}

async function getAssignmentById(
  id: string,
): Promise<{ assigned_to: Date | null; end_reason: string | null } | undefined> {
  const result = await pool.query(
    `select assigned_to, end_reason from imile.driver_id_assignments where id = $1`,
    [id],
  );
  return result.rows[0];
}

async function countAssignmentsForDriverId(driverIdRef: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from imile.driver_id_assignments where driver_id_ref = $1`,
    [driverIdRef],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function auditRowsForCorrelation(
  correlationId: string,
): Promise<Array<{ table_name: string; record_id: string | null; operation: string; new_value: unknown }>> {
  const result = await pool.query(
    `select table_name, record_id::text as record_id, operation, new_value
       from platform.audit_log where correlation_id = $1 and schema_name = 'imile' order by occurred_at`,
    [correlationId],
  );
  return result.rows;
}

// WBS 3.12 part 2c-i — platform.outbox row(s) for a correlationId (finding 9: AssignDriverId must
// write ONE row per successful call, in the same transaction as the state change, CLAUDE.md ·
// ARCHITECTURE). RED until pg-backend wires writeOutboxEvent into assignDriverId.
async function outboxRowsForCorrelation(correlationId: string): Promise<
  Array<{
    entity_id: string | null;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    payload: unknown;
    correlation_id: string;
    actor_id: string | null;
  }>
> {
  const result = await pool.query(
    `select entity_id::text as entity_id, aggregate_type, aggregate_id::text as aggregate_id,
            event_type, payload, correlation_id::text as correlation_id, actor_id::text as actor_id
       from platform.outbox where correlation_id = $1`,
    [correlationId],
  );
  return result.rows;
}

async function createFixtureShipment(driverCode: string, ofdAt: Date): Promise<string> {
  const trackingNo = `SHP-3120-${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.shipments (tracking_no, internal_status, ofd_at, closed_at, driver_code)
       values ($1, 'delivered', $2, $2, $3) returning id::text as id`,
    [trackingNo, ofdAt.toISOString(), driverCode],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture imile.shipments row');
  fixtureShipmentIds.push(id);
  return trackingNo;
}

async function verifyAttributionRows(
  from: string,
  to: string,
): Promise<Array<{ tracking_no: string }>> {
  const result: QueryResult<{ tracking_no: string }> = await pool.query(
    `select tracking_no from imile.verify_attribution($1, $2)`,
    [from, to],
  );
  return result.rows;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`fixture platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  // D-183: no DELETE here — beforeAll only upserts (ON CONFLICT DO UPDATE); the afterAll block
  // below is the only place this file deletes rows.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [ASSIGNER_ACTOR_UUID, `_imile_assigndriverid_${ASSIGNER_ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل اختبار إسناد معرّف iMile — WBS 3.12'],
  );

  // Fix round (test-fixture gap): the assigner is isInternal:true and every scenario's
  // getDriverAssignabilityCheck cross-schema read needs hr.employees/hr.employee_documents rows to
  // be visible under entity_scope RLS (entity_id = ANY(platform.allowed_entities())) — a real
  // identity.users row alone does not grant that, same precedent as
  // modules/wms/tests/process-outbound/process-outbound.test.ts:755,820. OUTSIDER_ACTOR_UUID
  // deliberately gets NO such row below (its whole test purpose is proving the internal_only RLS
  // denial path for an actor with no entity access).
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
       on conflict (user_id, entity_id) do nothing`,
    [ASSIGNER_ACTOR_UUID, entityId],
  );

  // round-2 fix round, finding 5: a real identity.users row for the outsider actor — deliberately
  // NO identity.user_entities row is ever inserted for OUTSIDER_ACTOR_UUID (that absence, plus
  // isInternal: false, is exactly what an outsider means for the `internal_only` RLS policy on
  // imile.driver_ids/imile.driver_id_assignments).
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'agent')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [OUTSIDER_ACTOR_UUID, `_imile_assigndriverid_outsider_${OUTSIDER_ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل خارجي اختبار إسناد معرّف iMile — WBS 3.12'],
  );
});

afterAll(async () => {
  // WBS 3.12 part 2c-i — outbox rows this suite's own calls wrote (no FK from platform.outbox back
  // to imile.driver_id_assignments, so this cleanup is independent of the assignment/driver_id
  // deletes below; same "delete by usedCorrelationIds" convention as
  // modules/hr/tests/register-employee/register-employee.test.ts's own afterAll).
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [
      [...usedCorrelationIds],
    ]);
  }
  if (fixtureShipmentIds.length > 0) {
    await pool.query(`delete from imile.shipments where id = any($1::uuid[])`, [fixtureShipmentIds]);
  }
  if (fixtureDriverIdIds.length > 0) {
    await pool.query(`delete from imile.driver_id_assignments where driver_id_ref = any($1::uuid[])`, [
      fixtureDriverIdIds,
    ]);
    await pool.query(`delete from imile.driver_ids where id = any($1::uuid[])`, [fixtureDriverIdIds]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  // platform.audit_log is NEVER deleted (CLAUDE.md-wide discipline, every prior slice).
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [ASSIGNER_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [ASSIGNER_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [ASSIGNER_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ASSIGNER_ACTOR_UUID]);
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [OUTSIDER_ACTOR_UUID]);
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/imile/assign-driver-id — AssignDriverIdInputSchema shape (brief Contract line)', () => {
  it('accepts { driverIdRef, employeeId, correlationId } and carries no caller-supplied assignedBy/approvedBy', () => {
    const parsed = AssignDriverIdInputSchema.parse({
      driverIdRef: randomUUID(),
      employeeId: randomUUID(),
      correlationId: randomUUID(),
    });
    expect('assignedBy' in parsed).toBe(false);
    expect('approvedBy' in parsed).toBe(false);
  });

  it('rejects a non-uuid driverIdRef', () => {
    const result = AssignDriverIdInputSchema.safeParse({
      driverIdRef: 'not-a-uuid',
      employeeId: randomUUID(),
      correlationId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });
});

// --- Scenario: An available driver ID is assigned to an employee with no prior active assignment --

describe('Scenario: An available driver ID is assigned to an employee with no prior active assignment', () => {
  it('inserts one imile.driver_id_assignments row (assigned_from=now, assigned_to=null), flips driver_ids.status to "assigned", writes one audit row per table', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    const result = await assignDriverId(ctx, { driverIdRef, employeeId, correlationId }, deps);

    expect(result.assignmentId).toEqual(expect.any(String));

    const assignment = await getActiveAssignment(driverIdRef);
    expect(assignment).toBeDefined();
    expect(assignment?.id).toBe(result.assignmentId);
    expect(assignment?.employee_id).toBe(employeeId);
    expect(assignment?.assigned_to).toBeNull();
    expect(assignment?.assigned_by).toBe(ASSIGNER_ACTOR_UUID);
    // brief, Contract: "no approvedBy this slice" — stays null; handover_doc_id also stays null
    // (brief, Contract: "handover_doc_id stays null this slice").
    expect(assignment?.approved_by).toBeNull();
    expect(assignment?.handover_doc_id).toBeNull();
    expect(new Date(assignment!.assigned_from).getTime()).toBe(clock.now().getTime());

    const driverIdRow = await getDriverIdRow(driverIdRef);
    expect(driverIdRow?.status).toBe('assigned');

    const auditRows = await auditRowsForCorrelation(correlationId);
    const assignmentAudit = auditRows.filter((r) => r.table_name === 'driver_id_assignments');
    const driverIdAudit = auditRows.filter((r) => r.table_name === 'driver_ids');
    expect(assignmentAudit).toHaveLength(1);
    expect(assignmentAudit[0]?.operation).toBe('insert');
    expect(assignmentAudit[0]?.record_id).toBe(result.assignmentId);
    expect(driverIdAudit).toHaveLength(1);
    expect(driverIdAudit[0]?.operation).toBe('update');
    expect(driverIdAudit[0]?.record_id).toBe(driverIdRef);

    // WBS 3.12 part 2c-i, finding 9: exactly one platform.outbox row per successful call, same
    // transaction as the state change (CLAUDE.md · ARCHITECTURE). RED until assignDriverId calls
    // writeOutboxEvent.
    const outboxRows = await outboxRowsForCorrelation(correlationId);
    expect(outboxRows).toHaveLength(1);
    const outboxRow = outboxRows[0]!;
    expect(outboxRow.event_type).toBe('imile.driver_id.assigned');
    expect(outboxRow.entity_id).toBe(entityId);
    expect(outboxRow.aggregate_type).toBe('imile.driver_id_assignments');
    expect(outboxRow.aggregate_id).toBe(result.assignmentId);
    expect(outboxRow.actor_id).toBe(ASSIGNER_ACTOR_UUID);
    expect(outboxRow.payload).toMatchObject({
      driverIdRef,
      employeeId,
      assignedFrom: expect.any(String),
      assignedBy: ASSIGNER_ACTOR_UUID,
    });
  });
});

// --- Scenario: an outsider (isInternal:false, no identity.user_entities row) is refused ---------
// round-2 fix round, finding 5: imile.driver_ids/imile.driver_id_assignments both carry
// `internal_only` RLS (13B-Schema-Reference-Consolidation.sql:3143 — `using (platform.is_internal())`
// applied `for all`, i.e. every command including SELECT and INSERT), not `entity_scope` — an
// outsider's own SELECT of the driver_ids row already returns undefined (RLS hides the row), and
// its own INSERT into driver_id_assignments is refused by the same policy's WITH CHECK. Either
// failure mode is acceptable here — this test asserts the OUTCOME (a real error is thrown, zero
// audit rows written), not which specific typed/untyped error the coordinated pg-backend fix round
// settles on.
//
// Round-2 fix round, finding 6 (test-honesty fix, added in the fix round after pg-reviewer's
// round-1 FAIL): WBS 3.12 part 2c-i's new INV-C4-1 gate (`getDriverAssignabilityCheck`) runs FIRST,
// reading hr.employees under `entity_scope` RLS — an outsider actor with no
// identity.user_entities row now fails INSIDE that cross-schema read ("hr.employees row not
// found", surfaced as `assignabilityCheck.employeeStatus` being undefined and
// `assertDriverAssignable` throwing on a non-'active' status, or the read itself returning no row)
// before ever reaching imile's own internal_only-protected tables. This test's own title/comment
// previously claimed it proves "internal_only RLS on both tables" — that claim no longer holds: the
// rejection now happens at the entity-scope gate on hr.employees, before imile.driver_ids/
// imile.driver_id_assignments are ever reached. Relabelled below to describe what this test
// actually proves; a SEPARATE case is added afterwards to still prove imile's own internal_only RLS
// specifically, with an actor who IS entity-scoped but still isInternal:false.

describe('Scenario: an outsider with no identity.user_entities row is refused at the entity-scope gate on hr.employees (INV-C4-1), before imile\'s own tables are ever reached', () => {
  it('assignDriverId under outsiderCtx throws a real error and writes zero platform.audit_log / platform.outbox rows for that correlationId', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    await expect(
      assignDriverId(outsiderCtx, { driverIdRef, employeeId, correlationId }, deps),
    ).rejects.toThrow();

    expect(await auditRowsForCorrelation(correlationId)).toHaveLength(0);
    expect(await countAssignmentsForDriverId(driverIdRef)).toBe(0);
    // doc 40 §B3: the event is written or not written WITH the state, never a third case — a
    // rejection must leave neither a state change NOR an outbox row.
    expect(await outboxRowsForCorrelation(correlationId)).toHaveLength(0);
  });
});

// Round-2 fix round, finding 6, part 2: a SEPARATE case proving imile's own `internal_only` RLS on
// imile.driver_ids/imile.driver_id_assignments specifically — an actor who IS entity-scoped (a real
// identity.user_entities row, so the INV-C4-1 gate's own hr.employees read succeeds) but is still
// isInternal:false must be refused once the command reaches imile's own tables.
describe('Scenario: an entity-scoped outsider (isInternal:false) is refused by imile\'s own internal_only RLS once the INV-C4-1 gate has passed', () => {
  const ENTITY_SCOPED_OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000003120a3';
  const entityScopedOutsiderCtx = { userId: ENTITY_SCOPED_OUTSIDER_ACTOR_UUID, clientId: null, isInternal: false };

  beforeAll(async () => {
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'agent')
         on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
      [
        ENTITY_SCOPED_OUTSIDER_ACTOR_UUID,
        `_imile_assigndriverid_entityscopedoutsider_${randomUUID()}@test.invalid`,
        'ممثل خارجي مُخصَّص للكيان اختبار إسناد معرّف iMile — WBS 3.12',
      ],
    );
    await pool.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
         on conflict (user_id, entity_id) do nothing`,
      [ENTITY_SCOPED_OUTSIDER_ACTOR_UUID, entityId],
    );
  });

  afterAll(async () => {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [
      ENTITY_SCOPED_OUTSIDER_ACTOR_UUID,
    ]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [ENTITY_SCOPED_OUTSIDER_ACTOR_UUID]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [
      ENTITY_SCOPED_OUTSIDER_ACTOR_UUID,
    ]);
    await pool.query(`delete from identity.users where id = $1`, [ENTITY_SCOPED_OUTSIDER_ACTOR_UUID]);
  });

  it('assignDriverId under entityScopedOutsiderCtx (passes the INV-C4-1 gate, isInternal:false) still throws a real error and writes zero audit/outbox rows', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    await expect(
      assignDriverId(entityScopedOutsiderCtx, { driverIdRef, employeeId, correlationId }, deps),
    ).rejects.toThrow();

    expect(await auditRowsForCorrelation(correlationId)).toHaveLength(0);
    expect(await countAssignmentsForDriverId(driverIdRef)).toBe(0);
    expect(await outboxRowsForCorrelation(correlationId)).toHaveLength(0);
  });
});

// --- Scenario: A driver ID that is not available cannot be assigned --------------------------

describe('Scenario: A driver ID that is not available cannot be assigned', () => {
  it('fails with a mapped DriverIdNotAvailableError and writes no row', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('assigned'); // already actively assigned to someone else
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    await expect(
      assignDriverId(ctx, { driverIdRef, employeeId, correlationId }, deps),
    ).rejects.toBeInstanceOf(DriverIdNotAvailableError);

    expect(await countAssignmentsForDriverId(driverIdRef)).toBe(0);
    const driverIdRow = await getDriverIdRow(driverIdRef);
    expect(driverIdRow?.status).toBe('assigned'); // unchanged

    // round-2 fix round, finding 6: "no row is written" must also cover platform.audit_log — a
    // failed command writes ZERO audit rows for the attempted correlationId, not just zero
    // assignment/driver_ids rows.
    expect(await auditRowsForCorrelation(correlationId)).toHaveLength(0);
  });
});

// --- Scenario: An employee who already holds an active assignment cannot receive a second one --

describe('Scenario: An employee who already holds an active assignment cannot receive a second one', () => {
  it('fails with a mapped EmployeeAlreadyAssignedError (the DB\'s own partial-unique-index violation, translated) and writes no row for the new driver ID', async () => {
    beginScenario();
    const firstDriverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });

    // Given: an employee with an existing active assignment.
    await assignDriverId(ctx, { driverIdRef: firstDriverIdRef, employeeId, correlationId: nextCorrelationId() }, deps);

    const secondDriverIdRef = await createFixtureDriverId('available');
    const secondCorrelationId = nextCorrelationId();

    await expect(
      assignDriverId(
        ctx,
        { driverIdRef: secondDriverIdRef, employeeId, correlationId: secondCorrelationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(EmployeeAlreadyAssignedError);

    expect(await countAssignmentsForDriverId(secondDriverIdRef)).toBe(0);
    const secondDriverIdRow = await getDriverIdRow(secondDriverIdRef);
    expect(secondDriverIdRow?.status).toBe('available'); // unchanged

    // round-2 fix round, finding 6: "no row is written" must also cover platform.audit_log — a
    // failed command writes ZERO audit rows for the attempted (second) correlationId.
    expect(await auditRowsForCorrelation(secondCorrelationId)).toHaveLength(0);
  });
});

// --- Scenario: verify_attribution() finds no unattributed deliveries once an assignment exists --

describe('Scenario: verify_attribution() finds no unattributed deliveries once an assignment exists', () => {
  it('returns zero rows for a delivered shipment covered by an AssignDriverId-created assignment', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });

    const result = await assignDriverId(
      ctx,
      { driverIdRef, employeeId, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.assignmentId).toEqual(expect.any(String));

    const driverIdRow: QueryResult<{ imile_code: string }> = await pool.query(
      `select imile_code from imile.driver_ids where id = $1`,
      [driverIdRef],
    );
    const imileCode = driverIdRow.rows[0]?.imile_code;
    if (!imileCode) throw new Error('fixture imile.driver_ids row missing imile_code');

    // The shipment's ofd_at instant must fall inside [assigned_from, now) — one second after the
    // assignment was created, well inside the still-open [assigned_from, null) window.
    const ofdAt = new Date(clock.now().getTime() + 1000);
    const trackingNo = await createFixtureShipment(imileCode, ofdAt);

    const dateOnly = ofdAt.toISOString().slice(0, 10);
    const rows = await verifyAttributionRows(dateOnly, dateOnly);
    expect(rows.find((r) => r.tracking_no === trackingNo)).toBeUndefined();
  });
});

// --- WBS 3.12 part 2c-i — INV-C4-1 gate (imile's own copy of hr's assertDriverAssignable) --------
// Covers findings 9 (outbox, above)/10 (gate reuse)/11 (terminated-employee, for free: a terminated
// employee's status is never 'active') from MASTER_BACKLOG "3.12 part 2". These four scenarios are
// RED until pg-backend wires the new getDriverAssignabilityCheck query + assertDriverAssignable gate
// into assignDriverId.

describe('Scenario: INV-C4-1 gate — a non-active employee is never assignable (covers finding 11, terminated-employee)', () => {
  it('assignDriverId for a "terminated" employee rejects with EmployeeNotActiveError; no assignment row, driver_ids stays "available"', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee('terminated'); // withResidency default still applies — status is what must gate this, not the document.
    const deps = createAssignDriverIdDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    await expect(
      assignDriverId(ctx, { driverIdRef, employeeId, correlationId }, deps),
    ).rejects.toBeInstanceOf(EmployeeNotActiveError);

    expect(await countAssignmentsForDriverId(driverIdRef)).toBe(0);
    const driverIdRow = await getDriverIdRow(driverIdRef);
    expect(driverIdRow?.status).toBe('available');
    expect(await auditRowsForCorrelation(correlationId)).toHaveLength(0);
    // Round-2 fix round, finding 7: doc 40 §B3 — the event is written or not written WITH the
    // state, never a third case; a rejection must leave neither a state change NOR an outbox row.
    expect(await outboxRowsForCorrelation(correlationId)).toHaveLength(0);
  });
});

describe('Scenario: INV-C4-1 gate — an active employee with NO residency document is never assignable', () => {
  it('assignDriverId for an active employee with zero hr.employee_documents rows rejects with DriverDocumentMissingError; no row written', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee('active', { withResidency: false });
    const deps = createAssignDriverIdDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    await expect(
      assignDriverId(ctx, { driverIdRef, employeeId, correlationId }, deps),
    ).rejects.toBeInstanceOf(DriverDocumentMissingError);

    expect(await countAssignmentsForDriverId(driverIdRef)).toBe(0);
    const driverIdRow = await getDriverIdRow(driverIdRef);
    expect(driverIdRow?.status).toBe('available');
    expect(await auditRowsForCorrelation(correlationId)).toHaveLength(0);
    expect(await outboxRowsForCorrelation(correlationId)).toHaveLength(0);
  });
});

describe('Scenario: INV-C4-1 gate — an active employee whose residency document has expired is never assignable', () => {
  it('assignDriverId for an active employee with a residency document expired as of the business "today" rejects with DriverDocumentExpiredError; no row written', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee('active', { withResidency: false });
    await insertResidencyDocument(employeeId, FIXTURE_YESTERDAY);
    const deps = createAssignDriverIdDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    await expect(
      assignDriverId(ctx, { driverIdRef, employeeId, correlationId }, deps),
    ).rejects.toBeInstanceOf(DriverDocumentExpiredError);

    expect(await countAssignmentsForDriverId(driverIdRef)).toBe(0);
    const driverIdRow = await getDriverIdRow(driverIdRef);
    expect(driverIdRow?.status).toBe('available');
    expect(await auditRowsForCorrelation(correlationId)).toHaveLength(0);
    expect(await outboxRowsForCorrelation(correlationId)).toHaveLength(0);
  });
});

describe('Scenario: INV-C4-1 gate — positive control: an active employee with a current residency document IS assignable', () => {
  it('assignDriverId succeeds for an active employee whose residency document has not yet expired (proves the gate does not over-reject a valid employee)', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee('active', { withResidency: false });
    await insertResidencyDocument(employeeId, FIXTURE_TODAY); // expiring today is still valid (>= today).
    const deps = createAssignDriverIdDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    const result = await assignDriverId(ctx, { driverIdRef, employeeId, correlationId }, deps);

    expect(result.assignmentId).toEqual(expect.any(String));
    const driverIdRow = await getDriverIdRow(driverIdRef);
    expect(driverIdRow?.status).toBe('assigned');
  });
});

// --- Scenario: Terminating the employee auto-releases the driver ID (existing trigger) ---------

describe('Scenario: Terminating the employee auto-releases the driver ID (proving the existing trigger, not rebuilding it)', () => {
  it('trg_close_driver_id sets assigned_to + end_reason "terminated" and returns driver_ids.status to "available"', async () => {
    beginScenario();
    const driverIdRef = await createFixtureDriverId('available');
    const employeeId = await createFixtureEmployee();
    const deps = createAssignDriverIdDeps({ clock, ids });

    const result = await assignDriverId(
      ctx,
      { driverIdRef, employeeId, correlationId: nextCorrelationId() },
      deps,
    );

    // When: the employee's hr.employees.status is updated to "terminated" (direct SQL, exercising
    // the ALREADY-BUILT trg_close_driver_id trigger — this slice never rebuilds it).
    await pool.query(`update hr.employees set status = 'terminated' where id = $1`, [employeeId]);

    const assignment = await getAssignmentById(result.assignmentId);
    expect(assignment?.assigned_to).not.toBeNull();
    expect(assignment?.end_reason).toBe('terminated');

    const driverIdRow = await getDriverIdRow(driverIdRef);
    expect(driverIdRow?.status).toBe('available');
  });
});
