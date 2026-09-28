// WBS 2.16 part 1a-7 (pg-tester) — SCR-IDENTITY-RLS-01 delta 4: platform.has_perm must carry a pinned
// `search_path = pg_catalog, pg_temp` (the pin every other SECURITY DEFINER function in this repo uses,
// migration 0031 allowed_entities). RED today: has_perm has proconfig = NULL.
//
// Scenario 4 formulation (deterministic, fails today only if the pin is missing): has_perm's body is
// schema-qualified for relations and functions, but `p.code = p_code` still resolves the text = text
// OPERATOR through the effective search_path. An unpinned definer inherits the CALLER's search_path,
// so a caller who puts a schema holding its own `=(text, text)` operator before pg_catalog hijacks the
// comparison. (Operators and functions are never looked up in the implicit pg_temp schema, so a bare
// temp object cannot be used to prove the property; a scratch schema listed explicitly is the same
// attack class and is observable.) Inside ONE transaction, on one connection: the admin creates a scratch
// schema + an always-true operator + a fixture GM user, then SET LOCAL ROLE pgeos_app and a hostile
// search_path, then calls has_perm with an unknown code. Unpinned => true (hijacked); pinned => false.
// The hostile operator behaves as normal equality EXCEPT that it also matches the unknown probe code,
// so the platform.current_user_id() helper (nullif(...,'')) keeps working and only the permission
// comparison is hijacked.
// Everything is rolled back, so nothing persists and no row is deleted.
//
// Connection idiom copied from column-classification.test.ts (admin pg Pool from PG* env) and
// tests/isolation/tests/hr-commission-confirm-sod.test.ts (admin fixtures + own-cleanup in afterAll).

import { randomUUID } from 'node:crypto';

import { withContext } from '@pg-eos/db';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const EXPECTED_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
const SEEDED_PERMISSION = 'hr.commission.read_all'; // seeded 13B; held by role GM
const HOLDER_ROLE_CODE = 'GM';
const UNKNOWN_PERMISSION = 'test.no.such.permission.code';
const NON_SYSTEM_EXCLUDED_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

const HOLDER_USER_ID = randomUUID();
const NO_ROLE_USER_ID = randomUUID();
const fixtureUserIds = [HOLDER_USER_ID, NO_ROLE_USER_ID];

async function roleId(code: string): Promise<string> {
  const r: QueryResult<{ id: string }> = await pool.query(
    'select id::text as id from identity.roles where code = $1',
    [code],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`identity.roles row not found for code ${code}`);
  return id;
}

beforeAll(async () => {
  const holderRole = await roleId(HOLDER_ROLE_CODE);
  for (const [id, label] of [
    [HOLDER_USER_ID, 'holder'],
    [NO_ROLE_USER_ID, 'no-role'],
  ] as const) {
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type)
         values ($1, $2, $3, 'internal')`,
      [id, `has-perm-search-path-${label}-${id}@test.invalid`, `اختبار has_perm ${label}`],
    );
  }
  await pool.query('insert into identity.user_roles (user_id, role_id) values ($1, $2)', [
    HOLDER_USER_ID,
    holderRole,
  ]);
});

afterAll(async () => {
  // D-183: only this suite's own fixture rows (user_roles cascade from users).
  await pool.query('delete from identity.users where id = any($1::uuid[])', [fixtureUserIds]);
  await pool.end();
});

async function hasPermAs(userId: string, code: string): Promise<boolean> {
  return withContext({ userId, clientId: null, isInternal: true }, async (tx) => {
    const res = await tx.execute(sql`select platform.has_perm(${code}) as ok`);
    const row = res.rows[0] as { ok: boolean } | undefined;
    if (!row) throw new Error('has_perm returned no row');
    return row.ok;
  });
}

describe('platform.has_perm runs with a pinned search_path (SCR-IDENTITY-RLS-01 delta 4)', () => {
  it('has_perm carries search_path=pg_catalog, pg_temp in proconfig', async () => {
    const r: QueryResult<{ proconfig: string[] | null }> = await pool.query(
      `select proconfig from pg_proc
        where oid = 'platform.has_perm(text)'::regprocedure`,
    );
    expect(r.rows).toHaveLength(1);
    const config = (r.rows[0]?.proconfig ?? []).map((e) => e.replace(/\s+/g, ' ').trim());
    expect(config).toEqual([EXPECTED_SEARCH_PATH]);
  });

  it('No SECURITY DEFINER function in the database lacks a pinned search_path', async () => {
    const r: QueryResult<{ signature: string }> = await pool.query(
      `select p.oid::regprocedure::text as signature
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef
          and n.nspname <> all($1::text[])
          and n.nspname not like 'pg\\_temp\\_%'
          and n.nspname not like 'pg\\_toast\\_temp\\_%'
          and not exists (
            select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%'
          )
        order by 1`,
      [NON_SYSTEM_EXCLUDED_SCHEMAS],
    );
    const offenders = r.rows.map((row) => row.signature);
    expect(offenders, `SECURITY DEFINER without search_path: ${offenders.join(', ')}`).toEqual([]);
  });

  it('has_perm still returns true for a held permission and false otherwise, under pgeos_app via withContext', async () => {
    expect(await hasPermAs(HOLDER_USER_ID, SEEDED_PERMISSION)).toBe(true);
    expect(await hasPermAs(NO_ROLE_USER_ID, SEEDED_PERMISSION)).toBe(false);
    expect(await hasPermAs(HOLDER_USER_ID, UNKNOWN_PERMISSION)).toBe(false);
  });

  it("A temp-schema object named like has_perm's dependencies cannot change its answer", async () => {
    const appUser = process.env['PG_APP_USER'];
    if (!appUser) throw new Error('PG_APP_USER must name the app role');
    const scratch = `hp_shadow_${randomUUID().replace(/-/g, '')}`;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`create schema ${scratch}`);
      await client.query(`grant usage on schema ${scratch} to public`);
      await client.query(
        `create function ${scratch}.hijacked_eq(text, text) returns boolean
           language sql immutable set search_path = pg_catalog
           as 'select $1 operator(pg_catalog.=) $2 or $2 operator(pg_catalog.=) ''${UNKNOWN_PERMISSION}'''`,
      );
      await client.query(
        `create operator ${scratch}.= (leftarg = text, rightarg = text, function = ${scratch}.hijacked_eq)`,
      );
      await client.query(`select set_config('app.user_id', $1, true)`, [HOLDER_USER_ID]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      await client.query(`set local role ${appUser}`);
      await client.query(`set local search_path = ${scratch}, pg_catalog`);
      const r: QueryResult<{ ok: boolean }> = await client.query(
        'select platform.has_perm($1) as ok',
        [UNKNOWN_PERMISSION],
      );
      expect(r.rows[0]?.ok).toBe(false);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
