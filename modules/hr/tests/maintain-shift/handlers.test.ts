// modules/hr/tests/maintain-shift/handlers.test.ts — WBS 5.5a part 2 (lane 2).
//
// The api layer's contract (modules/hr/api/maintain-shift/handlers.ts), one test per mapping,
// template = modules/platform/tests/maintain-site/handlers.test.ts's FINAL shape (its own 3
// review-round fixes already applied — this file copies that shape, not an earlier draft):
//   - a missing Idempotency-Key -> 400 Problem (every command here is a write);
//   - an invalid body, including an empty daysOfWeek -> 400 Problem (scenario: "An empty
//     daysOfWeek is rejected");
//   - StaleVersionError -> 409;
//   - ShiftAssignmentOverlapError / ShiftGroupShiftMismatchError / RoleRequiredError -> 422;
//   - an unknown error -> 500 Problem, logged via deps.logger.error, never sent to the client;
//   - the same Idempotency-Key + same body -> the second call replays the first response, no
//     second write; the same key + a DIFFERENT body -> IdempotencyConflictError (409);
//   - title = error.name.
//
// Fixture/RLS pattern: same admin-pool style as ./maintain-shift.test.ts, deliberately minimal
// (one site, one employee, one shift) since this file only exercises the API-mapping LAYER, not
// every business scenario (already covered by maintain-shift.test.ts). platform.audit_log is
// never deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createMaintainShiftDeps } from '../../api/maintain-shift/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — MaintainShiftDeps carries `logger: Logger`
// (../../application/maintain-shift/ports.js), and createMaintainShiftDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger.
import type { Logger } from '../../application/maintain-shift/ports.js';

// The module under test — its error-mapping behaviour, per the api-layer contract above.
import {
  handleAssignShift,
  handleCreateShift,
  handleCreateShiftGroup,
  handleEndShiftAssignment,
  type ApiRequest,
} from '../../api/maintain-shift/handlers.js';

// hr.shift_groups.group_type (migration 0016 chk_shift_groups_type) — used only to build a
// well-shaped body for the "missing Idempotency-Key" mapping test below; the group is never
// actually created (the missing-header short-circuit runs before any DB write or Zod parse).
const SHIFT_GROUP_TYPE = 'transport';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000556c1';
const HR_MGR_ROLE_CODE = 'HR_MGR';
const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(5561);
const deps = createMaintainShiftDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let draftSiteId: string;
let draftEmployeeId: string;
let draftShiftId: string;
let draftAssignmentId: string;
let draftAssignmentVersion: number;
const extraShiftIds: string[] = [];
const extraAssignmentIds: string[] = [];
let counter = 0;

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function uniqueCode(prefix: string): string {
  counter += 1;
  return `${prefix}-5.5a-h-${counter}-${Date.now()}`;
}

function spyLogger(): Logger & { readonly errorCalls: Array<[Record<string, unknown>, string]> } {
  const errorCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    errorCalls,
    error: (obj, msg) => {
      errorCalls.push([obj, msg]);
    },
    info: () => {
      // not asserted here.
    },
  };
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
    'PST',
  ]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  const siteResult: QueryResult<{ id: string }> = await pool.query(
    `insert into platform.sites (entity_id, kind, name_ar) values ($1, 'warehouse', $2) returning id`,
    [entityId, `موقع اختبار معالجات 5.5a ${uniqueCode('SITE')}`],
  );
  draftSiteId = (siteResult.rows[0] as { id: string }).id;

  const employeeResult: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, employment_type, status)
     values ($1, $2, $3, current_date, 'full_time', 'active') returning id`,
    [entityId, uniqueCode('PG'), 'موظف اختبار معالجات'],
  );
  draftEmployeeId = (employeeResult.rows[0] as { id: string }).id;

  const shiftResult: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.shifts (entity_id, code, name_ar, starts_at, ends_at, grace_minutes, days_of_week, site_id)
     values ($1, $2, $3, '08:00', '16:00', 10, '{0,1,2}', $4) returning id`,
    [entityId, uniqueCode('SHF'), 'مناوبة اختبار معالجات', draftSiteId],
  );
  draftShiftId = (shiftResult.rows[0] as { id: string }).id;

  // identity.users (and the rows that reference it) must exist BEFORE hr.shift_assignments is
  // inserted below, since shift_assignments.assigned_by foreign-keys to identity.users
  // (migration 0016) — ordering bug fixed per lane-2 report.
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
    FIXTURE_ACTOR_UUID,
    `_maintainshift_handlers_actor_${randomUUID()}@test.invalid`,
    'ممثل اختبار معالجات صيانة المناوبات',
  ]);
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [FIXTURE_ACTOR_UUID, entityId]);
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    HR_MGR_ROLE_CODE,
  ]);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);

  const assignmentResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into hr.shift_assignments (entity_id, employee_id, shift_id, valid_from, assigned_by)
     values ($1, $2, $3, current_date, $4) returning id, version`,
    [entityId, draftEmployeeId, draftShiftId, FIXTURE_ACTOR_UUID],
  );
  draftAssignmentId = (assignmentResult.rows[0] as { id: string; version: number }).id;
  draftAssignmentVersion = (assignmentResult.rows[0] as { id: string; version: number }).version;
});

afterAll(async () => {
  const allAssignmentIds = [draftAssignmentId, ...extraAssignmentIds].filter(Boolean);
  if (allAssignmentIds.length > 0) {
    await pool.query(`delete from hr.shift_assignments where id = any($1::uuid[])`, [allAssignmentIds]);
  }
  await pool.query(`delete from hr.shift_assignments where employee_id = $1`, [draftEmployeeId]);
  const allShiftIds = [draftShiftId, ...extraShiftIds].filter(Boolean);
  if (allShiftIds.length > 0) {
    await pool.query(`delete from hr.shifts where id = any($1::uuid[])`, [allShiftIds]);
  }
  await pool.query(`delete from hr.employees where id = $1`, [draftEmployeeId]);
  await pool.query(`delete from platform.sites where id = $1`, [draftSiteId]);
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleCreateShift: no Idempotency-Key header -> 400', async () => {
    const result = await handleCreateShift(
      requestWithoutKey({
        code: uniqueCode('SHF'),
        nameAr: 'x',
        startsAt: '08:00',
        endsAt: '16:00',
        graceMinutes: 10,
        daysOfWeek: [0],
        siteId: draftSiteId,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });

  it('handleCreateShiftGroup: no Idempotency-Key header -> 400', async () => {
    const result = await handleCreateShiftGroup(
      requestWithoutKey({
        shiftId: draftShiftId,
        code: uniqueCode('GRP'),
        nameAr: 'x',
        groupType: SHIFT_GROUP_TYPE,
        leadEmployeeId: draftEmployeeId,
        siteId: draftSiteId,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });

  it('handleAssignShift: no Idempotency-Key header -> 400', async () => {
    const result = await handleAssignShift(
      requestWithoutKey({ employeeId: draftEmployeeId, shiftId: draftShiftId, validFrom: '2027-01-01', correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });

  it('handleEndShiftAssignment: no Idempotency-Key header -> 400', async () => {
    const result = await handleEndShiftAssignment(
      requestWithoutKey({
        assignmentId: draftAssignmentId,
        validTo: '2027-01-01',
        expectedVersion: draftAssignmentVersion,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleCreateShift: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleCreateShift(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleCreateShift: daysOfWeek [] -> 400 (scenario: "An empty daysOfWeek is rejected"), and nothing is written', async () => {
    const code = uniqueCode('SHF');
    const result = await handleCreateShift(
      requestWithKey({
        code,
        nameAr: 'x',
        startsAt: '08:00',
        endsAt: '16:00',
        graceMinutes: 10,
        daysOfWeek: [],
        siteId: draftSiteId,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);

    const countResult: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from hr.shifts where code = $1`, [
      code,
    ]);
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleEndShiftAssignment: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const result = await handleEndShiftAssignment(
      requestWithKey({
        assignmentId: draftAssignmentId,
        validTo: '2027-01-01',
        expectedVersion: draftAssignmentVersion + 999,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('ShiftAssignmentOverlapError maps to 422, title = error.name', () => {
  it('handleAssignShift: an overlapping date range for the same employee -> 422, title "ShiftAssignmentOverlapError"', async () => {
    const result = await handleAssignShift(
      requestWithKey({ employeeId: draftEmployeeId, shiftId: draftShiftId, validFrom: '2026-09-25', correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'ShiftAssignmentOverlapError' });
  });
});

describe('ShiftGroupShiftMismatchError maps to 422, title = error.name', () => {
  it('handleAssignShift: a groupId whose own shift_id disagrees with the input shiftId -> 422, title "ShiftGroupShiftMismatchError"', async () => {
    const otherShiftResult: QueryResult<{ id: string }> = await pool.query(
      `insert into hr.shifts (entity_id, code, name_ar, starts_at, ends_at, grace_minutes, days_of_week, site_id)
       values ($1, $2, $3, '08:00', '16:00', 10, '{0}', $4) returning id`,
      [entityId, uniqueCode('SHF'), 'مناوبة أخرى', draftSiteId],
    );
    const otherShiftId = (otherShiftResult.rows[0] as { id: string }).id;
    extraShiftIds.push(otherShiftId);

    const groupResult: QueryResult<{ id: string }> = await pool.query(
      `insert into hr.shift_groups (entity_id, shift_id, code, name_ar, group_type, lead_employee_id, site_id)
       values ($1, $2, $3, $4, 'transport', $5, $6) returning id`,
      [entityId, otherShiftId, uniqueCode('GRP'), 'مجموعة أخرى', draftEmployeeId, draftSiteId],
    );
    const groupId = (groupResult.rows[0] as { id: string }).id;

    const employeeResult: QueryResult<{ id: string }> = await pool.query(
      `insert into hr.employees (entity_id, code, name_ar, hire_date, employment_type, status)
       values ($1, $2, $3, current_date, 'full_time', 'active') returning id`,
      [entityId, uniqueCode('PG'), 'موظف آخر'],
    );
    const otherEmployeeId = (employeeResult.rows[0] as { id: string }).id;

    const result = await handleAssignShift(
      requestWithKey({
        employeeId: otherEmployeeId,
        shiftId: draftShiftId, // deliberately NOT otherShiftId — mismatches the group's own shift_id.
        groupId,
        validFrom: '2027-01-01',
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'ShiftGroupShiftMismatchError' });

    await pool.query(`delete from hr.shift_groups where id = $1`, [groupId]);
    await pool.query(`delete from hr.employees where id = $1`, [otherEmployeeId]);
  });
});

describe('RoleRequiredError maps to 422, title = error.name', () => {
  it('handleCreateShift: a caller with no granted role -> 422, title "RoleRequiredError"', async () => {
    const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000556c2';
    await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
      NO_ROLE_ACTOR_UUID,
      `_maintainshift_handlers_norole_${randomUUID()}@test.invalid`,
      'ممثل اختبار — بلا دور',
    ]);
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [NO_ROLE_ACTOR_UUID, entityId]);
    const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

    const result = await handleCreateShift(
      {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: {
          code: uniqueCode('SHF'),
          nameAr: 'x',
          startsAt: '08:00',
          endsAt: '16:00',
          graceMinutes: 10,
          daysOfWeek: [0],
          siteId: draftSiteId,
          correlationId: randomUUID(),
        },
        ctx: noRoleCtx,
      },
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });

    await pool.query(`delete from identity.user_entities where user_id = $1`, [NO_ROLE_ACTOR_UUID]);
    await pool.query(`delete from identity.users where id = $1`, [NO_ROLE_ACTOR_UUID]);
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first and the command ran once', () => {
  it('handleCreateShift: identical key + body -> identical response, one hr.shifts row written', async () => {
    const idempotencyKey = randomUUID();
    const code = uniqueCode('SHF');
    const body = {
      code,
      nameAr: 'x',
      startsAt: '08:00',
      endsAt: '16:00',
      graceMinutes: 10,
      daysOfWeek: [0, 1],
      siteId: draftSiteId,
      correlationId: randomUUID(),
    };

    const first = await handleCreateShift(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleCreateShift(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from hr.shifts where code = $1`, [
      code,
    ]);
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1); // written once, not twice.

    if (first.status === 200) extraShiftIds.push((first.body as { id: string }).id);
  });

  it('handleCreateShift: the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const idempotencyKey = randomUUID();
    const body = {
      code: uniqueCode('SHF'),
      nameAr: 'x',
      startsAt: '08:00',
      endsAt: '16:00',
      graceMinutes: 10,
      daysOfWeek: [0],
      siteId: draftSiteId,
      correlationId: randomUUID(),
    };

    const first = await handleCreateShift(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraShiftIds.push((first.body as { id: string }).id);

    const differentBody = { ...body, code: uniqueCode('SHF') };
    const result = await handleCreateShift(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleCreateShift: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const depsWithSpyLogger = createMaintainShiftDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...(depsWithSpyLogger as unknown as { repo: Record<string, unknown> }).repo,
        insertShift: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleCreateShift(
      requestWithKey({
        code: uniqueCode('SHF'),
        nameAr: 'x',
        startsAt: '08:00',
        endsAt: '16:00',
        graceMinutes: 10,
        daysOfWeek: [0],
        siteId: draftSiteId,
        correlationId,
      }),
      brokenDeps as unknown as typeof deps,
    );

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });
});

// --- createMaintainShiftDeps({ clock, ids, logger }) --------------------------------------------

describe('createMaintainShiftDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createMaintainShiftDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createMaintainShiftDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
