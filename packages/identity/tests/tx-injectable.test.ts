// packages/identity/tests/tx-injectable.test.ts — Master task P6c (pg-tester), RED phase.
//
// PROBLEM THIS PINS DOWN (P6c brief). generateOtp, verifyOtp and issueSession each open THEIR OWN
// withContext(...) transaction — i.e. their own `pool.connect()` — because the WBS 0.17 mechanism
// slice was built with no caller in mind that already holds a connection. Lane 1's OTP-login
// endpoint calls them from inside withIdempotentContext (@pg-eos/db), which already holds one
// pool client for the whole request. With a bounded pool, N concurrent requests each try to
// acquire a SECOND connection while holding the first, and the pool deadlocks once N reaches the
// pool's max.
//
// THE FIX THESE TESTS PIN DOWN (not built here — pg-tester never implements). Each of the three
// functions gets a tx-injectable sibling that takes the CALLER's already-open transaction handle
// and performs its writes on THAT handle, opening no connection of its own:
//   generateOtpInTx(tx, email, opts?)   — src/otp.ts
//   verifyOtpInTx(tx, email, code, opts?) — src/otp.ts
//   issueSessionInTx(tx, userId, opts?) — src/session.ts
// `tx` is typed exactly as the callback parameter withContext(ctx, fn) already hands to `fn` —
// `NodePgDatabase` (drizzle-orm/node-postgres) — the same type getThreshold (thresholds.ts) already
// takes, so no new context/tx shape is invented.
//
// RED, and why it is the right RED: `generateOtpInTx`, `verifyOtpInTx` and `issueSessionInTx` do
// not exist yet in src/otp.ts / src/session.ts. Every import below of those three names fails to
// resolve — same class of RED as the WBS 0.17 suites this file sits beside.
//
// CONNECTION-COUNT INVARIANT, how it is checked without reaching into @pg-eos/db's internals.
// @pg-eos/db's package.json `exports` map exposes only `.` (dist/index.js) — a deep import of
// `dist/src/client.js` is blocked by Node's own exports enforcement (confirmed directly against
// this workspace: ERR_PACKAGE_PATH_NOT_EXPORTED), and the barrel deliberately does not re-export
// `pool` (packages/db/index.ts, "exporting it from the public barrel would defeat the whole point
// of the lint rule"). So this suite does not import @pg-eos/db's pool at all: it mocks the 'pg'
// package itself (identity's OWN direct dependency — package.json — resolving, under this pnpm
// workspace, to the exact same physical module as @pg-eos/db's copy: both packages/db and
// packages/identity resolve 'pg' to
// node_modules/.pnpm/pg@<version>/node_modules/pg/lib/index.js, confirmed with `require.resolve`
// on this checkout). Vitest's `vi.mock('pg', …)` replaces that resolved module for every importer
// inside this test file's module graph — including @pg-eos/db's `src/client.ts`, which does
// `import { Pool } from 'pg'` and constructs the package's one singleton `pool` from it — so a
// `Pool` subclass that counts `connect()` calls observes every connection the singleton pool
// hands out during this file's run, real DB round-trips included.
//
// Schema this suite depends on (database/schema/01-Data-Model.sql:212-224, 267-277, 279-286) and
// platform.thresholds (13B-Schema-Reference-Consolidation.sql:328-335) — identical to
// packages/identity/tests/otp.test.ts and session.test.ts, which this file deliberately mirrors
// fixture-for-fixture so it can run in the same test project without inventing a second fixture
// convention.

import { randomUUID } from 'node:crypto';

import { Pool as RealPool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Counts every `connect()` call made by the singleton pool @pg-eos/db's src/client.ts constructs
// from 'pg' — see header. Reset per-test in `beforeEach`-style blocks below (each test reads the
// delta, not the running total).
let totalConnectCalls = 0;

// The callback shape of pg's Pool#connect overload (@types/pg), named here so the override below
// can state it without `any`.
type PoolConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

vi.mock('pg', async () => {
  const actual = await vi.importActual<typeof import('pg')>('pg');
  class CountingPool extends actual.Pool {
    override connect(): Promise<PoolClient>;
    override connect(callback: PoolConnectCallback): void;
    override connect(callback?: PoolConnectCallback): Promise<PoolClient> | void {
      totalConnectCalls += 1;
      if (callback) {
        super.connect(callback);
        return;
      }
      return super.connect();
    }
  }
  return { ...actual, Pool: CountingPool };
});

// Imported AFTER the vi.mock('pg', …) above — vitest hoists vi.mock calls to the top of the file,
// so by the time these modules evaluate `import { Pool } from 'pg'` they receive CountingPool.
// Both *InTx siblings are now built (Master task P6c build phase) — plain named imports.
const { withContext } = await import('@pg-eos/db');
const { generateOtp, generateOtpInTx, verifyOtpInTx } = await import('../src/otp.js');
const { issueSessionInTx } = await import('../src/session.js');

const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';
const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';

const THRESHOLD_FIXTURES = [
  {
    key: OTP_EXPIRY_MINUTES_KEY,
    value: '7',
    unit: 'minutes',
    descriptionAr: 'صلاحية رمز الدخول لمرة واحدة بالدقائق — صف اختباري (P6c)',
  },
  {
    key: SESSION_LIFETIME_MINUTES_KEY,
    value: '43',
    unit: 'minutes',
    descriptionAr: 'عمر الجلسة بالدقائق — صف اختباري (P6c)',
  },
] as const;

// A verification pool, deliberately NOT the mocked/counted singleton — it reads rows back from
// OUTSIDE whatever transaction the code under test used, exactly like the sibling WBS 0.17 suites.
const verifyPool = new RealPool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const fixtureEmails: string[] = [];

// SEED-ONLY, NEVER DELETE (P6c — deliberate departure from the otp.test.ts / session.test.ts
// afterAll pattern). Both OTP_EXPIRY_MINUTES_KEY and SESSION_LIFETIME_MINUTES_KEY are shared,
// non-randomUUID()-suffixed keys that packages/identity/tests/otp.test.ts and session.test.ts
// already own and delete in their OWN afterAll (their header documents the narrow race that
// creates between just those two files). This file only ever needs SOME row to be present at
// those keys, never a value of its own choosing (every assertion below re-reads the live value,
// same discipline as the sibling suites) — so it seeds with `on conflict (key) do nothing` and
// stops there. Adding a THIRD (here: three more) deleter of the same shared-key rows would widen
// that already-accepted race instead of living inside it; not deleting keeps this file a pure
// bystander in that race.
async function seedThresholdFixtures(): Promise<void> {
  for (const fixture of THRESHOLD_FIXTURES) {
    await verifyPool.query(
      `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
       values ($1, $2, $3, $4, $5)
       on conflict (key) do nothing`,
      [fixture.key, fixture.value, fixture.unit, fixture.descriptionAr, randomUUID()],
    );
  }
}

async function createFixtureUser(isActive: boolean): Promise<{ id: string; email: string }> {
  const email = `pg-eos-p6c-txinjectable-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await verifyPool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', $3)
     returning id`,
    [email, 'مستخدم اختبار — P6c', isActive],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('fixture user insert returned no row');
  }
  return { id: row.id, email };
}

beforeAll(async () => {
  await seedThresholdFixtures();
});

afterAll(async () => {
  if (fixtureEmails.length > 0) {
    await verifyPool.query('delete from identity.sessions where user_id in (select id from identity.users where email = any($1::text[]))', [
      fixtureEmails,
    ]);
    await verifyPool.query('delete from identity.otp_codes where email = any($1::text[])', [
      fixtureEmails,
    ]);
    await verifyPool.query('delete from identity.users where email = any($1::text[])', [
      fixtureEmails,
    ]);
  }
  // No threshold-row delete here — see the seed-only comment above.
  await verifyPool.end();
});

const OUTER_CTX = { userId: null, clientId: null, isInternal: true } as const;

describe('generateOtpInTx — writes on the caller-supplied tx, opens no connection of its own (P6c)', () => {
  it('is exported from src/otp.ts', () => {
    expect(typeof generateOtpInTx).toBe('function');
  });

  it('an outer transaction rollback leaves NO identity.otp_codes row, and generateOtpInTx opens zero new pool connections', async () => {
    const user = await createFixtureUser(true);
    const marker = new Error('forced-rollback-marker');
    const connectCallsBeforeOuter = totalConnectCalls;
    let connectCallsAfterInTxCall = -1;

    await expect(
      withContext(OUTER_CTX, async (tx) => {
        // Exactly one connection so far: the outer withContext's own.
        expect(totalConnectCalls).toBe(connectCallsBeforeOuter + 1);

        await generateOtpInTx(tx, user.email, { now: () => new Date() });

        connectCallsAfterInTxCall = totalConnectCalls;
        throw marker;
      }),
    ).rejects.toBe(marker);

    // generateOtpInTx must not have opened a second connection: the count right after calling it
    // is identical to the count right after the outer transaction opened its own.
    expect(connectCallsAfterInTxCall).toBe(connectCallsBeforeOuter + 1);

    const codes = await verifyPool.query('select id from identity.otp_codes where email = $1', [
      user.email,
    ]);
    expect(codes.rows).toHaveLength(0);
  });

  it('on COMMIT (no rollback), generateOtpInTx really did insert an identity.otp_codes row on the shared tx', async () => {
    const user = await createFixtureUser(true);
    let otpId: string | undefined;

    await withContext(OUTER_CTX, async (tx) => {
      const otp = await generateOtpInTx(tx, user.email, { now: () => new Date() });
      otpId = otp.otpId;
    });

    expect(otpId).toBeDefined();
    const codes = await verifyPool.query('select id from identity.otp_codes where id = $1', [
      otpId,
    ]);
    expect(codes.rows).toHaveLength(1);
  });
});

describe('verifyOtpInTx — writes on the caller-supplied tx, opens no connection of its own (P6c)', () => {
  it('is exported from src/otp.ts', () => {
    expect(typeof verifyOtpInTx).toBe('function');
  });

  it('an outer transaction rollback leaves the identity.otp_codes row UNCONSUMED, and verifyOtpInTx opens zero new pool connections', async () => {
    const user = await createFixtureUser(true);
    const issuedAt = new Date();
    const otp = await generateOtp(user.email, { now: () => issuedAt });
    const marker = new Error('forced-rollback-marker');
    let connectCallsBeforeInTx = -1;
    let connectCallsAfterInTx = -1;

    await expect(
      withContext(OUTER_CTX, async (tx) => {
        connectCallsBeforeInTx = totalConnectCalls;
        const verification = await verifyOtpInTx(tx, user.email, otp.code, {
          now: () => issuedAt,
        });
        connectCallsAfterInTx = totalConnectCalls;
        expect(verification.valid).toBe(true);
        throw marker;
      }),
    ).rejects.toBe(marker);

    expect(connectCallsAfterInTx).toBe(connectCallsBeforeInTx);

    const row = await verifyPool.query(
      'select consumed_at from identity.otp_codes where id = $1',
      [otp.otpId],
    );
    expect(row.rows[0]?.consumed_at).toBeNull();
  });
});

describe('issueSessionInTx — writes on the caller-supplied tx, opens no connection of its own (P6c)', () => {
  it('is exported from src/session.ts', () => {
    expect(typeof issueSessionInTx).toBe('function');
  });

  it('an outer transaction rollback leaves NO identity.sessions row, and issueSessionInTx opens zero new pool connections', async () => {
    const user = await createFixtureUser(true);
    const marker = new Error('forced-rollback-marker');
    let connectCallsBeforeInTx = -1;
    let connectCallsAfterInTx = -1;

    await expect(
      withContext(OUTER_CTX, async (tx) => {
        connectCallsBeforeInTx = totalConnectCalls;
        await issueSessionInTx(tx, user.id, { now: () => new Date() });
        connectCallsAfterInTx = totalConnectCalls;
        throw marker;
      }),
    ).rejects.toBe(marker);

    expect(connectCallsAfterInTx).toBe(connectCallsBeforeInTx);

    const sessions = await verifyPool.query(
      'select id from identity.sessions where user_id = $1',
      [user.id],
    );
    expect(sessions.rows).toHaveLength(0);
  });
});
