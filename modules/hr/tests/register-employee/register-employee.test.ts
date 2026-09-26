// modules/hr/tests/register-employee/register-employee.test.ts — WBS 3.3.
//
// Integration tests, one per scenario in ./register-employee.feature, against the real database as
// pgeos_app. Sources: docs/notes/slice-briefs/_slice-3.3.brief.md, .claude/briefs/hr.brief.md.
//
// This suite imports application/register-employee/index.js,
// domain/register-employee/{errors,machine,invariants}.js, api/register-employee/composition.js,
// @pg-eos/contracts/hr/register-employee, and assumes hr.employees carries a
// `version int not null default 1` column (brief "Migration number: requested",
// database/migrations/NNNN_2_employees-version.sql). Every fixture helper below inserts/selects
// `version`.
//
// Expected application surface (brief's "Suggested" names, imported below):
//   registerEmployee(ctx, RegisterEmployeeInput, deps) -> { id, code, status: 'active', version }
//   recordEmployeeDocument(ctx, RecordEmployeeDocumentInput, deps) -> { id, employeeVersion }
//   changeEmployeeStatus(ctx, ChangeEmployeeStatusInput, deps) -> { status, version, endDate: string | null }
//   checkDriverAssignable(ctx, CheckDriverAssignableInput, deps) -> { assignable: true } (a
//     failure is always a typed throw, never `{ assignable: false }` — Contract section).
//
// RegisterEmployeeInput (camelCase, no entityId, no performedBy, no status — always 'active'):
//   { code, nameAr, nameEn?, civilId?, nationality?, passportNo?, jobTitleAr?, jobTitleEn?,
//     orgUnitId?, reportsTo?, employmentType? (default 'full_time'), hireDate, assignedClientId?,
//     phone?, email?, correlationId, idem? }
// RecordEmployeeDocumentInput:
//   { employeeId, docType, docNo?, issueDate?, expiryDate, fileUrl?, alertDaysBefore?,
//     expectedVersion, correlationId, idem? }
// ChangeEmployeeStatusInput: { employeeId, newStatus, expectedVersion, correlationId, idem? }
// CheckDriverAssignableInput: { employeeId, purpose: 'task' | 'vehicle', correlationId } (no idem
//   — read-only, brief D1).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as modules/wms/tests/receive-inbound/
// receive-inbound.test.ts. PG_APP_USER=pgeos_app is REQUIRED to run this suite (every command call
// goes through withContext(ctx, fn) as pgeos_app, genuinely subject to RLS).
// platform.audit_log rows are NEVER deleted.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test.
import {
  registerEmployee,
  recordEmployeeDocument,
  changeEmployeeStatus,
  checkDriverAssignable,
} from '../../application/register-employee/index.js';
import { createRegisterEmployeeDeps } from '../../api/register-employee/composition.js';
import {
  DocumentDatesInvalidError,
  DocumentTypeInvalidError,
  DriverDocumentExpiredError,
  DriverDocumentMissingError,
  EmployeeCodeFormatInvalidError,
  EmployeeCodeTakenError,
  EmployeeNotActiveError,
  EmployeeNotFoundError,
  // EntityScopeAmbiguousError — thrown when the caller is not scoped to exactly one entity (see
  // the "entity resolution fails closed" describe block below).
  EntityScopeAmbiguousError,
  IllegalTransitionError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/register-employee/errors.js';
// the package subpath export (@pg-eos/contracts/hr/register-employee), not a deep relative path.
import { RegisterEmployeeInputSchema } from '@pg-eos/contracts/hr/register-employee';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// --- literals ------------------------------------------------------------------------------------

const HR_MGR_ROLE_CODE = 'HR_MGR';
const PRO_ROLE_CODE = 'PRO';
const DEL_MGR_ROLE_CODE = 'DEL_MGR';
const WH_MGR_ROLE_CODE = 'WH_MGR'; // deliberately NOT a role this use case gates on (Role-gates scenario).

const EMPLOYEE_REGISTERED_EVENT_TYPE = 'hr.employee.registered';
const DOCUMENT_RECORDED_EVENT_TYPE = 'hr.employee_document.recorded';

const DOC_TYPE_RESIDENCY = 'residency';
const DOC_TYPE_LICENSE = 'license';

const HR_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000000303a1';
const PRO_ACTOR_UUID = '00000000-0000-4000-8000-0000000303a2';
const DEL_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000000303a3';
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000303a4';

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(303);
const deps = createRegisterEmployeeDeps({ clock, ids });

const hrMgrCtx = { userId: HR_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const proCtx = { userId: PRO_ACTOR_UUID, clientId: null, isInternal: true };
const delMgrCtx = { userId: DEL_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
const fixtureEmployeeIds: string[] = [];
const usedCorrelationIds = new Set<string>();
let codeCounter = 0;

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

/** ISO YYYY-MM-DD, `offsetDays` from the fixed clock's own date (negative -> past). */
function dateOffset(offsetDays: number): string {
  const base = clock.now();
  const shifted = new Date(base.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

const TODAY = dateOffset(0);
const YESTERDAY = dateOffset(-1);

/** PG-#### per the contract's regex — sequential per test run, so no two fixtures collide. */
function uniqueCode(): string {
  codeCounter += 1;
  return `PG-${(1000 + codeCounter).toString().padStart(4, '0').slice(-4)}`;
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    roleCode,
  ]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleId]);
}

async function createFixtureActor(userId: string): Promise<void> {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
    userId,
    `_registeremp_fixture_${userId}_${randomUUID()}@test.invalid`,
    'ممثل اختبار تسجيل الموظفين — WBS 3.3',
  ]);
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, entityId]);
}

/** admin-pool direct insert of an hr.employees row, bypassing the command under test — used ONLY
 *  to set up a fixture employee for a scenario that starts mid-flow (e.g. an already-registered
 *  driver). Selects `version` (hr.employees.version — see file header). */
async function insertEmployeeDirect(code: string, status = 'active'): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, employment_type, status)
     values ($1, $2, $3, $4, 'full_time', $5) returning id, version`,
    [entityId, code, 'سائق اختبار WBS 3.3', TODAY, status],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture hr.employees insert returned no row');
  fixtureEmployeeIds.push(row.id);
  return row;
}

async function insertDocumentDirect(employeeId: string, docType: string, expiryDate: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employee_documents (employee_id, doc_type, expiry_date) values ($1, $2, $3) returning id`,
    [employeeId, docType, expiryDate],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture hr.employee_documents insert returned no row');
  return row.id;
}

async function getEmployee(id: string): Promise<{ status: string; version: number; end_date: string | null }> {
  const result: QueryResult<{ status: string; version: number; end_date: string | null }> = await pool.query(
    `select status, version, end_date::text as end_date from hr.employees where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no hr.employees row for id ${id}`);
  return row;
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

async function employeeCountForCode(code: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(`select count(*)::text as n from hr.employees where code = $1`, [
    code,
  ]);
  return Number(result.rows[0]?.n ?? '0');
}

async function documentCountForEmployee(employeeId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from hr.employee_documents where employee_id = $1`,
    [employeeId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
    'PST',
  ]);
  entityId = (entityResult.rows[0] as { id: string }).id;

  await createFixtureActor(HR_MGR_ACTOR_UUID);
  await createFixtureActor(PRO_ACTOR_UUID);
  await createFixtureActor(DEL_MGR_ACTOR_UUID);
  await createFixtureActor(NO_ROLE_ACTOR_UUID);

  await grantRole(HR_MGR_ACTOR_UUID, HR_MGR_ROLE_CODE);
  await grantRole(PRO_ACTOR_UUID, PRO_ROLE_CODE);
  await grantRole(DEL_MGR_ACTOR_UUID, DEL_MGR_ROLE_CODE);
  await grantRole(NO_ROLE_ACTOR_UUID, WH_MGR_ROLE_CODE); // holds a role, just not one this slice gates on.
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.employee_documents where employee_id = any($1::uuid[])`, [fixtureEmployeeIds]);
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  for (const userId of [HR_MGR_ACTOR_UUID, PRO_ACTOR_UUID, DEL_MGR_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/hr/register-employee — code must match ^PG-\\d{4}$', () => {
  it('rejects a code outside PG-#### at the contract boundary (scenario: "A code outside PG-#### is rejected at the contract")', () => {
    expect(() =>
      RegisterEmployeeInputSchema.parse({
        code: 'X-1',
        nameAr: 'اسم اختبار',
        hireDate: TODAY,
        employmentType: 'full_time',
        correlationId: randomUUID(),
      }),
    ).toThrow();
  });

  it('accepts a well-formed PG-#### code with no entityId/performedBy/status field', () => {
    const parsed = RegisterEmployeeInputSchema.parse({
      code: 'PG-9999',
      nameAr: 'اسم اختبار',
      hireDate: TODAY,
      employmentType: 'full_time',
      correlationId: randomUUID(),
    });
    expect(parsed.code).toBe('PG-9999');
    expect('entityId' in parsed).toBe(false);
    expect('performedBy' in parsed).toBe(false);
    expect('status' in parsed).toBe(false);
  });
});

// --- Scenario: Register a driver ------------------------------------------------------------

describe('Scenario: Register a driver', () => {
  it('creates one hr.employees row (status active, version 1, entity_id = ctx.entityId), one hr.employee.registered outbox row, and a matching audit_log row', async () => {
    const code = uniqueCode();
    const correlationId = nextCorrelationId();
    const result = await registerEmployee(
      hrMgrCtx,
      { code, nameAr: 'سائق واحد', hireDate: TODAY, employmentType: 'full_time', correlationId },
      deps,
    );
    fixtureEmployeeIds.push(result.id);

    expect(result.status).toBe('active');
    expect(result.version).toBe(1);

    const row = await getEmployee(result.id);
    expect(row.status).toBe('active');
    expect(row.version).toBe(1);

    const registeredRows = await outboxRowsForCorrelationAndType(correlationId, EMPLOYEE_REGISTERED_EVENT_TYPE);
    expect(registeredRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBeGreaterThan(0);
  });
});

// --- Scenario: A duplicate employee code is rejected ------------------------------------------

describe('Scenario: A duplicate employee code is rejected', () => {
  it('EmployeeCodeTakenError (409), no second row written', async () => {
    const code = uniqueCode();
    const first = await registerEmployee(
      hrMgrCtx,
      { code, nameAr: 'أ', hireDate: TODAY, employmentType: 'full_time', correlationId: nextCorrelationId() },
      deps,
    );
    fixtureEmployeeIds.push(first.id);

    await expect(
      registerEmployee(
        hrMgrCtx,
        { code, nameAr: 'ب', hireDate: TODAY, employmentType: 'full_time', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(EmployeeCodeTakenError);

    expect(await employeeCountForCode(code)).toBe(1);
  });
});

// --- Scenario: A code outside PG-#### is rejected by the domain layer (SCR-HR-EMP-01) -----------
//
// The contract (RegisterEmployeeInputSchema) already blocks this at the boundary (see the
// "@pg-eos/contracts/hr/register-employee" describe block above) — this test calls the application
// command DIRECTLY, bypassing Zod, the same technique as "Scenario: issue_date after expiry_date is
// rejected" below, to prove modules/hr/application/register-employee/register-employee.ts's own
// `assertEmployeeCodeFormat(input.code)` wiring line is a genuine second line of defence, not dead
// code shadowed by the contract.

describe('Scenario: A code outside PG-#### is rejected by the domain layer (SCR-HR-EMP-01)', () => {
  it('EmployeeCodeFormatInvalidError (422), nothing written', async () => {
    const badCode = 'PG-12'; // Zod-shaped input otherwise; only `code` violates ^PG-[0-9]{4}$.

    await expect(
      registerEmployee(
        hrMgrCtx,
        { code: badCode, nameAr: 'اختبار تنسيق الكود', hireDate: TODAY, employmentType: 'full_time', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(EmployeeCodeFormatInvalidError);

    expect(await employeeCountForCode(badCode)).toBe(0);
  });
});

// --- Scenario: Record a residency document ------------------------------------------------------

describe('Scenario: Record a residency document', () => {
  it('creates one hr.employee_documents row, bumps hr.employees.version to 2, and writes exactly one hr.employee_document.recorded outbox + audit row', async () => {
    const employee = await registerEmployee(
      hrMgrCtx,
      { code: uniqueCode(), nameAr: 'سائق', hireDate: TODAY, employmentType: 'full_time', correlationId: nextCorrelationId() },
      deps,
    );
    fixtureEmployeeIds.push(employee.id);

    const correlationId = nextCorrelationId();
    const result = await recordEmployeeDocument(
      proCtx,
      { employeeId: employee.id, docType: DOC_TYPE_RESIDENCY, expiryDate: dateOffset(400), expectedVersion: 1, correlationId },
      deps,
    );
    expect(result.employeeVersion).toBe(2);
    expect((await getEmployee(employee.id)).version).toBe(2);
    expect(await documentCountForEmployee(employee.id)).toBe(1);

    const recordedRows = await outboxRowsForCorrelationAndType(correlationId, DOCUMENT_RECORDED_EVENT_TYPE);
    expect(recordedRows).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBeGreaterThan(0);
  });
});

// --- Scenario: A stale expectedVersion is rejected ----------------------------------------------

describe('Scenario: A stale expectedVersion is rejected', () => {
  it('StaleVersionError (409), no document row written', async () => {
    const employee = await registerEmployee(
      hrMgrCtx,
      { code: uniqueCode(), nameAr: 'سائق', hireDate: TODAY, employmentType: 'full_time', correlationId: nextCorrelationId() },
      deps,
    );
    fixtureEmployeeIds.push(employee.id);
    await recordEmployeeDocument(
      proCtx,
      { employeeId: employee.id, docType: DOC_TYPE_RESIDENCY, expiryDate: dateOffset(400), expectedVersion: 1, correlationId: nextCorrelationId() },
      deps,
    ); // employee now at version 2.

    await expect(
      recordEmployeeDocument(
        proCtx,
        { employeeId: employee.id, docType: DOC_TYPE_LICENSE, expiryDate: dateOffset(400), expectedVersion: 1, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(StaleVersionError);

    expect(await documentCountForEmployee(employee.id)).toBe(1);
  });
});

// --- Scenario: issue_date after expiry_date is rejected -------------------------------------------

describe('Scenario: issue_date after expiry_date is rejected', () => {
  it('DocumentDatesInvalidError (422), nothing written', async () => {
    const employee = await registerEmployee(
      hrMgrCtx,
      { code: uniqueCode(), nameAr: 'سائق', hireDate: TODAY, employmentType: 'full_time', correlationId: nextCorrelationId() },
      deps,
    );
    fixtureEmployeeIds.push(employee.id);

    await expect(
      recordEmployeeDocument(
        proCtx,
        {
          employeeId: employee.id,
          docType: DOC_TYPE_RESIDENCY,
          issueDate: dateOffset(10),
          expiryDate: dateOffset(5), // BEFORE issueDate.
          expectedVersion: 1,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(DocumentDatesInvalidError);

    expect(await documentCountForEmployee(employee.id)).toBe(0);
  });
});

// --- Scenario: A doc_type outside the 5 documented values is rejected by the domain layer
// (SCR-HR-EMP-01) -----------------------------------------------------------------------------
//
// The contract (RecordEmployeeDocumentInputSchema) already blocks this at the boundary — this test
// calls the application command DIRECTLY, bypassing Zod, same technique as the scenario above, to
// prove modules/hr/application/register-employee/record-employee-document.ts's own
// `assertDocTypeAllowed(input.docType)` wiring line is a genuine second line of defence.

describe('Scenario: A doc_type outside the 5 documented values is rejected by the domain layer (SCR-HR-EMP-01)', () => {
  it('DocumentTypeInvalidError (422), nothing written', async () => {
    const employee = await registerEmployee(
      hrMgrCtx,
      { code: uniqueCode(), nameAr: 'سائق', hireDate: TODAY, employmentType: 'full_time', correlationId: nextCorrelationId() },
      deps,
    );
    fixtureEmployeeIds.push(employee.id);

    await expect(
      recordEmployeeDocument(
        proCtx,
        {
          employeeId: employee.id,
          docType: 'visa', // outside the 5 documented values.
          expiryDate: dateOffset(400),
          expectedVersion: 1,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(DocumentTypeInvalidError);

    expect(await documentCountForEmployee(employee.id)).toBe(0);
  });
});

// --- Scenario: Expired residency blocks task assignment (the acceptance criterion) ---------------

describe('Scenario: Expired residency blocks task assignment (the acceptance criterion, doc 40 INV-C4-1)', () => {
  it('DriverDocumentExpiredError (422) naming doc_type "residency"', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());
    await insertDocumentDirect(employee.id, DOC_TYPE_RESIDENCY, YESTERDAY);
    await insertDocumentDirect(employee.id, DOC_TYPE_LICENSE, dateOffset(300));

    const error: unknown = await checkDriverAssignable(
      delMgrCtx,
      { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() },
      deps,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DriverDocumentExpiredError);
    expect((error as Error).message).toMatch(new RegExp(DOC_TYPE_RESIDENCY));
  });
});

// --- Scenario: Expired licence blocks vehicle assignment but not task assignment -----------------

describe('Scenario: Expired licence blocks vehicle assignment but not task assignment', () => {
  it('DriverDocumentExpiredError naming "license" for purpose vehicle; assignable=true for purpose task', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());
    await insertDocumentDirect(employee.id, DOC_TYPE_RESIDENCY, dateOffset(300));
    await insertDocumentDirect(employee.id, DOC_TYPE_LICENSE, YESTERDAY);

    const vehicleError: unknown = await checkDriverAssignable(
      delMgrCtx,
      { employeeId: employee.id, purpose: 'vehicle', correlationId: nextCorrelationId() },
      deps,
    ).catch((e: unknown) => e);
    expect(vehicleError).toBeInstanceOf(DriverDocumentExpiredError);
    expect((vehicleError as Error).message).toMatch(new RegExp(DOC_TYPE_LICENSE));

    const taskResult = await checkDriverAssignable(
      delMgrCtx,
      { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() },
      deps,
    );
    expect(taskResult.assignable).toBe(true);
  });
});

// --- Scenario: A document expiring today is still valid -------------------------------------------

describe('Scenario: A document expiring today is still valid', () => {
  it('assignable = true when residency.expiryDate === today', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());
    await insertDocumentDirect(employee.id, DOC_TYPE_RESIDENCY, TODAY);

    const result = await checkDriverAssignable(
      delMgrCtx,
      { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.assignable).toBe(true);
  });
});

// --- Scenario: A renewal supersedes the expired document -------------------------------------------

describe('Scenario: A renewal supersedes the expired document', () => {
  it('a new residency row with a later expiryDate makes the driver assignable again', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());
    await insertDocumentDirect(employee.id, DOC_TYPE_RESIDENCY, YESTERDAY);

    await recordEmployeeDocument(
      proCtx,
      { employeeId: employee.id, docType: DOC_TYPE_RESIDENCY, expiryDate: dateOffset(400), expectedVersion: employee.version, correlationId: nextCorrelationId() },
      deps,
    );

    const result = await checkDriverAssignable(
      delMgrCtx,
      { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.assignable).toBe(true);
    expect(await documentCountForEmployee(employee.id)).toBe(2); // history kept (brief D3), not overwritten.
  });
});

// --- Scenario: A missing required document blocks assignment -----------------------------------

describe('Scenario: A missing required document blocks assignment', () => {
  it('DriverDocumentMissingError (422) naming doc_type "residency"', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());

    const error: unknown = await checkDriverAssignable(
      delMgrCtx,
      { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() },
      deps,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DriverDocumentMissingError);
    expect((error as Error).message).toMatch(new RegExp(DOC_TYPE_RESIDENCY));
  });
});

// --- Scenario: A non-active employee is never assignable -----------------------------------------

describe('Scenario: A non-active employee is never assignable', () => {
  it('EmployeeNotActiveError (422) after ChangeEmployeeStatus moves the employee to "suspended"', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());
    await insertDocumentDirect(employee.id, DOC_TYPE_RESIDENCY, dateOffset(300));

    await changeEmployeeStatus(
      hrMgrCtx,
      { employeeId: employee.id, newStatus: 'suspended', expectedVersion: employee.version, correlationId: nextCorrelationId() },
      deps,
    );

    await expect(
      checkDriverAssignable(delMgrCtx, { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(EmployeeNotActiveError);
  });
});

// --- Scenario: Status machine edges -----------------------------------------------------------

describe('Scenario: Status machine edges', () => {
  it('active -> on_leave -> active succeeds, each call bumping version; -> terminated sets end_date=today and is terminal; on_leave -> suspended is IllegalTransitionError', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());

    const toOnLeave = await changeEmployeeStatus(
      hrMgrCtx,
      { employeeId: employee.id, newStatus: 'on_leave', expectedVersion: employee.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(toOnLeave.status).toBe('on_leave');
    expect(toOnLeave.version).toBe(employee.version + 1);

    const backToActive = await changeEmployeeStatus(
      hrMgrCtx,
      { employeeId: employee.id, newStatus: 'active', expectedVersion: toOnLeave.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(backToActive.status).toBe('active');
    expect(backToActive.version).toBe(toOnLeave.version + 1);

    const terminated = await changeEmployeeStatus(
      hrMgrCtx,
      { employeeId: employee.id, newStatus: 'terminated', expectedVersion: backToActive.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(terminated.status).toBe('terminated');
    expect(terminated.endDate).toBe(TODAY);

    await expect(
      changeEmployeeStatus(
        hrMgrCtx,
        { employeeId: employee.id, newStatus: 'active', expectedVersion: terminated.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('on_leave -> suspended is IllegalTransitionError (must pass through active)', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());
    const onLeave = await changeEmployeeStatus(
      hrMgrCtx,
      { employeeId: employee.id, newStatus: 'on_leave', expectedVersion: employee.version, correlationId: nextCorrelationId() },
      deps,
    );

    await expect(
      changeEmployeeStatus(
        hrMgrCtx,
        { employeeId: employee.id, newStatus: 'suspended', expectedVersion: onLeave.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

// --- Scenario: Role gates -------------------------------------------------------------------------

describe('Scenario: Role gates', () => {
  it('RegisterEmployee, RecordEmployeeDocument, ChangeEmployeeStatus, CheckDriverAssignable each throw RoleRequiredError for a caller holding only WH_MGR', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());
    await insertDocumentDirect(employee.id, DOC_TYPE_RESIDENCY, dateOffset(300));
    const freshCode = uniqueCode();

    await expect(
      registerEmployee(noRoleCtx, { code: freshCode, nameAr: 'x', hireDate: TODAY, employmentType: 'full_time', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    await expect(
      recordEmployeeDocument(
        noRoleCtx,
        { employeeId: employee.id, docType: DOC_TYPE_LICENSE, expiryDate: dateOffset(300), expectedVersion: employee.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    await expect(
      changeEmployeeStatus(
        noRoleCtx,
        { employeeId: employee.id, newStatus: 'suspended', expectedVersion: employee.version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    await expect(
      checkDriverAssignable(noRoleCtx, { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    expect(await documentCountForEmployee(employee.id)).toBe(1); // still just the fixture row.
    expect((await getEmployee(employee.id)).status).toBe('active'); // unchanged.
    expect(await employeeCountForCode(freshCode)).toBe(0); // RegisterEmployee wrote nothing.
  });
});

// --- Scenario: Idempotent replay -----------------------------------------------------------------

describe('Scenario: Idempotent replay', () => {
  it('RegisterEmployee twice with the same Idempotency-Key and body: one row exists, second call returns the first result; a different body with the same key -> IdempotencyConflictError', async () => {
    const idempotencyKey = randomUUID();
    const code = uniqueCode();
    const body = { code, nameAr: 'سائق', hireDate: TODAY, employmentType: 'full_time' as const, correlationId: nextCorrelationId() };
    const idem: IdempotencyInput = {
      key: idempotencyKey,
      endpoint: 'hr.register-employee.register-employee',
      requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      entityId: null,
      successStatus: 200,
    };

    const first = await registerEmployee(hrMgrCtx, { ...body, idem }, deps);
    fixtureEmployeeIds.push(first.id);
    const second = await registerEmployee(hrMgrCtx, { ...body, idem }, deps);
    expect(second).toEqual(first);
    expect(await employeeCountForCode(code)).toBe(1);

    const differentBody = { ...body, code: uniqueCode() };
    const differentIdem: IdempotencyInput = {
      ...idem,
      requestHash: createHash('sha256').update(JSON.stringify(differentBody)).digest('hex'),
    };
    await expect(
      registerEmployee(hrMgrCtx, { ...differentBody, idem: differentIdem }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- Business "today" is Asia/Kuwait, not UTC ----------------------------------------------------
//
// database/schema/01-Data-Model.sql:8 — timestamptz is stored UTC, displayed Asia/Kuwait. "today" is
// computed via businessDateOf, in Asia/Kuwait. Kuwait is UTC+3, no DST — 22:30 UTC on 2026-09-24 is
// already 01:30 Kuwait time on 2026-09-25.

describe('the business "today" is Asia/Kuwait, not UTC', () => {
  // 22:30 UTC 2026-09-24 == 01:30 Kuwait 2026-09-25 (business date "2026-09-25").
  const kuwaitClock = new FixedClock(new Date('2026-09-24T22:30:00Z'));
  const kuwaitDeps = createRegisterEmployeeDeps({ clock: kuwaitClock, ids });

  it('CheckDriverAssignable purpose "task": a residency document expiring 2026-09-24 is EXPIRED at 22:30 UTC (01:30 Kuwait next day) -> DriverDocumentExpiredError naming "residency"', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());
    await insertDocumentDirect(employee.id, DOC_TYPE_RESIDENCY, '2026-09-24');

    const error: unknown = await checkDriverAssignable(
      delMgrCtx,
      { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() },
      kuwaitDeps,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DriverDocumentExpiredError);
    expect((error as Error).message).toMatch(new RegExp(DOC_TYPE_RESIDENCY));
  });

  it('ChangeEmployeeStatus -> terminated at 22:30 UTC on 2026-09-24 writes end_date = "2026-09-25" (Kuwait business date), not "2026-09-24" (UTC date)', async () => {
    const employee = await insertEmployeeDirect(uniqueCode());

    const terminated = await changeEmployeeStatus(
      hrMgrCtx,
      { employeeId: employee.id, newStatus: 'terminated', expectedVersion: employee.version, correlationId: nextCorrelationId() },
      kuwaitDeps,
    );

    expect(terminated.endDate).toBe('2026-09-25');
    expect((await getEmployee(employee.id)).end_date).toBe('2026-09-25');
  });
});

// --- Entity resolution fails closed ----------------------------------------------------------
//
// infrastructure/register-employee/repository.ts's resolveCallerEntityId requires
// cardinality(platform.allowed_entities()) = 1 -> use it; otherwise throw
// EntityScopeAmbiguousError. database/schema/01-Data-Model.sql:1563-1571 seeds five entities: PGH,
// PCC, PST, PDL, POR.

describe('EntityScopeAmbiguousError: a caller not scoped to exactly one entity is refused, never defaulted', () => {
  const TWO_ENTITY_ACTOR_UUID = '00000000-0000-4000-8000-0000000303b1';
  const ZERO_ENTITY_ACTOR_UUID = '00000000-0000-4000-8000-0000000303b2';

  afterEach(async () => {
    for (const userId of [TWO_ENTITY_ACTOR_UUID, ZERO_ENTITY_ACTOR_UUID]) {
      await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
      await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
      await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
      await pool.query(`delete from identity.users where id = $1`, [userId]);
    }
  });

  it('RegisterEmployee: a caller (HR_MGR) scoped to TWO entities (PCC, PDL) throws EntityScopeAmbiguousError; no hr.employees row, no outbox row written', async () => {
    await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
      TWO_ENTITY_ACTOR_UUID,
      `_registeremp_fixture_${TWO_ENTITY_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل اختبار — نطاق كيانين',
    ]);
    const twoEntities: QueryResult<{ id: string }> = await pool.query(
      `select id from platform.entities where code in ('PCC', 'PDL') order by code`,
    );
    expect(twoEntities.rows).toHaveLength(2);
    for (const row of twoEntities.rows) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
        TWO_ENTITY_ACTOR_UUID,
        row.id,
      ]);
    }
    await grantRole(TWO_ENTITY_ACTOR_UUID, HR_MGR_ROLE_CODE);
    const twoEntityCtx = { userId: TWO_ENTITY_ACTOR_UUID, clientId: null, isInternal: true };

    const code = uniqueCode();
    const correlationId = nextCorrelationId();
    // .catch, not .rejects — resolveCallerEntityId must throw here; any row written before the
    // throw is cleaned up via fixtureEmployeeIds so the fixture leaves no orphan.
    const outcome: unknown = await registerEmployee(
      twoEntityCtx,
      { code, nameAr: 'x', hireDate: TODAY, employmentType: 'full_time', correlationId },
      deps,
    ).catch((e: unknown) => e);
    if (outcome !== null && typeof outcome === 'object' && 'id' in outcome) {
      fixtureEmployeeIds.push((outcome as { id: string }).id);
    }

    expect(outcome).toBeInstanceOf(EntityScopeAmbiguousError);
    expect(await employeeCountForCode(code)).toBe(0);
    expect(await outboxRowsForCorrelationAndType(correlationId, EMPLOYEE_REGISTERED_EVENT_TYPE)).toHaveLength(0);
  });

  it('RegisterEmployee: a caller (HR_MGR) scoped to ZERO entities throws EntityScopeAmbiguousError; nothing written', async () => {
    await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
      ZERO_ENTITY_ACTOR_UUID,
      `_registeremp_fixture_${ZERO_ENTITY_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل اختبار — بلا نطاق كيان',
    ]);
    await grantRole(ZERO_ENTITY_ACTOR_UUID, HR_MGR_ROLE_CODE);
    const zeroEntityCtx = { userId: ZERO_ENTITY_ACTOR_UUID, clientId: null, isInternal: true };

    const code = uniqueCode();
    const correlationId = nextCorrelationId();
    await expect(
      registerEmployee(
        zeroEntityCtx,
        { code, nameAr: 'x', hireDate: TODAY, employmentType: 'full_time', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(EntityScopeAmbiguousError);

    expect(await employeeCountForCode(code)).toBe(0);
  });
});

describe('cross-entity read is hidden by RLS (an employee outside the caller entity is EmployeeNotFoundError, not visible data)', () => {
  const OTHER_ENTITY_ACTOR_UUID = '00000000-0000-4000-8000-0000000303b3';

  afterEach(async () => {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [OTHER_ENTITY_ACTOR_UUID]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [OTHER_ENTITY_ACTOR_UUID]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [OTHER_ENTITY_ACTOR_UUID]);
    await pool.query(`delete from identity.users where id = $1`, [OTHER_ENTITY_ACTOR_UUID]);
  });

  it('RecordEmployeeDocument / CheckDriverAssignable against an employee registered under a different entity (PST) -> EmployeeNotFoundError for a caller scoped only to PCC', async () => {
    const employee = await insertEmployeeDirect(uniqueCode()); // entity A = the module-level `entityId` (PST).

    await pool.query(`insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`, [
      OTHER_ENTITY_ACTOR_UUID,
      `_registeremp_fixture_${OTHER_ENTITY_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل اختبار — كيان آخر',
    ]);
    const otherEntity: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
      'PCC',
    ]);
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
      OTHER_ENTITY_ACTOR_UUID,
      (otherEntity.rows[0] as { id: string }).id,
    ]);
    await grantRole(OTHER_ENTITY_ACTOR_UUID, PRO_ROLE_CODE);
    await grantRole(OTHER_ENTITY_ACTOR_UUID, DEL_MGR_ROLE_CODE);
    const otherEntityCtx = { userId: OTHER_ENTITY_ACTOR_UUID, clientId: null, isInternal: true };

    await expect(
      recordEmployeeDocument(
        otherEntityCtx,
        {
          employeeId: employee.id,
          docType: DOC_TYPE_RESIDENCY,
          expiryDate: dateOffset(300),
          expectedVersion: employee.version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(EmployeeNotFoundError);

    await expect(
      checkDriverAssignable(
        otherEntityCtx,
        { employeeId: employee.id, purpose: 'task', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(EmployeeNotFoundError);
  });
});
