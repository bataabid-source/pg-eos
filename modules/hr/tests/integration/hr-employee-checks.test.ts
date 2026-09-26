// modules/hr/tests/integration/hr-employee-checks.test.ts — Master task P6a (pg-tester), written
// RED-first against docs/notes/SCR-HR-EMP-01-employee-checks.md §1 table, ahead of Master migration
// 0029_M_hr-employee-checks.sql (approved under D-190, evaluation-session delegation; pre-migration
// review returned APPROVED WITH CHANGES). Lives in the owning module's test project, same precedent
// as modules/platform/tests/integration/schema-invariants.test.ts and
// modules/wms/tests/integration/sku-registration.test.ts (picked up by modules/hr/vitest.config.ts's
// `tests/**/*.test.ts` include, run via `pnpm --filter @pg-eos/hr test`).
//
// This proves the three invariants as DATABASE constraints (not the domain layer, which already
// enforces them — doc 36 §5-4 #2: assertDocumentDatesValid via
// modules/hr/tests/register-employee/register-employee.test.ts's "issue_date after expiry_date is
// rejected" scenario; assertDocTypeAllowed and assertEmployeeCodeFormat via
// modules/hr/tests/register-employee/employee-checks.property.test.ts). Connects via the ADMIN pool
// (superuser), on purpose: a superuser bypasses RLS entirely, so this suite is not distracted by
// row-level security and proves the CHECK constraint itself, exactly as SCR-HR-EMP-01 proposes it:
//   1. hr.employee_documents: issue_date <= expiry_date (constraint chk_employee_documents_dates)
//   2. hr.employee_documents.doc_type in {residency, passport, license, health_card, contract}
//      (constraint chk_employee_documents_doc_type)
//   3. hr.employees.code ~ '^PG-[0-9]{4}$' (constraint chk_employees_code_format)
//
// Migration 0029_M_hr-employee-checks.sql adds the three CHECK constraints above — confirmed applied
// on pgeos_p6 via `\d hr.employees` / `\d hr.employee_documents` (chk_employees_code_format,
// chk_employee_documents_dates, chk_employee_documents_doc_type all present). This file is now the
// permanent regression suite for the three constraints.
//
// D-183 (no DELETE/DROP/TRUNCATE on the shared DB outside afterAll for the suite's own fixtures):
// every accept/reject case below runs inside its own `BEGIN … ROLLBACK` on a dedicated pool client
// (pg-reviewer, pre-migration review round) — nothing this file inserts is ever committed, so there
// is no cleanup to do and no leftover row for another suite to trip over.
//
// Fixtures: minimum NOT NULL/FK columns read directly off database/schema/01-Data-Model.sql:
//   hr.employees:          entity_id (FK platform.entities, not null), code (not null, unique),
//                          name_ar (not null), hire_date (not null); status/employment_type have
//                          defaults.
//   hr.employee_documents: employee_id (FK hr.employees, not null), doc_type (not null),
//                          expiry_date (not null); issue_date is nullable; alert_days_before has a
//                          default.
// entity_id is looked up by code against the seeded platform.entities row (01-Data-Model.sql:1567,
// code 'PST') rather than hardcoded, since gen_random_uuid() gives a fresh id on every apply.sh run.
//
// hr.employees.code range: this suite owns PG-9xxx (Master's disjoint-range assignment, so parallel
// hr suites never collide on the unique index / 23505): register-employee PG-1xxx, its handlers
// PG-2xxx, maintain-shift PG-3xxx, maintain-shift handlers PG-4xxx, hr-employee-checks PG-9xxx. Since
// every insert here rolls back, this range is defence-in-depth (a bug that skips the ROLLBACK must
// still not collide with another suite's fixture codes), not strictly required for correctness.

import { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Same pool-construction convention as modules/hr/tests/register-employee/register-employee.test.ts
// and modules/hr/tests/maintain-shift/handlers.test.ts (PG* env vars, default database 'pgeos', max 20).
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// The five doc_type values SCR-HR-EMP-01 §1 row 2 names, copied verbatim from
// 01-Data-Model.sql:1303's column comment (never invented).
const VALID_DOC_TYPES = ['residency', 'passport', 'license', 'health_card', 'contract'] as const;

const CHECK_VIOLATION_SQLSTATE = '23514';

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

function asPgError(err: unknown): PgError {
  expect(err).toBeInstanceOf(Error);
  return err as PgError;
}

// PG-9xxx — this suite's own disjoint hr.employees.code range (see file header).
let employeeCodeCounter = 0;
function uniqueEmployeeCode(): string {
  employeeCodeCounter += 1;
  return `PG-${(9000 + employeeCodeCounter).toString().padStart(4, '0').slice(-4)}`;
}

let entityId: string;

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = 'PST'`,
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    throw new Error("fixture lookup failed: platform.entities row with code 'PST' not found (seed 01-Data-Model.sql:1567-1571 not applied?)");
  }
  entityId = entityRow.id;
});

afterAll(async () => {
  await pool.end();
});

// D-183: every case runs inside BEGIN … ROLLBACK on its own dedicated client — nothing committed,
// nothing to clean up. `fn` receives the transactional client and must issue all its own queries
// through it (not through the shared `pool`), so its writes are visible to itself but never persist.
async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    // Safe to call even after a failed statement aborted the transaction server-side — ROLLBACK is
    // exactly how a client recovers from an aborted transaction before release.
    await client.query('ROLLBACK').catch(() => {
      // ignore — the connection may already be closed/broken; client.release() below still runs.
    });
    client.release();
  }
}

async function insertEmployee(client: PoolClient): Promise<string> {
  const code = uniqueEmployeeCode();
  const result: QueryResult<{ id: string }> = await client.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date) values ($1, $2, $3, current_date) returning id`,
    [entityId, code, `موظف اختبار SCR-HR-EMP-01 — ${code}`],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture hr.employees insert returned no row');
  return row.id;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Invariant 1: hr.employee_documents.issue_date <= expiry_date (chk_employee_documents_dates)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('Invariant 1: hr.employee_documents issue_date <= expiry_date (chk_employee_documents_dates)', () => {
  it('issue_date > expiry_date is rejected with SQLSTATE 23514 and constraint chk_employee_documents_dates', async () => {
    await withRollback(async (client) => {
      const ownerId = await insertEmployee(client);
      try {
        await client.query(
          `insert into hr.employee_documents (employee_id, doc_type, issue_date, expiry_date) values ($1, 'contract', '2026-06-01', '2026-01-01')`,
          [ownerId],
        );
        throw new Error('expected insert to reject, but it succeeded');
      } catch (err) {
        const pgErr = asPgError(err);
        expect(pgErr.code).toBe(CHECK_VIOLATION_SQLSTATE);
        expect(pgErr.constraint).toBe('chk_employee_documents_dates');
      }
    });
  });

  it('issue_date = expiry_date is accepted', async () => {
    await withRollback(async (client) => {
      const ownerId = await insertEmployee(client);
      const result: QueryResult<{ id: string }> = await client.query(
        `insert into hr.employee_documents (employee_id, doc_type, issue_date, expiry_date) values ($1, 'contract', '2026-01-01', '2026-01-01') returning id`,
        [ownerId],
      );
      expect(result.rows[0]).toBeDefined();
    });
  });

  it('issue_date < expiry_date is accepted', async () => {
    await withRollback(async (client) => {
      const ownerId = await insertEmployee(client);
      const result: QueryResult<{ id: string }> = await client.query(
        `insert into hr.employee_documents (employee_id, doc_type, issue_date, expiry_date) values ($1, 'contract', '2026-01-01', '2026-06-01') returning id`,
        [ownerId],
      );
      expect(result.rows[0]).toBeDefined();
    });
  });

  it('issue_date NULL is accepted (the constraint is "issue_date is null or issue_date <= expiry_date")', async () => {
    await withRollback(async (client) => {
      const ownerId = await insertEmployee(client);
      const result: QueryResult<{ id: string }> = await client.query(
        `insert into hr.employee_documents (employee_id, doc_type, issue_date, expiry_date) values ($1, 'contract', null, '2026-06-01') returning id`,
        [ownerId],
      );
      expect(result.rows[0]).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Invariant 2: hr.employee_documents.doc_type in the five documented values
// (chk_employee_documents_doc_type)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('Invariant 2: hr.employee_documents.doc_type is one of the 5 documented values (chk_employee_documents_doc_type)', () => {
  it.each(VALID_DOC_TYPES)('doc_type = %s is accepted', async (docType) => {
    await withRollback(async (client) => {
      const ownerId = await insertEmployee(client);
      const result: QueryResult<{ id: string }> = await client.query(
        `insert into hr.employee_documents (employee_id, doc_type, expiry_date) values ($1, $2, current_date + 30) returning id`,
        [ownerId, docType],
      );
      expect(result.rows[0]).toBeDefined();
    });
  });

  it("doc_type outside the 5 documented values (e.g. 'visa') is rejected with SQLSTATE 23514 and constraint chk_employee_documents_doc_type", async () => {
    await withRollback(async (client) => {
      const ownerId = await insertEmployee(client);
      try {
        await client.query(
          `insert into hr.employee_documents (employee_id, doc_type, expiry_date) values ($1, 'visa', current_date + 30)`,
          [ownerId],
        );
        throw new Error('expected insert to reject, but it succeeded');
      } catch (err) {
        const pgErr = asPgError(err);
        expect(pgErr.code).toBe(CHECK_VIOLATION_SQLSTATE);
        expect(pgErr.constraint).toBe('chk_employee_documents_doc_type');
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Invariant 3: hr.employees.code matches ^PG-[0-9]{4}$ (chk_employees_code_format)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('Invariant 3: hr.employees.code matches ^PG-[0-9]{4}$ (chk_employees_code_format)', () => {
  // Exact literal values (no random suffix needed — each case runs inside its own rolled-back
  // transaction, D-183): too short, wrong case, too long, wrong prefix, prefix not anchored at
  // start, and Arabic-Indic digits (٠-٩) — the DB's `~ '^PG-[0-9]{4}$'` uses the ASCII character
  // class [0-9] under this database's C.UTF-8 ctype (database/schema/apply.sh createdb flags), so a
  // code using Arabic-Indic digit code points must NOT match.
  const invalidCodes = ['PG-12', 'pg-1234', 'PG-12345', 'X-1234', 'XPG-1234', 'PG-١٢٣٤'];

  it.each(invalidCodes)(
    "code = '%s' is rejected with SQLSTATE 23514 and constraint chk_employees_code_format",
    async (code) => {
      await withRollback(async (client) => {
        try {
          await client.query(
            `insert into hr.employees (entity_id, code, name_ar, hire_date) values ($1, $2, 'اختبار تنسيق الكود', current_date)`,
            [entityId, code],
          );
          throw new Error('expected insert to reject, but it succeeded');
        } catch (err) {
          const pgErr = asPgError(err);
          expect(pgErr.code).toBe(CHECK_VIOLATION_SQLSTATE);
          expect(pgErr.constraint).toBe('chk_employees_code_format');
        }
      });
    },
  );

  it('a well-formed PG-#### code is accepted', async () => {
    // PG-9xxx — this suite's own disjoint range (see file header), not the literal 'PG-0001' example
    // (that exact format is already proven by the property test in employee-checks.property.test.ts).
    await withRollback(async (client) => {
      const code = uniqueEmployeeCode();
      const result: QueryResult<{ id: string }> = await client.query(
        `insert into hr.employees (entity_id, code, name_ar, hire_date) values ($1, $2, 'اختبار تنسيق الكود المقبول', current_date) returning id`,
        [entityId, code],
      );
      expect(result.rows[0]).toBeDefined();
    });
  });
});
