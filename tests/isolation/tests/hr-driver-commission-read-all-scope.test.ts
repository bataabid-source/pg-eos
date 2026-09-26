// tests/isolation/tests/hr-driver-commission-read-all-scope.test.ts — WBS 3.13 part 4 (pg-tester).
//
// Migration 0033 (SCR-HR-COMM-01, D-190, docs/DECISION_LOG.md) split the pre-existing
// `hr.commission.read_all` permission into two GENUINELY SEPARATE ones, precisely because
// round-3's own pre-migration review (0033 header item (5)) found that seeding the OLD permission
// to DEL_SUP would have ALSO granted DEL_SUP visibility into `hr.sales_commission_events`
// (13B-Schema-Reference-Consolidation.sql:5124-5127's own `own_sales_commission` restrictive
// policy checks the SAME permission code) — sales reps' commission accrual data, unrelated to
// driver-commission disputes. The fix: a NEW `hr.driver_commission.read_all` permission gates
// `hr.commission_daily`'s own `own_commission` policy INSTEAD (migration 0033, lines 302-310);
// `hr.commission.read_all` and `hr.sales_commission_events`'s own policy are UNTOUCHED.
//
// This file proves that split held, with a REAL live query (not a mocked permission check, per the
// brief's own instruction): a DEL_SUP actor — who now holds `hr.driver_commission.read_all` — does
// NOT gain visibility into a genuinely-existing `hr.sales_commission_events` row through it, while
// a SALES_MGR actor holding the OLD, still-untouched `hr.commission.read_all` permission CAN see
// that same row (positive control — the zero-rows result for DEL_SUP is the permission boundary
// genuinely working, not the query/fixture being broken or empty by coincidence, same vacuity
// discipline as every other isolation-suite file in this directory).
//
// Placement: this proves a CROSS-TABLE, cross-permission-code separation, not the module's own
// command behaviour — the same class of proof as
// tests/isolation/tests/shipments-attributed-invoker-rls.test.ts (a cross-cutting RLS/permission
// property, not a use-case-scoped test), so it lives here rather than under
// modules/hr/tests/confirm-commission/ (that file's own two visibility/permission tests stay
// scoped to hr.commission_daily itself, this module's own table).
//
// Fixture/RLS pattern: a dedicated superuser admin `pg.Client` (bypasses RLS — fixture setup/
// teardown only) plus the `withAppRole` GUC-setting reproduction of withContext(ctx, fn) this
// directory's own shipments-attributed-invoker-rls.test.ts already uses (needed here for the same
// reason: proving a raw SELECT's own RLS visibility directly, not a command's end-to-end path).
// D-183: a DELETE against the shared database is only allowed in this suite's own `afterAll`.

import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PGHOST = process.env['PGHOST'] ?? 'localhost';
const PGPORT = process.env['PGPORT'] ?? '5432';
const PGDATABASE = process.env['PGDATABASE'] ?? 'pgeos';
const SUPERUSER = process.env['PGUSER'] ?? 'postgres';
const SUPERUSER_PASSWORD = process.env['PGPASSWORD'];
const APP_ROLE = process.env['PG_APP_USER'] ?? 'pgeos_app';

// named constants (per the Master's own instruction) — every assertion below reads a permission
// code through one of these, never a repeated literal string.
const DRIVER_COMMISSION_READ_ALL_PERMISSION_CODE = 'hr.driver_commission.read_all';
const SALES_COMMISSION_READ_ALL_PERMISSION_CODE = 'hr.commission.read_all';
const DEL_SUP_ROLE_CODE = 'DEL_SUP';
const SALES_MGR_ROLE_CODE = 'SALES_MGR';

const SUPERUSER_CONNECTION = {
  host: PGHOST,
  port: Number(PGPORT),
  user: SUPERUSER,
  password: SUPERUSER_PASSWORD,
  database: PGDATABASE,
};

// No password field — D-133: pgeos_app has no password, local pg_hba is `trust` (same idiom as
// every sibling isolation-suite file's own APP_ROLE_CONNECTION).
const APP_ROLE_CONNECTION = {
  host: PGHOST,
  port: Number(PGPORT),
  user: APP_ROLE,
  database: PGDATABASE,
};

function firstRow<T extends QueryResultRow>(result: QueryResult<T>, what: string): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`${what}: query returned no rows where at least one was expected`);
  }
  return row;
}

interface AppRoleCtx {
  readonly userId: string | null;
  readonly clientId: string | null;
  readonly isInternal: boolean;
}

/** Same reproduction of withContext(ctx, fn)'s own GUC-setting contract as this directory's own
 *  shipments-attributed-invoker-rls.test.ts and
 *  modules/hr/tests/calculate-daily-commission/calculate-daily-commission.test.ts's own
 *  withAppRole. */
async function withAppRole<T>(ctx: AppRoleCtx, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(APP_ROLE_CONNECTION);
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [ctx.userId]);
    await client.query("select set_config('app.client_id', $1, true)", [ctx.clientId]);
    await client.query("select set_config('app.is_internal', $1, true)", [ctx.isInternal ? 'true' : 'false']);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // original error still wins.
    }
    throw error;
  } finally {
    await client.end();
  }
}

const RUN_ID = randomUUID();
const DEL_SUP_ACTOR_UUID = '00000000-0000-4000-8000-0000003136a1';
const SALES_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000003136a2';

let admin: Client;
let entityId: string;
let employeeId: string;
let accountId: string;
let commissionRuleId: string;
let salesCommissionEventId: string;

async function resolveEntityId(client: Client, code: string): Promise<string> {
  const result = await client.query<{ id: string }>('select id from platform.entities where code = $1', [code]);
  return firstRow(result, `platform.entities lookup for code ${code}`).id;
}

async function grantRole(client: Client, userId: string, roleCode: string): Promise<void> {
  const roleResult = await client.query<{ id: string }>('select id from identity.roles where code = $1', [roleCode]);
  const roleId = firstRow(roleResult, `identity.roles lookup for code ${roleCode}`).id;
  await client.query('insert into identity.user_roles (user_id, role_id) values ($1, $2) on conflict do nothing', [
    userId,
    roleId,
  ]);
}

beforeAll(async () => {
  admin = new Client(SUPERUSER_CONNECTION);
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `hr-driver-commission-read-all-scope.test.ts: could not connect to Postgres at ${PGHOST}:${PGPORT}/${PGDATABASE} as ${SUPERUSER} — ${String(error)}`,
      { cause: error },
    );
  }

  entityId = await resolveEntityId(admin, 'PST');

  // D-183: no DELETE here — beforeAll only upserts.
  await admin.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [DEL_SUP_ACTOR_UUID, `_hrdriverreadallscope_delsup_${RUN_ID}@test.invalid`, 'ممثل مشرف توصيل — عزل صلاحيات العمولة'],
  );
  await admin.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [SALES_MGR_ACTOR_UUID, `_hrdriverreadallscope_salesmgr_${RUN_ID}@test.invalid`, 'ممثل مدير مبيعات — عزل صلاحيات العمولة'],
  );
  for (const userId of [DEL_SUP_ACTOR_UUID, SALES_MGR_ACTOR_UUID]) {
    await admin.query('insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing', [
      userId,
      entityId,
    ]);
  }
  await grantRole(admin, DEL_SUP_ACTOR_UUID, DEL_SUP_ROLE_CODE);
  await grantRole(admin, SALES_MGR_ACTOR_UUID, SALES_MGR_ROLE_CODE);

  // hr.employees.code must match chk_employees_code_format (^PG-[0-9]{4}$, migration 0029) — this
  // suite owns PG-8600-PG-8699 (disjoint from every other suite's own range, see this directory's
  // own sibling files for the convention).
  const employeeResult = await admin.query<{ id: string }>(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, 'active') returning id`,
    [entityId, 'PG-8600', `مندوب مبيعات — عزل صلاحيات العمولة ${RUN_ID}`],
  );
  employeeId = firstRow(employeeResult, 'insert hr.employees fixture').id;

  const accountResult = await admin.query<{ id: string }>(
    `insert into sales.accounts (code, name_ar, account_type)
       values ($1, $2, 'client') returning id`,
    [`ACCT-DRIVERREADALLSCOPE-${RUN_ID}`, `حساب اختبار عزل الصلاحيات ${RUN_ID}`],
  );
  accountId = firstRow(accountResult, 'insert sales.accounts fixture').id;

  // a sales-shaped hr.commission_rules row (chk_commission_rules_sales_shape: basis <> 'per_unit'
  // and rate_pct not null; chk_commission_rules_applies_to allows 'sales_rep').
  const ruleResult = await admin.query<{ id: string }>(
    `insert into hr.commission_rules
        (entity_id, name, applies_to, client_id, basis, rate_pct, valid_from, valid_to)
       values ($1, $2, 'sales_rep', null, 'recurring', 10.000, '2024-01-01', null)
       returning id`,
    [entityId, `WBS 3.13 part 4 fixture sales rule ${RUN_ID}`],
  );
  commissionRuleId = firstRow(ruleResult, 'insert hr.commission_rules fixture').id;

  const eventResult = await admin.query<{ id: string }>(
    `insert into hr.sales_commission_events
        (entity_id, period, employee_id, client_id, rule_id, event_kind, source_table, source_id,
         base_amount, amount, rule_snapshot, calc_snapshot, status)
       values ($1, $2, $3, $4, $5, 'recurring_collection', 'billing.invoices', $6, 100.000, 10.000,
               '{}'::jsonb, '{}'::jsonb, 'accrued')
       returning id`,
    [entityId, '2024-05-01', employeeId, accountId, commissionRuleId, randomUUID()],
  );
  salesCommissionEventId = firstRow(eventResult, 'insert hr.sales_commission_events fixture').id;
});

afterAll(async () => {
  if (salesCommissionEventId) {
    await admin.query('delete from hr.sales_commission_events where id = $1', [salesCommissionEventId]);
  }
  if (commissionRuleId) {
    await admin.query('delete from hr.commission_rules where id = $1', [commissionRuleId]);
  }
  if (accountId) {
    await admin.query('delete from sales.accounts where id = $1', [accountId]);
  }
  if (employeeId) {
    await admin.query('delete from hr.employees where id = $1', [employeeId]);
  }
  for (const userId of [DEL_SUP_ACTOR_UUID, SALES_MGR_ACTOR_UUID]) {
    await admin.query('delete from platform.idempotency_keys where user_id = $1', [userId]);
    await admin.query('delete from identity.user_roles where user_id = $1', [userId]);
    await admin.query('delete from identity.user_entities where user_id = $1', [userId]);
    await admin.query('delete from identity.users where id = $1', [userId]);
  }
  await admin.end();
});

describe('SCR-HR-COMM-01 (migration 0033, D-190) — hr.driver_commission.read_all and hr.commission.read_all stay genuinely separate, unrelated permissions', () => {
  it('vacuity guard: the seeded hr.sales_commission_events row genuinely exists (superuser admin connection, bypasses RLS)', async () => {
    const result = await admin.query('select id from hr.sales_commission_events where id = $1', [
      salesCommissionEventId,
    ]);
    expect(result.rows).toHaveLength(1);
  });

  it('DEL_SUP_ACTOR_UUID genuinely holds hr.driver_commission.read_all (seed-granted) but NOT hr.commission.read_all', async () => {
    const grantResult = await admin.query<{ holds_driver_read_all: boolean; holds_sales_read_all: boolean }>(
      `select
         bool_or(p.code = $2) as holds_driver_read_all,
         bool_or(p.code = $3) as holds_sales_read_all
       from identity.user_roles ur
       join identity.roles r on r.id = ur.role_id
       join identity.role_permissions rp on rp.role_id = r.id
       join identity.permissions p on p.id = rp.permission_id
       where ur.user_id = $1`,
      [DEL_SUP_ACTOR_UUID, DRIVER_COMMISSION_READ_ALL_PERMISSION_CODE, SALES_COMMISSION_READ_ALL_PERMISSION_CODE],
    );
    expect(grantResult.rows[0]?.holds_driver_read_all).toBe(true);
    expect(grantResult.rows[0]?.holds_sales_read_all).toBe(false);
  });

  it(
    'as pgeos_app, DEL_SUP_ACTOR_UUID (holds hr.driver_commission.read_all only) reading ' +
      'hr.sales_commission_events sees ZERO of the seeded rows — the new permission does NOT leak ' +
      'into the sister table',
    async () => {
      const delSupCtx: AppRoleCtx = { userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true };
      const result = await withAppRole(delSupCtx, (client) =>
        client.query<{ id: string }>('select id from hr.sales_commission_events where id = $1', [
          salesCommissionEventId,
        ]),
      );
      expect(result.rows).toEqual([]);
    },
  );

  it(
    'positive control: as pgeos_app, SALES_MGR_ACTOR_UUID (holds the OLD, untouched hr.commission.read_all) ' +
      'CAN read the same seeded hr.sales_commission_events row — proving the zero-rows result above is ' +
      'the permission boundary genuinely working, not the query/fixture being broken',
    async () => {
      const salesMgrCtx: AppRoleCtx = { userId: SALES_MGR_ACTOR_UUID, clientId: null, isInternal: true };
      const result = await withAppRole(salesMgrCtx, (client) =>
        client.query<{ id: string }>('select id from hr.sales_commission_events where id = $1', [
          salesCommissionEventId,
        ]),
      );
      expect(result.rows).toEqual([{ id: salesCommissionEventId }]);
    },
  );
});
