// modules/hr/tests/maintain-shift/maintain-shift.test.ts — WBS 5.5a part 2 (lane 2).
//
// Integration tests, one per scenario in ./maintain-shift.feature (except "An empty daysOfWeek is
// rejected", an API-layer/contract test — see ./handlers.test.ts), against the real database as
// pgeos_app. Sources: docs/notes/slice-briefs/_slice-5.5a-part2.brief.md, .claude/briefs/hr.brief.md.
//
// This suite imports application/maintain-shift/index.js, domain/maintain-shift/errors.js,
// api/maintain-shift/composition.js, and @pg-eos/contracts/hr/maintain-shift. Migration 0016
// (database/migrations/0016_2_hr-shifts-groups-assignments.sql) is already applied locally:
// hr.shifts, hr.shift_groups, hr.shift_assignments (RLS entity_scope active on all three).
//
// Expected application surface (brief D2, "Suggested" names):
//   createShift(ctx, CreateShiftInput, deps) -> { id, version }
//   createShiftGroup(ctx, CreateShiftGroupInput, deps) -> { id, version }
//   assignShift(ctx, AssignShiftInput, deps) -> { id, version }
//   endShiftAssignment(ctx, EndShiftAssignmentInput, deps) -> { id, version }
//
// CreateShiftInput (camelCase, no entityId, no performedBy):
//   { code, nameAr, nameEn?, startsAt, endsAt, crossesMidnight?, graceMinutes, daysOfWeek, siteId,
//     correlationId, idem? }
// CreateShiftGroupInput:
//   { shiftId, code, nameAr, groupType, leadEmployeeId, vehicleId?, siteId, startsAt?, endsAt?,
//     correlationId, idem? }
// AssignShiftInput:
//   { employeeId, shiftId, groupId?, validFrom, validTo?, correlationId, idem? }
// EndShiftAssignmentInput:
//   { assignmentId, validTo, expectedVersion, correlationId, idem? }
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as modules/platform/tests/maintain-site/
// maintain-site.test.ts and modules/hr/tests/register-employee/register-employee.test.ts (this
// slice's own two nearest precedents — combined here because a shift/group/assignment fixture
// needs BOTH a real platform.sites row (maintain-site pattern) AND a real hr.employees row
// (register-employee pattern)). PG_APP_USER=pgeos_app is REQUIRED to run this suite (every command
// call goes through withContext(ctx, fn) as pgeos_app, genuinely subject to RLS).
// platform.audit_log rows are NEVER deleted.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test.
import { assignShift, createShift, createShiftGroup, endShiftAssignment } from '../../application/maintain-shift/index.js';
import { createMaintainShiftDeps } from '../../api/maintain-shift/composition.js';
import {
  RoleRequiredError,
  ShiftAssignmentAlreadyEndedError,
  ShiftAssignmentNotFoundError,
  ShiftAssignmentOverlapError,
  ShiftAssignmentRangeInvalidError,
  ShiftCodeTakenError,
  ShiftGraceMinutesInvalidError,
  ShiftGroupCodeTakenError,
  ShiftGroupNotFoundError,
  ShiftGroupShiftMismatchError,
  ShiftGroupTypeInvalidError,
  StaleVersionError,
} from '../../domain/maintain-shift/errors.js';
// the package subpath export (@pg-eos/contracts/hr/maintain-shift), not a deep relative path.
import { CreateShiftInputSchema } from '@pg-eos/contracts/hr/maintain-shift';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// --- literals ------------------------------------------------------------------------------------

const HR_MGR_ROLE_CODE = 'HR_MGR';
const WH_OP_ROLE_CODE = 'WH_OP';

const SHIFT_CREATED_EVENT_TYPE = 'hr.shift.created';
const SHIFT_GROUP_CREATED_EVENT_TYPE = 'hr.shift_group.created';
const SHIFT_ASSIGNED_EVENT_TYPE = 'hr.shift.assigned';
const SHIFT_ASSIGNMENT_ENDED_EVENT_TYPE = 'hr.shift_assignment.ended';

const HR_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000000555a1';
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000555a2';

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(555);
const deps = createMaintainShiftDeps({ clock, ids });

const hrMgrCtx = { userId: HR_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let fixtureSiteId: string;
let fixtureEmployeeId: string;
const fixtureShiftIds: string[] = [];
const fixtureGroupIds: string[] = [];
const fixtureAssignmentIds: string[] = [];
const fixtureExtraEmployeeIds: string[] = [];
const usedCorrelationIds = new Set<string>();
let counter = 0;

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function uniqueCode(prefix: string): string {
  counter += 1;
  return `${prefix}-5.5a-${counter}-${Date.now()}`;
}

// hr.employees.code must match chk_employees_code_format (^PG-[0-9]{4}$, migration
// 0029_M_hr-employee-checks.sql) — this suite owns the PG-3xxx range (Master's disjoint-range
// assignment: register-employee PG-1xxx, its handlers PG-2xxx, maintain-shift PG-3xxx, maintain-shift
// handlers PG-4xxx, hr-employee-checks PG-9xxx), same `PG-${base + counter}` style as
// modules/hr/tests/register-employee/register-employee.test.ts's own uniqueCode().
let employeeCodeCounter = 0;
function uniqueEmployeeCode(): string {
  employeeCodeCounter += 1;
  return `PG-${(3000 + employeeCodeCounter).toString().padStart(4, '0').slice(-4)}`;
}

/** ISO YYYY-MM-DD, `offsetDays` from the fixed clock's own date (negative -> past). */
function dateOffset(offsetDays: number): string {
  const base = clock.now();
  const shifted = new Date(base.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

const TODAY = dateOffset(0);

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    roleCode,
  ]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleId]);
}

async function createFixtureActor(userId: string, forEntityId: string): Promise<void> {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
    userId,
    `_maintainshift_fixture_${userId}_${randomUUID()}@test.invalid`,
    'ممثل اختبار صيانة المناوبات — WBS 5.5a part 2',
  ]);
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, forEntityId]);
}

/** admin-pool direct insert of a platform.sites row — fixture attendance site for shifts/groups
 *  (maintain-site precedent pattern). */
async function insertSiteDirect(forEntityId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into platform.sites (entity_id, kind, name_ar) values ($1, 'warehouse', $2) returning id`,
    [forEntityId, `موقع اختبار 5.5a ${uniqueCode('SITE')}`],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture platform.sites insert returned no row');
  return row.id;
}

/** admin-pool direct insert of an hr.employees row — fixture driver/lead (register-employee
 *  precedent pattern). */
async function insertEmployeeDirect(forEntityId: string): Promise<string> {
  const code = uniqueEmployeeCode();
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, employment_type, status)
     values ($1, $2, $3, $4, 'full_time', 'active') returning id`,
    [forEntityId, code, 'موظف اختبار 5.5a', TODAY],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture hr.employees insert returned no row');
  return row.id;
}

async function insertShiftDirect(forEntityId: string, siteId: string): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into hr.shifts (entity_id, code, name_ar, starts_at, ends_at, grace_minutes, days_of_week, site_id)
     values ($1, $2, $3, '08:00', '16:00', 10, '{0,1,2,3,4}', $4) returning id, version`,
    [forEntityId, uniqueCode('SHF'), 'مناوبة اختبار', siteId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture hr.shifts insert returned no row');
  fixtureShiftIds.push(row.id);
  return row;
}

async function insertShiftGroupDirect(
  forEntityId: string,
  shiftId: string,
  leadEmployeeId: string,
  siteId: string,
): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into hr.shift_groups (entity_id, shift_id, code, name_ar, group_type, lead_employee_id, site_id)
     values ($1, $2, $3, $4, 'transport', $5, $6) returning id, version`,
    [forEntityId, shiftId, uniqueCode('GRP'), 'مجموعة اختبار', leadEmployeeId, siteId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture hr.shift_groups insert returned no row');
  fixtureGroupIds.push(row.id);
  return row;
}

async function insertAssignmentDirect(
  forEntityId: string,
  employeeId: string,
  shiftId: string,
  validFrom: string,
  validTo: string | null,
  actorId: string,
): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into hr.shift_assignments (entity_id, employee_id, shift_id, valid_from, valid_to, assigned_by)
     values ($1, $2, $3, $4, $5, $6) returning id, version`,
    [forEntityId, employeeId, shiftId, validFrom, validTo, actorId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture hr.shift_assignments insert returned no row');
  fixtureAssignmentIds.push(row.id);
  return row;
}

async function getShift(id: string): Promise<{ version: number; entity_id: string }> {
  const result: QueryResult<{ version: number; entity_id: string }> = await pool.query(
    `select version, entity_id from hr.shifts where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no hr.shifts row for id ${id}`);
  return row;
}

async function getAssignment(id: string): Promise<{ version: number; valid_to: string | null; group_id: string | null }> {
  const result: QueryResult<{ version: number; valid_to: string | null; group_id: string | null }> = await pool.query(
    `select version, valid_to::text as valid_to, group_id from hr.shift_assignments where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no hr.shift_assignments row for id ${id}`);
  return row;
}

async function shiftCountForCode(code: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from hr.shifts where code = $1`, [
    code,
  ]);
  return Number(result.rows[0]?.n ?? '0');
}

async function groupCountForCode(code: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from hr.shift_groups where code = $1`,
    [code],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function assignmentCountForEmployee(employeeId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from hr.shift_assignments where employee_id = $1`,
    [employeeId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function outboxRowsForCorrelationAndType(correlationId: string, eventType: string): Promise<Array<{ id: string }>> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id::text as id from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

async function auditCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
    'PST',
  ]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  await createFixtureActor(HR_MGR_ACTOR_UUID, entityId);
  await createFixtureActor(NO_ROLE_ACTOR_UUID, entityId);
  await grantRole(HR_MGR_ACTOR_UUID, HR_MGR_ROLE_CODE);
  await grantRole(NO_ROLE_ACTOR_UUID, WH_OP_ROLE_CODE); // holds a role, just not one this slice gates on.

  fixtureSiteId = await insertSiteDirect(entityId);
  fixtureEmployeeId = await insertEmployeeDirect(entityId);
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureAssignmentIds.length > 0) {
    await pool.query(`delete from hr.shift_assignments where id = any($1::uuid[])`, [fixtureAssignmentIds]);
  }
  // any assignment written by a command under test (not tracked above) for our fixture employees.
  await pool.query(`delete from hr.shift_assignments where employee_id = any($1::uuid[])`, [
    [fixtureEmployeeId, ...fixtureExtraEmployeeIds],
  ]);
  if (fixtureGroupIds.length > 0) {
    await pool.query(`delete from hr.shift_groups where id = any($1::uuid[])`, [fixtureGroupIds]);
  }
  if (fixtureShiftIds.length > 0) {
    await pool.query(`delete from hr.shifts where id = any($1::uuid[])`, [fixtureShiftIds]);
  }
  if (fixtureExtraEmployeeIds.length > 0) {
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureExtraEmployeeIds]);
  }
  await pool.query(`delete from hr.employees where id = $1`, [fixtureEmployeeId]);
  await pool.query(`delete from platform.sites where id = $1`, [fixtureSiteId]);
  for (const userId of [HR_MGR_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/hr/maintain-shift — no entityId/performedBy field', () => {
  it('accepts a well-formed CreateShift body with no entityId/performedBy field', () => {
    const parsed = CreateShiftInputSchema.parse({
      code: uniqueCode('SHF'),
      nameAr: 'مناوبة',
      startsAt: '08:00',
      endsAt: '16:00',
      graceMinutes: 10,
      daysOfWeek: [0, 1, 2, 3, 4],
      siteId: fixtureSiteId,
      correlationId: randomUUID(),
    });
    expect(parsed.graceMinutes).toBe(10);
    expect('entityId' in parsed).toBe(false);
    expect('performedBy' in parsed).toBe(false);
  });
});

// --- Scenario: Create a shift ----------------------------------------------------------------

describe('Scenario: Create a shift', () => {
  it('creates one hr.shifts row (version 1, entity_id = ctx.entityId), one hr.shift.created outbox row, and a matching audit_log row', async () => {
    const code = uniqueCode('SHF');
    const correlationId = nextCorrelationId();
    const result = await createShift(
      hrMgrCtx,
      {
        code,
        nameAr: 'مناوبة صباحية',
        startsAt: '08:00',
        endsAt: '16:00',
        graceMinutes: 10,
        daysOfWeek: [0, 1, 2, 3, 4],
        siteId: fixtureSiteId,
        correlationId,
      },
      deps,
    );
    fixtureShiftIds.push(result.id);
    expect(result.version).toBe(1);

    const row = await getShift(result.id);
    expect(row.version).toBe(1);
    expect(row.entity_id).toBe(entityId);
    expect(await shiftCountForCode(code)).toBe(1);

    const createdRows = await outboxRowsForCorrelationAndType(correlationId, SHIFT_CREATED_EVENT_TYPE);
    expect(createdRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: Create a shift group ------------------------------------------------------------

describe('Scenario: Create a shift group', () => {
  it('creates one hr.shift_groups row (version 1), one hr.shift_group.created outbox row, and its audit_log row', async () => {
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const correlationId = nextCorrelationId();
    const result = await createShiftGroup(
      hrMgrCtx,
      {
        shiftId: shift.id,
        code: uniqueCode('GRP'),
        nameAr: 'مجموعة نقل',
        groupType: 'transport',
        leadEmployeeId: fixtureEmployeeId,
        siteId: fixtureSiteId,
        correlationId,
      },
      deps,
    );
    fixtureGroupIds.push(result.id);
    expect(result.version).toBe(1);

    const createdRows = await outboxRowsForCorrelationAndType(correlationId, SHIFT_GROUP_CREATED_EVENT_TYPE);
    expect(createdRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: Assign an employee to a shift -----------------------------------------------------

describe('Scenario: Assign an employee to a shift', () => {
  it('creates one hr.shift_assignments row (version 1), one hr.shift.assigned outbox row, and its audit_log row', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const correlationId = nextCorrelationId();

    const result = await assignShift(
      hrMgrCtx,
      { employeeId, shiftId: shift.id, validFrom: TODAY, correlationId },
      deps,
    );
    fixtureAssignmentIds.push(result.id);
    expect(result.version).toBe(1);
    expect(await assignmentCountForEmployee(employeeId)).toBe(1);

    const assignedRows = await outboxRowsForCorrelationAndType(correlationId, SHIFT_ASSIGNED_EVENT_TYPE);
    expect(assignedRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: Assigning the same employee to an overlapping date range is rejected -----------------

describe('Scenario: Assigning the same employee to an overlapping date range is rejected', () => {
  it('ShiftAssignmentOverlapError (422), no row written', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    await insertAssignmentDirect(entityId, employeeId, shift.id, TODAY, null, HR_MGR_ACTOR_UUID); // open-ended, from today.

    await expect(
      assignShift(
        hrMgrCtx,
        { employeeId, shiftId: shift.id, validFrom: dateOffset(5), correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftAssignmentOverlapError);

    expect(await assignmentCountForEmployee(employeeId)).toBe(1);
  });
});

// --- Scenario: Assigning with a group whose shift does not match is rejected -------------------------

describe('Scenario: Assigning with a group whose shift does not match is rejected', () => {
  it('ShiftGroupShiftMismatchError (422), no row written', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shiftA = await insertShiftDirect(entityId, fixtureSiteId);
    const shiftB = await insertShiftDirect(entityId, fixtureSiteId);
    const group = await insertShiftGroupDirect(entityId, shiftA.id, fixtureEmployeeId, fixtureSiteId);

    await expect(
      assignShift(
        hrMgrCtx,
        { employeeId, shiftId: shiftB.id, groupId: group.id, validFrom: TODAY, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftGroupShiftMismatchError);

    expect(await assignmentCountForEmployee(employeeId)).toBe(0);
  });
});

// --- Scenario: Assigning with a group whose shift matches succeeds -----------------------------------

describe('Scenario: Assigning with a group whose shift matches succeeds', () => {
  it('one hr.shift_assignments row exists with that group_id', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shiftA = await insertShiftDirect(entityId, fixtureSiteId);
    const group = await insertShiftGroupDirect(entityId, shiftA.id, fixtureEmployeeId, fixtureSiteId);

    const result = await assignShift(
      hrMgrCtx,
      { employeeId, shiftId: shiftA.id, groupId: group.id, validFrom: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureAssignmentIds.push(result.id);

    const row = await getAssignment(result.id);
    expect(row.group_id).toBe(group.id);
  });
});

// --- Scenario: End a shift assignment ------------------------------------------------------------

describe('Scenario: End a shift assignment', () => {
  it("the row's valid_to is set and version becomes 2, one hr.shift_assignment.ended outbox row and its audit_log row are written", async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const assignment = await insertAssignmentDirect(entityId, employeeId, shift.id, TODAY, null, HR_MGR_ACTOR_UUID);
    expect(assignment.version).toBe(1);

    const correlationId = nextCorrelationId();
    const result = await endShiftAssignment(
      hrMgrCtx,
      { assignmentId: assignment.id, validTo: TODAY, expectedVersion: 1, correlationId },
      deps,
    );
    expect(result.version).toBe(2);

    const row = await getAssignment(assignment.id);
    expect(row.version).toBe(2);
    expect(row.valid_to).toBe(TODAY);

    const endedRows = await outboxRowsForCorrelationAndType(correlationId, SHIFT_ASSIGNMENT_ENDED_EVENT_TYPE);
    expect(endedRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: A stale expectedVersion on EndShiftAssignment is rejected -----------------------------

describe('Scenario: A stale expectedVersion on EndShiftAssignment is rejected', () => {
  it('StaleVersionError (409), no column written', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const assignment = await insertAssignmentDirect(entityId, employeeId, shift.id, TODAY, null, HR_MGR_ACTOR_UUID);

    await endShiftAssignment(
      hrMgrCtx,
      { assignmentId: assignment.id, validTo: TODAY, expectedVersion: 1, correlationId: nextCorrelationId() },
      deps,
    ); // assignment now at version 2.

    await expect(
      endShiftAssignment(
        hrMgrCtx,
        { assignmentId: assignment.id, validTo: TODAY, expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(StaleVersionError);

    const row = await getAssignment(assignment.id);
    expect(row.version).toBe(2); // unchanged by the rejected call.
  });
});

// --- Scenario: After ending an assignment, a new overlapping one is allowed -------------------------

describe('Scenario: After ending an assignment, a new overlapping one is allowed', () => {
  it('one new hr.shift_assignments row exists', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    await insertAssignmentDirect(entityId, employeeId, shift.id, dateOffset(-30), dateOffset(-1), HR_MGR_ACTOR_UUID); // ended yesterday.

    const result = await assignShift(
      hrMgrCtx,
      { employeeId, shiftId: shift.id, validFrom: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureAssignmentIds.push(result.id);

    expect(await assignmentCountForEmployee(employeeId)).toBe(2);
  });
});

// --- Scenario: Role gates ---------------------------------------------------------------------------

describe('Scenario: Role gates', () => {
  it('CreateShift, CreateShiftGroup, AssignShift and EndShiftAssignment each throw RoleRequiredError for a caller holding only WH_OP; nothing written', async () => {
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const assignment = await insertAssignmentDirect(entityId, fixtureEmployeeId, shift.id, TODAY, null, HR_MGR_ACTOR_UUID);
    const code = uniqueCode('SHF');

    await expect(
      createShift(
        noRoleCtx,
        {
          code,
          nameAr: 'x',
          startsAt: '08:00',
          endsAt: '16:00',
          graceMinutes: 10,
          daysOfWeek: [0],
          siteId: fixtureSiteId,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    await expect(
      createShiftGroup(
        noRoleCtx,
        {
          shiftId: shift.id,
          code: uniqueCode('GRP'),
          nameAr: 'x',
          groupType: 'transport',
          leadEmployeeId: fixtureEmployeeId,
          siteId: fixtureSiteId,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    await expect(
      assignShift(
        noRoleCtx,
        { employeeId: fixtureEmployeeId, shiftId: shift.id, validFrom: dateOffset(365), correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    await expect(
      endShiftAssignment(
        noRoleCtx,
        { assignmentId: assignment.id, validTo: TODAY, expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    expect(await shiftCountForCode(code)).toBe(0);
    const row = await getAssignment(assignment.id);
    expect(row.version).toBe(1); // unchanged.
  });
});

// --- pg-reviewer round-1 findings 1/2: an invalid (validTo < validFrom) date range ------------------

describe("Scenario: EndShiftAssignment with a validTo earlier than the assignment's valid_from is rejected", () => {
  it('ShiftAssignmentRangeInvalidError (422), no column written (finding 1)', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const assignment = await insertAssignmentDirect(entityId, employeeId, shift.id, TODAY, null, HR_MGR_ACTOR_UUID);

    await expect(
      endShiftAssignment(
        hrMgrCtx,
        { assignmentId: assignment.id, validTo: dateOffset(-10), expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftAssignmentRangeInvalidError);

    const row = await getAssignment(assignment.id);
    expect(row.version).toBe(1);
    expect(row.valid_to).toBeNull();
  });
});

describe('Scenario: AssignShift with a validTo earlier than validFrom is rejected', () => {
  it('ShiftAssignmentRangeInvalidError (422), no row written (finding 2)', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);

    await expect(
      assignShift(
        hrMgrCtx,
        { employeeId, shiftId: shift.id, validFrom: TODAY, validTo: dateOffset(-1), correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftAssignmentRangeInvalidError);

    expect(await assignmentCountForEmployee(employeeId)).toBe(0);
  });
});

// --- pg-reviewer round-1 finding 3: EndShiftAssignment called twice on the same assignment -----------

describe('Scenario: EndShiftAssignment called twice on the same assignment is rejected', () => {
  it("ShiftAssignmentAlreadyEndedError (422) on the second call, not the exclusion constraint's raw error", async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const assignment = await insertAssignmentDirect(entityId, employeeId, shift.id, TODAY, null, HR_MGR_ACTOR_UUID);

    const firstResult = await endShiftAssignment(
      hrMgrCtx,
      { assignmentId: assignment.id, validTo: TODAY, expectedVersion: 1, correlationId: nextCorrelationId() },
      deps,
    );
    expect(firstResult.version).toBe(2);

    await expect(
      endShiftAssignment(
        hrMgrCtx,
        { assignmentId: assignment.id, validTo: dateOffset(1), expectedVersion: 2, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftAssignmentAlreadyEndedError);

    const row = await getAssignment(assignment.id);
    expect(row.valid_to).toBe(TODAY); // unchanged by the rejected second call.
  });
});

// --- pg-reviewer round-2 finding 1: role gate must run BEFORE business-rule checks on
// EndShiftAssignment (proves it does not leak assignment state to an unauthorized caller) ------------

describe('Scenario: EndShiftAssignment role gate runs before business checks (round-2 finding 1)', () => {
  it('a caller holding only WH_OP gets RoleRequiredError, not ShiftAssignmentAlreadyEndedError, when the assignment is already ended', async () => {
    const employeeId = await insertEmployeeDirect(entityId);
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    // an ALREADY-ENDED assignment (valid_to already set) — if the business check ran first, this
    // call would throw ShiftAssignmentAlreadyEndedError instead, leaking the row's own state to an
    // unauthorized caller.
    const assignment = await insertAssignmentDirect(entityId, employeeId, shift.id, dateOffset(-30), dateOffset(-1), HR_MGR_ACTOR_UUID);

    await expect(
      endShiftAssignment(
        noRoleCtx, // holds WH_OP only, not HR_MGR/GM.
        { assignmentId: assignment.id, validTo: dateOffset(-1), expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    const row = await getAssignment(assignment.id);
    expect(row.version).toBe(1); // unchanged by the rejected call.
  });
});

// --- pg-reviewer round-1 finding 6: grace_minutes / group_type domain-layer re-validation -------------
//
// Both CreateShiftInputSchema (GRACE_MINUTES min(0)) and CreateShiftGroupInputSchema (groupType
// enum) already reject these at the CONTRACT layer. These two scenarios call the application
// function directly (bypassing the parsed-and-validated HTTP path), same discipline as
// maintain-site.test.ts's "An invalid kind is rejected by the application layer" — proving the
// domain-layer re-validation (isValidGraceMinutes/isValidGroupType) actually runs and is not dead
// code.

describe('Scenario: CreateShift with a negative grace_minutes is rejected', () => {
  it('ShiftGraceMinutesInvalidError (422), no row written (finding 6a)', async () => {
    const code = uniqueCode('SHF');
    await expect(
      createShift(
        hrMgrCtx,
        {
          code,
          nameAr: 'مناوبة',
          startsAt: '08:00',
          endsAt: '16:00',
          graceMinutes: -1,
          daysOfWeek: [0],
          siteId: fixtureSiteId,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftGraceMinutesInvalidError);

    expect(await shiftCountForCode(code)).toBe(0);
  });
});

describe('Scenario: CreateShiftGroup with an invalid group_type is rejected', () => {
  it('ShiftGroupTypeInvalidError (422), no row written (finding 6b)', async () => {
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const code = uniqueCode('GRP');
    await expect(
      createShiftGroup(
        hrMgrCtx,
        {
          shiftId: shift.id,
          code,
          nameAr: 'مجموعة',
          groupType: 'not_a_real_group_type',
          leadEmployeeId: fixtureEmployeeId,
          siteId: fixtureSiteId,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftGroupTypeInvalidError);

    expect(await groupCountForCode(code)).toBe(0);
  });
});

// --- pg-reviewer round-1 finding 7: a duplicate code on hr.shifts / hr.shift_groups -------------------

describe('Scenario: CreateShift with a duplicate code is rejected', () => {
  it('ShiftCodeTakenError (409), no second row written (finding 7a)', async () => {
    const code = uniqueCode('SHF');
    const first = await createShift(
      hrMgrCtx,
      {
        code,
        nameAr: 'مناوبة أولى',
        startsAt: '08:00',
        endsAt: '16:00',
        graceMinutes: 10,
        daysOfWeek: [0],
        siteId: fixtureSiteId,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    fixtureShiftIds.push(first.id);

    await expect(
      createShift(
        hrMgrCtx,
        {
          code, // duplicate.
          nameAr: 'مناوبة ثانية',
          startsAt: '09:00',
          endsAt: '17:00',
          graceMinutes: 5,
          daysOfWeek: [1],
          siteId: fixtureSiteId,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftCodeTakenError);

    expect(await shiftCountForCode(code)).toBe(1);
  });
});

describe('Scenario: CreateShiftGroup with a duplicate code is rejected', () => {
  it('ShiftGroupCodeTakenError (409), no second row written (finding 7b)', async () => {
    const shift = await insertShiftDirect(entityId, fixtureSiteId);
    const code = uniqueCode('GRP');
    const first = await createShiftGroup(
      hrMgrCtx,
      {
        shiftId: shift.id,
        code,
        nameAr: 'مجموعة أولى',
        groupType: 'transport',
        leadEmployeeId: fixtureEmployeeId,
        siteId: fixtureSiteId,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    fixtureGroupIds.push(first.id);

    await expect(
      createShiftGroup(
        hrMgrCtx,
        {
          shiftId: shift.id,
          code, // duplicate.
          nameAr: 'مجموعة ثانية',
          groupType: 'warehouse',
          leadEmployeeId: fixtureEmployeeId,
          siteId: fixtureSiteId,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftGroupCodeTakenError);

    expect(await groupCountForCode(code)).toBe(1);
  });
});

// --- Finding 9: cross-entity isolation (no counterpart existed before — maintain-site.test.ts's own
// "A site outside the caller's entity is invisible" / register-employee.test.ts's own cross-entity
// pattern, replicated here for all three of this slice's tables) ---------------------------------------

describe('Scenario: cross-entity isolation (finding 9)', () => {
  let otherEntityId: string;
  let otherEntitySiteId: string;
  const crossEntityShiftIds: string[] = [];
  const crossEntityGroupIds: string[] = [];
  const crossEntityAssignmentIds: string[] = [];
  const crossEntityEmployeeIds: string[] = [];

  beforeAll(async () => {
    const otherEntityResult: QueryResult<{ id: string }> = await pool.query(
      `select id from platform.entities where code = $1`,
      ['PCC'],
    );
    otherEntityId = (otherEntityResult.rows[0] as { id: string }).id;
    otherEntitySiteId = await insertSiteDirect(otherEntityId);
  });

  afterAll(async () => {
    if (crossEntityAssignmentIds.length > 0) {
      await pool.query(`delete from hr.shift_assignments where id = any($1::uuid[])`, [crossEntityAssignmentIds]);
    }
    if (crossEntityGroupIds.length > 0) {
      await pool.query(`delete from hr.shift_groups where id = any($1::uuid[])`, [crossEntityGroupIds]);
    }
    if (crossEntityShiftIds.length > 0) {
      await pool.query(`delete from hr.shifts where id = any($1::uuid[])`, [crossEntityShiftIds]);
    }
    if (crossEntityEmployeeIds.length > 0) {
      await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [crossEntityEmployeeIds]);
    }
    await pool.query(`delete from platform.sites where id = $1`, [otherEntitySiteId]);
  });

  it("EndShiftAssignment on an assignment belonging to entity B -> ShiftAssignmentNotFoundError for a caller scoped only to entity A", async () => {
    const otherEmployeeId = await insertEmployeeDirect(otherEntityId);
    crossEntityEmployeeIds.push(otherEmployeeId);
    const otherShift = await insertShiftDirect(otherEntityId, otherEntitySiteId);
    crossEntityShiftIds.push(otherShift.id);
    const otherAssignment = await insertAssignmentDirect(
      otherEntityId,
      otherEmployeeId,
      otherShift.id,
      TODAY,
      null,
      HR_MGR_ACTOR_UUID,
    );
    crossEntityAssignmentIds.push(otherAssignment.id);

    await expect(
      endShiftAssignment(
        hrMgrCtx, // scoped only to entity A (PST) — see beforeAll.
        { assignmentId: otherAssignment.id, validTo: TODAY, expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftAssignmentNotFoundError);
  });

  it('AssignShift with a groupId belonging to entity B -> ShiftGroupNotFoundError (the group is invisible under RLS) for a caller scoped only to entity A', async () => {
    const otherLeadEmployeeId = await insertEmployeeDirect(otherEntityId);
    crossEntityEmployeeIds.push(otherLeadEmployeeId);
    const otherShift = await insertShiftDirect(otherEntityId, otherEntitySiteId);
    crossEntityShiftIds.push(otherShift.id);
    const otherGroup = await insertShiftGroupDirect(otherEntityId, otherShift.id, otherLeadEmployeeId, otherEntitySiteId);
    crossEntityGroupIds.push(otherGroup.id);

    const employeeId = await insertEmployeeDirect(entityId); // entity A employee.
    fixtureExtraEmployeeIds.push(employeeId);
    const shift = await insertShiftDirect(entityId, fixtureSiteId); // entity A shift.

    await expect(
      assignShift(
        hrMgrCtx,
        { employeeId, shiftId: shift.id, groupId: otherGroup.id, validFrom: TODAY, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShiftGroupNotFoundError);

    expect(await assignmentCountForEmployee(employeeId)).toBe(0);
  });

  it("CreateShift ignores a caller-supplied entityId — the row is written under ctx.entityId (the caller's own entity), never the supplied value", async () => {
    const code = uniqueCode('SHF');
    const correlationId = nextCorrelationId();
    // CreateShiftInput carries NO entityId field (brief D6) — this object is assigned to a `const`
    // BEFORE the call, so TypeScript's excess-property check (which only fires on a fresh object
    // LITERAL at the call site) does not reject the extra key; it proves the application layer
    // structurally ignores an entityId even if one were smuggled in.
    const bodyWithForeignEntityId = {
      code,
      nameAr: 'مناوبة كيان آخر',
      startsAt: '08:00',
      endsAt: '16:00',
      graceMinutes: 10,
      daysOfWeek: [0, 1],
      siteId: fixtureSiteId,
      correlationId,
      entityId: otherEntityId,
    };
    const result = await createShift(hrMgrCtx, bodyWithForeignEntityId, deps);
    fixtureShiftIds.push(result.id);

    const row = await getShift(result.id);
    expect(row.entity_id).toBe(entityId); // ctx.entityId (A) — never the caller-supplied otherEntityId (B).
    expect(row.entity_id).not.toBe(otherEntityId);
  });
});

// --- Scenario: Idempotent replay ----------------------------------------------------------------------

describe('Scenario: Idempotent replay', () => {
  it('CreateShift twice with the same Idempotency-Key and body: one row exists, second call returns the first result; a different body with the same key -> IdempotencyConflictError', async () => {
    const idempotencyKey = randomUUID();
    const code = uniqueCode('SHF');
    const body = {
      code,
      nameAr: 'مناوبة',
      startsAt: '08:00',
      endsAt: '16:00',
      graceMinutes: 10,
      daysOfWeek: [0, 1, 2],
      siteId: fixtureSiteId,
      correlationId: nextCorrelationId(),
    };
    const idem: IdempotencyInput = {
      key: idempotencyKey,
      endpoint: 'hr.maintain-shift.create-shift',
      requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      entityId: null,
      successStatus: 200,
    };

    const first = await createShift(hrMgrCtx, { ...body, idem }, deps);
    fixtureShiftIds.push(first.id);
    const second = await createShift(hrMgrCtx, { ...body, idem }, deps);
    expect(second).toEqual(first);
    expect(await shiftCountForCode(code)).toBe(1);

    const differentBody = { ...body, code: uniqueCode('SHF') };
    const differentIdem: IdempotencyInput = {
      ...idem,
      requestHash: createHash('sha256').update(JSON.stringify(differentBody)).digest('hex'),
    };
    await expect(
      createShift(hrMgrCtx, { ...differentBody, idem: differentIdem }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
