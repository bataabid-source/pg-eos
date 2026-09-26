// packages/identity/tests/login-flows.test.ts — Master task P6c (round 3, pg-tester), RED phase.
//
// Supersedes tests/user-directory-and-thresholds.test.ts (deleted): the pre-authentication surface
// is no longer two separate reads a caller has to sequence itself — it is the two FLOWS
// src/login.ts exports through the barrel, `requestLoginOtp` and `verifyLoginOtp`
// (index.ts: "the pre-authentication login path is exported ONLY as the two flows in
// src/login.ts"). `findActiveUserIdByEmail` / `otpExpiryMinutes` stay package-internal
// (src/otp.ts), never imported here — this file only calls the barrel's two flows.
//
// NO HAND-BUILT ctx ANYWHERE IN THIS FILE (round 1 finding 6). Every call below is
// `requestLoginOtp(email, idem)` / `verifyLoginOtp(email, code, idem)`, called PLAIN — no wrapping
// withContext, no `{ isInternal: true }` assembled by the test. That is the whole point of the
// redesign: the flows own the package-internal context themselves (login.ts header), so a caller —
// this test included — never holds, and never has to forge, one.
//
// ROUND 3: `requestLoginOtp` now returns `{ expiresInMinutes, code }` — `expiresInMinutes` is the
// live platform.thresholds value itself (identical on the known and the unknown/inactive path,
// and time-independent), not a computed instant. Idempotency conflicts (IdempotencyConflictError,
// @pg-eos/db) are absorbed into the generic result rather than thrown — `code: null` for request,
// `{ valid: false }` for verify. A user deactivated between the flow's own lookup and its write
// (the race the bounded-pool redesign exists around) surfaces as `UnknownOrInactiveUserError`
// (otp.ts / session.ts) from the INNER *InTx re-check; the flow must map that to the SAME generic
// result too, never let it escape as an unhandled rejection.
//
// THE RACE, HOW IT IS DRIVEN (requirement (c), no hook exists in production code for this — the
// fallback Master's brief names is used instead). `../src/otp.js` is mocked for this WHOLE file:
// the wrapped `findActiveUserIdByEmail` delegates to the real implementation and, ONLY for an
// email a test has registered in `raceTargetEmails` (and only once), deactivates that user via a
// direct SQL UPDATE immediately after the real lookup resolved it as active — landing the
// deactivation exactly between the flow's own lookup and its write, with zero effect on every
// OTHER test in this file (an email never added to the set passes straight through to the real
// implementation, unchanged). `generateOtpInTx` / `verifyOtpInTx` / `issueSessionInTx` are left
// untouched by the mock (`...actual`); their OWN internal active-checks (otp.ts's
// `activeUserIdByEmailInTx`, a same-module private function, not a re-import) are unaffected by
// mocking the barrel-facing `findActiveUserIdByEmail` export, so they still see the TRUE,
// just-updated row — which is exactly what makes the race real rather than simulated.
//
// Schema this suite depends on — identical to otp.test.ts / session.test.ts / tx-injectable.test.ts
// (database/schema/01-Data-Model.sql:212-224, 267-277, 279-286;
// 13B-Schema-Reference-Consolidation.sql:328-335).

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { IdempotencyInput } from '@pg-eos/db';

// The package under test's public surface — generateOtp/verifyOtp are the pre-P6c mechanism
// (still barrel-exported, index.ts), used here only to seed/derive a code the black-box flows
// under test did not themselves generate, for tests that need a KNOWN code independent of a
// requestLoginOtp call (round 1's own tests kept the same "src imports only where needed"
// discipline; here the need is met by an already-exported barrel function, not a src import).
import * as identityBarrel from '../index.js';
import { generateOtp, requestLoginOtp, verifyLoginOtp } from '../index.js';
import type { LoginOtpRequestResult, LoginOtpVerification } from '../index.js';

// vi.hoisted: the mock factory below runs at `../src/otp.js` import time, before this file's own
// top-level `const` statements have executed (import evaluation always precedes a module's own
// body) — `raceTargetEmails` must therefore be created through `vi.hoisted` so the SAME Set
// instance is visible both inside the factory and inside the test bodies later in this file.
const raceTargetEmails = vi.hoisted(() => new Set<string>());

vi.mock('../src/otp.js', async () => {
  const actual = await vi.importActual<typeof import('../src/otp.js')>('../src/otp.js');
  // A dedicated, self-contained pool — created lazily inside the factory (never referencing this
  // file's own `pool` const, which is not yet initialised when this factory first runs; see the
  // header). Only ever used for the one-shot race UPDATE below.
  const { Pool: RacePool } = await import('pg');
  const racePool = new RacePool({
    host: process.env['PGHOST'] ?? 'localhost',
    port: Number(process.env['PGPORT'] ?? '5432'),
    user: process.env['PGUSER'] ?? 'postgres',
    database: process.env['PGDATABASE'] ?? 'pgeos',
    max: 2,
  });
  return {
    ...actual,
    findActiveUserIdByEmail: async (email: string): Promise<string | null> => {
      const id = await actual.findActiveUserIdByEmail(email);
      if (id !== null && raceTargetEmails.has(email)) {
        raceTargetEmails.delete(email);
        await racePool.query('update identity.users set is_active = false where id = $1', [id]);
      }
      return id;
    },
  };
});

const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';
const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';
const SIX_DIGIT_CODE = /^[0-9]{6}$/;

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * A fresh IdempotencyInput (@pg-eos/db) for one call — a NEW random key every time, unless a test
 * deliberately reuses the same object across two calls to exercise a replay. `requestHash` is the
 * caller's own canonicalization of the request body; the P6c requirement that `verifyLoginOtp`'s
 * hash EXCLUDE the code is honoured by never putting `code` into `body` below — the code is a
 * SEPARATE positional argument to verifyLoginOtp, never part of the hashed body.
 */
function idemFor(endpoint: string, body: Record<string, unknown>): IdempotencyInput {
  return {
    key: randomUUID(),
    endpoint,
    requestHash: sha256Hex(body),
    entityId: null,
    successStatus: 200,
  };
}

// A code guaranteed to differ from `code`, for the "same key, different code" replay test.
function wrongCodeFor(code: string): string {
  const firstDigit = Number(code.slice(0, 1));
  const shifted = (firstDigit + 1) % 10;
  return `${shifted}${code.slice(1)}`;
}

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const fixtureEmails: string[] = [];

// SEED-ONLY, NEVER DELETE — see tests/tx-injectable.test.ts's header comment for the full
// reasoning: both keys are shared, non-randomUUID()-suffixed rows already owned (seeded AND
// deleted) by otp.test.ts / session.test.ts. Every assertion below reads the LIVE value back, so
// it never matters whose insert actually won the race.
async function seedThresholds(): Promise<void> {
  for (const fixture of [
    {
      key: OTP_EXPIRY_MINUTES_KEY,
      value: '7',
      descriptionAr: 'صلاحية رمز الدخول لمرة واحدة بالدقائق — صف اختباري (P6c login flows)',
    },
    {
      key: SESSION_LIFETIME_MINUTES_KEY,
      value: '43',
      descriptionAr: 'عمر الجلسة بالدقائق — صف اختباري (P6c login flows)',
    },
  ] as const) {
    await pool.query(
      `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
       values ($1, $2, 'minutes', $3, $4)
       on conflict (key) do nothing`,
      [fixture.key, fixture.value, fixture.descriptionAr, randomUUID()],
    );
  }
}

async function createFixtureUser(isActive: boolean): Promise<{ id: string; email: string }> {
  const email = `pg-eos-p6c-loginflows-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', $3)
     returning id`,
    [email, 'مستخدم اختبار — P6c login flows', isActive],
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
    await pool.query(
      'delete from platform.idempotency_keys where user_id in (select id from identity.users where email = any($1::text[]))',
      [fixtureEmails],
    );
    await pool.query(
      'delete from identity.sessions where user_id in (select id from identity.users where email = any($1::text[]))',
      [fixtureEmails],
    );
    await pool.query('delete from identity.otp_codes where email = any($1::text[])', [
      fixtureEmails,
    ]);
    await pool.query('delete from identity.users where email = any($1::text[])', [fixtureEmails]);
  }
  // No threshold-row delete here — see the seed-only comment above.
  await pool.end();
});

describe('requestLoginOtp / verifyLoginOtp — the whole pre-auth flow, called with NO context at all (P6c round 2)', () => {
  it('a real active user requests an OTP and a valid code yields a session — no ctx built anywhere in this test', async () => {
    const user = await createFixtureUser(true);

    const requested: LoginOtpRequestResult = await requestLoginOtp(
      user.email,
      idemFor('POST /auth/otp/request', { email: user.email }),
    );
    expect(typeof requested.expiresInMinutes).toBe('number');
    expect(requested.code).not.toBeNull();
    const code = requested.code;
    if (code === null) {
      throw new Error('expected a delivered code for a real active user');
    }
    expect(code).toMatch(SIX_DIGIT_CODE);

    const otpRows = await pool.query(
      'select id from identity.otp_codes where email = $1 and consumed_at is null',
      [user.email],
    );
    expect(otpRows.rows).toHaveLength(1);

    const verification: LoginOtpVerification = await verifyLoginOtp(
      user.email,
      code,
      idemFor('POST /auth/otp/verify', { email: user.email }),
    );

    expect(verification.valid).toBe(true);
    if (!verification.valid) {
      throw new Error('expected a valid verification for the code just requested');
    }
    expect(verification.userId).toBe(user.id);
    expect(verification.token).not.toBeNull();
    expect(typeof verification.issuedAt).toBe('string');
    expect(typeof verification.expiresAt).toBe('string');

    const sessionRows = await pool.query('select id, user_id from identity.sessions where id = $1', [
      verification.sessionId,
    ]);
    expect(sessionRows.rows).toHaveLength(1);
    expect(sessionRows.rows[0]?.user_id).toBe(user.id);
  });

  it('a wrong code against a real, live OTP is rejected — no session is created', async () => {
    const user = await createFixtureUser(true);
    const requested = await requestLoginOtp(
      user.email,
      idemFor('POST /auth/otp/request', { email: user.email }),
    );
    const code = requested.code;
    if (code === null) {
      throw new Error('expected a delivered code for a real active user');
    }

    const verification = await verifyLoginOtp(
      user.email,
      wrongCodeFor(code),
      idemFor('POST /auth/otp/verify', { email: user.email }),
    );

    expect(verification).toEqual({ valid: false });

    const sessions = await pool.query('select id from identity.sessions where user_id = $1', [
      user.id,
    ]);
    expect(sessions.rows).toHaveLength(0);
  });
});

describe('anti-enumeration — an unknown or inactive email is INDISTINGUISHABLE from the outside (P6c round 2)', () => {
  it('requestLoginOtp returns the identical shape/fields for an unknown email and an inactive user, and writes nothing for either', async () => {
    const inactiveUser = await createFixtureUser(false);
    const unknownEmail = `pg-eos-p6c-loginflows-unknown-${randomUUID()}@example.invalid`;
    fixtureEmails.push(unknownEmail);

    const [unknownResult, inactiveResult] = await Promise.all([
      requestLoginOtp(unknownEmail, idemFor('POST /auth/otp/request', { email: unknownEmail })),
      requestLoginOtp(
        inactiveUser.email,
        idemFor('POST /auth/otp/request', { email: inactiveUser.email }),
      ),
    ]);

    expect(Object.keys(unknownResult).sort()).toEqual(Object.keys(inactiveResult).sort());
    expect(Object.is(unknownResult.code, null)).toBe(true);
    expect(Object.is(inactiveResult.code, null)).toBe(true);
    // expiresInMinutes is the live threshold value itself — time-independent, so it must be not
    // just the same TYPE but the exact same NUMBER on both paths.
    expect(unknownResult.expiresInMinutes).toBe(inactiveResult.expiresInMinutes);
    expect(typeof unknownResult.expiresInMinutes).toBe('number');

    const codes = await pool.query('select id from identity.otp_codes where email = any($1::text[])', [
      [unknownEmail, inactiveUser.email],
    ]);
    expect(codes.rows).toHaveLength(0);
  });

  it('verifyLoginOtp returns exactly {valid:false} for an unknown email and an inactive user, regardless of the code, and writes nothing for either', async () => {
    const inactiveUser = await createFixtureUser(false);
    const unknownEmail = `pg-eos-p6c-loginflows-unknown2-${randomUUID()}@example.invalid`;
    fixtureEmails.push(unknownEmail);
    const anyCode = '135790';

    const [unknownResult, inactiveResult] = await Promise.all([
      verifyLoginOtp(unknownEmail, anyCode, idemFor('POST /auth/otp/verify', { email: unknownEmail })),
      verifyLoginOtp(
        inactiveUser.email,
        anyCode,
        idemFor('POST /auth/otp/verify', { email: inactiveUser.email }),
      ),
    ]);

    expect(unknownResult).toEqual({ valid: false });
    expect(inactiveResult).toEqual({ valid: false });

    const sessions = await pool.query(
      `select s.id from identity.sessions s
         join identity.users u on u.id = s.user_id
        where u.email = any($1::text[])`,
      [[unknownEmail, inactiveUser.email]],
    );
    expect(sessions.rows).toHaveLength(0);
  });
});

describe('idempotency — same key replays the same result; the request-hash excludes the code (P6c round 3)', () => {
  it('requestLoginOtp: the SAME idempotency key+body replays the SAME expiresInMinutes, and the replay never re-delivers the code (code: null)', async () => {
    const user = await createFixtureUser(true);
    const idem = idemFor('POST /auth/otp/request', { email: user.email });

    const first = await requestLoginOtp(user.email, idem);
    expect(first.code).not.toBeNull();

    const second = await requestLoginOtp(user.email, idem);
    expect(second.expiresInMinutes).toBe(first.expiresInMinutes);
    expect(second.code).toBeNull();

    // Exactly ONE otp_codes row exists — the replay did not re-run the write.
    const rows = await pool.query('select id from identity.otp_codes where email = $1', [
      user.email,
    ]);
    expect(rows.rows).toHaveLength(1);
  });

  it('verifyLoginOtp: the SAME idempotency key replays the SAME result even with a DIFFERENT code — the caller\'s request-hash excludes the code', async () => {
    const user = await createFixtureUser(true);
    const otp = await generateOtp(user.email, { now: () => new Date() });
    // Deliberately does NOT include `code` in the hashed body — the P6c requirement.
    const idem = idemFor('POST /auth/otp/verify', { email: user.email });

    const first = await verifyLoginOtp(user.email, otp.code, idem);
    expect(first.valid).toBe(true);
    if (!first.valid) {
      throw new Error('expected the correct code to verify on the executing call');
    }
    expect(first.token).not.toBeNull();

    // SAME idem object (same key, same requestHash) — but a WRONG code this time.
    const second = await verifyLoginOtp(user.email, wrongCodeFor(otp.code), idem);
    expect(second.valid).toBe(true);
    if (!second.valid) {
      throw new Error('expected a REPLAY of the first (valid) result, not a fresh evaluation');
    }
    expect(second.sessionId).toBe(first.sessionId);
    // The secret is delivered by the executing call only — a replay never re-delivers it.
    expect(second.token).toBeNull();

    // Exactly ONE session row exists — the replay did not attempt a second issueSessionInTx.
    const sessions = await pool.query('select id from identity.sessions where user_id = $1', [
      user.id,
    ]);
    expect(sessions.rows).toHaveLength(1);
  });
});

describe('replay parity — a known email\'s replayed result is indistinguishable from an unknown email\'s (P6c round 3, requirement a)', () => {
  it('requestLoginOtp: the SAME key called twice a second apart (known email) is identical, in keys AND values, to an unknown email\'s call — except `code`', async () => {
    const user = await createFixtureUser(true);
    const unknownEmail = `pg-eos-p6c-loginflows-parity-${randomUUID()}@example.invalid`;
    fixtureEmails.push(unknownEmail);

    // The injected clock: three calls, each a full second apart. expiresInMinutes is the live
    // threshold value itself (round 3), so it does not actually depend on the clock any more —
    // this still exercises the clock injection Master's brief names, and proves the parity holds
    // even when the calls are not simultaneous.
    let clock = new Date();
    const tick = (): Date => {
      clock = new Date(clock.getTime() + 1000);
      return clock;
    };

    const knownIdem = idemFor('POST /auth/otp/request', { email: user.email });
    const knownFirst = await requestLoginOtp(user.email, knownIdem, { now: tick });
    expect(knownFirst.code).not.toBeNull();

    // SAME key — a replay, one second later by the injected clock.
    const knownSecond = await requestLoginOtp(user.email, knownIdem, { now: tick });
    expect(knownSecond.code).toBeNull();

    const unknownResult = await requestLoginOtp(
      unknownEmail,
      idemFor('POST /auth/otp/request', { email: unknownEmail }),
      { now: tick },
    );

    // Identical keys AND values — both have `code: null` here, so this is full equality, not
    // just same-shape: a known email's REPLAY is exactly as anonymous as an unknown email's call.
    expect(knownSecond).toEqual(unknownResult);
  });
});

describe('conflict absorption — an idempotency-key reuse with a DIFFERENT body never throws or 409s out of the flow (P6c round 3, requirement b)', () => {
  it('requestLoginOtp: the same key with a different body gives the generic result (code: null), not an IdempotencyConflictError', async () => {
    const user = await createFixtureUser(true);
    const key = randomUUID();

    const first = await requestLoginOtp(user.email, {
      key,
      endpoint: 'POST /auth/otp/request',
      requestHash: sha256Hex({ email: user.email }),
      entityId: null,
      successStatus: 200,
    });
    expect(first.code).not.toBeNull();

    // SAME key, a DIFFERENT request body (a different canonical hash) — would be a 409
    // IdempotencyConflictError('mismatch') straight out of withIdempotentContext; the flow must
    // absorb it into the generic result instead of letting it propagate.
    const conflicting = await requestLoginOtp(user.email, {
      key,
      endpoint: 'POST /auth/otp/request',
      requestHash: sha256Hex({ email: user.email, extra: 'a different body' }),
      entityId: null,
      successStatus: 200,
    });

    expect(conflicting.code).toBeNull();
    expect(typeof conflicting.expiresInMinutes).toBe('number');
  });

  it('verifyLoginOtp: the same key with a different body gives {valid:false}, not an IdempotencyConflictError', async () => {
    const user = await createFixtureUser(true);
    const otp = await generateOtp(user.email, { now: () => new Date() });
    const key = randomUUID();

    const first = await verifyLoginOtp(user.email, otp.code, {
      key,
      endpoint: 'POST /auth/otp/verify',
      requestHash: sha256Hex({ email: user.email }),
      entityId: null,
      successStatus: 200,
    });
    expect(first.valid).toBe(true);

    const conflicting = await verifyLoginOtp(user.email, otp.code, {
      key,
      endpoint: 'POST /auth/otp/verify',
      requestHash: sha256Hex({ email: user.email, extra: 'a different body' }),
      entityId: null,
      successStatus: 200,
    });

    expect(conflicting).toEqual({ valid: false });
  });
});

describe('the race — a user deactivated between the flow\'s own lookup and its write (P6c round 3, requirement c)', () => {
  it('requestLoginOtp: a user deactivated right after the lookup (still inside the SAME call) gets the generic unknown-email result, not a thrown UnknownOrInactiveUserError', async () => {
    const user = await createFixtureUser(true);
    raceTargetEmails.add(user.email);

    const raced = await requestLoginOtp(
      user.email,
      idemFor('POST /auth/otp/request', { email: user.email }),
    );

    expect(raced.code).toBeNull();
    expect(typeof raced.expiresInMinutes).toBe('number');

    // Confirms the deactivation actually happened mid-flow, and that it produced no otp row.
    const row = await pool.query<{ is_active: boolean }>(
      'select is_active from identity.users where id = $1',
      [user.id],
    );
    expect(row.rows[0]?.is_active).toBe(false);
    const codes = await pool.query('select id from identity.otp_codes where email = $1', [
      user.email,
    ]);
    expect(codes.rows).toHaveLength(0);
  });

  it('verifyLoginOtp: a user deactivated right after the lookup (still inside the SAME call) gets {valid:false}, not a thrown error, and no session is created', async () => {
    const user = await createFixtureUser(true);
    const otp = await generateOtp(user.email, { now: () => new Date() });
    raceTargetEmails.add(user.email);

    const raced = await verifyLoginOtp(
      user.email,
      otp.code,
      idemFor('POST /auth/otp/verify', { email: user.email }),
    );

    expect(raced).toEqual({ valid: false });

    const sessions = await pool.query('select id from identity.sessions where user_id = $1', [
      user.id,
    ]);
    expect(sessions.rows).toHaveLength(0);
  });
});

describe('barrel non-export guard — internal plumbing and the *InTx siblings stay internal (P6c round 2)', () => {
  it('the barrel exports requestLoginOtp and verifyLoginOtp', () => {
    expect(typeof requestLoginOtp).toBe('function');
    expect(typeof verifyLoginOtp).toBe('function');
  });

  // findActiveUserIdByEmail / otpExpiryMinutes are deliberately NOT asserted here either way: the
  // P6c round 2 brief only names INTERNAL_NO_ACTOR_CTX / internalCtxForSubject / the *InTx
  // functions as forbidden barrel exports (index.ts currently still exports both reads — its own
  // comment says only because a now-deleted test file pinned them; this file does not re-pin
  // them, and does not assert their absence either, since neither is in the brief's list).
  it.each([
    'INTERNAL_NO_ACTOR_CTX',
    'internalCtxForSubject',
    'generateOtpInTx',
    'verifyOtpInTx',
    'issueSessionInTx',
  ])('the barrel does not export %s', (name) => {
    expect(Object.prototype.hasOwnProperty.call(identityBarrel, name)).toBe(false);
  });
});
