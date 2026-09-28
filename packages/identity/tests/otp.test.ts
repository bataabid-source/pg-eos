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
// platform.thresholds carries NO production seed row for the OTP expiry. CLAUDE.md forbids
// inventing one ("No magic numbers — constants or platform.thresholds"; "Never fabricate a
// number"). So this suite seeds its OWN fixture row under the `identity.otp.*` key namespace
// (matching the WBS 0.12 precedent of tests owning their fixtures), and never asserts the seeded
// number as a literal: every expiry assertion re-reads `value` from platform.thresholds at assert
// time and derives the expected instant from it. A hardcoded default inside generateOtp would
// therefore fail this suite, which is the point.
//
// ONE fixture key, not two. An earlier revision of this file also seeded
// `identity.otp.max_attempts`. No delivered code reads that key, and no max-attempts / lockout rule
// exists anywhere in docs 01 / 13 / 13B / 019 / 40 — so none was built, correctly (CLAUDE.md ·
// AGENT CONSTRAINTS: "never invent"). Seeding a business-named threshold that nothing reads asserts
// a rule the system does not have, so the row is gone; `identity.otp.expiry_minutes`, which real
// code does read, carries the getThreshold happy-path assertion instead. If a lockout rule is ever
// added to the docs, the task that adds it seeds its own key.
//
// CONCURRENCY — SEED-ONLY, NEVER DELETE (P6c round 1 fix; supersedes an earlier version of this
// comment). platform.thresholds is keyed by `key`, and the implementation reads a FIXED key, so —
// unlike every other fixture in this suite — this row cannot be randomUUID()-suffixed per run. It
// used to be deleted in afterAll (guarded by "still this run's key AND value"), but that guard
// only protects against a DIFFERENT value winning the row; it does nothing against a concurrent
// file that depends on the SAME value this run wrote, which is exactly what
// tests/login-flows.test.ts and tests/deadlock-regression.test.ts now do with this same key. This
// file therefore only ever inserts with `on conflict (key) do nothing` and never deletes — the
// same bystander discipline tests/tx-injectable.test.ts's header already documents. The row is
// removed only by the Master's eventual production seed replacing the whole mechanism.

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

// The one platform.thresholds key this package reads for OTP. The name, not the value, is the
// contract here — the value below is fixture data, deliberately NOT a round number, so that an
// implementation with a plausible hardcoded default (5, 10, 15 minutes) cannot accidentally pass.
const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';

// WBS 2.16 part 1a-5 / G-16a: the resend-window key the "candidate selection" regression below now
// has to respect (a second request inside this window is refused) — read live, never seeded by
// this file (migration 0042 is its only permitted writer; see g16a-limits.test.ts's own header).
const OTP_RESEND_SECONDS_KEY = 'identity.otp.resend_seconds';

const THRESHOLD_FIXTURES = [
  {
    key: OTP_EXPIRY_MINUTES_KEY,
    value: '7',
    unit: 'minutes',
    descriptionAr: 'صلاحية رمز الدخول لمرة واحدة بالدقائق — صف اختباري (WBS 0.17)',
  },
] as const;

// Unit conversion only — platform.thresholds.unit says 'minutes', JS Date arithmetic is in
// milliseconds. Not a business number.
const MILLISECONDS_PER_MINUTE = 60_000;

// Unit conversion only (seconds, for the resend-window arithmetic the rewritten "candidate
// selection" regression below needs — WBS 2.16 part 1a-5 / G-16a). Not a business number.
const MILLISECONDS_PER_SECOND = 1000;

// A tiny arithmetic safety margin (not a business number) so "just past the resend window" is
// unambiguous against an integer-second threshold — same constant name/role as
// g16a-limits.test.ts's own.
const BOUNDARY_MARGIN_SECONDS = 1;

// Arithmetic, not a business number: the rewritten "candidate selection" regression below only
// needs the older row's doctored expires_at to be STRICTLY after the newer row's real one — any
// positive margin proves the point.
const INVERSION_MARGIN_MS = 1000;

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

const fixtureEmails: string[] = [];

async function seedThresholdFixtures(): Promise<void> {
  for (const fixture of THRESHOLD_FIXTURES) {
    await pool.query(
      `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
       values ($1, $2, $3, $4, $5)
       on conflict (key) do nothing`,
      [fixture.key, fixture.value, fixture.unit, fixture.descriptionAr, randomUUID()],
    );
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

// --- WBS 2.16 part 1a-5 / G-16a support for the rewritten "candidate selection" regression below
// (coordinator round 2, defect 2) ------------------------------------------------------------
//
// WHY NOT A LIVE identity.otp.expiry_minutes EDIT (as originally instructed) — a documented
// deviation, not a silent one. The obvious rewrite ("issue code 1 under a LARGER expiry_minutes,
// lower it, advance the clock past resend_seconds, issue code 2") is mathematically impossible
// against the REAL, as-built generateOtpInTx: its resend/hourly-cap check re-derives EVERY row's
// issue instant from `expires_at` using the CURRENT (live) expiry_minutes at check time
// (otp.ts's own "ISSUE-INSTANT SKEW" note: "LOWERING it moves them later — fails closed"). Given
// expiry_minutes E1 (older) lowered to E2 (newer, E2 < E1) and a gap of `g` seconds between the two
// issuances: avoiding a false resend refusal requires g >= resendSeconds + (E1-E2)*60; producing the
// expires_at INVERSION this regression needs requires g < (E1-E2)*60. Since resendSeconds > 0 (G-16a
// seeds 60), these two requirements can never both hold — for ANY E1 > E2 and ANY resendSeconds > 0,
// not just the specific numbers tried. So the second `generateOtp` call in that recipe is ALWAYS
// refused with OtpRateLimitedError('resend'), confirmed by running it.
//
// THE WORKING ALTERNATIVE, achieving the identical end state without fighting that check: issue
// BOTH codes entirely normally (two real `generateOtp` calls, resend_seconds apart, no threshold
// ever touched — so the resend/hourly check runs on ACCURATE, unskewed data and never misfires).
// D3 already invalidates `older` automatically the moment `newer` is issued. Only THEN, with no
// further `generateOtpInTx` call left to re-derive anything from it, is `older`'s OWN `expires_at`
// column pushed later than `newer`'s real one via a single, direct, single-row UPDATE — a plain
// fixture-data edit on this run's own otp_codes row (identical in kind to this file's own
// pre-existing "update identity.users set is_active = false where id = $1" fixture edit), never a
// platform.thresholds write, so there is nothing here that could ever leak to another suite.
async function inflateExpiresAt(otpId: string, mustBeAfter: Date): Promise<void> {
  const inflated = new Date(mustBeAfter.getTime() + INVERSION_MARGIN_MS);
  await pool.query('update identity.otp_codes set expires_at = $2 where id = $1', [
    otpId,
    inflated.toISOString(),
  ]);
}

/**
 * Issues an OLDER code, then — after advancing the clock past identity.otp.resend_seconds (WBS
 * 2.16 part 1a-5: a request inside the resend window is refused) — a NEWER code, both entirely
 * normally (no threshold ever touched; see inflateExpiresAt's header for why). D3 has already
 * invalidated `older` by the time this returns. The caller then calls inflateExpiresAt(older.otpId,
 * newer.expiresAt) to reproduce the exact expires_at INVERSION the WBS 0.17 round-1 bug relied on
 * (the surviving code has the EARLIER absolute expires_at of the two) — done AFTER both real
 * `generateOtp` calls have already completed, so it can never affect either one's own resend/hourly
 * check.
 */
async function issueOlderThenNewer(
  email: string,
): Promise<{ older: GeneratedOtp; newer: GeneratedOtp; verifyAt: Date }> {
  const resendSeconds = await readThresholdValue(OTP_RESEND_SECONDS_KEY);

  const firstIssuedAt = new Date();
  const older = await generateOtp(email, { now: () => firstIssuedAt });

  const secondIssuedAt = new Date(
    firstIssuedAt.getTime() + (resendSeconds + BOUNDARY_MARGIN_SECONDS) * MILLISECONDS_PER_SECOND,
  );
  const newer = await generateOtp(email, { now: () => secondIssuedAt });

  return { older, newer, verifyAt: secondIssuedAt };
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
  // SEED-ONLY, NEVER DELETE (P6c round 1 fix — this key is no longer this file's alone to
  // delete: packages/identity/tests/login-flows.test.ts and deadlock-regression.test.ts now seed
  // the SAME shared, non-randomUUID()-suffixed key and depend on the row surviving for their own
  // whole run. The narrowing "and value = …" guard this block used to carry only protected
  // against a DIFFERENT value winning the row — it did nothing against a concurrent file relying
  // on the SAME value this run wrote, which is exactly what login-flows.test.ts's identical `'7'`
  // fixture does, and deleting the row out from under it was the round-1 order-dependent failure.
  // tx-injectable.test.ts's header documents the same reasoning for why IT never deletes; this
  // file now joins it as a bystander instead of an owner.
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

  it('verifyOtp with the correct code reports invalid, and does not increment attempts, when the owning user was deactivated after the OTP was issued', async () => {
    // Round-2 review finding 1 (pg-reviewer): generateOtp already refuses an inactive user at issue
    // time (the two tests above) — this proves the OTHER half of the same rule, that a user
    // deactivated BETWEEN issue and verification cannot still consume a code that is already live.
    // is_active is not a new rule here; it is the column doc 01 already gates issuance on
    // (01-Data-Model.sql:220), applied to the other side of the same flow.
    const user = await createFixtureUser(true);
    const issuedAt = new Date();

    const otp = await generateOtp(user.email, { now: () => issuedAt });
    const before = await readOtpRow(otp.otpId);

    await pool.query('update identity.users set is_active = false where id = $1', [user.id]);

    const verification = await verifyOtp(user.email, otp.code, { now: () => issuedAt });

    expect(verification.valid).toBe(false);

    // A deactivated owner is treated the same as an expired row: the code is already dead, so no
    // attempt was genuinely spent trying to guess it.
    const after = await readOtpRow(otp.otpId);
    expect(after.attempts).toBe(before.attempts);
    expect(after.consumed_at).toBeNull();
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

describe('OTP candidate selection — regression: "newest" is not "greatest expires_at" (pg-reviewer round 1, finding 3), REWRITTEN for WBS 2.16 part 1a-5 / G-16a (coordinator round 2, defect 2)', () => {
  // THE ORIGINAL BUG THIS PINS DOWN. identity.otp_codes has no created_at column (01:279-286,
  // confirmed absent), so an implementation that wants "the newest unconsumed code" can only order
  // by expires_at — and expires_at is issue time PLUS a threshold that is live-editable in
  // platform.thresholds. The moment that threshold is lowered between two outstanding codes, the
  // more recently issued code has the EARLIER expires_at, `order by expires_at desc limit 1` picks
  // the older row, and the code the user just received is rejected while a stale one still works.
  //
  // WHY THIS BLOCK CHANGED (coordinator round 2, defect 2). The original two tests below issued TWO
  // codes for the same email and asserted BOTH remained independently live and verifiable — that
  // premise is now false: WBS 2.16 part 1a-5's approved G-16a rule (slice brief acceptance: "a new
  // request invalidates the previous live code") means the SECOND generateOtp call for an email
  // always consumes the first. The regression this block guards — that candidate selection is a
  // SCAN over live, unconsumed rows, never an "order by expires_at desc limit 1" — is still real and
  // still pinned down here: it is now demonstrated by showing that the SURVIVING code (the newer
  // one, made to have the EARLIER expires_at — see inflateExpiresAt's header) is still found and
  // verified correctly, while the DEAD code (the older one, with the LATER expires_at) is refused —
  // the OPPOSITE of what "pick the greatest expires_at" would produce.
  //
  // HOW THE INVERSION IS PRODUCED NOW (a documented deviation from the coordinator's original
  // recipe — see issueOlderThenNewer / inflateExpiresAt's own headers, above, for the full
  // mathematical reason the literal "lower expiry_minutes between two issuances" recipe is
  // impossible against the real, as-built resend check). Both codes are issued entirely normally;
  // only AFTER both real `generateOtp` calls (and D3's own automatic invalidation of `older`) have
  // completed is `older`'s stored expires_at pushed later than `newer`'s via a direct UPDATE — never
  // a platform.thresholds write, so nothing here can leak to another suite.

  it('verifyOtp accepts the more recently issued code even though an older, now-invalidated OTP for the same email has a LATER expires_at', async () => {
    const user = await createFixtureUser(true);
    const { older, newer, verifyAt } = await issueOlderThenNewer(user.email);

    // D3 already invalidated `older` the instant `newer` was issued — confirmed on the stored row.
    const olderRowBeforeInversion = await readOtpRow(older.otpId);
    expect(olderRowBeforeInversion.consumed_at).not.toBeNull();

    // The premise this block needs: the DEAD older row's expires_at is LATER than the LIVE newer
    // row's — the same inversion round 1's bug relied on, reproduced without touching any
    // threshold. Exactly the shape a naive `order by expires_at desc limit 1` (run before, or
    // without, filtering out consumed rows) would still get wrong.
    await inflateExpiresAt(older.otpId, newer.expiresAt);
    const olderRow = await readOtpRow(older.otpId);
    const newerRow = await readOtpRow(newer.otpId);
    expect(newerRow.expires_at.getTime()).toBeLessThan(olderRow.expires_at.getTime());
    expect(newerRow.expires_at.getTime()).toBeGreaterThan(verifyAt.getTime());
    expect(newerRow.consumed_at).toBeNull();

    const verification = await verifyOtp(user.email, newer.code, { now: () => verifyAt });

    expect(verification.valid).toBe(true);
    if (!verification.valid) {
      throw new Error(
        'the code the user most recently received was rejected — candidate selection must not ' +
          "have been confused by the older, now-invalidated row's LATER expires_at",
      );
    }
    expect(verification.userId).toBe(user.id);
    // The discriminating assertion: the row that was verified is the one whose code was supplied,
    // not whichever row happened to sort first.
    expect(verification.otpId).toBe(newer.otpId);
    // Parity with the original (pre-rewrite) test: a successful verification consumes the row.
    expect((await readOtpRow(newer.otpId)).consumed_at).not.toBeNull();
  });

  it('after the newer code is issued, the older code is refused (D3, "a new request invalidates the previous live code") and the newer one verifies exactly once, then is refused on replay', async () => {
    const user = await createFixtureUser(true);
    const { older, newer, verifyAt } = await issueOlderThenNewer(user.email);
    await inflateExpiresAt(older.otpId, newer.expiresAt);

    const olderVerification = await verifyOtp(user.email, older.code, { now: () => verifyAt });
    expect(olderVerification.valid).toBe(false);

    // The surviving code — the one with the numerically EARLIER expires_at of the two — still
    // verifies exactly once (this is the same "scan, not an inverted sort" guarantee the original
    // second test pinned down, just no longer phrased as "both codes stay live").
    const firstNewerVerification = await verifyOtp(user.email, newer.code, {
      now: () => verifyAt,
    });
    expect(firstNewerVerification.valid).toBe(true);

    // Single-use: a replay of the same, now-consumed code is refused.
    const replayedNewerVerification = await verifyOtp(user.email, newer.code, {
      now: () => verifyAt,
    });
    expect(replayedNewerVerification.valid).toBe(false);
  });
});

describe('getThreshold — the only way a limit enters this package (WBS 0.17 brief, Known schema gap)', () => {
  it('returns the platform.thresholds value for a key that exists, as a number', async () => {
    // Asserted against identity.otp.expiry_minutes — a key real code reads — so this happy path
    // exercises the same row the mechanism depends on, and no key exists here that nothing reads.
    const expiryMinutes = await withContext(
      { userId: null, clientId: null, isInternal: true },
      async (tx) => getThreshold(tx, OTP_EXPIRY_MINUTES_KEY),
    );

    expect(expiryMinutes).toBe(await readThresholdValue(OTP_EXPIRY_MINUTES_KEY));
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
