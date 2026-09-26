// modules/identity/tests/otp-login/otp-login.test.ts — WBS 2.16 part 1a-3 (pg-tester).
//
// POST-P6c REWRITE (Master task P6c merged @ b18c0ca/69899c5 — see the brief's own "POST-P6c
// REWRITE" section, top of docs/notes/slice-briefs/_slice-2.16-otp-login.brief.md, and
// packages/identity/src/login.ts, both read in full before this rewrite). Ground truth:
//   requestOtpCode(input, deps)  — TWO args now, no ctx. input: { email, correlationId,
//                                  idem: IdempotencyInput } — idem is REQUIRED, not optional.
//                                  Result: { expiresInMinutes: number } ONLY — never `expiresAt`,
//                                  never `code`.
//   verifyOtpCode(input, deps)   — TWO args, no ctx. input: { email, code, correlationId,
//                                  idem: IdempotencyInput }. Result: { token: string,
//                                  expiresAt: string (ISO) } on success; throws InvalidOtpError
//                                  (422 at the handler) for EVERY other outcome, including a
//                                  REPLAY of an already-completed verification (login.ts's own
//                                  `token: null` replay signal — Master rule 3, brief POST-P6c).
//                                  There is no 409 anywhere in this flow any more: login.ts
//                                  absorbs IdempotencyConflictError internally on both flows.
//   OtpLoginDeps                 — `{ clock, logger }` only. No mechanism/repository port: the
//                                  whole pre-auth path (account lookup, idempotency, OTP
//                                  issue/verify, session issue) is owned end to end by
//                                  @pg-eos/identity-mechanisms' requestLoginOtp/verifyLoginOtp.
//
// Scope (unchanged from the original brief, re-verified against the new shapes):
//   1. the ISOLATION test (Master ruling): user A's live OTP code can never issue a session naming
//      user B, and cross-submitting (wrong email/code pairing) always fails for BOTH directions.
//   2. the ANTI-ENUMERATION test (Master decision 2 / POST-P6c rule 4): requestOtpCode against an
//      unknown/inactive email returns 200 { expiresInMinutes } — never an error, never a different
//      shape — and writes no identity.otp_codes row for that email.
//   3. the happy path each command needs proven at least once.
//   4. NEW — the replay-is-422 test (POST-P6c rule 3): the same key/body/code verified twice: the
//      first call succeeds with a token, the second gets InvalidOtpError (422), never a silent
//      200-without-token and never a 409.
//
// TEST-DB PATTERN — copied faithfully from packages/identity/tests/otp.test.ts (viewed directly,
// not in this slice's Read ONLY list — same "sibling test file" convention documented in this
// repo's own briefs): an independent `pg.Pool`, fixture users created/cleaned by this run's own
// randomUUID()-suffixed emails, and OTP codes minted directly via the real `generateOtp` (WBS 0.17,
// still exported unchanged by @pg-eos/identity-mechanisms — packages/identity/index.ts:33-39) as
// this suite's OWN test setup — per the brief's Master decision 3 ("no delivery provider exists;
// the isolation test obtains a KNOWN code by calling generateOtp(email) directly").

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The already-built, already-correct WBS 0.17 mechanism (packages/identity, frozen aside from
// P6c's own additive login.ts) — used as this suite's OWN fixture-minting tool, never re-proven
// here. Package manifest name per packages/identity/package.json: "@pg-eos/identity-mechanisms".
import { generateOtp } from '@pg-eos/identity-mechanisms';
import type { IdempotencyInput } from '@pg-eos/db';

// The module under test.
import { requestOtpCode, verifyOtpCode } from '../../application/otp-login/index.js';
import { createOtpLoginDeps } from '../../api/otp-login/composition.js';
import { InvalidOtpError } from '../../domain/otp-login/errors.js';

const REQUEST_OTP_CODE_ENDPOINT = 'identity.otp-login.request-otp-code';
const VERIFY_OTP_CODE_ENDPOINT = 'identity.otp-login.verify-otp-code';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const deps = createOtpLoginDeps({});
const fixtureEmails: string[] = [];

// THRESHOLD FIXTURES — same keys, same `on conflict (key) do nothing` seeding, same narrowed
// afterAll delete as packages/identity/tests/otp.test.ts's own `seedThresholdFixtures` /
// `thresholdRowsSeededByThisRun`. Both keys are required: `requestLoginOtp` reads
// `identity.otp.expiry_minutes` on every path (login.ts's own `otpExpiryMinutes()` call, always
// executed), and `verifyLoginOtp`'s success path reads `identity.session.lifetime_minutes`
// (issueSessionInTx).
const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';
const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';

const THRESHOLD_FIXTURES = [
  {
    key: OTP_EXPIRY_MINUTES_KEY,
    value: '7',
    unit: 'minutes',
    descriptionAr: 'صلاحية رمز الدخول لمرة واحدة بالدقائق — صف اختباري (WBS 2.16)',
  },
  {
    key: SESSION_LIFETIME_MINUTES_KEY,
    value: '480',
    unit: 'minutes',
    descriptionAr: 'مدة صلاحية الجلسة بالدقائق — صف اختباري (WBS 2.16)',
  },
] as const;

const thresholdRowsSeededByThisRun: { key: string; value: string }[] = [];

async function seedThresholdFixtures(): Promise<void> {
  for (const fixture of THRESHOLD_FIXTURES) {
    const inserted = await pool.query(
      `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
       values ($1, $2, $3, $4, $5)
       on conflict (key) do nothing`,
      [fixture.key, fixture.value, fixture.unit, fixture.descriptionAr, randomUUID()],
    );
    if (inserted.rowCount === 1) {
      thresholdRowsSeededByThisRun.push({ key: fixture.key, value: fixture.value });
    }
  }
}

/** A real 64-hex-char sha256 digest — migration 0010's `platform.idempotency_keys.request_hash`
 *  carries `check (request_hash ~ '^[0-9a-f]{64}$')`. */
function fixtureRequestHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function freshIdem(endpoint: string, hashedInput: unknown, key?: string): IdempotencyInput {
  return {
    key: key ?? randomUUID(),
    endpoint,
    requestHash: fixtureRequestHash(hashedInput),
    entityId: null,
    successStatus: 200,
  };
}

beforeAll(async () => {
  await seedThresholdFixtures();
});

async function createFixtureUser(): Promise<{ id: string; email: string }> {
  const email = `pg-eos-2.16-otp-login-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', true)
     returning id`,
    [email, 'مستخدم اختبار — WBS 2.16'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture user insert returned no row');
  return { id: row.id, email };
}

afterAll(async () => {
  if (fixtureEmails.length > 0) {
    // platform.idempotency_keys FKs to identity.users — removed first (same ordering as
    // modules/wms/tests/receive-inbound/handlers.test.ts's own afterAll).
    await pool.query(
      'delete from platform.idempotency_keys where user_id in (select id from identity.users where email = any($1::text[]))',
      [fixtureEmails],
    );
    await pool.query('delete from identity.sessions where user_id in (select id from identity.users where email = any($1::text[]))', [fixtureEmails]);
    await pool.query('delete from identity.otp_codes where email = any($1::text[])', [fixtureEmails]);
    await pool.query('delete from identity.users where email = any($1::text[])', [fixtureEmails]);
  }
  for (const seeded of thresholdRowsSeededByThisRun) {
    await pool.query('delete from platform.thresholds where key = $1 and value = $2::numeric', [
      seeded.key,
      seeded.value,
    ]);
  }
  await pool.end();
});

describe('requestOtpCode — anti-enumeration (Master decision 2 / POST-P6c rule 4)', () => {
  it('a known, active email returns 200 { expiresInMinutes } with no code, no expiresAt, in the response', async () => {
    const user = await createFixtureUser();

    const result = await requestOtpCode(
      {
        email: user.email,
        correlationId: randomUUID(),
        idem: freshIdem(REQUEST_OTP_CODE_ENDPOINT, { email: user.email }),
      },
      deps,
    );

    expect(Object.keys(result)).toEqual(['expiresInMinutes']);
    expect(typeof result.expiresInMinutes).toBe('number');
  });

  it('an unknown email ALSO returns 200 { expiresInMinutes } — same shape, no error, never a signal the email does not exist', async () => {
    const unknownEmail = `pg-eos-2.16-otp-login-unknown-${randomUUID()}@example.invalid`;
    fixtureEmails.push(unknownEmail);

    const result = await requestOtpCode(
      {
        email: unknownEmail,
        correlationId: randomUUID(),
        idem: freshIdem(REQUEST_OTP_CODE_ENDPOINT, { email: unknownEmail }),
      },
      deps,
    );

    expect(Object.keys(result)).toEqual(['expiresInMinutes']);
    expect(typeof result.expiresInMinutes).toBe('number');
  });

  it('an unknown email writes NO identity.otp_codes row', async () => {
    const unknownEmail = `pg-eos-2.16-otp-login-unknown-${randomUUID()}@example.invalid`;
    fixtureEmails.push(unknownEmail);

    await requestOtpCode(
      {
        email: unknownEmail,
        correlationId: randomUUID(),
        idem: freshIdem(REQUEST_OTP_CODE_ENDPOINT, { email: unknownEmail }),
      },
      deps,
    );

    const codes: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.otp_codes where email = $1',
      [unknownEmail],
    );
    expect(codes.rows).toHaveLength(0);
  });

  it('an inactive email is treated identically to an unknown one — 200 { expiresInMinutes }, no otp row', async () => {
    const email = `pg-eos-2.16-otp-login-inactive-${randomUUID()}@example.invalid`;
    fixtureEmails.push(email);
    await pool.query(
      `insert into identity.users (email, full_name_ar, user_type, is_active)
       values ($1, $2, 'internal', false)`,
      [email, 'مستخدم غير نشط — WBS 2.16'],
    );

    const result = await requestOtpCode(
      { email, correlationId: randomUUID(), idem: freshIdem(REQUEST_OTP_CODE_ENDPOINT, { email }) },
      deps,
    );

    expect(Object.keys(result)).toEqual(['expiresInMinutes']);
    const codes: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.otp_codes where email = $1',
      [email],
    );
    expect(codes.rows).toHaveLength(0);
  });
});

describe('requestOtpCode — Idempotency-Key replay (idem is now REQUIRED on every call; login.ts owns the account-scoped bookkeeping internally)', () => {
  it('the same Idempotency-Key and email replay the same { expiresInMinutes } shape without minting a second identity.otp_codes row', async () => {
    const user = await createFixtureUser();
    const idem = freshIdem(REQUEST_OTP_CODE_ENDPOINT, { email: user.email });

    const first = await requestOtpCode({ email: user.email, correlationId: randomUUID(), idem }, deps);

    const beforeSecondCall: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.otp_codes where email = $1',
      [user.email],
    );

    const second = await requestOtpCode({ email: user.email, correlationId: randomUUID(), idem }, deps);

    expect(second.expiresInMinutes).toBe(first.expiresInMinutes);

    const afterSecondCall: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.otp_codes where email = $1',
      [user.email],
    );
    // The replay must not have minted a second OTP row — same count before and after.
    expect(afterSecondCall.rows.length).toBe(beforeSecondCall.rows.length);
  });
});

describe('verifyOtpCode — happy path and uniform rejection (Master decision 2 — login.ts collapses every rejection to { valid: false })', () => {
  it('the correct, live code issues a session — { token, expiresAt } (ISO string)', async () => {
    const user = await createFixtureUser();
    const otp = await generateOtp(user.email);

    const result = await verifyOtpCode(
      {
        email: user.email,
        code: otp.code,
        correlationId: randomUUID(),
        idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: user.email, correlationId: 'fixed' }),
      },
      deps,
    );

    expect(typeof result.token).toBe('string');
    expect(typeof result.expiresAt).toBe('string');
    expect(Number.isNaN(Date.parse(result.expiresAt))).toBe(false);

    const sessionRow: QueryResult<{ user_id: string }> = await pool.query(
      'select user_id from identity.sessions where user_id = $1',
      [user.id],
    );
    expect(sessionRow.rows).toHaveLength(1);
  });

  it('a wrong code throws InvalidOtpError and issues no session', async () => {
    const user = await createFixtureUser();
    await generateOtp(user.email);

    await expect(
      verifyOtpCode(
        {
          email: user.email,
          code: '000000',
          correlationId: randomUUID(),
          idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: user.email, correlationId: 'wrong' }),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidOtpError);

    const sessionRow: QueryResult<{ user_id: string }> = await pool.query(
      'select user_id from identity.sessions where user_id = $1',
      [user.id],
    );
    expect(sessionRow.rows).toHaveLength(0);
  });

  it('an unknown email throws the SAME InvalidOtpError as a wrong code — no distinguishable signal (Master decision 2)', async () => {
    const unknownEmail = `pg-eos-2.16-otp-login-unknown-verify-${randomUUID()}@example.invalid`;
    fixtureEmails.push(unknownEmail);

    await expect(
      verifyOtpCode(
        {
          email: unknownEmail,
          code: '000000',
          correlationId: randomUUID(),
          idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: unknownEmail, correlationId: 'x' }),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidOtpError);
  });
});

describe('verifyOtpCode — a REPLAY of a completed verification is 422, never a silent 200-without-token, never 409 (POST-P6c rule 3)', () => {
  it('the same Idempotency-Key + body + code verified twice: first call succeeds with a token, second call throws InvalidOtpError', async () => {
    const user = await createFixtureUser();
    const otp = await generateOtp(user.email);
    const idem = freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: user.email, correlationId: 'replay-fixed' });
    const input = { email: user.email, code: otp.code, correlationId: 'replay-fixed', idem };

    const first = await verifyOtpCode(input, deps);
    expect(typeof first.token).toBe('string');

    // SAME idem object (same key, same endpoint, same requestHash) AND the same body — login.ts's
    // own replay signal is `{ valid: true, token: null }`; verify-otp-code.ts treats `token===null`
    // identically to `valid:false` (POST-P6c rule 3), so this throws InvalidOtpError, not a second
    // 200 and not a 409.
    await expect(verifyOtpCode(input, deps)).rejects.toBeInstanceOf(InvalidOtpError);

    // Still exactly one session — the replay did not mint a second one.
    const sessionRows: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.sessions where user_id = $1',
      [user.id],
    );
    expect(sessionRows.rows).toHaveLength(1);
  });
});

describe('ISOLATION (mandatory, Master ruling) — user A\'s code can never issue a session naming user B', () => {
  it('cross-submitting (email B, code A) is rejected and issues no session for either user', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const otpA = await generateOtp(userA.email);
    const otpB = await generateOtp(userB.email);
    // Two independently generated 6-digit codes collide with probability 1e-6 — if they collide,
    // the cross-submit premise below is not meaningfully tested. Extremely unlikely; not retried,
    // same acceptance as packages/identity/tests/otp.test.ts's own use of randomness.
    expect(otpA.code).not.toBe(otpB.code);

    await expect(
      verifyOtpCode(
        {
          email: userB.email,
          code: otpA.code,
          correlationId: randomUUID(),
          idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: userB.email, correlationId: 'cross-1' }),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidOtpError);

    const sessionsAfterFirstCross: QueryResult<{ user_id: string }> = await pool.query(
      'select user_id from identity.sessions where user_id = any($1::uuid[])',
      [[userA.id, userB.id]],
    );
    expect(sessionsAfterFirstCross.rows).toHaveLength(0);
  });

  it('cross-submitting (email A, code B) is rejected and issues no session for either user', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const otpA = await generateOtp(userA.email);
    const otpB = await generateOtp(userB.email);
    expect(otpA.code).not.toBe(otpB.code);

    await expect(
      verifyOtpCode(
        {
          email: userA.email,
          code: otpB.code,
          correlationId: randomUUID(),
          idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: userA.email, correlationId: 'cross-2' }),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidOtpError);

    const sessionsAfterSecondCross: QueryResult<{ user_id: string }> = await pool.query(
      'select user_id from identity.sessions where user_id = any($1::uuid[])',
      [[userA.id, userB.id]],
    );
    expect(sessionsAfterSecondCross.rows).toHaveLength(0);
  });

  it('after both cross-submits are rejected, each user can still redeem their OWN code for their OWN session', async () => {
    const userA = await createFixtureUser();
    const userB = await createFixtureUser();
    const otpA = await generateOtp(userA.email);
    const otpB = await generateOtp(userB.email);

    // Cross-submit both ways first — proves the correct-pairing redemption below is not merely
    // "the first call always succeeds".
    await expect(
      verifyOtpCode(
        {
          email: userB.email,
          code: otpA.code,
          correlationId: randomUUID(),
          idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: userB.email, correlationId: 'cross-3a' }),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidOtpError);
    await expect(
      verifyOtpCode(
        {
          email: userA.email,
          code: otpB.code,
          correlationId: randomUUID(),
          idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: userA.email, correlationId: 'cross-3b' }),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidOtpError);

    const resultA = await verifyOtpCode(
      {
        email: userA.email,
        code: otpA.code,
        correlationId: randomUUID(),
        idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: userA.email, correlationId: 'own-a' }),
      },
      deps,
    );
    const resultB = await verifyOtpCode(
      {
        email: userB.email,
        code: otpB.code,
        correlationId: randomUUID(),
        idem: freshIdem(VERIFY_OTP_CODE_ENDPOINT, { email: userB.email, correlationId: 'own-b' }),
      },
      deps,
    );

    expect(typeof resultA.token).toBe('string');
    expect(typeof resultB.token).toBe('string');
    expect(resultA.token).not.toBe(resultB.token);

    const sessionRowA: QueryResult<{ user_id: string }> = await pool.query(
      'select user_id from identity.sessions where user_id = $1',
      [userA.id],
    );
    const sessionRowB: QueryResult<{ user_id: string }> = await pool.query(
      'select user_id from identity.sessions where user_id = $1',
      [userB.id],
    );
    expect(sessionRowA.rows).toHaveLength(1);
    expect(sessionRowB.rows).toHaveLength(1);
  });
});
