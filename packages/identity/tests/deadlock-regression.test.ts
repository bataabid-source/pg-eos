// packages/identity/tests/deadlock-regression.test.ts — Master task P6c (round 2, pg-tester),
// RED phase.
//
// THE BUG (P6c brief, round 1). Lane 1's OTP-login endpoint used to call the OTP/session
// mechanisms from inside an already-open transaction — a second `withContext` nested inside the
// first tried to acquire a SECOND pool client while the first was still checked out, and a bounded
// pool deadlocked once as many concurrent callers as the pool's max were all mid-flight.
//
// THE FIX (round 2 redesign, not built by pg-tester). `requestLoginOtp` / `verifyLoginOtp`
// (src/login.ts) now own the WHOLE pre-auth path themselves: each runs a short lookup transaction
// that is released BEFORE the write transaction opens — sequential, never nested (login.ts
// header: "ONE POOL CONNECTION AT A TIME"). A caller — Lane 1's endpoint, or this test — calls
// either flow directly, with no wrapping withContext/withIdempotentContext of its own; the flow
// itself never needs a second connection while holding one, so a pool of max = 1 still completes.
//
// This file therefore no longer nests anything by hand (round 1's version manually nested
// generateOtpInTx inside withIdempotentContext to reproduce the bug at the lowest level available
// at the time); it exercises the CURRENT public contract directly — call the two flows, exactly as
// Lane 1's endpoint will, under a pool forced down to a single connection.
//
// RED, and why it is the right RED: this file's import of `requestLoginOtp` / `verifyLoginOtp`
// from the barrel now resolves (src/login.ts exists) — the RED, if any, is a real hang/timeout were
// the flows still nested, or a normal test failure if the flows' contract differs from what this
// file assumes. Either way this file is run to CONFIRM the fix, not to pin down a still-missing
// export.
//
// Pool max = 1 is forced by mocking 'pg' (identity's own direct dependency, resolving under this
// pnpm workspace to the exact same physical module @pg-eos/db's `src/client.ts` imports — see the
// header of tests/tx-injectable.test.ts for the confirmation and the reasoning). This is the ONLY
// way available to this suite to control the singleton pool's size: @pg-eos/db's package.json
// `exports` map exposes only `.`, and its barrel deliberately does not re-export `pool` or accept
// a `max` option.

import { createHash, randomUUID } from 'node:crypto';

import { Pool as RealPool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { IdempotencyInput } from '@pg-eos/db';

vi.mock('pg', async () => {
  const actual = await vi.importActual<typeof import('pg')>('pg');
  class SingleConnectionPool extends actual.Pool {
    constructor(config?: Record<string, unknown>) {
      // Forces the ONE singleton pool @pg-eos/db's src/client.ts constructs (module-eval time,
      // inside this test file's own isolated module graph) down to a single connection — the
      // smallest pool in which "a caller that already holds a connection tries to acquire a
      // second one" would deadlock deterministically and immediately, rather than only under N
      // concurrent callers.
      super({ ...config, max: 1 });
    }
  }
  return { ...actual, Pool: SingleConnectionPool };
});

const { requestLoginOtp, verifyLoginOtp } = await import('../index.js');
const { withContext } = await import('@pg-eos/db');

const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';
const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';

// Generous relative to a single local-DB round trip, tight relative to "forever" — a deadlocked
// call never resolves at all, so any bounded timeout that is comfortably longer than a real query
// distinguishes "completed" from "hung" without flaking on machine load.
const DEADLOCK_TIMEOUT_MS = 5_000;

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idemFor(endpoint: string, body: Record<string, unknown>): IdempotencyInput {
  return {
    key: randomUUID(),
    endpoint,
    requestHash: sha256Hex(body),
    entityId: null,
    successStatus: 200,
  };
}

// A verification pool, deliberately NOT the mocked/counted singleton — real DB round trips for
// fixture setup and teardown, outside whatever transaction the code under test used.
const verifyPool = new RealPool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const fixtureEmails: string[] = [];

// SEED-ONLY, NEVER DELETE — see tests/tx-injectable.test.ts's header comment for the full
// reasoning: both keys are shared, non-randomUUID()-suffixed rows already owned (seeded AND
// deleted) by otp.test.ts / session.test.ts.
async function seedThresholds(): Promise<void> {
  for (const fixture of [
    {
      key: OTP_EXPIRY_MINUTES_KEY,
      value: '7',
      descriptionAr: 'صلاحية رمز الدخول لمرة واحدة بالدقائق — صف اختباري (P6c deadlock regression)',
    },
    {
      key: SESSION_LIFETIME_MINUTES_KEY,
      value: '43',
      descriptionAr: 'عمر الجلسة بالدقائق — صف اختباري (P6c deadlock regression)',
    },
  ] as const) {
    await verifyPool.query(
      `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
       values ($1, $2, 'minutes', $3, $4)
       on conflict (key) do nothing`,
      [fixture.key, fixture.value, fixture.descriptionAr, randomUUID()],
    );
  }
}

async function createFixtureUser(): Promise<{ id: string; email: string }> {
  const email = `pg-eos-p6c-deadlock-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result = await verifyPool.query<{ id: string }>(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', true)
     returning id`,
    [email, 'مستخدم اختبار — P6c deadlock regression'],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('fixture user insert returned no row');
  }
  return { id: row.id, email };
}

beforeAll(async () => {
  await seedThresholds();
});

afterAll(async () => {
  if (fixtureEmails.length > 0) {
    // platform.idempotency_keys.user_id -> identity.users(id), no cascade (migration 0010) — the
    // login flows write a row there for every idem key this suite used, so it is deleted BEFORE
    // the owning user, or the user delete below fails its FK.
    await verifyPool.query(
      'delete from platform.idempotency_keys where user_id in (select id from identity.users where email = any($1::text[]))',
      [fixtureEmails],
    );
    await verifyPool.query(
      'delete from identity.sessions where user_id in (select id from identity.users where email = any($1::text[]))',
      [fixtureEmails],
    );
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

function raceAgainstTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms — deadlocked`)), ms);
    }),
  ]);
}

describe('deadlock regression — pool max=1, each WHOLE flow called directly, no wrapping context (P6c round 2)', () => {
  it(
    'requestLoginOtp completes within a short timeout under a pool of max=1',
    async () => {
      const user = await createFixtureUser();

      const result = await raceAgainstTimeout(
        requestLoginOtp(user.email, idemFor('POST /auth/otp/request', { email: user.email })),
        DEADLOCK_TIMEOUT_MS,
      );

      expect(result.code).toMatch(/^[0-9]{6}$/);
    },
    DEADLOCK_TIMEOUT_MS + 2_000,
  );

  it(
    'verifyLoginOtp completes within a short timeout under a pool of max=1 (whole flow, including the session write)',
    async () => {
      const user = await createFixtureUser();
      const requested = await raceAgainstTimeout(
        requestLoginOtp(user.email, idemFor('POST /auth/otp/request', { email: user.email })),
        DEADLOCK_TIMEOUT_MS,
      );
      const code = requested.code;
      if (code === null) {
        throw new Error('expected a delivered code for a real active user');
      }

      const result = await raceAgainstTimeout(
        verifyLoginOtp(user.email, code, idemFor('POST /auth/otp/verify', { email: user.email })),
        DEADLOCK_TIMEOUT_MS,
      );

      expect(result.valid).toBe(true);
    },
    (DEADLOCK_TIMEOUT_MS + 2_000) * 2,
  );

  it('sanity: withContext alone (no nesting) still works under the mocked pool of max=1', async () => {
    const rows = await withContext({ userId: null, clientId: null, isInternal: true }, async (tx) =>
      tx.execute('select 1 as one'),
    );
    expect(rows.rows[0]).toEqual({ one: 1 });
  });
});
