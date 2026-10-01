// tests/isolation/tests/platform-scoped-writers.test.ts — D-213 step 1 (pg-tester).
//
// Executable half of tests/isolation/platform-scoped-writers.feature: the named SECURITY DEFINER
// writers platform.write_platform_audit / platform.write_platform_event, delivered by
// database/migrations/0049_M_platform-scoped-writers.sql (written AFTER this file, by pg-builder-core).
// Brief: docs/notes/slice-briefs/_slice-X-d213-0049.brief.md. Every write runs in a transaction that is
// rolled back; a missing migration file FAILS every test with an explicit RED message — never a skip.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRATION_FILE = path.join(ROOT, 'database', 'migrations', '0049_M_platform-scoped-writers.sql');

const FIXTURE_USER_EMAIL = 'platform-scoped-writers.fixture@pg-eos.invalid';
const FIXTURE_USER_NAME = 'platform-scoped-writers fixture';
const FIXTURE_USER_TYPE = 'internal';
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const NON_ALLOWLISTED_TABLE = ['billing', 'invoice_lines'] as const; // no entity_id, parent-scoped, not allowlisted
const EXISTING_VIEW = ['wms', 'reservations_aging'] as const;
const TEMP_TABLE = 'x_d213_probe_tmp';
const PASSED_RECORD_ID = '66666666-6666-4666-8666-666666666666';
const PASSED_CORRELATION_ID = '77777777-7777-4777-8777-777777777777';
const PASSED_OPERATION = 'update';
const PASSED_OLD_VALUE = { before: 1 };
const PASSED_NEW_VALUE = { after: 2 };
const USER_ACTOR_TYPE = 'user';
const SYSTEM_ACTOR_TYPE = 'system';

const APP_ROLE = 'pgeos_app';
const WORKER_ROLE = 'pgeos_worker';
const FN_AUDIT = 'write_platform_audit';
const FN_EVENT = 'write_platform_event';
const PLATFORM_SCHEMA = 'platform';
const WRITER_FUNCTIONS = [FN_AUDIT, FN_EVENT] as const;
const PINNED_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
const PUBLIC_GRANTEE_OID = 0;

const AUDIT_SIGNATURE =
  'platform.write_platform_audit(timestamptz, text, text, uuid, text, jsonb, uuid, jsonb)';
const EVENT_SIGNATURE = 'platform.write_platform_event(text, uuid, text, jsonb, uuid, uuid)';
const SIGNATURES = [AUDIT_SIGNATURE, EVENT_SIGNATURE] as const;

const PLATFORM_AUDIT_SQL = `select platform.write_platform_audit(
  now(), 'platform', 'alert_log', null, 'insert', '{"probe":true}'::jsonb, gen_random_uuid()) as id`;
const ENTITY_TABLE_AUDIT_SQL = `select platform.write_platform_audit(
  now(), 'wms', 'outbound_orders', null, 'insert', '{"probe":true}'::jsonb, gen_random_uuid()) as id`;
const UNKNOWN_TABLE_AUDIT_SQL = `select platform.write_platform_audit(
  now(), 'platform', 'no_such_table', null, 'insert', '{"probe":true}'::jsonb, gen_random_uuid()) as id`;
const AUDIT_ARGS = ["now()", "'platform'", "'alert_log'", "'insert'", 'gen_random_uuid()'] as const;
const EVENT_ARGS = ["'platform.probe'", 'gen_random_uuid()', "'platform.probe.happened'", "'{}'::jsonb", 'gen_random_uuid()'] as const;
// Each required argument null in turn, the others valid. Audit order: occurred_at, schema, table, operation, correlation_id.
const NULL_ARG_SQLS: readonly string[] = AUDIT_ARGS.map((_, i) => {
  const a = AUDIT_ARGS.map((arg, j) => (j === i ? 'null' : arg));
  return `select platform.write_platform_audit(${a[0]}, ${a[1]}, ${a[2]}, null, ${a[3]}, '{}'::jsonb, ${a[4]})`;
});
// Event order: aggregate_type, aggregate_id, event_type, payload, correlation_id.
const NULL_EVENT_SQLS: readonly string[] = EVENT_ARGS.map((_, i) => {
  const a = EVENT_ARGS.map((arg, j) => (j === i ? 'null' : arg));
  return `select platform.write_platform_event(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]}, ${a[4]})`;
});
const PLATFORM_EVENT_SQL = `select platform.write_platform_event(
  'platform.probe', gen_random_uuid(), 'platform.probe.happened', '{}'::jsonb, gen_random_uuid()) as id`;
const BUSINESS_EVENT_SQL = `select platform.write_platform_event(
  'wms.outbound_order', gen_random_uuid(), 'wms.outbound_order.probe', '{}'::jsonb, gen_random_uuid()) as id`;

/** SQLSTATE 42501 — insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';

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

function roleConnection(role: string): { host: string; port: number; user: string; database: string } {
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

interface Ctx {
  readonly userId: string;
  readonly isInternal: boolean;
}

/** GUCs as packages/db/src/with-context.ts sets them; ALWAYS rolled back. */
async function inRolledBackTx<T>(client: Client, ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    await client.query("select set_config('app.user_id', $1, true)", [ctx.userId]);
    await client.query("select set_config('app.client_id', $1, true)", [null]);
    await client.query("select set_config('app.is_internal', $1, true)", [String(ctx.isInternal)]);
    await client.query("select set_config('app.entity_id', $1, true)", [null]);
    return await fn();
  } finally {
    await client.query('rollback');
  }
}

async function refusalOf(client: Client, ctx: Ctx, sql: string): Promise<string | undefined> {
  let thrown: unknown = null;
  try {
    await inRolledBackTx(client, ctx, () => client.query(sql));
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected a refusal for: ${sql}`).not.toBeNull();
  return sqlStateOf(thrown);
}

let admin: Client;
let appClient: Client;
let workerClient: Client;
let migrationPresent = false;
let fixtureUserId = '';

function requireMigration(): void {
  if (!migrationPresent) {
    throw new Error(
      `RED: migration file not found: ${MIGRATION_FILE} — database/migrations/0049_M_platform-scoped-writers.sql (D-213 step 1) has not been written yet`,
    );
  }
}

async function applyMigration(): Promise<void> {
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
      `platform-scoped-writers.test.ts: could not connect to Postgres at ${PGHOST}:${PGPORT}/${PGDATABASE} — ${String(error)}`,
      { cause: error },
    );
  }
  await admin.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, $3, true) on conflict (email) do nothing`,
    [FIXTURE_USER_EMAIL, FIXTURE_USER_NAME, FIXTURE_USER_TYPE],
  );
  const user = await admin.query<{ id: string }>('select id from identity.users where email = $1', [
    FIXTURE_USER_EMAIL,
  ]);
  fixtureUserId = firstRow(user, 'fixture identity.users row').id;
  migrationPresent = existsSync(MIGRATION_FILE);
  if (migrationPresent) {
    await applyMigration();
  }
});

afterAll(async () => {
  await admin?.query('delete from identity.users where email = $1', [FIXTURE_USER_EMAIL]);
  await Promise.all([admin?.end(), appClient?.end(), workerClient?.end()]);
});

describe('D-213 step 1 — platform-scoped rows are written only through named definer functions', () => {
  it("write_platform_audit under pgeos_app (internal) writes one audit row with entity_id null, the caller's user_id and actor_type user, for a table without entity_id", async () => {
    requireMigration();
    const ctx: Ctx = { userId: fixtureUserId, isInternal: true };
    const row = await inRolledBackTx(appClient, ctx, async () => {
      const written = await appClient.query<{ id: string }>(PLATFORM_AUDIT_SQL);
      const id = firstRow(written, 'write_platform_audit').id;
      return firstRow(
        await appClient.query<{ entity_id: string | null; user_id: string | null; actor_type: string }>(
          'select entity_id, user_id, actor_type from platform.audit_log where id = $1',
          [id],
        ),
        'the audit row just written',
      );
    });
    expect(row.entity_id).toBeNull();
    expect(row.user_id).toBe(fixtureUserId);
    expect(row.actor_type).toBe(USER_ACTOR_TYPE);
  });

  it('write_platform_audit refuses with 42501 a table that has an entity_id column, an unknown table, and a non-internal caller', async () => {
    requireMigration();
    const internal: Ctx = { userId: fixtureUserId, isInternal: true };
    const external: Ctx = { userId: fixtureUserId, isInternal: false };
    // Positive control: the same caller is admitted for a table without entity_id.
    await inRolledBackTx(appClient, internal, () => appClient.query(PLATFORM_AUDIT_SQL));
    expect(await refusalOf(appClient, internal, ENTITY_TABLE_AUDIT_SQL)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    expect(await refusalOf(appClient, internal, UNKNOWN_TABLE_AUDIT_SQL)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    expect(await refusalOf(appClient, external, PLATFORM_AUDIT_SQL)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
  });

  it('write_platform_audit with no user in context writes actor_type system', async () => {
    requireMigration();
    const row = await inRolledBackTx(appClient, { userId: '', isInternal: true }, async () => {
      const written = await appClient.query<{ id: string }>(PLATFORM_AUDIT_SQL);
      const id = firstRow(written, 'write_platform_audit').id;
      return firstRow(
        await appClient.query<{ entity_id: string | null; user_id: string | null; actor_type: string }>(
          'select entity_id, user_id, actor_type from platform.audit_log where id = $1',
          [id],
        ),
        'the audit row just written',
      );
    });
    expect(row.entity_id).toBeNull();
    expect(row.user_id).toBeNull();
    expect(row.actor_type).toBe(SYSTEM_ACTOR_TYPE);
  });

  it('write_platform_event under pgeos_app (internal) writes one outbox row with entity_id null and actor_id = the caller for a platform.* aggregate type', async () => {
    requireMigration();
    const row = await inRolledBackTx(appClient, { userId: fixtureUserId, isInternal: true }, async () => {
      const written = await appClient.query<{ id: string }>(PLATFORM_EVENT_SQL);
      const id = firstRow(written, 'write_platform_event').id;
      return firstRow(
        await appClient.query<{ entity_id: string | null; actor_id: string | null }>(
          'select entity_id, actor_id from platform.outbox where id = $1',
          [id],
        ),
        'the outbox row just written',
      );
    });
    expect(row.entity_id).toBeNull();
    expect(row.actor_id).toBe(fixtureUserId);
  });

  it('write_platform_event refuses with 42501 a business aggregate type and a non-internal caller', async () => {
    requireMigration();
    const internal: Ctx = { userId: fixtureUserId, isInternal: true };
    const external: Ctx = { userId: fixtureUserId, isInternal: false };
    // Positive control: the same caller is admitted for a platform.* aggregate type.
    await inRolledBackTx(appClient, internal, () => appClient.query(PLATFORM_EVENT_SQL));
    expect(await refusalOf(appClient, internal, BUSINESS_EVENT_SQL)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    expect(await refusalOf(appClient, external, PLATFORM_EVENT_SQL)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    for (const sql of NULL_EVENT_SQLS) {
      expect(await refusalOf(appClient, internal, sql)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    }
  });

  it('both functions are SECURITY DEFINER with search_path pinned, executable by pgeos_app and not by PUBLIC or pgeos_worker', async () => {
    requireMigration();
    const procs = await admin.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1 and p.proname = any($2::text[]) order by p.proname`,
      [PLATFORM_SCHEMA, [...WRITER_FUNCTIONS]],
    );
    expect(procs.rows.map((r) => r.proname)).toEqual([...WRITER_FUNCTIONS].sort());
    for (const proc of procs.rows) {
      expect(proc.prosecdef, `platform.${proc.proname} is not SECURITY DEFINER`).toBe(true);
      expect(proc.proconfig ?? [], `platform.${proc.proname} search_path not pinned`).toContain(PINNED_SEARCH_PATH);
    }
    for (const signature of SIGNATURES) {
      const owner = firstRow(
        await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          `select r.rolsuper, r.rolbypassrls from pg_proc p join pg_roles r on r.oid = p.proowner
            where p.oid = $1::regprocedure`,
          [signature],
        ),
        `owner of ${signature}`,
      );
      expect(owner.rolsuper || owner.rolbypassrls, `owner of ${signature} must be superuser or bypassrls`).toBe(true);
      const held = async (role: string): Promise<boolean> =>
        firstRow(
          await admin.query<{ held: boolean }>("select has_function_privilege($1, $2, 'EXECUTE') as held", [
            role,
            signature,
          ]),
          `has_function_privilege ${role} ${signature}`,
        ).held;
      expect(await held(APP_ROLE), `${APP_ROLE} EXECUTE ${signature}`).toBe(true);
      expect(await held(WORKER_ROLE), `${WORKER_ROLE} EXECUTE ${signature}`).toBe(false);
      const publicGrants = await admin.query<{ n: string }>(
        `select count(*)::text as n
           from pg_proc p cross join lateral aclexplode(p.proacl) a
          where p.oid = $1::regprocedure and a.grantee = $2`,
        [signature, PUBLIC_GRANTEE_OID],
      );
      expect(firstRow(publicGrants, `PUBLIC grants on ${signature}`).n, `PUBLIC EXECUTE ${signature}`).toBe('0');
    }
  });

  it('both functions refuse with 42501 under pgeos_app when app.user_id is the system actor id', async () => {
    requireMigration();
    const system: Ctx = { userId: SYSTEM_ACTOR_ID, isInternal: true };
    expect(await refusalOf(appClient, system, PLATFORM_AUDIT_SQL)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    expect(await refusalOf(appClient, system, PLATFORM_EVENT_SQL)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
  });

  it('write_platform_audit refuses with 42501 a no-entity_id table that is not on the allowlist, a view, a pg_temp table, and null arguments', async () => {
    requireMigration();
    const internal: Ctx = { userId: fixtureUserId, isInternal: true };
    const auditFor = (schema: string, table: string): string =>
      `select platform.write_platform_audit(now(), '${schema}', '${table}', null, 'insert', '{}'::jsonb, gen_random_uuid())`;
    // Positive control: the allowlisted pair is admitted for the same caller.
    await inRolledBackTx(appClient, internal, () => appClient.query(PLATFORM_AUDIT_SQL));
    // The table really has no entity_id column, so only the allowlist can refuse it.
    const noEntity = await admin.query<{ n: string }>(
      `select count(*)::text as n from pg_attribute
        where attrelid = $1::regclass and attname = 'entity_id' and not attisdropped`,
      [NON_ALLOWLISTED_TABLE.join('.')],
    );
    expect(firstRow(noEntity, 'entity_id column count').n).toBe('0');
    expect(await refusalOf(appClient, internal, auditFor(...NON_ALLOWLISTED_TABLE))).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    expect(await refusalOf(appClient, internal, auditFor(...EXISTING_VIEW))).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);

    let thrown: unknown = null;
    await inRolledBackTx(appClient, internal, async () => {
      // The temp table must be created successfully, so a missing TEMP privilege cannot pass vacuously.
      await expect(appClient.query(`create temp table ${TEMP_TABLE} (id int)`)).resolves.toBeDefined();
      await appClient.query('savepoint before_temp_write');
      try {
        await appClient.query(auditFor('pg_temp', TEMP_TABLE));
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown, 'pg_temp table was not refused').not.toBeNull();
    expect(sqlStateOf(thrown)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);

    for (const sql of NULL_ARG_SQLS) {
      expect(await refusalOf(appClient, internal, sql)).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
    }
  });

  it('write_platform_audit writes schema, table, record_id, operation, old and new values and correlation_id as passed, and the audit hash chain fills its columns', async () => {
    requireMigration();
    const row = await inRolledBackTx(appClient, { userId: fixtureUserId, isInternal: true }, async () => {
      const written = await appClient.query<{ id: string }>(
        `select platform.write_platform_audit(now(), 'platform', 'alert_log', $1, $2, $3::jsonb, $4, $5::jsonb) as id`,
        [
          PASSED_RECORD_ID,
          PASSED_OPERATION,
          JSON.stringify(PASSED_NEW_VALUE),
          PASSED_CORRELATION_ID,
          JSON.stringify(PASSED_OLD_VALUE),
        ],
      );
      const id = firstRow(written, 'write_platform_audit').id;
      return firstRow(
        await appClient.query<{
          schema_name: string;
          table_name: string;
          record_id: string;
          operation: string;
          old_value: unknown;
          new_value: unknown;
          correlation_id: string;
          chain_seq: string | null;
          row_hash: string | null;
        }>(
          `select schema_name, table_name, record_id, operation, old_value, new_value, correlation_id,
                  chain_seq::text as chain_seq, row_hash
             from platform.audit_log where id = $1`,
          [id],
        ),
        'the audit row just written',
      );
    });
    expect(row.schema_name).toBe('platform');
    expect(row.table_name).toBe('alert_log');
    expect(row.record_id).toBe(PASSED_RECORD_ID);
    expect(row.operation).toBe(PASSED_OPERATION);
    expect(row.old_value).toEqual(PASSED_OLD_VALUE);
    expect(row.new_value).toEqual(PASSED_NEW_VALUE);
    expect(row.correlation_id).toBe(PASSED_CORRELATION_ID);
    expect(row.chain_seq).not.toBeNull();
    expect(row.row_hash).not.toBeNull();
  });

  it('applying the migration twice changes nothing', async () => {
    requireMigration();
    const snapshot = async (): Promise<string[]> => {
      const out: string[] = [];
      for (const signature of SIGNATURES) {
        const row = firstRow(
          await admin.query<{ def: string; acl: string | null }>(
            'select pg_get_functiondef($1::regprocedure) as def, proacl::text as acl from pg_proc where oid = $1::regprocedure',
            [signature],
          ),
          `snapshot ${signature}`,
        );
        out.push(row.def, row.acl ?? '');
      }
      return out;
    };
    const before = await snapshot();
    await applyMigration();
    await applyMigration();
    expect(await snapshot()).toEqual(before);
  });
});
