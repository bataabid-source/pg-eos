// packages/identity/tests/g16a-limits.test.ts — WBS 2.16 part 1a-5 (pg-tester), RED phase.
//
// G-16a authentication limits (EXECUTION-MASTER-v4 §1.8, quoted in the slice brief and in
// ./g16a-limits.feature): "OTP 6 digits · TTL 5 min · single-use · 5 attempts · resend 60 s ·
// 5/email/hour. Lockout 10 fails/15 min → 15→30→60 min; 3 lockouts/24 h → alert. Rate limits:
// login 5/min/IP + 20/h/email".
//
// OUT OF SCOPE (pre-build review round 1, finding 1) — SCR-IDENTITY-AUTH-01: the lockout ladder,
// the "3 lockouts/24h -> alert" clause, and both login rate limits (5/min/IP, 20/h/email) are not
// tested here — see ./g16a-limits.feature's own header and docs/notes/SCR-IDENTITY-AUTH-01.md. This
// file covers only the OTP-mechanism limits (5 attempts, resend 60s, 5/email/hour) that
// packages/identity/src/otp.ts's generateOtpInTx/verifyOtpInTx enforce, plus migration 0042's own
// seed of every G-16a number (the seed happens regardless of which limits are enforced yet).
//
// RED, and why it is the right RED. This file imports THREE new key-name constants and the new
// `OtpRateLimitedError` class from '../src/otp.js':
//   OTP_MAX_ATTEMPTS_KEY, OTP_RESEND_SECONDS_KEY, OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY,
//   OtpRateLimitedError
// None of these exist yet. Vitest's esbuild-based transform does NOT raise a hard SyntaxError for a
// missing named export from a TS source module the way a real Node ESM runtime would — it silently
// binds the missing name to `undefined` (confirmed on this checkout: `tsc -p tsconfig.test.json
// --noEmit` reports the same gaps as `error TS2305: Module has no exported member`, while `vitest
// run` itself proceeds to execute the tests and fails them individually — `new OtpRateLimitedError(...)`
// as "is not a constructor", every `readThresholdValue(OTP_MAX_ATTEMPTS_KEY)` as "threshold not
// seeded: undefined" because the key is `undefined`, not the real string). Both signals — the
// `tsc` errors AND the runtime failures — are the right RED for the same reason: the export does
// not exist yet.
//
// The 8 identity.login.* keys D1 still requires migration 0042 to seed (lockout/rate numbers — see
// the OUT-OF-SCOPE note above) are referenced by LITERAL key strings, not imported constants:
// nothing in otp.ts reads them yet (their enforcement is the SCR's job), so otp.ts has no reason to
// export a name for them, and this file's D1 table does not need one either — it only needs the
// exact string platform.thresholds.key must equal (D1, verbatim from the brief) (pre-build review
// round 1, finding 6).
//
// KEY NAMING (D1, verbatim from the brief) — the platform.thresholds `key` column value each
// constant/literal must hold, asserted by the 'migration 0042' describe block below:
//   identity.otp.expiry_minutes = 5 (checked two ways — see that describe block's own header)
//   identity.otp.max_attempts = 5
//   identity.otp.resend_seconds = 60
//   identity.otp.requests_per_email_per_hour = 5
//   identity.login.lockout_fail_threshold = 10
//   identity.login.lockout_window_minutes = 15
//   identity.login.lockout_minutes_1 = 15
//   identity.login.lockout_minutes_2 = 30
//   identity.login.lockout_minutes_3 = 60
//   identity.login.lockout_alert_count_24h = 3
//   identity.login.rate_per_ip_per_minute = 5
//   identity.login.rate_per_email_per_hour = 20
//
// D1's own instruction: "Test: each key exists with exactly that value (RED until the builder
// writes/applies 0042)" — this file therefore READS platform.thresholds directly, and NEVER seeds
// the new G-16a keys itself. Migration 0042 is the only permitted writer of these rows in a running
// system; a test that seeded them would prove nothing about the migration existing.
//
// identity.otp.expiry_minutes IS DIFFERENT (pre-build review round 1, finding 3). This key already
// exists and is already read by generateOtp/verifyOtp (WBS 0.17) — sibling suites (otp.test.ts,
// login-flows.test.ts, handlers.test.ts, otp-login.test.ts) already seed it with their OWN fixture
// value ('7') via `on conflict (key) do nothing`, and the shared test database keeps whichever row
// won that race FOREVER (by design — see those files' own "SEED-ONLY, NEVER DELETE" headers,
// migrations 0010/0015/0033's own precedent for this pattern). Once any sibling suite has ever run
// against this database, migration 0042's `on conflict (key) do nothing` seed of 5 will never
// overwrite that stale 7 — so a LIVE exact-value check against this key is not a meaningful RED
// signal for "did migration 0042 seed 5 minutes": it is a signal for "which test ran first". This
// file therefore checks identity.otp.expiry_minutes TWO ways instead: (a) a live check that SOME
// row exists and is finite and positive (proves the key is seeded at all, from whatever source),
// and (b) a STATIC check that migration 0042's own file text contains the seed row for 5.000
// minutes (proves the migration itself is correct, independent of the shared database's history).
//
// CONCURRENCY (same discipline as otp.test.ts / login-flows.test.ts / tx-injectable.test.ts's own
// headers): this file never inserts or deletes ANY platform.thresholds row — it only reads. It is a
// pure bystander with respect to every key.
//
// Schema this suite depends on — identical to otp.test.ts (database/schema/01-Data-Model.sql:
// 212-224, 289-296; 13B-Schema-Reference-Consolidation.sql:428-435).

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

// The already-built WBS 0.17 surface, used as-is.
import { generateOtp, verifyOtp, OTP_EXPIRY_MINUTES_KEY } from '../src/otp.js';
import type { GeneratedOtp, OtpVerification } from '../src/otp.js';

// NOT YET BUILT — the whole point of this file's RED (see header).
import {
  OTP_MAX_ATTEMPTS_KEY,
  OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY,
  OTP_RESEND_SECONDS_KEY,
  OtpRateLimitedError,
} from '../src/otp.js';

// A code that is guaranteed to differ from any generated one — same derivation as otp.test.ts's own
// wrongCodeFor, not re-invented.
function wrongCodeFor(code: string): string {
  const firstDigit = Number(code.slice(0, 1));
  const shifted = (firstDigit + 1) % 10;
  return `${shifted}${code.slice(1)}`;
}

// Unit conversion constants only (CLAUDE.md: "no magic numbers" is about business numbers; these
// are the fixed meanings of "second"/"minute", not a threshold value).
const MILLISECONDS_PER_SECOND = 1000;

// A tiny arithmetic safety margin (not a business number) so "just inside"/"just outside" a window
// boundary is unambiguous against integer-second thresholds.
const BOUNDARY_MARGIN_SECONDS = 1;

// The migration this slice delivers (Master-issued number, slice brief: "Migration number: 0042 —
// issued to lane M"). Resolved relative to THIS file so it does not depend on the process cwd.
const MIGRATION_0042_PATH = fileURLToPath(
  new URL(
    '../../../database/migrations/0042_M_identity-auth-thresholds.sql',
    import.meta.url,
  ),
);

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const fixtureEmails: string[] = [];

/** The live platform.thresholds value for `key` — never seeded by this file (see header). Throws a
 *  clear message (a valid RED before migration 0042 exists) rather than returning a default. */
async function readThresholdValue(key: string): Promise<number> {
  const result: QueryResult<{ value: string }> = await pool.query(
    'select value from platform.thresholds where key = $1',
    [key],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `G-16a threshold not seeded: ${key} — expected from migration 0042 (WBS 2.16 part 1a-5)`,
    );
  }
  return Number(row.value);
}

async function createFixtureUser(): Promise<{ id: string; email: string }> {
  const email = `pg-eos-2.16-g16a-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', true)
     returning id`,
    [email, 'مستخدم اختبار — WBS 2.16 part 1a-5'],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('fixture user insert returned no row');
  }
  return { id: row.id, email };
}

interface OtpRow {
  id: string;
  consumed_at: Date | null;
  attempts: number;
}

async function readOtpRow(otpId: string): Promise<OtpRow> {
  const result: QueryResult<OtpRow> = await pool.query(
    'select id, consumed_at, attempts from identity.otp_codes where id = $1',
    [otpId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`identity.otp_codes row not found: ${otpId}`);
  }
  return row;
}

async function countOtpRows(email: string): Promise<number> {
  const result = await pool.query('select id from identity.otp_codes where email = $1', [email]);
  return result.rows.length;
}

afterAll(async () => {
  if (fixtureEmails.length > 0) {
    await pool.query('delete from identity.otp_codes where email = any($1::text[])', [
      fixtureEmails,
    ]);
    await pool.query('delete from identity.users where email = any($1::text[])', [fixtureEmails]);
  }
  // No platform.thresholds row is ever written by this file — nothing to delete (see header).
  await pool.end();
});

describe('migration 0042 seeds every G-16a number into platform.thresholds (D1)', () => {
  it('identity.otp.expiry_minutes has SOME live, finite, positive value (the shared database may still carry an older fixture value than 0042 itself seeds — see the static check below for the exact number 0042 must write)', async () => {
    const value = await readThresholdValue(OTP_EXPIRY_MINUTES_KEY);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });

  it('migration 0042\'s own file text seeds identity.otp.expiry_minutes = 5.000 minutes — independent of whatever value the shared database currently carries', () => {
    const migrationText = readFileSync(MIGRATION_0042_PATH, 'utf8');
    expect(migrationText).toMatch(
      /'identity\.otp\.expiry_minutes'\s*,\s*5(?:\.0+)?\s*,\s*'minutes'/,
    );
  });

  it.each([
    [OTP_MAX_ATTEMPTS_KEY, 5],
    [OTP_RESEND_SECONDS_KEY, 60],
    [OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY, 5],
    ['identity.login.lockout_fail_threshold', 10],
    ['identity.login.lockout_window_minutes', 15],
    ['identity.login.lockout_minutes_1', 15],
    ['identity.login.lockout_minutes_2', 30],
    ['identity.login.lockout_minutes_3', 60],
    ['identity.login.lockout_alert_count_24h', 3],
    ['identity.login.rate_per_ip_per_minute', 5],
    ['identity.login.rate_per_email_per_hour', 20],
  ])('%s = %d exactly', async (key, expectedValue) => {
    const value = await readThresholdValue(key);
    expect(value).toBe(expectedValue);
  });
});

describe('OTP verification is refused once identity.otp.max_attempts wrong attempts have been recorded — even for the correct code (D2)', () => {
  it('after exactly max_attempts wrong codes, the correct code is refused and the row stays unconsumed', async () => {
    const user = await createFixtureUser();
    const maxAttempts = await readThresholdValue(OTP_MAX_ATTEMPTS_KEY);
    const issuedAt = new Date();
    const otp: GeneratedOtp = await generateOtp(user.email, { now: () => issuedAt });

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const wrong: OtpVerification = await verifyOtp(user.email, wrongCodeFor(otp.code), {
        now: () => issuedAt,
      });
      expect(wrong.valid).toBe(false);
    }

    const finalVerification = await verifyOtp(user.email, otp.code, { now: () => issuedAt });
    expect(finalVerification.valid).toBe(false);

    const row = await readOtpRow(otp.otpId);
    expect(row.consumed_at).toBeNull();
  });

  it('after only max_attempts - 1 wrong codes, the correct code still verifies (the cap is exclusive of the correct attempt)', async () => {
    const user = await createFixtureUser();
    const maxAttempts = await readThresholdValue(OTP_MAX_ATTEMPTS_KEY);
    const issuedAt = new Date();
    const otp = await generateOtp(user.email, { now: () => issuedAt });

    for (let attempt = 0; attempt < maxAttempts - 1; attempt += 1) {
      const wrong = await verifyOtp(user.email, wrongCodeFor(otp.code), { now: () => issuedAt });
      expect(wrong.valid).toBe(false);
    }

    const accepted = await verifyOtp(user.email, otp.code, { now: () => issuedAt });
    expect(accepted.valid).toBe(true);
  });
});

describe('a new OTP request invalidates every previous live code for that email (D3)', () => {
  it('after requesting a second code, the first (still correct, unexpired) code is refused; the second verifies', async () => {
    const user = await createFixtureUser();
    const resendSeconds = await readThresholdValue(OTP_RESEND_SECONDS_KEY);
    const firstIssuedAt = new Date();
    const first = await generateOtp(user.email, { now: () => firstIssuedAt });

    const secondIssuedAt = new Date(
      firstIssuedAt.getTime() +
        (resendSeconds + BOUNDARY_MARGIN_SECONDS) * MILLISECONDS_PER_SECOND,
    );
    const second = await generateOtp(user.email, { now: () => secondIssuedAt });

    const firstVerification = await verifyOtp(user.email, first.code, {
      now: () => secondIssuedAt,
    });
    expect(firstVerification.valid).toBe(false);

    const firstRow = await readOtpRow(first.otpId);
    expect(firstRow.consumed_at).not.toBeNull();

    const secondVerification = await verifyOtp(user.email, second.code, {
      now: () => secondIssuedAt,
    });
    expect(secondVerification.valid).toBe(true);
  });
});

describe('resend window — a second request inside identity.otp.resend_seconds is refused (D4)', () => {
  it('is refused, writes no otp_codes row, and does not invalidate the earlier live code', async () => {
    const user = await createFixtureUser();
    const resendSeconds = await readThresholdValue(OTP_RESEND_SECONDS_KEY);
    const issuedAt = new Date();
    const first = await generateOtp(user.email, { now: () => issuedAt });

    const insideResendWindow = new Date(
      issuedAt.getTime() +
        Math.max(0, resendSeconds - BOUNDARY_MARGIN_SECONDS) * MILLISECONDS_PER_SECOND,
    );

    await expect(
      generateOtp(user.email, { now: () => insideResendWindow }),
    ).rejects.toBeInstanceOf(OtpRateLimitedError);

    expect(await countOtpRows(user.email)).toBe(1);

    const verification = await verifyOtp(user.email, first.code, { now: () => insideResendWindow });
    expect(verification.valid).toBe(true);
  });
});

describe('hourly cap — the (N+1)-th request in an hour for one email is refused, N = identity.otp.requests_per_email_per_hour (D4)', () => {
  it('after N accepted requests, the next one is refused and writes no row', async () => {
    const user = await createFixtureUser();
    const requestsPerHour = await readThresholdValue(OTP_REQUESTS_PER_EMAIL_PER_HOUR_KEY);
    const resendSeconds = await readThresholdValue(OTP_RESEND_SECONDS_KEY);

    let clock = new Date();
    const step = (): Date => {
      clock = new Date(
        clock.getTime() + (resendSeconds + BOUNDARY_MARGIN_SECONDS) * MILLISECONDS_PER_SECOND,
      );
      return clock;
    };

    for (let i = 0; i < requestsPerHour; i += 1) {
      await expect(generateOtp(user.email, { now: step })).resolves.toBeDefined();
    }

    expect(await countOtpRows(user.email)).toBe(requestsPerHour);

    await expect(generateOtp(user.email, { now: step })).rejects.toBeInstanceOf(
      OtpRateLimitedError,
    );

    expect(await countOtpRows(user.email)).toBe(requestsPerHour);
  });
});

describe('concurrency — K simultaneous requests for the same email at ONE instant accept exactly one and refuse the rest (pre-build review round 1, finding 4)', () => {
  // K parallel calls, each its own withContext transaction (generateOtp, not generateOtpInTx) —
  // named so it is never a bare literal in the assertions below. Deliberately smaller than the real
  // identity.otp.requests_per_email_per_hour seed (5) so this test's own concurrency race, not the
  // hourly cap, is what determines the outcome.
  const CONCURRENT_REQUEST_COUNT = 4;

  it(`exactly 1 of ${CONCURRENT_REQUEST_COUNT} parallel generateOtp calls at the same instant is fulfilled, the rest reject with OtpRateLimitedError, and exactly one identity.otp_codes row exists`, async () => {
    const user = await createFixtureUser();
    const at = new Date();

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_REQUEST_COUNT }, () =>
        generateOtp(user.email, { now: () => at }),
      ),
    );

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<GeneratedOtp> => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENT_REQUEST_COUNT - 1);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(OtpRateLimitedError);
    }

    expect(await countOtpRows(user.email)).toBe(1);
  });
});

describe('OtpRateLimitedError conveys a fixed reason, never free text or the email/code (pre-build review round 1, finding 8)', () => {
  it.each(['resend', 'hourly'] as const)(
    'constructs from reason "%s" — a real Error subclass whose message never contains an email-like or code-like value',
    (reason) => {
      const instance = new OtpRateLimitedError(reason);
      expect(instance).toBeInstanceOf(Error);
      expect(instance.name).toBe('OtpRateLimitedError');
      expect(instance.message).toContain(reason);
      expect(instance.message).not.toMatch(/@/);
      expect(instance.message).not.toMatch(/\d{6}/);
    },
  );
});

describe('readThresholdValue (this file\'s own probe) fails clearly, never silently, for a key with no row — proves the D1 table above is read against a real gap, not a stale row', () => {
  it('throws naming the key for a randomUUID()-suffixed probe key that can never have a row', async () => {
    const neverSeededKey = `identity.otp.g16a_absent_probe_${randomUUID()}`;
    await expect(readThresholdValue(neverSeededKey)).rejects.toThrow(neverSeededKey);
  });
});
