// tests/isolation/tests/shipments-attributed-invoker-rls.test.ts — WBS 3.13 part 1 (pg-tester).
//
// Proves migration 0027's item (4) (database/migrations/0027_3_commission-daily-rls-version.sql,
// header item (4)): `imile.shipments_attributed` is set `security_invoker = true` BEFORE
// `pgeos_app` is granted SELECT on it. Without the invoker option the view's OWNER (`postgres`, a
// superuser) evaluates its underlying queries with OWNER rights, which would bypass RLS on
// `imile.shipments` / `imile.driver_ids` / `imile.driver_id_assignments` entirely and let
// `pgeos_app` read every row through the view regardless of caller context — a G14-class leak,
// exactly the failure mode 0012 (wms.space_dashboard) already fixed once for a different view, and
// 0027 replicates verbatim (see 0027's header + database/migrations/0012_M_space-dashboard-invoker-
// grant.sql for the precedent this file's self-check block is copied from).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE'S "SCOPE" DIMENSION IS is_internal(), NOT entity_id — RECORDED DEFAULT, NOT AN
// INVENTED RULE (CLAUDE.md · AGENT CONSTRAINTS, G-01: never fabricate a table, column, or rule)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The task that produced this file asked for a two-entity (entity A / entity B) isolation proof,
// the same shape as tests/isolation/tests/app-role-rls.test.ts's own entity-boundary describe
// block. But `imile.shipments`, `imile.driver_ids` and `imile.driver_id_assignments` carry NO
// `entity_id` column at all (database/schema/01-Data-Model.sql:1315-1339, :281-313), and
// `.claude/briefs/imile.brief.md` §2 confirms their RLS policy is `internal_only` — gated on
// `platform.is_internal()` alone, never on `platform.allowed_entities()`. The view itself
// (imile.shipments_attributed, 13-Schema-Additions.sql:317-326) does not project an entity_id
// column either. Writing an `entity_id = any(allowed_entities())` assertion against these tables
// would be asserting a rule this schema does not implement — exactly what G-01 forbids.
//
// hr.employees DOES carry entity_id (01-Data-Model.sql:1269), so this file still seeds two
// employees under two different entities (PST / PDL, the same seed entity codes
// client-isolation.test.ts and app-role-rls.test.ts already reuse) to keep the fixture shape close
// to what was asked — but the caller-scope boundary this file actually PROVES, because it is the
// only one this schema enforces on these three tables, is `platform.is_internal()`: a non-internal
// `pgeos_app` session reading `imile.shipments_attributed` must see ZERO rows (proving the view
// genuinely re-evaluates RLS per caller through invoker rights, not the owner's bypass), while an
// internal session sees every seeded row (proving that zero-rows result is the boundary actually
// working, not the session seeing nothing at all). This is the honest, schema-grounded analogue of
// "entity A sees none of entity B's rows" available on this view today — recorded here as a
// default, not silently substituted.

import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Same PG* convention and defaults as tests/isolation/tests/app-role-rls.test.ts and
// packages/db/src/client.ts — this file does not go through @pg-eos/db / withContext for the same
// reason app-role-rls.test.ts documents at length in its own header: it needs a superuser admin
// connection AND a separate unprivileged pgeos_app connection live at once, for the whole run.
const PGHOST = process.env['PGHOST'] ?? 'localhost';
const PGPORT = process.env['PGPORT'] ?? '5432';
const PGDATABASE = process.env['PGDATABASE'] ?? 'pgeos';
const SUPERUSER = process.env['PGUSER'] ?? 'postgres';
const SUPERUSER_PASSWORD = process.env['PGPASSWORD'];
const APP_ROLE = process.env['PG_APP_USER'] ?? 'pgeos_app';

const SUPERUSER_CONNECTION = {
  host: PGHOST,
  port: Number(PGPORT),
  user: SUPERUSER,
  password: SUPERUSER_PASSWORD,
  database: PGDATABASE,
};

// No password field — D-133: pgeos_app has no password, local pg_hba is `trust`. Same idiom as
// app-role-rls.test.ts's own APP_ROLE_CONNECTION.
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

/** The three GUCs packages/db/src/with-context.ts sets — copied verbatim, not guessed, same as
 *  app-role-rls.test.ts's own AppRoleCtx. */
interface AppRoleCtx {
  readonly userId: string | null;
  readonly clientId: string | null;
  readonly isInternal: boolean;
}

/** Opens one dedicated pgeos_app connection, sets the three GUCs inside a transaction, runs `fn`,
 *  commits on success / rolls back and rethrows on failure, always closes the connection — the same
 *  reproduction of withContext(ctx, fn)'s contract app-role-rls.test.ts already uses. */
async function withAppRole<T>(ctx: AppRoleCtx, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(APP_ROLE_CONNECTION);
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [ctx.userId]);
    await client.query("select set_config('app.client_id', $1, true)", [ctx.clientId]);
    await client.query("select set_config('app.is_internal', $1, true)", [
      ctx.isInternal ? 'true' : 'false',
    ]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Original error still wins.
    }
    throw error;
  } finally {
    await client.end();
  }
}

async function resolveEntityId(admin: Client, code: string): Promise<string> {
  const result = await admin.query<{ id: string }>(
    'select id from platform.entities where code = $1',
    [code],
  );
  return firstRow(result, `platform.entities lookup for code ${code}`).id;
}

interface EmployeeFixture {
  readonly employeeId: string;
  readonly driverIdRef: string;
  readonly driverCode: string;
  readonly shipmentTrackingNos: readonly string[];
}

let admin: Client;
let entityAId: string;
let entityBId: string;
let fixtureA: EmployeeFixture;
let fixtureB: EmployeeFixture;

// Prefixed like every other isolation-suite fixture (client-isolation.test.ts's own convention),
// so a stray row can be identified and reported to the Master (D-183) rather than silently
// deleted outside this suite's own afterAll.
// Fix round, finding 11: this constant's VALUE previously said "entity-scope" even though this
// file was renamed to `-invoker-rls` and its own header above correctly describes the
// `is_internal()` boundary this file actually proves, not entity-scope — renamed to match.
const FIXTURE_PREFIX = 'shipments-attributed-invoker-rls-test';
const RUN_ID = randomUUID();

function label(name: string, suffix: string): string {
  return `${FIXTURE_PREFIX}-${name}-${RUN_ID}-${suffix}`;
}

// hr.employees.code must match chk_employees_code_format (^PG-[0-9]{4}$, migration
// 0029_M_hr-employee-checks.sql) — this suite owns the PG-8xxx range (Master's disjoint-range
// assignment: register-employee PG-1xxx, its handlers PG-2xxx, maintain-shift PG-3xxx, maintain-shift
// handlers PG-4xxx, this isolation suite PG-8xxx, hr-employee-checks PG-9xxx), same
// `PG-${base + counter}` monotonic-counter style as modules/hr/tests/*/uniqueEmployeeCode().
let employeeCodeCounter = 0;
function uniqueEmployeeCode(): string {
  employeeCodeCounter += 1;
  return `PG-${(8000 + employeeCodeCounter).toString().padStart(4, '0').slice(-4)}`;
}

/** Seeds one employee (under `entityId`), one active imile.driver_ids row, one active
 *  imile.driver_id_assignments row covering "now", and two imile.shipments rows attributed to that
 *  employee through the view (internal_status 'delivered', ofd_at inside the assignment window) —
 *  all via the superuser admin connection, which bypasses RLS to write fixture rows the same way
 *  client-isolation.test.ts's seedClient() does. */
async function seedEmployeeFixture(name: 'a' | 'b', entityId: string): Promise<EmployeeFixture> {
  const employee = await admin.query<{ id: string }>(
    `insert into hr.employees (entity_id, code, name_ar, hire_date)
     values ($1, $2, $3, current_date) returning id`,
    [entityId, uniqueEmployeeCode(), `موظف اختبار عزل الإسناد ${name}`],
  );
  const employeeId = firstRow(employee, `insert hr.employees for fixture ${name}`).id;

  const driverId = await admin.query<{ id: string }>(
    `insert into imile.driver_ids (imile_code, allocated_at) values ($1, current_date) returning id`,
    [label(name, 'driver')],
  );
  const driverIdRef = firstRow(driverId, `insert imile.driver_ids for fixture ${name}`).id;
  const driverCode = label(name, 'driver');

  await admin.query(
    `insert into imile.driver_id_assignments (driver_id_ref, employee_id, assigned_from, assigned_by)
     values ($1, $2, now() - interval '1 day', $3)`,
    [driverIdRef, employeeId, randomUUID()],
  );

  const trackingNos = [label(name, 'ship-1'), label(name, 'ship-2')] as const;
  for (const trackingNo of trackingNos) {
    await admin.query(
      `insert into imile.shipments (tracking_no, driver_code, internal_status, ofd_at, closed_at)
       values ($1, $2, 'delivered', now() - interval '12 hours', now() - interval '6 hours')`,
      [trackingNo, driverCode],
    );
  }

  return { employeeId, driverIdRef, driverCode, shipmentTrackingNos: trackingNos };
}

async function deleteEmployeeFixture(fixture: EmployeeFixture | undefined): Promise<void> {
  if (!fixture) {
    return;
  }
  await admin.query('delete from imile.shipments where tracking_no = any($1)', [
    fixture.shipmentTrackingNos,
  ]);
  await admin.query('delete from imile.driver_id_assignments where driver_id_ref = $1', [
    fixture.driverIdRef,
  ]);
  await admin.query('delete from imile.driver_ids where id = $1', [fixture.driverIdRef]);
  await admin.query('delete from hr.employees where id = $1', [fixture.employeeId]);
}

beforeAll(async () => {
  admin = new Client(SUPERUSER_CONNECTION);
  try {
    await admin.connect();
  } catch (error) {
    // Fail loudly, not a silent skip — same convention as app-role-rls.test.ts's own beforeAll.
    throw new Error(
      `shipments-attributed-invoker-rls.test.ts: could not connect to Postgres at ${PGHOST}:${PGPORT}/${PGDATABASE} as ${SUPERUSER} — ${String(error)}`,
      { cause: error },
    );
  }

  entityAId = await resolveEntityId(admin, 'PST');
  entityBId = await resolveEntityId(admin, 'PDL');

  fixtureA = await seedEmployeeFixture('a', entityAId);
  fixtureB = await seedEmployeeFixture('b', entityBId);
});

afterAll(async () => {
  try {
    await deleteEmployeeFixture(fixtureA);
  } finally {
    try {
      await deleteEmployeeFixture(fixtureB);
    } finally {
      await admin.end();
    }
  }
});

describe('0027 self-check — imile.shipments_attributed carries security_invoker=true (0012 precedent)', () => {
  it('pg_class.reloptions for imile.shipments_attributed includes security_invoker=true', async () => {
    const result = await admin.query<{ reloptions: string[] | null }>(
      `select reloptions from pg_class where oid = 'imile.shipments_attributed'::regclass`,
    );
    const row = firstRow(result, 'pg_class lookup for imile.shipments_attributed');
    expect(row.reloptions ?? []).toContain('security_invoker=true');
  });
});

describe('imile.shipments_attributed is genuinely RLS-filtered per caller, not owner-rights', () => {
  // Vacuity guard: prove the fixture rows really exist (via the superuser admin connection, which
  // bypasses RLS) before trusting any "pgeos_app sees zero rows" result below as meaningful rather
  // than an empty-table coincidence.
  it('vacuity guard: the seeded shipments are visible to the superuser admin connection', async () => {
    const result = await admin.query<{ tracking_no: string }>(
      `select tracking_no from imile.shipments where tracking_no = any($1)`,
      [[...fixtureA.shipmentTrackingNos, ...fixtureB.shipmentTrackingNos]],
    );
    expect(result.rows).toHaveLength(4);
  });

  it(
    'as pgeos_app, a NON-internal session reading imile.shipments_attributed sees ZERO of the seeded rows ' +
      '(imile.shipments/driver_ids/driver_id_assignments RLS = internal_only — a leak here would mean the ' +
      "view ran with the OWNER's privileges, bypassing internal_only entirely)",
    async () => {
      const nonInternalCtx: AppRoleCtx = { userId: null, clientId: null, isInternal: false };

      let thrown: unknown = null;
      let result: QueryResult<{ tracking_no: string }> | undefined;
      try {
        result = await withAppRole(nonInternalCtx, (client) =>
          client.query<{ tracking_no: string }>(
            `select tracking_no from imile.shipments_attributed where tracking_no = any($1)`,
            [[...fixtureA.shipmentTrackingNos, ...fixtureB.shipmentTrackingNos]],
          ),
        );
      } catch (error) {
        thrown = error;
      }

      // Both halves of the "genuinely filtered, not merely erroring" pass condition — same idiom
      // client-isolation.test.ts's G14 assertions use: a rejected promise never reaching `.rows`
      // would also show "0 rows" but would not be evidence of RLS filtering.
      expect(thrown).toBeNull();
      expect(result?.rows).toEqual([]);
    },
  );

  it(
    'as pgeos_app, an INTERNAL session reading imile.shipments_attributed sees every seeded row for ' +
      'BOTH entity-A and entity-B employees (positive control — the zero-rows result above is the ' +
      'is_internal() boundary actually working, not the session seeing nothing at all)',
    async () => {
      const internalCtx: AppRoleCtx = { userId: null, clientId: null, isInternal: true };

      const result = await withAppRole(internalCtx, (client) =>
        client.query<{ tracking_no: string; employee_id: string }>(
          `select tracking_no, employee_id from imile.shipments_attributed where tracking_no = any($1)`,
          [[...fixtureA.shipmentTrackingNos, ...fixtureB.shipmentTrackingNos]],
        ),
      );

      const trackingNos = result.rows.map((row) => row.tracking_no).sort();
      expect(trackingNos).toEqual(
        [...fixtureA.shipmentTrackingNos, ...fixtureB.shipmentTrackingNos].sort(),
      );

      const employeeIdsForA = result.rows
        .filter((row) => fixtureA.shipmentTrackingNos.includes(row.tracking_no))
        .map((row) => row.employee_id);
      const employeeIdsForB = result.rows
        .filter((row) => fixtureB.shipmentTrackingNos.includes(row.tracking_no))
        .map((row) => row.employee_id);

      // Attribution runs through the assignment table only (doc 38's own acceptance criterion,
      // this slice's brief item — imile.shipments_attributed is the ONLY allowed view for this):
      // every entity-A shipment must attribute to employee A, every entity-B shipment to employee
      // B, and the two sets must not cross.
      expect(employeeIdsForA.every((id) => id === fixtureA.employeeId)).toBe(true);
      expect(employeeIdsForB.every((id) => id === fixtureB.employeeId)).toBe(true);
    },
  );

  it('migration 0027 granted pgeos_app SELECT on imile.shipments_attributed', async () => {
    // Unconditional assertion of what 0027 delivers (its own header item (4): security_invoker=true
    // BEFORE the grant) — no branch, so this can never pass vacuously. Pre-0027 this query resolves
    // to `false` and the assertion fails for real; post-0027 it resolves to `true`.
    const hasSelect = await admin.query<{ has_priv: boolean }>(
      `select has_table_privilege($1, 'imile.shipments_attributed', 'SELECT') as has_priv`,
      [APP_ROLE],
    );
    const row = firstRow(hasSelect, `has_table_privilege lookup for ${APP_ROLE} on imile.shipments_attributed`);

    expect(row.has_priv).toBe(true);
  });
});
