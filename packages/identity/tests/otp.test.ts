// packages/identity/tests/otp.test.ts — WBS 0.17 (pg-tester), RED phase.
//
// RED, and why it is the right RED: `packages/identity/src/otp.ts` and
// `packages/identity/src/thresholds.ts` do not exist yet — pg-backend builds them next, to exactly
// the contract these tests pin down. Every import below therefore fails to resolve, which is the
// same class of RED as WBS 0.11 (packages/db/tests/with-context.test.ts) and WBS 0.12
// (packages/events/tests/outbox-write.test.ts) and is the documented precedent in this repo.
//
// Scope: the OTP feature of the WBS 0.17 slice brief, "Feature: OTP login mechanism" — five
// Gherkin scenarios, plus the two invariants the brief's Deliver section states in prose (the
// stored hash is a keyed HMAC, never the plaintext code; every limit comes from
// platform.thresholds, never from an embedded default).
//
// Schema this suite depends on, quoted from the ONLY permitted schema
// (database/schema/01-Data-Model.sql:212-224, 279-286):
//   identity.users     (id uuid pk, email text not null unique, full_name_ar text not null,
//                       user_type text not null default 'internal', is_active boolean not null
//                       default true, …)
//   identity.otp_codes (id uuid pk, email text not null, code_hash text not null,
//                       expires_at timestamptz not null, consumed_at timestamptz,
//                       attempts int not null default 0)
// and platform.thresholds (database/schema/13B-Schema-Reference-Consolidation.sql:328-335):
//   (key text pk, value numeric(14,3) not null, unit text, description_ar text not null,
//    changed_by uuid not null, changed_at timestamptz not null default now()).
//
// KNOWN SCHEMA GAP this suite is designed around (WBS 0.17 brief, "Known schema gap"):
// platform.thresholds carries NO production seed row for OTP expiry or OTP max attempts. CLAUDE.md
// forbids inventing one ("No magic numbers — constants or platform.thresholds"; "Never fabricate a
// number"). So this suite seeds its OWN fixture rows under the `identity.otp.*` key namespace
// (matching the WBS 0.12 precedent of tests owning their fixtures), and never asserts the seeded
// number as a literal: every expiry assertion re-reads `value` from platform.thresholds at assert
// time and derives the expected instant from it. A hardcoded default inside generateOtp would
// therefore fail this suite, which is the point.
//
// Concurrency note on those fixture rows: platform.thresholds is keyed by `key`, and the
// implementation reads a FIXED key — so, unlike every other fixture in this suite, these rows
// cannot be randomUUID()-suffixed per run. The suite inserts them with `on conflict (key) do
// nothing` and deletes in afterAll only the keys THIS run actually inserted, so two concurrent
// worktree sessions do not delete each other's rows. A run that finishes while a second run is
// still mid-test could still remove a row the second run relies on; that narrow window closes for
// good once the Master's follow-up lands real production seed rows for these keys (at which point
// `on conflict do nothing` becomes a no-op and nothing is ever deleted).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The public contract of the already-built @pg-eos/db package (WBS 0.11) — used as-is, not
// re-proven here. Needed only to hand `getThreshold` the transaction handle it takes.
import { withContext } from '@pg-eos/db';

// The package under test. Neither module exists yet — this is the RED.
import { generateOtp, verifyOtp, UnknownOrInactiveUserError } from '../src/otp.js';
import type { GeneratedOtp, OtpVerification } from '../src/otp.js';
import { getThreshold } from '../src/thresholds.js';

// platform.thresholds keys this package reads. Names, not values, are the contract here — the
// values below are fixture data, deliberately NOT round numbers, so that an implementation with a
// plausible hardcoded default (5, 10, 15 minutes; 3 or 5 attempts) cannot accidentally pass.
const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';
const OTP_MAX_ATTEMPTS_KEY = 'identity.otp.max_attempts';

const THRESHOLD_FIXTURES = [
  {
    key: OTP_EXPIRY_MINUTES_KEY,
    value: '7',
    unit: 'minutes',
    descriptionAr: 'صلاحية رمز الدخول لمرة واحدة بالدقائق — صف اختباري (WBS 0.17)',
  },
  {
    key: OTP_MAX_ATTEMPTS_KEY,
    value: '4',
    unit: 'attempts',
    descriptionAr: 'أقصى عدد محاولات للتحقق من رمز الدخول — صف اختباري (WBS 0.17)',
  },
] as const;

// Unit conversion only — platform.thresholds.unit says 'minutes', JS Date arithmetic is in
// milliseconds. Not a business number.
const MILLISECONDS_PER_MINUTE = 60_000;

// The WBS 0.17 brief states the OTP is six digits ("a 6-digit OTP is a 1e6-space, brute-forceable
// under a bare SHA-256 lookup if the table ever leaked"). Asserted from the brief, not invented.
const SIX_DIGIT_CODE = /^[0-9]{6}$/;

// A code that is guaranteed to differ from any generated one, for the wrong-code scenario:
// derived from the real code, never a literal that could coincidentally match it.
function wrongCodeFor(code: string): string {
  const firstDigit = Number(code.slice(0, 1));
  const shifted = (firstDigit + 1) % 10;
  return `${shifted}${code.slice(1)}`;
}

// Same PG* env-var convention as packages/db/src/client.ts, packages/db/tests/with-context.test.ts
// and packages/events/tests/*.test.ts. An independent pool: it reads identity.otp_codes back from
// OUTSIDE whatever transaction the code under test used, and seeds fixtures.
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const thresholdKeysSeededByThisRun: string[] = [];
const fixtureEmails: string[] = [];

async function seedThresholdFixtures(): Promise<void> {
  for (const fixture of THRESHOLD_FIXTURES) {
    const inserted = await pool.query(
      `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
       values ($1, $2, $3, $4, $5)
       on conflict (key) do nothing`,
      [fixture.key, fixture.value, fixture.unit, fixture.descriptionAr, randomUUID()],
    );
    if (inserted.rowCount === 1) {
      thresholdKeysSeededByThisRun.push(fixture.key);
    }
  }
}

/** The live value of a threshold, read at assert time — never the literal seeded above. */
async function readThresholdValue(key: string): Promise<number> {
  const result: QueryResult<{ value: string }> = await pool.query(
    'select value from platform.thresholds where key = $1',
    [key],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`threshold fixture missing at assert time: ${key}`);
  }
  // numeric(14,3) comes back from node-postgres as a string — parsed here, not assumed.
  return Number(row.value);
}

/** An active identity.users row owned by this run. Email is randomUUID()-suffixed and .invalid. */
async function createFixtureUser(isActive: boolean): Promise<{ id: string; email: string }> {
  const email = `pg-eos-0.17-otp-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', $3)
     returning id`,
    [email, 'مستخدم اختبار — WBS 0.17', isActive],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('fixture user insert returned no row');
  }
  return { id: row.id, email };
}

interface OtpRow {
  id: string;
  email: string;
  code_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  attempts: number;
}

async function readOtpRow(otpId: string): Promise<OtpRow> {
  const result: QueryResult<OtpRow> = await pool.query(
    'select id, email, code_hash, expires_at, consumed_at, attempts from identity.otp_codes where id = $1',
    [otpId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`identity.otp_codes row not found: ${otpId}`);
  }
  return row;
}

beforeAll(async () => {
  await seedThresholdFixtures();
});

afterAll(async () => {
  // identity.otp_codes has no FK to identity.users, so it is cleaned by email explicitly.
  if (fixtureEmails.length > 0) {
    await pool.query('delete from identity.otp_codes where email = any($1::text[])', [
      fixtureEmails,
    ]);
    await pool.query('delete from identity.users where email = any($1::text[])', [fixtureEmails]);
  }
  if (thresholdKeysSeededByThisRun.length > 0) {
    await pool.query('delete from platform.thresholds where key = any($1::text[])', [
      thresholdKeysSeededByThisRun,
    ]);
  }
  await pool.end();
});

describe('OTP login mechanism — generateOtp / verifyOtp (WBS 0.17 brief, Feature: OTP login mechanism)', () => {
  it('verifyOtp with the correct, unexpired, unconsumed code reports valid, returns that user id, and marks the otp_codes row consumed', async () => {
    const user = await createFixtureUser(true);
    const issuedAt = new Date();

    const otp: GeneratedOtp = await generateOtp(user.email, { now: () => issuedAt });
    expect(otp.code).toMatch(SIX_DIGIT_CODE);

    const before = await readOtpRow(otp.otpId);
    expect(before.consumed_at).toBeNull();

    const verification: OtpVerification = await verifyOtp(user.email, otp.code, {
      now: () => issuedAt,
    });

    expect(verification.valid).toBe(true);
    // Narrowed on the discriminant so userId is only read where the union says it exists.
    if (!verification.valid) {
      throw new Error('expected a valid verification for the correct, unexpired code');
    }
    expect(verification.userId).toBe(user.id);
    expect(verification.otpId).toBe(otp.otpId);

    const after = await readOtpRow(otp.otpId);
    expect(after.consumed_at).not.toBeNull();
  });

  it('verifyOtp with a wrong code reports invalid, increments identity.otp_codes.attempts by exactly 1, and leaves the row unconsumed', async () => {
    const user = await createFixtureUser(true);
    const issuedAt = new Date();

    const otp = await generateOtp(user.email, { now: () => issuedAt });
    const before = await readOtpRow(otp.otpId);

    const verification = await verifyOtp(user.email, wrongCodeFor(otp.code), {
      now: () => issuedAt,
    });

    expect(verification.valid).toBe(false);

    const after = await readOtpRow(otp.otpId);
    // "increments by 1" — asserted as a delta against the row's own prior value, not against a
    // literal, so the starting point is whatever the schema default made it.
    expect(after.attempts).toBe(before.attempts + 1);
    expect(after.consumed_at).toBeNull();
  });

  it('verifyOtp with the correct code reports invalid once the instant is past identity.otp_codes.expires_at', async () => {
    const user = await createFixtureUser(true);
    const issuedAt = new Date();

    const otp = await generateOtp(user.email, { now: () => issuedAt });

    // One millisecond past the row's OWN expires_at — read back from the database, never computed
    // from a literal lifetime. The injected clock is what makes this deterministic instead of a
    // sleep (WBS 0.17 brief: "inject a clock function … so expiry tests are deterministic").
    const row = await readOtpRow(otp.otpId);
    const justAfterExpiry = new Date(row.expires_at.getTime() + 1);

    const verification = await verifyOtp(user.email, otp.code, { now: () => justAfterExpiry });

    expect(verification.valid).toBe(false);
  });

  it('verifyOtp with the correct code reports invalid the second time — a consumed code cannot be reused', async () => {
    const user = await createFixtureUser(true);
    const issuedAt = new Date();

    const otp = await generateOtp(user.email, { now: () => issuedAt });

    const first = await verifyOtp(user.email, otp.code, { now: () => issuedAt });
    expect(first.valid).toBe(true);

    const second = await verifyOtp(user.email, otp.code, { now: () => issuedAt });
    expect(second.valid).toBe(false);
  });

  it('generateOtp throws UnknownOrInactiveUserError for an email with no identity.users row, and creates no user and no otp_codes row', async () => {
    // Never inserted: there is no self-registration rule in 01 / 13 / 13B / 019 / 40, so
    // generateOtp must refuse rather than create anything (WBS 0.17 brief, scenario 5).
    const unknownEmail = `pg-eos-0.17-otp-unknown-${randomUUID()}@example.invalid`;
    fixtureEmails.push(unknownEmail);

    await expect(generateOtp(unknownEmail, { now: () => new Date() })).rejects.toBeInstanceOf(
      UnknownOrInactiveUserError,
    );

    const users: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.users where email = $1',
      [unknownEmail],
    );
    expect(users.rows).toHaveLength(0);

    const codes: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.otp_codes where email = $1',
      [unknownEmail],
    );
    expect(codes.rows).toHaveLength(0);
  });

  it('generateOtp throws UnknownOrInactiveUserError for an email whose identity.users row has is_active = false, and creates no otp_codes row', async () => {
    const user = await createFixtureUser(false);

    await expect(generateOtp(user.email, { now: () => new Date() })).rejects.toBeInstanceOf(
      UnknownOrInactiveUserError,
    );

    const codes: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.otp_codes where email = $1',
      [user.email],
    );
    expect(codes.rows).toHaveLength(0);
  });
});

describe('OTP storage invariants — the stored value is a keyed HMAC, the expiry comes from platform.thresholds (WBS 0.17 brief, Deliver)', () => {
  it('identity.otp_codes.code_hash never equals, nor contains, the plaintext code — and two OTPs with the same digits hash identically under the one keyed secret', async () => {
    const userA = await createFixtureUser(true);
    const userB = await createFixtureUser(true);
    const issuedAt = new Date();

    const otpA = await generateOtp(userA.email, { now: () => issuedAt });
    const otpB = await generateOtp(userB.email, { now: () => issuedAt });

    const rowA = await readOtpRow(otpA.otpId);
    const rowB = await readOtpRow(otpB.otpId);

    for (const [row, otp] of [
      [rowA, otpA],
      [rowB, otpB],
    ] as const) {
      expect(row.code_hash).not.toBe(otp.code);
      expect(row.code_hash).not.toContain(otp.code);
      // A 1e6-space secret stored in the clear, or reversibly encoded, is the failure this guards
      // against: the stored value must not be the code in any trivially recoverable form.
      expect(Buffer.from(row.code_hash, 'base64').toString('utf8')).not.toBe(otp.code);
      expect(Buffer.from(row.code_hash, 'hex').toString('utf8')).not.toBe(otp.code);
    }

    // Determinism of the keyed hash is what makes verification possible at all: equal codes must
    // produce equal stored hashes, different codes different ones.
    if (otpA.code === otpB.code) {
      expect(rowA.code_hash).toBe(rowB.code_hash);
    } else {
      expect(rowA.code_hash).not.toBe(rowB.code_hash);
    }
  });

  it('generateOtp sets identity.otp_codes.expires_at to the injected instant plus the identity.otp.expiry_minutes threshold — no embedded default', async () => {
    const user = await createFixtureUser(true);
    const issuedAt = new Date();

    const otp = await generateOtp(user.email, { now: () => issuedAt });

    const expiryMinutes = await readThresholdValue(OTP_EXPIRY_MINUTES_KEY);
    const expected = issuedAt.getTime() + expiryMinutes * MILLISECONDS_PER_MINUTE;

    expect(otp.expiresAt.getTime()).toBe(expected);

    const row = await readOtpRow(otp.otpId);
    expect(row.expires_at.getTime()).toBe(expected);
  });
});

describe('getThreshold — the only way a limit enters this package (WBS 0.17 brief, Known schema gap)', () => {
  it('returns the platform.thresholds value for a key that exists, as a number', async () => {
    const maxAttempts = await withContext(
      { userId: null, clientId: null, isInternal: true },
      async (tx) => getThreshold(tx, OTP_MAX_ATTEMPTS_KEY),
    );

    expect(maxAttempts).toBe(await readThresholdValue(OTP_MAX_ATTEMPTS_KEY));
  });

  it('rejects with a clear "threshold not configured" error for a key with no platform.thresholds row — never falls back to a default', async () => {
    const absentKey = `identity.otp.absent_probe_${randomUUID()}`;

    await expect(
      withContext({ userId: null, clientId: null, isInternal: true }, async (tx) =>
        getThreshold(tx, absentKey),
      ),
    ).rejects.toThrow(absentKey);
  });
});
