// tests/isolation/tests/app-role-rls.test.ts — WBS 0.6a-1 (pg-tester).
//
// Proves the executable half of tests/isolation/app-role-rls.feature — the `pgeos_app` role and
// the entity_scope USING / WITH CHECK split (D-133, pg-reviewer pre-migration review, APPROVED
// WITH CHANGES), delivered by database/migrations/0007_M_pgeos-app-role-entity-scope.sql, which
// was written after this file. This file was written first and ran RED, per CLAUDE.md · BUILD
// METHOD; pg-tester writes test files only, and pg-backend built the migration.
//
// LEAN DESIGN (GM directive, this session): views are NOT altered (no security_invoker rewrite
// of existing views). Instead migration 0007's grant loop gives pgeos_app NO privilege at all on
// any view in the fourteen schemas that lacks security_invoker=true — an "owner-rights" view.
// Trimmed to 10 tests for the lean design (Master list); fix round 2 added 2 more — 12 in all.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE DOES NOT GO THROUGH @pg-eos/db / withContext
// ─────────────────────────────────────────────────────────────────────────────────────────────
// tests/isolation/tests/client-isolation.test.ts (WBS 0.18) mutates process.env.PGUSER at module
// top level so `@pg-eos/db`'s pool (built once, at module-load time, from that env var) connects
// as its own throwaway fixture role. That file's own header comment documents, at length, that
// this mutation is process-wide and can leak across spec files in the SAME vitest worker. This
// suite needs TWO separate identities at once — an unprivileged `pgeos_app` connection for the
// code under test AND a superuser admin connection for fixtures/catalog reads — for the entire
// run, which the single shared @pg-eos/db pool cannot give us without re-running the same
// leak-prone env-var dance a second, incompatible way. Instead this file opens its own `pg.Client`
// connections directly, one per role, and reproduces with-context.ts's exact GUC-setting contract
// (`withAppRole`, below) rather than importing it — the three GUC names (app.user_id,
// app.client_id, app.is_internal) and the `set_config(name, value, true)` idiom are copied
// verbatim from packages/db/src/with-context.ts, not guessed.
//
// Unlike client-isolation.test.ts, this suite does NOT create/drop the `pgeos_app` role itself —
// that role is schema (migration 0007's job). This file only ever CONNECTS as it, and fails loudly
// (not a silent skip) if it does not exist or the
// database is unreachable at all — CLAUDE.md · AGENT CONSTRAINTS / this slice's own brief: "no
// silent skips: fail if the database is unreachable."

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// tests/isolation/tests/app-role-rls.test.ts -> tests/isolation/tests -> tests/isolation -> tests -> root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const MIGRATIONS_DIR = path.join(ROOT, 'database', 'migrations');

const MIGRATION_FILE = path.join(MIGRATIONS_DIR, '0007_M_pgeos-app-role-entity-scope.sql');

// Fix round 1 (Master, this session): 0007's grant loop re-grants DELETE on every platform table
// (including platform.idempotency_keys, added later by migration 0010) — applying 0007 ALONE, as
// this test used to, left the dev DB with pgeos_app holding DELETE on it, because normally
// apply.sh's own full run applies every LATER migration afterward (0010 revokes DELETE again).
// Root cause + fix confirmed live: `has_table_privilege('pgeos_app','platform.idempotency_keys',
// 'DELETE')` was false before this test ran, true immediately after (0007-only), and false again
// once every migration numbered >= 0007 is re-applied in file order, below.
const MIGRATION_NUMBER_RE = /^(\d{4})_/;

/** Every database/migrations/NNNN_*.sql file whose numeric prefix is >= `minNumber`, sorted by
 *  that number — mirrors apply.sh's own `sort -V` migrations step, not re-invented. */
function migrationFilesFrom(minNumber: number): string[] {
  const entries = readdirSync(MIGRATIONS_DIR);
  return entries
    .map((name) => {
      const match = MIGRATION_NUMBER_RE.exec(name);
      return match ? { name, number: Number(match[1]) } : null;
    })
    .filter((entry): entry is { name: string; number: number } => entry !== null && entry.number >= minNumber)
    .sort((a, b) => a.number - b.number)
    .map((entry) => path.join(MIGRATIONS_DIR, entry.name));
}

// The runtime role D-133 names — fixed, not a per-run throwaway (contrast ROLE in
// client-isolation.test.ts): this file only ever connects as it, never creates or drops it.
const APP_ROLE = 'pgeos_app';

// doc 40 Part F row G7's own schema list — the "fourteen business schemas" everywhere in this
// suite and in guards.sql/client-isolation.test.ts's own G7 query, copied verbatim, not reordered.
const FOURTEEN_SCHEMAS = [
  'platform', 'identity', 'catalog', 'sales', 'wms', 'tms', 'cc',
  'billing', 'hr', 'partners', 'admin', 'housing', 'imile', 'governance',
] as const;

// The brief's own numbers — never invented: "There are 69 today, including the 7 gated on
// is_internal()." Updated to 70 by migration 0015 (WBS 5.5a part 1, platform.sites), which added
// an entity_scope RLS policy on platform.sites.
// Updated to 73 by migration 0016 (WBS 5.5a part 2, hr.shifts/shift_groups/shift_assignments),
// each of which added an entity_scope RLS policy.
const ENTITY_SCOPE_POLICY_COUNT = 73;
const IS_INTERNAL_GATED_ENTITY_SCOPE_COUNT = 7;

// The design's own three append-only tables (UPDATE/DELETE revoked from pgeos_app).
const UPDATE_DELETE_REVOKED_TABLES = [
  'platform.audit_log',
  'wms.stock_movements',
  'wms.work_order_events',
] as const;

const REVOKED_COMMANDS = ['UPDATE', 'DELETE'] as const;

const PGHOST = process.env['PGHOST'] ?? 'localhost';
const PGPORT = process.env['PGPORT'] ?? '5432';
const PGDATABASE = process.env['PGDATABASE'] ?? 'pgeos';
const SUPERUSER = process.env['PGUSER'] ?? 'postgres';
const SUPERUSER_PASSWORD = process.env['PGPASSWORD'];

const SUPERUSER_CONNECTION = {
  host: PGHOST,
  port: Number(PGPORT),
  user: SUPERUSER,
  password: SUPERUSER_PASSWORD,
  database: PGDATABASE,
};

// No password field at all — D-133: pgeos_app has NO password. Local pg_hba is `trust` (never
// checks the password), same assumption tests/isolation/tests/client-isolation.test.ts documents
// and relies on; this is the portability boundary this suite accepts, same as that precedent.
const APP_ROLE_CONNECTION = {
  host: PGHOST,
  port: Number(PGPORT),
  user: APP_ROLE,
  database: PGDATABASE,
};

/** SQLSTATE 42501 — insufficient_privilege (PostgreSQL docs, Appendix A, Class 42). Raised both
 *  for an RLS WITH CHECK violation ("new row violates row-level security policy") and for a plain
 *  missing GRANT ("permission denied for ..."). Quoted, not invented — same idiom as
 *  CHECK_VIOLATION_SQLSTATE in client-isolation.test.ts. */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';

function sqlStateOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

function firstRow<T extends QueryResultRow>(result: QueryResult<T>, what: string): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`${what}: query returned no rows where at least one was expected`);
  }
  return row;
}

/** The three GUCs packages/db/src/with-context.ts sets, and only those three — names and the
 *  set_config(name, value, true) idiom copied verbatim from that file, not guessed. */
interface AppRoleCtx {
  readonly userId: string | null;
  readonly clientId: string | null;
  readonly isInternal: boolean;
}

/**
 * Opens ONE dedicated `pgeos_app` connection, sets exactly with-context.ts's three GUCs inside a
 * transaction, runs `fn`, commits on success / rolls back and re-throws on failure, and always
 * closes the connection — the same transaction-scoped contract withContext(ctx, fn) gives its
 * callers, reproduced here (see the file header for why this is a reproduction, not an import).
 */
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
      // Original error still wins — see with-context.ts's own identical rollback-safety comment.
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

async function resolveWarehouseId(admin: Client, code: string): Promise<string> {
  const result = await admin.query<{ id: string }>(
    'select id from wms.warehouses where code = $1',
    [code],
  );
  return firstRow(result, `wms.warehouses lookup for code ${code}`).id;
}

let admin: Client;
let dbReachable = true;
let entityAId: string;
let entityBId: string;
let warehouseId: string;

beforeAll(async () => {
  admin = new Client(SUPERUSER_CONNECTION);
  try {
    await admin.connect();
  } catch (error) {
    // Fail loudly, not a silent skip — this slice's own brief: "no silent skips: fail if the
    // database is unreachable."
    dbReachable = false;
    throw new Error(
      `app-role-rls.test.ts: could not connect to Postgres at ${PGHOST}:${PGPORT}/${PGDATABASE} as ${SUPERUSER} — ${String(error)}`,
      { cause: error },
    );
  }
  entityAId = await resolveEntityId(admin, 'PST');
  entityBId = await resolveEntityId(admin, 'PDL');
  warehouseId = await resolveWarehouseId(admin, 'WH1');
});

afterAll(async () => {
  if (admin && dbReachable) {
    await admin.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Test 1 — pgeos_app role shape
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('pgeos_app role shape (D-133)', () => {
  it('pgeos_app exists with rolsuper=false, rolbypassrls=false, rolcreaterole=false', async () => {
    const result = await admin.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolcanlogin: boolean;
      rolpassword: string | null;
    }>(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, rolpassword
         from pg_authid where rolname = $1`,
      [APP_ROLE],
    );

    expect(result.rows).toHaveLength(1);
    const row = firstRow(result, `pg_authid lookup for role ${APP_ROLE}`);
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
    expect(row.rolcreaterole).toBe(false);
    // Beyond the three the test name names — the design's remaining shape requirements, asserted
    // in the same query rather than invented duplicate round-trips: NOCREATEDB, LOGIN, no password.
    expect(row.rolcreatedb).toBe(false);
    expect(row.rolcanlogin).toBe(true);
    expect(row.rolpassword).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Test 2 — entity_scope WITH CHECK == USING, on every one of the 69
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('entity_scope policies carry an explicit WITH CHECK equal to their USING', () => {
  it('every entity_scope policy carries a WITH CHECK equal to its USING', async () => {
    // doc 40 Part F row G7's own schema list — "fourteen business schemas", named, not invented.
    expect(FOURTEEN_SCHEMAS).toHaveLength(14);

    const result = await admin.query<{
      table_name: string;
      qual: string;
      withcheck: string | null;
    }>(
      `select (n.nspname || '.' || c.relname) as table_name,
              pg_get_expr(p.polqual, p.polrelid) as qual,
              pg_get_expr(p.polwithcheck, p.polrelid) as withcheck
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where p.polname = 'entity_scope'
          and n.nspname = any($1::text[])
        order by 1`,
      [FOURTEEN_SCHEMAS as unknown as string[]],
    );

    // The brief's own cited number — never invented.
    expect(result.rows).toHaveLength(ENTITY_SCOPE_POLICY_COUNT);

    const gated = result.rows.filter((row) => row.qual.includes('platform.is_internal()'));
    expect(gated).toHaveLength(IS_INTERNAL_GATED_ENTITY_SCOPE_COUNT);

    for (const row of result.rows) {
      expect(row.withcheck, `${row.table_name}.entity_scope has no WITH CHECK`).not.toBeNull();
      expect(row.withcheck, `${row.table_name}.entity_scope WITH CHECK differs from its USING`).toBe(
        row.qual,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests 3-4 — Behavioral entity boundary — wms.occupancy_snapshots (entity_scope, FOR ALL, no
// client leg; simplest fixture shape of the seven SCR-RLS-01 tables plus this table, per the
// brief: "pick a real entity_scope table with a simple row shape ... check the schema; don't
// invent columns" — entity_id, client_id, warehouse_id, snapshot_date, three numeric defaults,
// one int default; verified live against database/schema/01-Data-Model.sql:816-827).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('as pgeos_app in entity A — the entity boundary on wms.occupancy_snapshots', () => {
  // A dedicated sales.accounts row, prefixed like every other fixture row in this repo's isolation
  // suites (sweepLeftoverFixtureRows precedent in client-isolation.test.ts), so an interrupted run
  // is found and removed by prefix on the NEXT run.
  const accountCode = `app-role-rls-test-${randomUUID()}`;
  let clientAccountId: string;
  // A real identity.users row (user_type = 'internal' — Option C, migration 0003, forbids a
  // 'client' user from holding identity.user_entities access at all) whose identity.user_entities
  // membership is exactly {entity A}, so platform.allowed_entities() for this session is {entity
  // A} and only entity A.
  const entityAUserEmail = `app-role-rls-test-entity-a-${randomUUID()}@example.invalid`;
  let entityAUserId: string;

  beforeAll(async () => {
    const account = await admin.query<{ id: string }>(
      `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
      [accountCode, 'عميل اختبار دور pgeos_app'],
    );
    clientAccountId = firstRow(account, 'insert sales.accounts fixture for entity-boundary tests').id;

    const user = await admin.query<{ id: string }>(
      `insert into identity.users (email, full_name_ar, user_type) values ($1, $2, 'internal') returning id`,
      [entityAUserEmail, 'مستخدم اختبار حدود الكيان (pgeos_app)'],
    );
    entityAUserId = firstRow(user, 'insert identity.users fixture for entity-boundary tests').id;

    await admin.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
      entityAUserId,
      entityAId,
    ]);
  });

  afterAll(async () => {
    try {
      await admin.query('delete from wms.occupancy_snapshots where client_id = $1', [
        clientAccountId,
      ]);
    } finally {
      try {
        await admin.query('delete from identity.user_entities where user_id = $1', [
          entityAUserId,
        ]);
        await admin.query('delete from identity.users where id = $1', [entityAUserId]);
      } finally {
        await admin.query('delete from sales.accounts where id = $1', [clientAccountId]);
      }
    }
  });

  function entityACtx(): AppRoleCtx {
    return { userId: entityAUserId, clientId: null, isInternal: false };
  }

  it('as pgeos_app in entity A: INSERT of an entity-B row is rejected (42501)', async () => {
    let thrown: unknown = null;
    try {
      await withAppRole(entityACtx(), (client) =>
        client.query(
          `insert into wms.occupancy_snapshots (snapshot_date, entity_id, client_id, warehouse_id)
           values (current_date - 1, $1, $2, $3)`,
          [entityBId, clientAccountId, warehouseId],
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(sqlStateOf(thrown)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
  });

  it('as pgeos_app in entity A: SELECT returns no entity-B row', async () => {
    const rowB = await admin.query<{ id: string }>(
      `insert into wms.occupancy_snapshots (snapshot_date, entity_id, client_id, warehouse_id)
       values (current_date - 3, $1, $2, $3) returning id`,
      [entityBId, clientAccountId, warehouseId],
    );
    const rowBId = firstRow(rowB, 'insert wms.occupancy_snapshots entity-B seed row for SELECT test').id;

    let thrown: unknown = null;
    let result: QueryResult<{ id: string }> | undefined;
    try {
      result = await withAppRole(entityACtx(), (client) =>
        client.query<{ id: string }>('select id from wms.occupancy_snapshots where id = $1', [
          rowBId,
        ]),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeNull();
    expect(result?.rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tests 5-6 — audit_append — the new permissive INSERT policy on platform.audit_log
//
// Fix round 2 (Finding 1, serious): the earlier draft committed a real audit_log row (via the
// admin connection's own INSERT/DELETE fixture pair) and deleted it afterwards WITHOUT the audit
// hash-chain lock and without the "only the newest row" check platform.audit_hash_chain() itself
// enforces — a delete like that can leave a permanent gap in the chain (observed: G8
// chain_seq_gap). Fix: pgeos_app performs the INSERT inside its own transaction and the test
// asserts "no error was thrown", then the transaction is ALWAYS rolled back — the row never
// commits, so there is nothing to delete and no chain gap is possible. audit_append itself grants
// INSERT only (no SELECT), so there is no read-back to prove success with inside the same
// transaction beyond "no error was thrown" — the honest option finding 1 names.
//
// Fix round 2 (Finding 6) + Master default (D-117): the portal session is the GUC context
// packages/db/src/with-context.ts writes for a client session — app.user_id, app.client_id,
// app.is_internal = false. No identity.users / sales.accounts rows are created: audit_append reads
// only platform.current_user_id() (the app.user_id GUC), platform.audit_log.user_id has no FK,
// pgeos_app cannot insert those rows under RLS, and the seed holds no client users yet.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Opens ONE dedicated pgeos_app connection and, INSIDE A SINGLE TRANSACTION, sets the portal
 * session GUCs (app.user_id and app.client_id = fresh random uuids, app.is_internal = false),
 * then runs `fn`. No rows are created. The transaction is ALWAYS rolled back afterwards, success
 * or failure (Finding 1): nothing is ever committed, so there is nothing to clean up and no
 * audit-chain risk.
 */
async function withRolledBackPortalUser(
  fn: (client: Client, portalUserId: string) => Promise<void>,
): Promise<void> {
  const client = new Client(APP_ROLE_CONNECTION);
  await client.connect();
  try {
    await client.query('begin');

    // The portal context is the GUC set with-context.ts writes for a client session (app.user_id,
    // app.client_id, app.is_internal=false). audit_append reads only platform.current_user_id(),
    // i.e. the app.user_id GUC, and platform.audit_log.user_id carries no FK — so no identity.users
    // / sales.accounts rows are needed. They also cannot be created here: pgeos_app is not allowed
    // to insert them under RLS (the point of this suite), and the seed holds no client users yet
    // (D-134 synthetic pilot clients not seeded). Master default, recorded in CHANGELOG (0.6a-1).
    const clientAccountId = randomUUID();
    const portalUserId = randomUUID();

    await client.query("select set_config('app.user_id', $1, true)", [portalUserId]);
    await client.query("select set_config('app.client_id', $1, true)", [clientAccountId]);
    await client.query("select set_config('app.is_internal', 'false', true)");

    await fn(client, portalUserId);
  } finally {
    // ALWAYS rolled back, success or failure — see the describe-block comment (Finding 1): the
    // fixture and every row `fn` inserts must never commit.
    try {
      await client.query('rollback');
    } catch {
      // Connection close below still discards the uncommitted transaction either way.
    }
    await client.end();
  }
}

describe('as pgeos_app — the audit_append policy on platform.audit_log', () => {
  it('as pgeos_app in a portal context: an own audit_log INSERT succeeds', async () => {
    let thrown: unknown = null;
    await withRolledBackPortalUser(async (client, portalUserId) => {
      try {
        await client.query(
          `insert into platform.audit_log
             (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
           values (now(), $1, 'user', $2, 'platform', '_app_role_rls_fixture', $3, 'insert')`,
          [portalUserId, entityAId, randomUUID()],
        );
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeNull();
  });

  it('as pgeos_app: an audit_log INSERT for another user is rejected', async () => {
    let thrown: unknown = null;
    await withRolledBackPortalUser(async (client) => {
      const foreignUserId = randomUUID();
      try {
        await client.query(
          `insert into platform.audit_log
             (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
           values (now(), $1, 'user', $2, 'platform', '_app_role_rls_fixture', $3, 'insert')`,
          [foreignUserId, entityAId, randomUUID()],
        );
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).not.toBeNull();
    expect(sqlStateOf(thrown)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Finding 3 proof — audit_append is now parent-only (pg-backend, this fix round): the previous
// per-partition audit_append duplication (0007's own "DEVIATION" block) is removed. Test 5 above
// (INSERT through the PARENT platform.audit_log) succeeding IS that proof at the behavioral
// level; this is the catalog-level half — zero audit_append policies on any partition, exactly
// one on the parent.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('audit_append is parent-only (Finding 3)', () => {
  it('audit_append exists only on platform.audit_log (zero rows on its partitions)', async () => {
    const parent = await admin.query<{ n: string }>(
      `select count(*)::text as n from pg_policy
        where polname = 'audit_append' and polrelid = 'platform.audit_log'::regclass`,
    );
    expect(firstRow(parent, 'audit_append parent-policy count').n).toBe('1');

    const partitions = await admin.query<{ n: string }>(
      `select count(*)::text as n
         from pg_policy p
         join pg_inherits i on i.inhrelid = p.polrelid
        where p.polname = 'audit_append'
          and i.inhparent = 'platform.audit_log'::regclass`,
    );
    expect(firstRow(partitions, 'audit_append partition-policy count').n).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Finding 4 — direct writes to a partition, bypassing the parent, are denied: UPDATE, DELETE and
// INSERT all fail with 42501 because pgeos_app holds no privilege on any partition (0007 §2b —
// the grant loop skips partitions and every existing partition is revoked; G7 catches a
// partition that regains a privilege). audit_append is parent-only (Finding 3, above).
// Partitions are read at run time from pg_inherits, not a fixed list — mirrors migration 0004's
// and 0007's own per-partition loops, so this test covers whatever partitions actually exist.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('as pgeos_app: direct writes to an audit_log partition are denied (Finding 4)', () => {
  const noopCtx: AppRoleCtx = { userId: null, clientId: null, isInternal: true };

  it('as pgeos_app: UPDATE/DELETE/INSERT directly on any platform.audit_log partition is denied', async () => {
    const partitions = await admin.query<{ table_name: string }>(
      `select (n.nspname || '.' || c.relname) as table_name
         from pg_inherits i
         join pg_class c on c.oid = i.inhrelid
         join pg_namespace n on n.oid = c.relnamespace
        where i.inhparent = 'platform.audit_log'::regclass
        order by 1`,
    );

    // Vacuity guard: a partitioned audit_log with zero partitions would make the loop below pass
    // trivially and prove nothing.
    if (partitions.rows.length === 0) {
      throw new Error(
        'vacuity guard: platform.audit_log has zero partitions — the per-partition denial assertions below would pass trivially',
      );
    }

    for (const { table_name: table } of partitions.rows) {
      // Identifiers (table names) are never parameterizable in SQL and come from a trusted
      // catalog read (pg_inherits via the admin connection), the same convention as
      // UPDATE_DELETE_REVOKED_TABLES above; only VALUES are parameterized.
      const attempts: ReadonlyArray<{ command: string; sql: string; params: readonly unknown[] }> = [
        { command: 'UPDATE', sql: `update ${table} set id = id where false`, params: [] },
        { command: 'DELETE', sql: `delete from ${table} where false`, params: [] },
        {
          command: 'INSERT',
          sql: `insert into ${table}
                  (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
                values (now(), null, 'user', $1, 'platform', '_app_role_rls_fixture', $2, 'insert')`,
          params: [entityAId, randomUUID()],
        },
      ];

      for (const { command, sql, params } of attempts) {
        let thrown: unknown = null;
        try {
          await withAppRole(noopCtx, (client) => client.query(sql, params as unknown[]));
        } catch (error) {
          thrown = error;
        }

        expect(thrown, `${command} directly on partition ${table} did not throw`).not.toBeNull();
        expect(
          sqlStateOf(thrown),
          `${command} directly on partition ${table} threw the wrong SQLSTATE`,
        ).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Test 7 — UPDATE/DELETE denied on the three append-only tables, one test, looping table x command
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('as pgeos_app: UPDATE/DELETE on the three append-only tables is denied', () => {
  const noopCtx: AppRoleCtx = { userId: null, clientId: null, isInternal: true };

  it('as pgeos_app: UPDATE/DELETE on audit_log, stock_movements, work_order_events is denied', async () => {
    for (const table of UPDATE_DELETE_REVOKED_TABLES) {
      for (const command of REVOKED_COMMANDS) {
        // `where false` — the privilege check happens regardless of which (if any) rows would
        // match, so this never mutates a real row even if the grant were mistakenly present.
        const sql =
          command === 'UPDATE'
            ? `update ${table} set id = id where false`
            : `delete from ${table} where false`;

        let thrown: unknown = null;
        try {
          await withAppRole(noopCtx, (client) => client.query(sql));
        } catch (error) {
          thrown = error;
        }

        expect(thrown, `${command} on ${table} did not throw`).not.toBeNull();
        expect(
          sqlStateOf(thrown),
          `${command} on ${table} threw the wrong SQLSTATE`,
        ).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Test 8 — No blanket EXECUTE grant — the two audit hash-chain functions stay denied
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('as pgeos_app: EXECUTE on the audit hash-chain functions is denied', () => {
  // has_function_privilege(...), via the admin connection, not a direct call as pgeos_app:
  // platform.audit_hash_chain() returns pseudo-type "trigger" and can only be invoked as a
  // trigger, never via SELECT, by ANY role — a direct call would fail on that type mismatch
  // regardless of GRANTs, which would prove nothing about privilege. has_function_privilege is the
  // simpler, honest way to prove the grant itself is absent.
  it('as pgeos_app: EXECUTE on audit_hash_chain() and verify_audit_chain() is denied', async () => {
    // Exact signatures, not guessed — 0004_M_audit-chain-seq.sql:87 defines
    // platform.audit_hash_chain() (a trigger function, no arguments) and :127/:215 define
    // platform.verify_audit_chain(bigint, text). has_function_privilege requires the exact
    // signature to disambiguate an overloaded name.
    const result = await admin.query<{ hash_chain: boolean; verify_chain: boolean }>(
      `select has_function_privilege($1, 'platform.audit_hash_chain()', 'EXECUTE') as hash_chain,
              has_function_privilege($1, 'platform.verify_audit_chain(bigint,text)', 'EXECUTE') as verify_chain`,
      [APP_ROLE],
    );

    const row = firstRow(result, 'has_function_privilege lookup for pgeos_app');
    expect(row.hash_chain).toBe(false);
    expect(row.verify_chain).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Test 9 — LEAN DESIGN: no privilege on any owner-rights view (views themselves are not altered;
// pgeos_app simply holds no grant on any view lacking security_invoker=true).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('as pgeos_app: no privilege on any owner-rights view', () => {
  it('as pgeos_app: no privilege on any owner-rights view (security_invoker not set)', async () => {
    const views = await admin.query<{ view_name: string; reloptions: string[] | null }>(
      `select (n.nspname || '.' || c.relname) as view_name, c.reloptions
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'v'
          and n.nspname = any($1::text[])
        order by 1`,
      [FOURTEEN_SCHEMAS as unknown as string[]],
    );

    // Vacuity guard: if this repo's schema somehow defined zero views across all fourteen
    // schemas, the loop below would pass trivially and prove nothing (this repo's own schema
    // files define at least a dozen distinct views today — database/schema/13B-Schema-Reference-
    // Consolidation.sql and 13-Schema-Additions.sql).
    if (views.rows.length === 0) {
      throw new Error(
        'vacuity guard: zero views found across the fourteen business schemas — the no-privilege assertion below would pass trivially',
      );
    }

    const ownerRightsViews = views.rows.filter(
      (row) => !(row.reloptions ?? []).includes('security_invoker=true'),
    );

    if (ownerRightsViews.length === 0) {
      throw new Error(
        'vacuity guard: zero owner-rights views found (every view already carries security_invoker=true) — the no-privilege assertion below would pass trivially',
      );
    }

    for (const view of ownerRightsViews) {
      const privilege = await admin.query<{ has_priv: boolean }>(
        `select has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') as has_priv`,
        [APP_ROLE, view.view_name],
      );
      const row = firstRow(privilege, `has_table_privilege lookup for ${view.view_name}`);
      expect(row.has_priv, `pgeos_app must hold no privilege on owner-rights view ${view.view_name}`).toBe(
        false,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Test 10 — Migration 0007 applied twice converges, and the extended G7 guard returns zero rows
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('0007 applied twice converges and G7 extended query returns 0', () => {
  interface CatalogSnapshot {
    readonly role: unknown;
    readonly entityScopeWithChecks: unknown;
    readonly grants: unknown;
  }

  async function catalogSnapshot(): Promise<CatalogSnapshot> {
    const role = await admin.query(
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, rolpassword
         from pg_authid where rolname = $1`,
      [APP_ROLE],
    );
    const entityScopeWithChecks = await admin.query(
      `select (n.nspname || '.' || c.relname) as table_name,
              pg_get_expr(p.polwithcheck, p.polrelid) as withcheck
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where p.polname = 'entity_scope' and n.nspname = any($1::text[])
        order by 1`,
      [FOURTEEN_SCHEMAS as unknown as string[]],
    );
    const grants = await admin.query(
      `select table_schema, table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = $1
        order by 1, 2, 3`,
      [APP_ROLE],
    );
    return {
      role: role.rows,
      entityScopeWithChecks: entityScopeWithChecks.rows,
      grants: grants.rows,
    };
  }

  // G7 extended, per the Master's revised design (fix round 1 — the "entity_id tables with no
  // entity_scope policy" clause is REMOVED: it flagged 9 reference/bespoke tables by 13B's own
  // design). Mirrors exactly:
  //   (a) policies named entity_scope in the 14 schemas with a null polwithcheck;
  //   (b) views in the 14 schemas without security_invoker=true on which pgeos_app holds any
  //       privilege.
  // guards.sql itself is Read-ONLY for this slice (schema, not a test file) — this query is this
  // suite's own, independently written proof of the same requirement.
  async function g7ExtendedRows(): Promise<unknown[]> {
    const result = await admin.query(
      `-- (a) an entity_scope policy with a null WITH CHECK
       select 'G7-entity-scope-withcheck' as guard, n.nspname as schema_name, c.relname as table_name
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where p.polname = 'entity_scope'
          and n.nspname = any($1::text[])
          and p.polwithcheck is null
       union all
       -- (b) any view without security_invoker=true on which pgeos_app holds any privilege
       select 'G7-view-privilege' as guard, n.nspname as schema_name, c.relname as table_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'v'
          and n.nspname = any($1::text[])
          and not (coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true'])
          and has_table_privilege('pgeos_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE')`,
      [FOURTEEN_SCHEMAS as unknown as string[]],
    );
    return result.rows;
  }

  it('0007 applied twice converges and G7 extended query returns 0', async () => {
    if (!existsSync(MIGRATION_FILE)) {
      throw new Error(
        `migration file not found: ${MIGRATION_FILE} — database/migrations/0007_M_pgeos-app-role-entity-scope.sql (D-133) has not been written yet`,
      );
    }
    const sqlText = readFileSync(MIGRATION_FILE, 'utf8');

    // WBS 0.15: stdin, not -f — database/schema/apply.sh's own header documents this at length
    // (a Windows psql -f corruption this repo could not fully root-cause). `input` here pipes the
    // file's own text to psql's stdin via Node's child_process, the exact mechanism apply.sh uses
    // via shell redirection (`psql ... < file`), not a re-typed shell command string.
    const psqlArgs = [
      '-X', '-q', '-v', 'ON_ERROR_STOP=1',
      '-h', PGHOST, '-p', PGPORT, '-U', SUPERUSER, '-d', PGDATABASE,
    ];

    execFileSync('psql', psqlArgs, { input: sqlText, encoding: 'utf8' });
    const before = await catalogSnapshot();

    execFileSync('psql', psqlArgs, { input: sqlText, encoding: 'utf8' });
    const after = await catalogSnapshot();

    expect(after).toEqual(before);

    const g7Rows = await g7ExtendedRows();
    expect(g7Rows).toEqual([]);

    // Fix round 1: 0007 alone re-grants DELETE broadly (its own grant loop) — apply.sh's real
    // sequence always runs every LATER migration afterward (0010 revokes DELETE on
    // platform.idempotency_keys again). Reproduce that same convergence here, in file order, so
    // this test leaves the dev DB in exactly the state a full `apply.sh` run would, not the
    // 0007-only intermediate state.
    const laterMigrations = migrationFilesFrom(7);
    expect(laterMigrations.length).toBeGreaterThan(0); // vacuity guard — 0007 itself must be found.
    for (const migrationFile of laterMigrations) {
      execFileSync('psql', psqlArgs, { input: readFileSync(migrationFile, 'utf8'), encoding: 'utf8' });
    }

    const deleteGrant = await admin.query<{ has_priv: boolean }>(
      `select has_table_privilege('pgeos_app', 'platform.idempotency_keys', 'DELETE') as has_priv`,
    );
    expect(firstRow(deleteGrant, 'has_table_privilege lookup for platform.idempotency_keys DELETE').has_priv).toBe(
      false,
    );
  });
});
