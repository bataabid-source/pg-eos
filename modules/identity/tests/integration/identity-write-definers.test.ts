// WBS 2.16 part 1a-8 (pg-tester) — SCR-IDENTITY-RLS-01 delta 2: identity.sessions and
// identity.otp_codes are written only through five SECURITY DEFINER functions; pgeos_app has no
// direct INSERT / UPDATE / DELETE on either table (42501). RED before migration 0044: the direct
// writes still succeed and the five functions do not exist.
//
// Connection idiom copied from has-perm-search-path.test.ts: an admin pg Pool from PG* env creates
// and removes this suite's own fixtures (unique emails); the code under test runs as PG_APP_USER
// through withContext. No row of another suite is touched (D-183); the fixture users row is deleted
// in afterAll (a leftover identity.users row broke G16 before).

import { randomUUID } from 'node:crypto';

import { withContext } from '@pg-eos/db';
import {
  generateOtp,
  issueSession,
  revokeSession,
  verifyOtp,
  verifySession,
} from '@pg-eos/identity-mechanisms';
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

const INSUFFICIENT_PRIVILEGE = '42501';
const EXPECTED_SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
const RESEND_SECONDS_KEY = 'identity.otp.resend_seconds';
const MS_PER_SECOND = 1000;
const RESEND_MARGIN_SECONDS = 1;
const ATTEMPTS_AFTER_ONE_FAILURE = 1;
const WRONG_CODE = 'not-the-code';
const FILLER_HASH = 'test-filler-hash-not-a-real-hmac';
const FILLER_LIFETIME_MINUTES = 3;
const SESSION_LIFETIME_KEY = 'identity.session.lifetime_minutes';
const SESSION_LIFETIME_FIXTURE_VALUE = '43'; // same fixture value as packages/identity/tests

const INTERNAL_CTX = { userId: null, clientId: null, isInternal: true } as const;
const EXTERNAL_CTX = { userId: null, clientId: null, isInternal: false } as const;

const FUNCTIONS = [
  'identity.otp_issue(text,text,timestamptz,timestamptz)',
  'identity.otp_record_failure(uuid[])',
  'identity.otp_consume(uuid,timestamptz)',
  'identity.session_issue(uuid,text,timestamptz,timestamptz)',
  'identity.session_revoke(uuid,timestamptz)',
] as const;

const runId = randomUUID();
const USER_ID = randomUUID();
const USER_EMAIL = `write-definers-${runId}@test.invalid`;
const FLOW_USER_ID = randomUUID();
const FLOW_EMAIL = `write-definers-flow-${runId}@test.invalid`;
const RESEND_USER_ID = randomUUID();
const RESEND_EMAIL = `write-definers-resend-${runId}@test.invalid`;
const ATTEMPTS_USER_ID = randomUUID();
const ATTEMPTS_EMAIL = `write-definers-attempts-${runId}@test.invalid`;
const fixtures = [
  { id: USER_ID, email: USER_EMAIL },
  { id: FLOW_USER_ID, email: FLOW_EMAIL },
  { id: RESEND_USER_ID, email: RESEND_EMAIL },
  { id: ATTEMPTS_USER_ID, email: ATTEMPTS_EMAIL },
] as const;

beforeAll(async () => {
  // Bystander discipline (same as packages/identity/tests/session.test.ts): 0042 deliberately does
  // not seed the session lifetime; seed a fixture row if absent, NEVER delete it (other suites
  // sharing the database read the same fixed key).
  await pool.query(
    `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
     values ($1, $2, $3, $4, $5)
     on conflict (key) do nothing`,
    [
      SESSION_LIFETIME_KEY,
      SESSION_LIFETIME_FIXTURE_VALUE,
      'minutes',
      'عمر الجلسة بالدقائق — صف اختباري (WBS 2.16 part 1a-8)',
      randomUUID(),
    ],
  );
  for (const f of fixtures) {
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type)
         values ($1, $2, $3, 'internal')`,
      [f.id, f.email, 'اختبار write definers'],
    );
  }
});

afterAll(async () => {
  // D-183: only this suite's own fixture rows.
  const ids = fixtures.map((f) => f.id);
  const emails = fixtures.map((f) => f.email);
  await pool.query('delete from identity.sessions where user_id = any($1::uuid[])', [ids]);
  await pool.query('delete from identity.otp_codes where email = any($1::text[])', [emails]);
  await pool.query('delete from identity.users where id = any($1::uuid[])', [ids]);
  await pool.end();
});

function sqlstateOf(err: unknown): string | undefined {
  let cur: unknown = err;
  while (typeof cur === 'object' && cur !== null) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Runs `fn` in withContext and returns the SQLSTATE of the failure, or 'OK' when it did not fail. */
async function sqlstateOfRun(
  ctx: typeof INTERNAL_CTX | typeof EXTERNAL_CTX,
  fn: (tx: Parameters<Parameters<typeof withContext>[1]>[0]) => Promise<unknown>,
): Promise<string> {
  try {
    await withContext(ctx, fn);
    return 'OK';
  } catch (err) {
    return sqlstateOf(err) ?? `non-sql:${String(err)}`;
  }
}

async function insertSessionRow(userId: string): Promise<string> {
  const r: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.sessions (user_id, token_hash, issued_at, expires_at)
       values ($1, $2, now(), now() + interval '1 hour') returning id::text as id`,
    [userId, `fixture-${randomUUID()}`],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('fixture session insert returned no row');
  return id;
}

async function insertOtpRow(email: string): Promise<string> {
  const r: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.otp_codes (email, code_hash, expires_at)
       values ($1, $2, now() + $3::double precision * interval '1 minute') returning id::text as id`,
    [email, FILLER_HASH, FILLER_LIFETIME_MINUTES],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('fixture otp insert returned no row');
  return id;
}

describe('identity.sessions / identity.otp_codes are written only through definer functions (SCR-IDENTITY-RLS-01 delta 2)', () => {
  it('pgeos_app cannot insert, update or delete identity.sessions directly (42501)', async () => {
    const sessionId = await insertSessionRow(USER_ID);
    const insert = await sqlstateOfRun(INTERNAL_CTX, async (tx) => {
      await tx.execute(sql`
        insert into identity.sessions (user_id, token_hash, issued_at, expires_at)
        values (${USER_ID}::uuid, ${`direct-${randomUUID()}`}, now(), now() + interval '1 hour')`);
    });
    const update = await sqlstateOfRun(INTERNAL_CTX, async (tx) => {
      await tx.execute(
        sql`update identity.sessions set revoked_at = now() where id = ${sessionId}::uuid`,
      );
    });
    const del = await sqlstateOfRun(INTERNAL_CTX, async (tx) => {
      await tx.execute(sql`delete from identity.sessions where id = ${sessionId}::uuid`);
    });
    expect({ insert, update, del }).toEqual({
      insert: INSUFFICIENT_PRIVILEGE,
      update: INSUFFICIENT_PRIVILEGE,
      del: INSUFFICIENT_PRIVILEGE,
    });
  });

  it('pgeos_app cannot insert, update or delete identity.otp_codes directly (42501)', async () => {
    const otpId = await insertOtpRow(USER_EMAIL);
    const insert = await sqlstateOfRun(INTERNAL_CTX, async (tx) => {
      await tx.execute(sql`
        insert into identity.otp_codes (email, code_hash, expires_at)
        values (${USER_EMAIL}, ${FILLER_HASH}, now() + interval '5 minutes')`);
    });
    const update = await sqlstateOfRun(INTERNAL_CTX, async (tx) => {
      await tx.execute(
        sql`update identity.otp_codes set attempts = attempts + 1 where id = ${otpId}::uuid`,
      );
    });
    const del = await sqlstateOfRun(INTERNAL_CTX, async (tx) => {
      await tx.execute(sql`delete from identity.otp_codes where id = ${otpId}::uuid`);
    });
    expect({ insert, update, del }).toEqual({
      insert: INSUFFICIENT_PRIVILEGE,
      update: INSUFFICIENT_PRIVILEGE,
      del: INSUFFICIENT_PRIVILEGE,
    });
  });

  it('pgeos_app can still select both tables in an internal context', async () => {
    const sessionId = await insertSessionRow(USER_ID);
    const otpId = await insertOtpRow(USER_EMAIL);
    const found = await withContext(INTERNAL_CTX, async (tx) => {
      const s = await tx.execute<{ id: string }>(
        sql`select id::text as id from identity.sessions where id = ${sessionId}::uuid`,
      );
      const o = await tx.execute<{ id: string }>(
        sql`select id::text as id from identity.otp_codes where id = ${otpId}::uuid`,
      );
      return { session: s.rows[0]?.id, otp: o.rows[0]?.id };
    });
    expect(found).toEqual({ session: sessionId, otp: otpId });
  });

  it('Each of the five identity write functions is SECURITY DEFINER with search_path pinned to pg_catalog, pg_temp and is not executable by PUBLIC', async () => {
    const appUser = process.env['PG_APP_USER'];
    if (!appUser) throw new Error('PG_APP_USER must name the app role');
    for (const signature of FUNCTIONS) {
      const r: QueryResult<{
        found: boolean;
        prosecdef: boolean | null;
        proconfig: string[] | null;
        public_exec: boolean | null;
        app_exec: boolean | null;
      }> = await pool.query(
        `select p.oid is not null as found,
                p.prosecdef,
                p.proconfig,
                has_function_privilege('public', p.oid, 'execute') as public_exec,
                has_function_privilege($2, p.oid, 'execute') as app_exec
           from (select to_regprocedure($1)::oid as oid) f
           left join pg_proc p on p.oid = f.oid`,
        [signature, appUser],
      );
      const row = r.rows[0];
      expect(row?.found, `${signature} must exist`).toBe(true);
      expect(row?.prosecdef, `${signature} prosecdef`).toBe(true);
      const config = (row?.proconfig ?? []).map((e) => e.replace(/\s+/g, ' ').trim());
      expect(config, `${signature} proconfig`).toEqual([EXPECTED_SEARCH_PATH]);
      expect(row?.public_exec, `${signature} PUBLIC execute`).toBe(false);
      expect(row?.app_exec, `${signature} ${appUser} execute`).toBe(true);
    }
  });

  it('Each write function refuses a non-internal context (42501)', async () => {
    const someId = randomUUID();
    const calls = {
      otp_issue: sql`select identity.otp_issue(${USER_EMAIL}, ${FILLER_HASH}, now(), now() + interval '5 minutes')`,
      otp_record_failure: sql`select identity.otp_record_failure(array[${someId}::uuid])`,
      otp_consume: sql`select identity.otp_consume(${someId}::uuid, now())`,
      session_issue: sql`select identity.session_issue(${USER_ID}::uuid, ${FILLER_HASH}, now(), now() + interval '1 hour')`,
      session_revoke: sql`select identity.session_revoke(${someId}::uuid, now())`,
    } as const;
    const results: Record<string, string> = {};
    for (const [name, statement] of Object.entries(calls)) {
      results[name] = await sqlstateOfRun(EXTERNAL_CTX, async (tx) => {
        await tx.execute(statement);
      });
    }
    expect(results).toEqual({
      otp_issue: INSUFFICIENT_PRIVILEGE,
      otp_record_failure: INSUFFICIENT_PRIVILEGE,
      otp_consume: INSUFFICIENT_PRIVILEGE,
      session_issue: INSUFFICIENT_PRIVILEGE,
      session_revoke: INSUFFICIENT_PRIVILEGE,
    });
  });

  it('The OTP issue → verify → session issue → revoke flow still succeeds as pgeos_app through withContext', async () => {
    const otp = await generateOtp(FLOW_EMAIL);
    const verified = await verifyOtp(FLOW_EMAIL, otp.code);
    expect(verified).toEqual({ valid: true, userId: FLOW_USER_ID, otpId: otp.otpId });

    const session = await issueSession(FLOW_USER_ID);
    const live = await verifySession(session.token);
    expect(live).toEqual({ valid: true, userId: FLOW_USER_ID, sessionId: session.sessionId });

    await revokeSession(session.sessionId);
    expect(await verifySession(session.token)).toEqual({ valid: false });

    // The consumed code cannot be reused.
    expect(await verifyOtp(FLOW_EMAIL, otp.code)).toEqual({ valid: false });
  });

  it('A wrong code still increments attempts on every live candidate; a new request still consumes the earlier live code', async () => {
    // (a) two live candidates for one email: one real (generateOtp), one admin-inserted filler.
    const real = await generateOtp(ATTEMPTS_EMAIL);
    const fillerId = await insertOtpRow(ATTEMPTS_EMAIL);
    expect(await verifyOtp(ATTEMPTS_EMAIL, WRONG_CODE)).toEqual({ valid: false });
    const after: QueryResult<{ id: string; attempts: number; consumed_at: Date | null }> =
      await pool.query(
        'select id::text as id, attempts, consumed_at from identity.otp_codes where id = any($1::uuid[])',
        [[real.otpId, fillerId]],
      );
    expect(after.rows).toHaveLength(2);
    for (const row of after.rows) {
      expect(row.attempts, `attempts of ${row.id}`).toBe(ATTEMPTS_AFTER_ONE_FAILURE);
      expect(row.consumed_at, `consumed_at of ${row.id}`).toBeNull();
    }

    // (b) a second request after the resend window consumes the earlier live code.
    const resend: QueryResult<{ value: string }> = await pool.query(
      'select value::text as value from platform.thresholds where key = $1',
      [RESEND_SECONDS_KEY],
    );
    const resendSeconds = Number(resend.rows[0]?.value);
    expect(Number.isFinite(resendSeconds)).toBe(true);
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + (resendSeconds + RESEND_MARGIN_SECONDS) * MS_PER_SECOND);
    const first = await generateOtp(RESEND_EMAIL, { now: () => t0 });
    const second = await generateOtp(RESEND_EMAIL, { now: () => t1 });
    const rows: QueryResult<{ id: string; consumed_at: Date | null }> = await pool.query(
      'select id::text as id, consumed_at from identity.otp_codes where id = any($1::uuid[])',
      [[first.otpId, second.otpId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.consumed_at]));
    expect(byId.get(first.otpId)).toBeInstanceOf(Date);
    expect(byId.get(second.otpId)).toBeNull();
  });
});
