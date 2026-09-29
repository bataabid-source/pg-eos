// packages/identity/tests/g16a-limits.property.test.ts — WBS 2.16 part 1a-5 (pg-tester), RED phase.
//
// Property tests (fast-check) for the G-16a invariants the slice brief's Decision 8 names,
// asserted for ARBITRARY small threshold values, never just the migration-0042 seeded ones (so a
// hardcoded literal anywhere in the enforcement path fails this file even if it happens to match
// the seeded number) — same discipline as ../tests/otp.test.ts's own "no embedded default" test,
// generalised to a property.
//
// RED, and why it is the right RED: this file imports `generateOtpInTx`, `verifyOtpInTx` (both
// already built, WBS 0.17/P6c) plus the NOT-YET-BUILT key constants and `OtpRateLimitedError` from
// '../src/otp.js' — the same missing-export RED as ./g16a-limits.test.ts's header explains.
//
// EACH PROPERTY RUNS INSIDE ITS OWN ROLLED-BACK TRANSACTION (D8: "set INSIDE a transaction via the
// package's tx-injectable functions ... then ROLLED BACK, so no suite sees another's threshold
// values (known race: identity threshold test under turbo, X part 3)"). The threshold row for the
// key under test is written with `insert ... on conflict (key) do update set value = excluded.value`
// ON THE SAME tx that generateOtpInTx/verifyOtpInTx then read from — visible only inside this
// transaction, because it is explicitly BEGIN'd and ROLLBACK'd by this file itself (see
// runInRolledBackTx below), never committed. No other file, and no other iteration of this same
// property, can ever observe a value this test wrote.
//
// NOT withContext (post-build fix, coordinator round 2). `platform.thresholds` carries RLS policy
// `reference_write`, which requires `is_internal() AND has_perm('platform.reference.manage')` —
// `withContext({ isInternal: true, ... })` alone does not satisfy `has_perm(...)`, so writing a
// threshold row through the ordinary app-role pool (`@pg-eos/db`'s `withContext`) is refused with
// `42501` before any of this file's own code runs. This file instead opens its OWN connection as
// the same superuser/owner role the sibling suites already use to seed fixtures (otp.test.ts's own
// `pool`, `PGUSER` defaulting to 'postgres' — a role RLS does not apply to at all), wraps that ONE
// `pg.PoolClient` in drizzle exactly the way `@pg-eos/db`'s own `withContext` does internally
// (`drizzle(client)`, packages/db/src/with-context.ts), and runs `BEGIN` / the test's own threshold
// writes / the package's `*InTx` functions / `ROLLBACK` all on that SAME client and SAME
// transaction — so generateOtpInTx/verifyOtpInTx see the overridden thresholds (same tx, read
// uncommitted-to-everyone-else), and nothing survives the ROLLBACK.
//
// EVERY OTHER NEW G-16a LIMIT IS ALSO SET, to a large/no-op safe value, inside the SAME rolled-back
// transaction, so each property below isolates the ONE dimension it names — e.g. the max_attempts
// property must not incidentally fail because the (still-default-in-that-tx) resend window or
// hourly cap refused the second generateOtpInTx call it needs.
//
// Schema this suite depends on — identical to tests/tx-injectable.test.ts (01-Data-Model.sql:
// 212-224, 289-296; 13B-Schema-Reference-Consolidation.sql:428-435).

import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

// The already-built WBS 0.17 / P6c tx-injectable surface (tests/tx-injectable.test.ts pins these
// down; reused here unchanged).
import { generateOtpInTx, verifyOtpInTx, OTP_EXPIRY_MINUTES_KEY } from '../src/otp.js';

// NOT YET BUILT — see header. Only these three keys and the error class: nothing in otp.ts reads
// the identity.login.* keys (lockout/rate — out of scope, SCR-IDENTITY-AUTH-01, pre-build review
// round 1 finding 1), so no export exists for them (pre-build review round 1, finding 6).
import {
  OTP_MAX_ATTEMPTS_KEY,
  OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY,
  OTP_RESEND_SECONDS_KEY,
  OtpRateLimitedError,
} from '../src/otp.js';

// Unit conversion, not a business number.
const MILLISECONDS_PER_SECOND = 1000;

// DB-bound async properties (each run opens a real transaction and issues several real queries) —
// same order of magnitude as the existing DB-bound precedent in this repo (modules/billing/tests/
// dimensions/invariants.property.integration.test.ts uses `{ numRuns: 30 }`, matched here exactly
// per the coordinator's round-2 instruction); a runtime/perf tuning constant, never a business
// number.
const PROPERTY_DB_RUNS = 30;

// The same PG* env-var convention, and the same superuser/owner role, as
// ../tests/otp.test.ts's own `pool` (used there to seed threshold fixtures directly — its header:
// "the shared, non-randomUUID()-suffixed key"). RLS does not apply to this role at all, which is
// exactly why this file uses it instead of the ordinary app-role pool behind `withContext` (see
// header — `platform.thresholds`'s `reference_write` policy requires `has_perm(...)`, which
// `withContext`'s `isInternal: true` alone does not satisfy).
const superuserPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// A safe, non-interfering value for every G-16a limit NOT under test in a given property — large
// enough that it can never itself bind within the small arbitrary ranges (1..6, 1..120) used below.
// A fixture/test-tuning constant, not a business number (CLAUDE.md's "numbers come from the system"
// governs identity.otp.* / identity.login.* VALUES, not this suite's own non-interference margin).
const SAFE_NON_BINDING_COUNT = 1_000_000;
const SAFE_NON_BINDING_SECONDS = 0;

// verifyOtpInTx/generateOtpInTx derive an OTP row's issue instant as
// expires_at - identity.otp.expiry_minutes (otp.ts, no created_at column) — every property below
// therefore needs a STABLE, KNOWN value for this key inside its own rolled-back tx, never whatever
// value the shared database happens to carry (pre-build review round 1, finding 6). Deliberately
// NOT the real G-16a number (5) — this file does not test that invariant, so a value that could be
// mistaken for it is avoided.
const PROPERTY_TEST_OTP_EXPIRY_MINUTES = 9;

function wrongCodeFor(code: string): string {
  const firstDigit = Number(code.slice(0, 1));
  const shifted = (firstDigit + 1) % 10;
  return `${shifted}${code.slice(1)}`;
}

async function setThresholdInTx(tx: NodePgDatabase, key: string, value: number): Promise<void> {
  // A guard, not production logic: drizzle's `sql` template silently omits the placeholder for an
  // `undefined` interpolated value instead of binding it, which turns a NOT-YET-BUILT key-name
  // export (see file header — this is the expected RED right now) into a confusing raw Postgres
  // "syntax error at or near ','" instead of a clear signal. This turns it back into one.
  if (typeof key !== 'string') {
    throw new Error(
      `setThresholdInTx: key is not a string (got ${JSON.stringify(key)}) — this is almost ` +
        "certainly a NOT-YET-BUILT key-name export from '../src/otp.js' (see file header)",
    );
  }
  await tx.execute(sql`
    insert into platform.thresholds (key, value, unit, description_ar, changed_by)
    values (
      ${key},
      ${value},
      'count',
      ${'صف اختباري مؤقت — WBS 2.16 part 1a-5 (يُلغى بالتراجع، لا يصل إلى القرص)'},
      ${randomUUID()}
    )
    on conflict (key) do update set value = excluded.value
  `);
}

/** Every new G-16a limit except the one(s) the caller is about to override — set to a value that
 *  cannot bind within this file's small arbitrary ranges, so each property tests ONE dimension.
 *  Also fixes identity.otp.expiry_minutes to a known value (see PROPERTY_TEST_OTP_EXPIRY_MINUTES). */
async function seedNonInterferingDefaultsInTx(tx: NodePgDatabase): Promise<void> {
  await setThresholdInTx(tx, OTP_MAX_ATTEMPTS_KEY, SAFE_NON_BINDING_COUNT);
  await setThresholdInTx(tx, OTP_RESEND_SECONDS_KEY, SAFE_NON_BINDING_SECONDS);
  await setThresholdInTx(tx, OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY, SAFE_NON_BINDING_COUNT);
  await setThresholdInTx(tx, OTP_EXPIRY_MINUTES_KEY, PROPERTY_TEST_OTP_EXPIRY_MINUTES);
}

async function insertFixtureUserInTx(tx: NodePgDatabase, email: string): Promise<void> {
  await tx.execute(sql`
    insert into identity.users (email, full_name_ar, user_type, is_active)
    values (${email}, ${'مستخدم اختبار — WBS 2.16 part 1a-5 (خاصية)'}, 'internal', true)
  `);
}

function uniqueEmail(label: string): string {
  return `pg-eos-2.16-g16a-prop-${label}-${randomUUID()}@example.invalid`;
}

/**
 * Opens ONE client on the superuser/owner pool (RLS does not apply to it — see header), BEGINs a
 * transaction on it, wraps that same client in drizzle (`drizzle(client)`, the exact pattern
 * `@pg-eos/db`'s own `withContext` uses internally — packages/db/src/with-context.ts), runs `fn`
 * against that ONE `tx`/client for its whole body (every threshold write, every generateOtpInTx/
 * verifyOtpInTx call), then ALWAYS ROLLBACKs and releases the client — success or failure. Returns
 * whatever `fn` returned.
 */
async function runInRolledBackTx<T>(fn: (tx: NodePgDatabase) => Promise<T>): Promise<T> {
  const client = await superuserPool.connect();
  try {
    await client.query('begin');
    // 1a-8 / 0044: the write definers refuse a non-internal context, so mirror withContext's
    // transaction-local GUCs (packages/db/src/with-context.ts) for the internal, no-actor context.
    await client.query(`select set_config('app.user_id', null, true)`);
    await client.query(`select set_config('app.client_id', null, true)`);
    await client.query(`select set_config('app.is_internal', 'true', true)`);
    await client.query(`select set_config('app.entity_id', null, true)`);
    const tx = drizzle(client);
    try {
      return await fn(tx);
    } finally {
      // Always rolled back — never committed, whether `fn` succeeded or threw (D8: "ROLLED BACK,
      // so no suite sees another's threshold values").
      await client.query('rollback');
    }
  } finally {
    client.release();
  }
}

afterAll(async () => {
  // Nothing to clean up: every insert this file makes (fixture users, otp_codes,
  // platform.thresholds overrides) lives only inside a transaction that is always rolled back —
  // never committed, so nothing ever reaches a state another test could observe.
  await superuserPool.end();
});

describe('property: identity.otp.max_attempts is read from platform.thresholds, never a literal (D8)', () => {
  it('after exactly (max_attempts - 1) wrong codes the correct code is accepted; after max_attempts it is refused — for any max_attempts in 1..6', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (maxAttempts) => {
        await runInRolledBackTx(async (tx) => {
          const email = uniqueEmail('max-attempts');
          await insertFixtureUserInTx(tx, email);
          await seedNonInterferingDefaultsInTx(tx);
          await setThresholdInTx(tx, OTP_MAX_ATTEMPTS_KEY, maxAttempts);

          const acceptedInstant = new Date();
          const acceptedCase = await generateOtpInTx(tx, email, { now: () => acceptedInstant });
          for (let i = 0; i < maxAttempts - 1; i += 1) {
            const wrong = await verifyOtpInTx(tx, email, wrongCodeFor(acceptedCase.code), {
              now: () => acceptedInstant,
            });
            expect(wrong.valid).toBe(false);
          }
          const accepted = await verifyOtpInTx(tx, email, acceptedCase.code, {
            now: () => acceptedInstant,
          });
          expect(accepted.valid).toBe(true);

          const refusedInstant = new Date(acceptedInstant.getTime() + 1);
          const refusedCase = await generateOtpInTx(tx, email, { now: () => refusedInstant });
          for (let i = 0; i < maxAttempts; i += 1) {
            const wrong = await verifyOtpInTx(tx, email, wrongCodeFor(refusedCase.code), {
              now: () => refusedInstant,
            });
            expect(wrong.valid).toBe(false);
          }
          const refused = await verifyOtpInTx(tx, email, refusedCase.code, {
            now: () => refusedInstant,
          });
          expect(refused.valid).toBe(false);
        });
      }),
      { numRuns: PROPERTY_DB_RUNS },
    );
  });
});

describe('property: identity.otp.requests_per_email_per_hour is read from platform.thresholds, never a literal (D8)', () => {
  it('the N-th request in an hour is accepted; the (N+1)-th is refused — for any N in 1..6', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (requestsPerHour) => {
        await runInRolledBackTx(async (tx) => {
          const email = uniqueEmail('hourly-cap');
          await insertFixtureUserInTx(tx, email);
          await seedNonInterferingDefaultsInTx(tx);
          await setThresholdInTx(tx, OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY, requestsPerHour);
          // resend_seconds is already SAFE_NON_BINDING_SECONDS (0) from the defaults above, so
          // spacing requests by 1ms never itself triggers a resend refusal.

          const baseInstant = new Date();
          for (let i = 0; i < requestsPerHour; i += 1) {
            const at = new Date(baseInstant.getTime() + i);
            await expect(generateOtpInTx(tx, email, { now: () => at })).resolves.toBeDefined();
          }

          const refusalInstant = new Date(baseInstant.getTime() + requestsPerHour);
          await expect(
            generateOtpInTx(tx, email, { now: () => refusalInstant }),
          ).rejects.toBeInstanceOf(OtpRateLimitedError);
        });
      }),
      { numRuns: PROPERTY_DB_RUNS },
    );
  });
});

describe('property: identity.otp.resend_seconds is read from platform.thresholds, never a literal (D8)', () => {
  it('a request strictly inside resend_seconds of the previous one is refused; one at resend_seconds is accepted — for any resend_seconds in 1..120', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 120 }), async (resendSeconds) => {
        await runInRolledBackTx(async (tx) => {
          const email = uniqueEmail('resend');
          await insertFixtureUserInTx(tx, email);
          await seedNonInterferingDefaultsInTx(tx);
          await setThresholdInTx(tx, OTP_RESEND_SECONDS_KEY, resendSeconds);

          const issuedAt = new Date();
          await generateOtpInTx(tx, email, { now: () => issuedAt });

          const insideWindow = new Date(
            issuedAt.getTime() + (resendSeconds - 1) * MILLISECONDS_PER_SECOND,
          );
          await expect(
            generateOtpInTx(tx, email, { now: () => insideWindow }),
          ).rejects.toBeInstanceOf(OtpRateLimitedError);

          const atWindowEnd = new Date(
            issuedAt.getTime() + resendSeconds * MILLISECONDS_PER_SECOND,
          );
          await expect(
            generateOtpInTx(tx, email, { now: () => atWindowEnd }),
          ).resolves.toBeDefined();
        });
      }),
      { numRuns: PROPERTY_DB_RUNS },
    );
  });
});
