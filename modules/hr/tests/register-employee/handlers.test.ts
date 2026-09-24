// modules/hr/tests/register-employee/handlers.test.ts — WBS 3.3.
//
// The api layer's contract (modules/hr/api/register-employee/handlers.ts), one test per mapping:
//   - a missing Idempotency-Key -> 400 Problem (write commands only — CheckDriverAssignable is
//     read-only, brief D1, and needs none);
//   - an invalid body -> 400 Problem;
//   - EmployeeCodeTakenError / StaleVersionError -> 409;
//   - DriverDocumentExpiredError / DriverDocumentMissingError / EmployeeNotActiveError /
//     DocumentDatesInvalidError / IllegalTransitionError / RoleRequiredError -> 422;
//   - an unknown error -> 500 Problem, logged via deps.logger.error, never sent to the client;
//   - title = error.name.
//
// Fixture/RLS pattern: same admin-pool style as ./register-employee.test.ts, deliberately minimal
// (one employee, one document) since this file only exercises the API-mapping LAYER, not every
// business scenario (already covered by register-employee.test.ts). platform.audit_log is never
// deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createRegisterEmployeeDeps } from '../../api/register-employee/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — RegisterEmployeeDeps carries `logger: Logger`
// (../../application/register-employee/ports.ts), and createRegisterEmployeeDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger.
import type { Logger } from '../../application/register-employee/ports.js';

// The module under test — its error-mapping behaviour, per the api-layer contract above.
import {
  handleRegisterEmployee,
  handleRecordEmployeeDocument,
  handleChangeEmployeeStatus,
  handleCheckDriverAssignable,
  type ApiRequest,
} from '../../api/register-employee/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000303c1';
const HR_MGR_ROLE_CODE = 'HR_MGR';
const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(3031);
const deps = createRegisterEmployeeDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let draftEmployeeId: string;
let draftEmployeeVersion: number;
const extraEmployeeIds: string[] = [];
let codeCounter = 0;

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

function uniqueCode(): string {
  codeCounter += 1;
  return `PG-${(2000 + codeCounter).toString().padStart(4, '0').slice(-4)}`;
}

function todayIso(): string {
  return clock.now().toISOString().slice(0, 10);
}

/** A fresh draft employee, independent of the shared `draftEmployeeId` fixture. */
async function insertFreshEmployee(): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, employment_type, status)
     values ($1, $2, $3, $4, 'full_time', 'active') returning id, version`,
    [entityId, uniqueCode(), 'سائق اختبار معالجات', todayIso()],
  );
  const row = result.rows[0] as { id: string; version: number };
  extraEmployeeIds.push(row.id);
  return row;
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

  const employeeResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, employment_type, status)
     values ($1, $2, $3, $4, 'full_time', 'active') returning id, version`,
    [entityId, uniqueCode(), 'سائق اختبار معالجات', todayIso()],
  );
  draftEmployeeId = (employeeResult.rows[0] as { id: string; version: number }).id;
  draftEmployeeVersion = (employeeResult.rows[0] as { id: string; version: number }).version;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
    FIXTURE_ACTOR_UUID,
    `_registeremp_handlers_actor_${randomUUID()}@test.invalid`,
    'ممثل اختبار معالجات تسجيل الموظفين',
  ]);
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [FIXTURE_ACTOR_UUID, entityId]);
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    HR_MGR_ROLE_CODE,
  ]);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);
});

afterAll(async () => {
  const allIds = [draftEmployeeId, ...extraEmployeeIds].filter(Boolean);
  if (allIds.length > 0) {
    await pool.query(`delete from hr.employee_documents where employee_id = any($1::uuid[])`, [allIds]);
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [allIds]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleRegisterEmployee: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const result = await handleRegisterEmployee(
      requestWithoutKey({ code: uniqueCode(), nameAr: 'x', hireDate: todayIso(), employmentType: 'full_time', correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleRegisterEmployee: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleRegisterEmployee(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleRegisterEmployee: a code outside PG-#### -> 400 (scenario: "A code outside PG-#### is rejected at the contract")', async () => {
    const result = await handleRegisterEmployee(
      requestWithKey({ code: 'X-1', nameAr: 'x', hireDate: todayIso(), employmentType: 'full_time', correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('EmployeeCodeTakenError maps to 409, title = error.name', () => {
  it('handleRegisterEmployee: a duplicate code -> 409, title "EmployeeCodeTakenError"', async () => {
    const code = uniqueCode();
    const first = await handleRegisterEmployee(
      requestWithKey({ code, nameAr: 'x', hireDate: todayIso(), employmentType: 'full_time', correlationId: randomUUID() }),
    deps,
    );
    expect(first.status).toBe(200);
    if (first.status === 200) extraEmployeeIds.push((first.body as { id: string }).id);

    const second = await handleRegisterEmployee(
      requestWithKey({ code, nameAr: 'y', hireDate: todayIso(), employmentType: 'full_time', correlationId: randomUUID() }),
      deps,
    );
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ title: 'EmployeeCodeTakenError' });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleRecordEmployeeDocument: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const result = await handleRecordEmployeeDocument(
      requestWithKey({
        employeeId: draftEmployeeId,
        docType: 'residency',
        expiryDate: '2099-01-01',
        expectedVersion: draftEmployeeVersion + 999,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('IllegalTransitionError maps to 422, title = error.name', () => {
  it('handleChangeEmployeeStatus: on_leave -> suspended -> 422, title "IllegalTransitionError"', async () => {
    const employee = await insertFreshEmployee();
    const toOnLeave = await handleChangeEmployeeStatus(
      requestWithKey({ employeeId: employee.id, newStatus: 'on_leave', expectedVersion: employee.version, correlationId: randomUUID() }),
      deps,
    );
    expect(toOnLeave.status).toBe(200);
    const bumpedVersion = (toOnLeave.body as { version: number }).version;

    const result = await handleChangeEmployeeStatus(
      requestWithKey({ employeeId: employee.id, newStatus: 'suspended', expectedVersion: bumpedVersion, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });
});

describe('DriverDocumentMissingError maps to 422, title = error.name', () => {
  it('handleCheckDriverAssignable against an employee with no residency document -> 422', async () => {
    const employee = await insertFreshEmployee();
    const result = await handleCheckDriverAssignable(
      requestWithoutKey({ employeeId: employee.id, purpose: 'task', correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'DriverDocumentMissingError' });
  });
});

describe('CheckDriverAssignable requires no Idempotency-Key (read-only, brief D1)', () => {
  it('handleCheckDriverAssignable: no Idempotency-Key header -> still runs (never a 400 for the missing header)', async () => {
    const employee = await insertFreshEmployee();
    const result = await handleCheckDriverAssignable(
      requestWithoutKey({ employeeId: employee.id, purpose: 'task', correlationId: randomUUID() }),
      deps,
    );
    // whatever the business outcome (this employee has no documents -> 422), it must not be the
    // 400 "Idempotency-Key required" Problem a write handler returns.
    expect(result.status).not.toBe(400);
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleRegisterEmployee: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const depsWithSpyLogger = createRegisterEmployeeDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...(depsWithSpyLogger as unknown as { repo: Record<string, unknown> }).repo,
        insertEmployee: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleRegisterEmployee(
      requestWithKey({ code: uniqueCode(), nameAr: 'x', hireDate: todayIso(), employmentType: 'full_time', correlationId }),
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

// --- EntityScopeAmbiguousError maps to 422 -------------------------------------------------------

describe('EntityScopeAmbiguousError maps to 422, title = error.name', () => {
  const AMBIGUOUS_ACTOR_UUID = '00000000-0000-4000-8000-0000000303c2';

  afterEach(async () => {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [AMBIGUOUS_ACTOR_UUID]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [AMBIGUOUS_ACTOR_UUID]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [AMBIGUOUS_ACTOR_UUID]);
    await pool.query(`delete from identity.users where id = $1`, [AMBIGUOUS_ACTOR_UUID]);
  });

  it('handleRegisterEmployee: a caller (HR_MGR) scoped to two entities -> 422, title "EntityScopeAmbiguousError"', async () => {
    await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
      AMBIGUOUS_ACTOR_UUID,
      `_registeremp_handlers_ambiguous_${randomUUID()}@test.invalid`,
      'ممثل اختبار معالجات — نطاق كيانين',
    ]);
    const twoEntities: QueryResult<{ id: string }> = await pool.query(
      `select id from platform.entities where code in ('PCC', 'PDL') order by code`,
    );
    expect(twoEntities.rows).toHaveLength(2);
    for (const row of twoEntities.rows) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
        AMBIGUOUS_ACTOR_UUID,
        row.id,
      ]);
    }
    const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
      HR_MGR_ROLE_CODE,
    ]);
    await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
      AMBIGUOUS_ACTOR_UUID,
      (roleResult.rows[0] as { id: string }).id,
    ]);
    const ambiguousCtx = { userId: AMBIGUOUS_ACTOR_UUID, clientId: null, isInternal: true };

    const result = await handleRegisterEmployee(
      {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: { code: uniqueCode(), nameAr: 'x', hireDate: todayIso(), employmentType: 'full_time', correlationId: randomUUID() },
        ctx: ambiguousCtx,
      },
      deps,
    );
    // if the handler ever returned 200 for an ambiguous caller, the written row would still need
    // cleanup so this test leaves no orphaned hr.employees row behind.
    if (result.status === 200) extraEmployeeIds.push((result.body as { id: string }).id);

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'EntityScopeAmbiguousError' });
  });
});

// --- createRegisterEmployeeDeps({ clock, ids, logger }) --------------------------------------------

describe('createRegisterEmployeeDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createRegisterEmployeeDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createRegisterEmployeeDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
