// tests/isolation/tests/system-actor-rls.test.ts — WBS 4.3 part 1a (pg-tester), D-212.
//
// Proves the executable half of tests/isolation/system-actor-rls.feature — the system actor
// identity (one identity.users row, user_entities for every entity) that works ONLY under the
// pgeos_worker database role, delivered by database/migrations/0048_M_system-actor-identity.sql,
// which is written AFTER this file. Brief: docs/notes/slice-briefs/_slice-4.3-p1a-system-actor.brief.md.
// pg-tester writes test files only; the migration is built by pg-builder-core.
//
// LIMIT (brief, "Note for the audit scenario"): `set role` is unusable (the binding reads
// session_user). The "worker admits it" half of audit_append is proven two ways: through the policy
// predicate platform.system_actor_permitted() on the worker's OWN connection, and — since the grants
// addendum (0048 Design E, INSERT on platform.audit_log) — by a real audit_log INSERT under pgeos_worker.
// The refusal under pgeos_app is a real INSERT attempt (42501). Every insert is rolled back so no audit
// row and no chain gap is ever committed.
//
// Like app-role-rls.test.ts this file opens its own pg.Client per role (superuser for the
// migration and fixtures, pgeos_app and pgeos_worker for the code under test) and reproduces the
// GUC contract of packages/db/src/with-context.ts (app.user_id, app.client_id, app.is_internal,
// app.entity_id via set_config(name, value, true)). Trust auth locally and in CI, no password.
// A missing migration file FAILS every test with a clear message — never a skip.
//
// Branch B limit (billable_events): when the local db has no sales.accounts / catalog.services row the
// insert falls back to an FK/not-null probe, which proves only that the privilege exists, not the row.
//
// Read control limit: when no wms.outbound_orders row exists locally the scoped-read positive control
// cannot run; it then writes READ_CONTROL_NOT_RUN to stdout (not proven, not skipped).
//
// The worker-side positive half of the idem_own predicate stays unprovable by a real INSERT: pgeos_worker
// has no grant on platform.idempotency_keys; the policy TEXT is asserted via pg_policies instead.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// tests/isolation/tests/system-actor-rls.test.ts -> tests/isolation/tests -> tests/isolation -> tests -> root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const MIGRATION_FILE = path.join(
  ROOT,
  'database',
  'migrations',
  '0048_M_system-actor-identity.sql',
);

// The nil uuid every seed already uses as changed_by (brief Design A) — the well-known system id.
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const SYSTEM_ACTOR_EMAIL = 'system@pg-eos.invalid';
const FIXTURE_USER_EMAIL = 'system-actor-rls.fixture@pg-eos.invalid';
const FIXTURE_USER_NAME = 'system-actor-rls fixture';
const SYSTEM_USER_TYPE = 'internal';
const SYSTEM_ACTOR_TYPE = 'system';
const USER_ACTOR_TYPE = 'user';

const APP_ROLE = 'pgeos_app';
const WORKER_ROLE = 'pgeos_worker';

const FN_SYSTEM_ACTOR_ID = 'system_actor_id';
const FN_SYSTEM_ACTOR_PERMITTED = 'system_actor_permitted';
const FN_ALLOWED_ENTITIES = 'allowed_entities';
const PLATFORM_FUNCTIONS = [FN_SYSTEM_ACTOR_ID, FN_SYSTEM_ACTOR_PERMITTED, FN_ALLOWED_ENTITIES] as const;
const POLICY_AUDIT_APPEND = 'audit_append';
const POLICY_IDEM_OWN = 'idem_own';
const PERMITTED_FN_MARKER = 'system_actor_permitted';
const SYSTEM_ACTOR_TYPE_CLAUSE = /actor_type\s*=\s*'system'/;
const SET_ROLE_WORKER_SQL = `set role ${WORKER_ROLE}`;
const IDEMPOTENCY_ENDPOINT = 'POST /system-actor-rls-fixture';
const IDEMPOTENCY_REQUEST_HASH = '0'.repeat(64); // check: request_hash ~ '^[0-9a-f]{64}$'
const PINNED_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';

/** SQLSTATE 42501 — insufficient_privilege (RLS WITH CHECK violation or missing GRANT). */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';

/** Property runs; the property is cheap (one SELECT per role per run). */
const PROPERTY_NUM_RUNS = 25;

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

function roleConnection(role: string): {
  host: string;
  port: number;
  user: string;
  database: string;
} {
  return { host: PGHOST, port: Number(PGPORT), user: role, database: PGDATABASE };
}

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

/** The GUCs packages/db/src/with-context.ts sets — names and set_config idiom copied verbatim. */
interface RoleCtx {
  readonly userId: string;
  readonly entityId: string | null;
}

/**
 * Runs `fn` on `client` inside ONE transaction with the GUCs set (is_internal = true, client_id
 * null) and ALWAYS rolls back — nothing here is ever committed.
 */
async function inRolledBackTx<T>(
  client: Client,
  ctx: RoleCtx,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query("select set_config('app.user_id', $1, true)", [ctx.userId]);
    await client.query("select set_config('app.client_id', $1, true)", [null]);
    await client.query("select set_config('app.is_internal', 'true', true)");
    await client.query("select set_config('app.entity_id', $1, true)", [ctx.entityId]);
    return await fn();
  } finally {
    await client.query('rollback');
  }
}

/** The ruled minimum grants (Master ruling #207, Design E) as a table/privilege matrix. */
interface PrivilegeExpectation {
  readonly table: string;
  readonly privilege: string;
  readonly expected: boolean;
}
const WORKER_TABLE_PRIVILEGES: readonly PrivilegeExpectation[] = [
  { table: 'catalog.services', privilege: 'SELECT', expected: true },
  { table: 'wms.outbound_orders', privilege: 'SELECT', expected: true },
  { table: 'billing.billable_events', privilege: 'SELECT', expected: true },
  { table: 'billing.billable_events', privilege: 'INSERT', expected: true },
  { table: 'platform.audit_log', privilege: 'INSERT', expected: true },
  { table: 'platform.outbox', privilege: 'INSERT', expected: true },
  { table: 'catalog.services', privilege: 'INSERT', expected: false },
  { table: 'wms.outbound_orders', privilege: 'INSERT', expected: false },
  { table: 'catalog.services', privilege: 'UPDATE', expected: false },
  { table: 'wms.outbound_orders', privilege: 'UPDATE', expected: false },
  { table: 'billing.billable_events', privilege: 'UPDATE', expected: false },
  { table: 'platform.audit_log', privilege: 'UPDATE', expected: false },
  { table: 'platform.outbox', privilege: 'DELETE', expected: false },
  { table: 'catalog.services', privilege: 'DELETE', expected: false },
  { table: 'wms.outbound_orders', privilege: 'DELETE', expected: false },
  { table: 'billing.billable_events', privilege: 'DELETE', expected: false },
  { table: 'platform.audit_log', privilege: 'DELETE', expected: false },
];
const WORKER_USAGE_SCHEMAS = ['catalog', 'wms', 'billing'] as const;
const WORKER_EXECUTE_FUNCTIONS = [
  'platform.allowed_entities()',
  'platform.current_user_id()',
] as const;
const OUTBOX_ID_SEQUENCE = 'platform.outbox_id_seq';
const AUDIT_ID_SEQUENCE = 'platform.audit_log_id_seq';
const WORKER_SEQUENCES = [AUDIT_ID_SEQUENCE, OUTBOX_ID_SEQUENCE] as const;
const SEQUENCE_DENIED_PRIVILEGES = ['SELECT', 'UPDATE'] as const;
const FIVE_TABLES = [
  'catalog.services',
  'wms.outbound_orders',
  'billing.billable_events',
  'platform.audit_log',
  'platform.outbox',
] as const;
const EXTRA_DENIED_PRIVILEGES: readonly PrivilegeExpectation[] = [
  { table: 'platform.audit_log', privilege: 'SELECT', expected: false },
  { table: 'platform.outbox', privilege: 'UPDATE', expected: false },
  ...FIVE_TABLES.map((table) => ({ table, privilege: 'TRUNCATE', expected: false })),
];
const WORKER_EXECUTE_EXTRA_FUNCTIONS = [
  'platform.system_actor_permitted()',
  'platform.system_actor_id()',
] as const;
/** The EXACT set of grants pgeos_worker may hold (Design E + 0039 outbox relay), sorted. */
const EXPECTED_WORKER_ACL: readonly string[] = [
  'billing.billable_events:INSERT',
  'billing.billable_events:SELECT',
  'catalog.services:SELECT',
  'platform.audit_log:INSERT',
  'platform.audit_log_id_seq:USAGE',
  'platform.outbox.attempts:UPDATE',
  'platform.outbox.last_error:UPDATE',
  'platform.outbox.published_at:UPDATE',
  'platform.outbox:INSERT',
  'platform.outbox:SELECT',
  'platform.outbox_id_seq:USAGE',
  'wms.outbound_orders:SELECT',
];
const WORKER_ACL_SQL = `
  select n.nspname || '.' || c.relname || ':' || a.privilege_type as grant_key
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
   where c.relkind in ('r', 'p', 'S', 'v', 'm', 'f') and a.grantee = $1::regrole
     and n.nspname not in ('pg_catalog', 'information_schema')
  union all
  select n.nspname || '.' || c.relname || '.' || t.attname || ':' || a.privilege_type
    from pg_attribute t
    join pg_class c on c.oid = t.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(t.attacl) a
   where a.grantee = $1::regrole and n.nspname not in ('pg_catalog', 'information_schema')`;
const EXPECTED_WORKER_SCHEMA_USAGE: readonly string[] = ['billing:USAGE', 'catalog:USAGE', 'platform:USAGE', 'wms:USAGE'];
const WORKER_SCHEMA_ACL_SQL = `
  select n.nspname || ':' || a.privilege_type as grant_key
    from pg_namespace n
    cross join lateral aclexplode(n.nspacl) a
   where a.grantee = $1::regrole`;
const READ_CONTROL_NOT_RUN =
  'positive read control did NOT run: no wms.outbound_orders row exists locally (control skipped, not proven)';
const WORKER_READ_TABLES = ['wms.outbound_orders', 'catalog.services'] as const;
const BILLABLE_FIXTURE_QTY = '1';
const BILLABLE_FIXTURE_UOM = 'each';
const NIL_UUID_PROBE = '00000000-0000-0000-0000-000000000000';
const FOREIGN_KEY_VIOLATION_SQLSTATE = '23503';
const NOT_NULL_VIOLATION_SQLSTATE = '23502';

let admin: Client;
let appClient: Client;
let workerClient: Client;
let migrationPresent = false;
let entityIds: string[] = [];

function requireMigration(): void {
  if (!migrationPresent) {
    throw new Error(
      `RED: migration file not found: ${MIGRATION_FILE} — database/migrations/0048_M_system-actor-identity.sql (D-212, WBS 4.3 part 1a) has not been written yet`,
    );
  }
}

async function applyMigration(): Promise<void> {
  // One `begin … commit` block; a multi-statement simple query runs it as written.
  await admin.query(readFileSync(MIGRATION_FILE, 'utf8'));
}

beforeAll(async () => {
  admin = new Client(SUPERUSER_CONNECTION);
  appClient = new Client(roleConnection(APP_ROLE));
  workerClient = new Client(roleConnection(WORKER_ROLE));
  try {
    await admin.connect();
    await appClient.connect();
    await workerClient.connect();
  } catch (error) {
    throw new Error(
      `system-actor-rls.test.ts: could not connect to Postgres at ${PGHOST}:${PGPORT}/${PGDATABASE} — ${String(error)}`,
      { cause: error },
    );
  }
  migrationPresent = existsSync(MIGRATION_FILE);
  if (migrationPresent) {
    await applyMigration();
  }
  const entities = await admin.query<{ id: string }>('select id from platform.entities order by id');
  entityIds = entities.rows.map((row) => row.id);
});

afterAll(async () => {
  // Remove the ordinary-user fixture this file created (its other rows live in rolled-back transactions).
  await admin?.query('delete from identity.users where email = $1', [FIXTURE_USER_EMAIL]);
  await Promise.all([admin?.end(), appClient?.end(), workerClient?.end()]);
});

const SYSTEM_CTX: RoleCtx = { userId: SYSTEM_ACTOR_ID, entityId: null };

describe('4.3 part 1a — the system actor identity works only under pgeos_worker (D-212)', () => {
  it('the system actor row exists once, internal, active, with no session and a user_entities row for every entity', async () => {
    requireMigration();
    expect(entityIds.length).toBeGreaterThan(0); // vacuity guard: platform.entities is seeded

    const users = await admin.query<{
      email: string;
      user_type: string;
      is_active: boolean;
    }>('select email, user_type, is_active from identity.users where id = $1', [SYSTEM_ACTOR_ID]);
    expect(users.rows).toHaveLength(1);
    const user = firstRow(users, 'identity.users system actor row');
    expect(user.email).toBe(SYSTEM_ACTOR_EMAIL);
    expect(user.user_type).toBe(SYSTEM_USER_TYPE);
    expect(user.is_active).toBe(true);

    const sessions = await admin.query<{ n: string }>(
      'select count(*)::text as n from identity.sessions where user_id = $1',
      [SYSTEM_ACTOR_ID],
    );
    expect(firstRow(sessions, 'identity.sessions count').n).toBe('0');

    const memberships = await admin.query<{ entity_id: string }>(
      'select entity_id from identity.user_entities where user_id = $1 order by entity_id',
      [SYSTEM_ACTOR_ID],
    );
    expect(memberships.rows.map((row) => row.entity_id)).toEqual(entityIds);
  });

  it('under pgeos_worker the system actor sees every entity (allowed_entities = all platform.entities) and an active entity narrows it (app.entity_id)', async () => {
    requireMigration();
    expect(entityIds.length).toBeGreaterThan(1); // vacuity guard: narrowing needs > 1 entity
    const allowedSql = 'select platform.allowed_entities()::text[] as ids';

    const all = await inRolledBackTx(workerClient, SYSTEM_CTX, () =>
      workerClient.query<{ ids: string[] }>(allowedSql),
    );
    expect([...firstRow(all, 'allowed_entities under worker').ids].sort()).toEqual(entityIds);

    const activeId = entityIds[0];
    if (activeId === undefined) {
      throw new Error('no entity id available for the active-entity narrowing check');
    }
    const narrowed = await inRolledBackTx(
      workerClient,
      { userId: SYSTEM_ACTOR_ID, entityId: activeId },
      () => workerClient.query<{ ids: string[] }>(allowedSql),
    );
    expect(firstRow(narrowed, 'allowed_entities under worker, active entity').ids).toEqual([activeId]);
  });

  it('under pgeos_app the same GUCs resolve to no entities and an entity-scoped read returns zero rows', async () => {
    requireMigration();
    // Positive control: the membership rows exist, so zero rows below is the role binding, not absence.
    const memberships = await admin.query<{ n: string }>(
      'select count(*)::text as n from identity.user_entities where user_id = $1',
      [SYSTEM_ACTOR_ID],
    );
    expect(Number(firstRow(memberships, 'system user_entities count').n)).toBe(entityIds.length);
    expect(entityIds.length).toBeGreaterThan(0);

    const allowed = await inRolledBackTx(appClient, SYSTEM_CTX, () =>
      appClient.query<{ ids: string[] }>('select platform.allowed_entities()::text[] as ids'),
    );
    expect(firstRow(allowed, 'allowed_entities under app').ids).toEqual([]);

    const scoped = await inRolledBackTx(appClient, SYSTEM_CTX, () =>
      appClient.query<{ n: string }>(
        'select count(*)::text as n from identity.user_entities where user_id = $1',
        [SYSTEM_ACTOR_ID],
      ),
    );
    expect(firstRow(scoped, 'entity-scoped read under app').n).toBe('0');
  });

  it('under pgeos_app an audit_log insert as the system actor is refused with 42501, under pgeos_worker audit_append admits it (actor_type system)', async () => {
    requireMigration();
    const entityId = entityIds[0];
    if (entityId === undefined) {
      throw new Error('no entity id available for the audit_log insert');
    }
    const insertSql = `insert into platform.audit_log
        (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
      values (now(), $1, $2, $3, 'platform', '_system_actor_rls_fixture', $4, 'insert')`;

    // Positive control: an ordinary user's own insert under pgeos_app is admitted (rolled back),
    // so the refusal below comes from the system-actor binding, not from a generic denial.
    const ordinaryUserId = '11111111-1111-4111-8111-111111111111';
    const ordinaryRecordId = '22222222-2222-4222-8222-222222222222';
    await inRolledBackTx(appClient, { userId: ordinaryUserId, entityId: null }, () =>
      appClient.query(insertSql, [ordinaryUserId, USER_ACTOR_TYPE, entityId, ordinaryRecordId]),
    );

    let thrown: unknown = null;
    try {
      await inRolledBackTx(appClient, SYSTEM_CTX, () =>
        appClient.query(insertSql, [SYSTEM_ACTOR_ID, SYSTEM_ACTOR_TYPE, entityId, ordinaryRecordId]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(sqlStateOf(thrown)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);

    // Worker half (see LIMIT in the header): the audit_append predicate is admitted for the system
    // actor on the worker's own connection and refused on the app connection.
    const permittedSql = 'select platform.system_actor_permitted() as permitted';
    const underWorker = await inRolledBackTx(workerClient, SYSTEM_CTX, () =>
      workerClient.query<{ permitted: boolean }>(permittedSql),
    );
    expect(firstRow(underWorker, 'system_actor_permitted under worker').permitted).toBe(true);
    const underApp = await inRolledBackTx(appClient, SYSTEM_CTX, () =>
      appClient.query<{ permitted: boolean }>(permittedSql),
    );
    expect(firstRow(underApp, 'system_actor_permitted under app').permitted).toBe(false);
  });

  it('platform.system_actor_id, platform.system_actor_permitted and platform.allowed_entities are SECURITY DEFINER with search_path pinned to pg_catalog, pg_temp', async () => {
    requireMigration();
    const result = await admin.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'platform' and p.proname = any($1::text[])
        order by p.proname`,
      [[...PLATFORM_FUNCTIONS]],
    );
    expect(result.rows.map((row) => row.proname)).toEqual([...PLATFORM_FUNCTIONS].sort());
    for (const row of result.rows) {
      expect(row.prosecdef, `platform.${row.proname} is not SECURITY DEFINER`).toBe(true);
      expect(row.proconfig ?? [], `platform.${row.proname} search_path not pinned`).toContain(
        PINNED_SEARCH_PATH,
      );
    }
  });

  it('under pgeos_app the system actor cannot insert an idempotency key with a null entity, an ordinary user can', async () => {
    requireMigration();
    await admin.query(
      `insert into identity.users (email, full_name_ar, user_type, is_active)
       values ($1, $2, $3, true) on conflict (email) do nothing`,
      [FIXTURE_USER_EMAIL, FIXTURE_USER_NAME, SYSTEM_USER_TYPE],
    );
    const other = await admin.query<{ id: string }>('select id from identity.users where email = $1', [
      FIXTURE_USER_EMAIL,
    ]);
    const ordinaryUserId = firstRow(other, 'the fixture identity.users row').id;
    const insertSql = `insert into platform.idempotency_keys (user_id, key, entity_id, endpoint, request_hash)
      values ($1, $2, null, $3, $4)`;
    const fixtureKey = 'system-actor-rls-fixture-key';

    // Positive control: an ordinary user's own null-entity key is admitted (rolled back).
    await inRolledBackTx(appClient, { userId: ordinaryUserId, entityId: null }, () =>
      appClient.query(insertSql, [ordinaryUserId, fixtureKey, IDEMPOTENCY_ENDPOINT, IDEMPOTENCY_REQUEST_HASH]),
    );

    let thrown: unknown = null;
    try {
      await inRolledBackTx(appClient, SYSTEM_CTX, () =>
        appClient.query(insertSql, [SYSTEM_ACTOR_ID, fixtureKey, IDEMPOTENCY_ENDPOINT, IDEMPOTENCY_REQUEST_HASH]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(sqlStateOf(thrown)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
  });

  it("the audit_append policy requires actor_type system for the system actor's rows", async () => {
    requireMigration();
    const policy = await admin.query<{ with_check: string | null }>(
      `select with_check from pg_policies
        where schemaname = 'platform' and tablename = 'audit_log' and policyname = $1`,
      [POLICY_AUDIT_APPEND],
    );
    expect(policy.rows).toHaveLength(1);
    const withCheck = firstRow(policy, 'audit_append policy').with_check ?? '';
    expect(withCheck).toContain(PERMITTED_FN_MARKER);
    expect(withCheck).toMatch(SYSTEM_ACTOR_TYPE_CLAUSE);

    const entityId = entityIds[0];
    if (entityId === undefined) {
      throw new Error('no entity id available for the audit_log insert');
    }
    const insertSql = `insert into platform.audit_log
        (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
      values (now(), $1, $2, $3, 'platform', '_system_actor_rls_fixture', $4, 'insert')`;
    const recordId = '33333333-3333-4333-8333-333333333333';
    // Under pgeos_app both the wrong and the right actor_type are refused: the role binding (42501).
    for (const actorType of [USER_ACTOR_TYPE, SYSTEM_ACTOR_TYPE]) {
      let thrown: unknown = null;
      try {
        await inRolledBackTx(appClient, SYSTEM_CTX, () =>
          appClient.query(insertSql, [SYSTEM_ACTOR_ID, actorType, entityId, recordId]),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `actor_type ${actorType} insert did not throw`).not.toBeNull();
      expect(sqlStateOf(thrown)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    }
  });

  it('under pgeos_app set role pgeos_worker is refused with 42501 and an active member entity still resolves to no entities for the system id', async () => {
    requireMigration();
    let thrown: unknown = null;
    await appClient.query('begin');
    try {
      await appClient.query(SET_ROLE_WORKER_SQL);
    } catch (error) {
      thrown = error;
    } finally {
      await appClient.query('rollback');
    }
    expect(thrown).not.toBeNull();
    expect(sqlStateOf(thrown)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);

    const memberEntityId = entityIds[0];
    if (memberEntityId === undefined) {
      throw new Error('no entity id available for the active-entity check');
    }
    const membership = await admin.query<{ n: string }>(
      'select count(*)::text as n from identity.user_entities where user_id = $1 and entity_id = $2',
      [SYSTEM_ACTOR_ID, memberEntityId],
    );
    expect(firstRow(membership, 'system actor membership of the active entity').n).toBe('1');

    const allowed = await inRolledBackTx(
      appClient,
      { userId: SYSTEM_ACTOR_ID, entityId: memberEntityId },
      () => appClient.query<{ ids: string[] }>('select platform.allowed_entities()::text[] as ids'),
    );
    expect(firstRow(allowed, 'allowed_entities under app, active member entity').ids).toEqual([]);
  });

  it('applying the migration twice changes nothing (idempotent) and keeps the binding on audit_append (parent only), allowed_entities and idem_own', async () => {
    requireMigration();
    async function counts(): Promise<{ users: string; memberships: string }> {
      const users = await admin.query<{ n: string }>(
        'select count(*)::text as n from identity.users',
      );
      const memberships = await admin.query<{ n: string }>(
        'select count(*)::text as n from identity.user_entities',
      );
      return {
        users: firstRow(users, 'identity.users count').n,
        memberships: firstRow(memberships, 'identity.user_entities count').n,
      };
    }
    const before = await counts();
    await applyMigration();
    await applyMigration();
    expect(await counts()).toEqual(before);

    const parent = await admin.query<{ with_check: string | null }>(
      `select with_check from pg_policies
        where schemaname = 'platform' and tablename = 'audit_log' and policyname = $1`,
      [POLICY_AUDIT_APPEND],
    );
    expect(parent.rows).toHaveLength(1);
    expect(firstRow(parent, 'audit_append on parent').with_check ?? '').toContain(PERMITTED_FN_MARKER);

    const partitions = await admin.query<{ n: string }>(
      `select count(*)::text as n
         from pg_policy p
         join pg_inherits i on i.inhrelid = p.polrelid
        where p.polname = $1 and i.inhparent = 'platform.audit_log'::regclass`,
      [POLICY_AUDIT_APPEND],
    );
    expect(firstRow(partitions, 'audit_append partition-policy count').n).toBe('0');

    const definition = await admin.query<{ def: string }>(
      "select pg_get_functiondef('platform.allowed_entities()'::regprocedure) as def",
    );
    expect(firstRow(definition, 'allowed_entities definition').def).toContain(PERMITTED_FN_MARKER);

    const idem = await admin.query<{ qual: string | null; with_check: string | null }>(
      `select qual, with_check from pg_policies
        where schemaname = 'platform' and tablename = 'idempotency_keys' and policyname = $1`,
      [POLICY_IDEM_OWN],
    );
    expect(idem.rows).toHaveLength(1);
    const idemRow = firstRow(idem, 'idem_own policy');
    expect(idemRow.qual ?? '').toContain(PERMITTED_FN_MARKER);
    expect(idemRow.with_check ?? '').toContain(PERMITTED_FN_MARKER);
  });

  it('property: for any random uuid other than the system id, system_actor_permitted() is true under both roles', async () => {
    requireMigration();
    const permittedSql = 'select platform.system_actor_permitted() as permitted';
    await fc.assert(
      fc.asyncProperty(
        fc.uuid().filter((id) => id !== SYSTEM_ACTOR_ID),
        async (userId) => {
          for (const client of [appClient, workerClient]) {
            const result = await inRolledBackTx(client, { userId, entityId: null }, () =>
              client.query<{ permitted: boolean }>(permittedSql),
            );
            if (firstRow(result, 'system_actor_permitted property').permitted !== true) {
              return false;
            }
          }
          return true;
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('pgeos_worker holds exactly the ruled minimum grants and nothing more, still without BYPASSRLS', async () => {
    requireMigration();
    for (const { table, privilege, expected } of WORKER_TABLE_PRIVILEGES) {
      const result = await admin.query<{ held: boolean }>(
        'select has_table_privilege($1, $2, $3) as held',
        [WORKER_ROLE, table, privilege],
      );
      expect(
        firstRow(result, `has_table_privilege ${table} ${privilege}`).held,
        `${WORKER_ROLE} ${privilege} on ${table} expected ${String(expected)}`,
      ).toBe(expected);
    }
    for (const schema of WORKER_USAGE_SCHEMAS) {
      const result = await admin.query<{ held: boolean }>(
        "select has_schema_privilege($1, $2, 'USAGE') as held",
        [WORKER_ROLE, schema],
      );
      expect(firstRow(result, `has_schema_privilege ${schema}`).held, `USAGE on schema ${schema}`).toBe(true);
    }
    for (const fn of [...WORKER_EXECUTE_FUNCTIONS, ...WORKER_EXECUTE_EXTRA_FUNCTIONS]) {
      const result = await admin.query<{ held: boolean }>(
        "select has_function_privilege($1, $2, 'EXECUTE') as held",
        [WORKER_ROLE, fn],
      );
      expect(firstRow(result, `has_function_privilege ${fn}`).held, `EXECUTE on ${fn}`).toBe(true);
    }
    for (const sequenceName of WORKER_SEQUENCES) {
      const usage = await admin.query<{ held: boolean }>(
        "select has_sequence_privilege($1, $2, 'USAGE') as held",
        [WORKER_ROLE, sequenceName],
      );
      expect(firstRow(usage, `has_sequence_privilege ${sequenceName}`).held, `USAGE on ${sequenceName}`).toBe(true);
      for (const privilege of SEQUENCE_DENIED_PRIVILEGES) {
        const denied = await admin.query<{ held: boolean }>(
          'select has_sequence_privilege($1, $2, $3) as held',
          [WORKER_ROLE, sequenceName, privilege],
        );
        expect(firstRow(denied, `has_sequence_privilege ${sequenceName} ${privilege}`).held, `${privilege} on ${sequenceName}`).toBe(false);
      }
    }
    for (const { table, privilege, expected } of EXTRA_DENIED_PRIVILEGES) {
      const result = await admin.query<{ held: boolean }>(
        'select has_table_privilege($1, $2, $3) as held',
        [WORKER_ROLE, table, privilege],
      );
      expect(firstRow(result, `has_table_privilege ${table} ${privilege}`).held, `${privilege} on ${table}`).toBe(expected);
    }
    // "nothing more": the exact grant set, tables + sequences + column grants, over the whole catalog.
    const acl = await admin.query<{ grant_key: string }>(WORKER_ACL_SQL, [WORKER_ROLE]);
    expect(acl.rows.map((row) => row.grant_key).sort()).toEqual([...EXPECTED_WORKER_ACL]);
    const schemaAcl = await admin.query<{ grant_key: string }>(WORKER_SCHEMA_ACL_SQL, [WORKER_ROLE]);
    expect(schemaAcl.rows.map((row) => row.grant_key).sort()).toEqual([...EXPECTED_WORKER_SCHEMA_USAGE]);
    const role = await admin.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'select rolbypassrls, rolsuper from pg_roles where rolname = $1',
      [WORKER_ROLE],
    );
    const roleRow = firstRow(role, 'pg_roles pgeos_worker');
    expect(roleRow.rolbypassrls).toBe(false);
    expect(roleRow.rolsuper).toBe(false);
  });

  it('under pgeos_worker the system actor can read wms.outbound_orders and catalog.services, insert a billing.billable_events row, an audit_log row with actor_type system and an outbox row inside its entity scope, and a row outside the scope is refused', async () => {
    requireMigration();
    expect(entityIds.length).toBeGreaterThan(1); // vacuity guard: the outside-scope half needs 2 entities
    const [scopeEntityId, otherEntityId] = entityIds;
    if (scopeEntityId === undefined || otherEntityId === undefined) {
      throw new Error('two entity ids are required for the scope check');
    }
    const scopedCtx: RoleCtx = { userId: SYSTEM_ACTOR_ID, entityId: scopeEntityId };

    // Reads: the query resolves (no 42501); counts may be 0.
    for (const table of WORKER_READ_TABLES) {
      const result = await inRolledBackTx(workerClient, SYSTEM_CTX, () =>
        workerClient.query<{ n: string }>(`select count(*)::text as n from ${table}`),
      );
      expect(firstRow(result, `count ${table} under worker`).n).toMatch(/^\d+$/);
    }

    // Positive control (nit): a scoped worker sees the rows of an entity that has outbound orders.
    const populated = await admin.query<{ entity_id: string }>(
      'select entity_id from wms.outbound_orders order by entity_id limit 1',
    );
    const populatedRow = populated.rows[0];
    let controlRows: number | null = null;
    if (populatedRow) {
      const seen = await inRolledBackTx(
        workerClient,
        { userId: SYSTEM_ACTOR_ID, entityId: populatedRow.entity_id },
        () => workerClient.query<{ n: string }>('select count(*)::text as n from wms.outbound_orders'),
      );
      controlRows = Number(firstRow(seen, 'scoped wms.outbound_orders count').n);
    }
    if (controlRows === null) {
      process.stdout.write(`${READ_CONTROL_NOT_RUN}\n`);
    }
    expect(controlRows ?? 1, READ_CONTROL_NOT_RUN).toBeGreaterThanOrEqual(1);

    const auditSql = `insert into platform.audit_log
        (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
      values (now(), $1, $2, $3, 'platform', '_system_actor_rls_fixture', $4, 'insert')`;
    const auditRecordId = '44444444-4444-4444-8444-444444444444';
    await inRolledBackTx(workerClient, scopedCtx, () =>
      workerClient.query(auditSql, [SYSTEM_ACTOR_ID, SYSTEM_ACTOR_TYPE, scopeEntityId, auditRecordId]),
    );

    const outboxSql = `insert into platform.outbox
        (aggregate_type, aggregate_id, event_type, payload, correlation_id, entity_id)
      values ('billing.fixture', $1, 'billing.fixture.created', '{}'::jsonb, $2, $3)`;
    const outboxCorrelationId = '55555555-5555-4555-8555-555555555555';
    await inRolledBackTx(workerClient, scopedCtx, () =>
      workerClient.query(outboxSql, [auditRecordId, outboxCorrelationId, scopeEntityId]),
    );

    // billing.billable_events needs a sales.accounts and a catalog.services row (FKs).
    const client = await admin.query<{ id: string }>('select id from sales.accounts order by id limit 1');
    const service = await admin.query<{ id: string }>('select id from catalog.services order by id limit 1');
    const billableSql = `insert into billing.billable_events
        (entity_id, occurred_at, client_id, service_id, qty, uom, source_module, source_table, source_id)
      values ($1, now(), $2, $3, $4, $5, 'wms', '_system_actor_rls_fixture', $6)`;
    const clientRow = client.rows[0];
    const serviceRow = service.rows[0];
    if (clientRow && serviceRow) {
      // Branch A: fixtures exist -> the insert must succeed.
      await inRolledBackTx(workerClient, scopedCtx, () =>
        workerClient.query(billableSql, [
          scopeEntityId,
          clientRow.id,
          serviceRow.id,
          BILLABLE_FIXTURE_QTY,
          BILLABLE_FIXTURE_UOM,
          auditRecordId,
        ]),
      );
    } else {
      // Branch B: no fixtures -> the privilege is there; the error is an FK/not-null one, never 42501.
      let thrown: unknown = null;
      try {
        await inRolledBackTx(workerClient, scopedCtx, () =>
          workerClient.query(billableSql, [
            scopeEntityId,
            NIL_UUID_PROBE,
            NIL_UUID_PROBE,
            BILLABLE_FIXTURE_QTY,
            BILLABLE_FIXTURE_UOM,
            auditRecordId,
          ]),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).not.toBeNull();
      expect([FOREIGN_KEY_VIOLATION_SQLSTATE, NOT_NULL_VIOLATION_SQLSTATE]).toContain(sqlStateOf(thrown));
    }

    // Outside the scope: active entity A, outbox row for entity B -> entity_scope refuses (42501).
    // (Not audit_log: its permissive audit_append policy ignores entity_id, so it admits by design.)
    let refused: unknown = null;
    try {
      await inRolledBackTx(workerClient, scopedCtx, () =>
        workerClient.query(outboxSql, [auditRecordId, outboxCorrelationId, otherEntityId]),
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).not.toBeNull();
    expect(sqlStateOf(refused)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
  });
});
