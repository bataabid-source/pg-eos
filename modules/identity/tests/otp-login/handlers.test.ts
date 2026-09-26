// modules/identity/tests/otp-login/handlers.test.ts — WBS 2.16 part 1a-3 (pg-tester).
//
// POST-P6c REWRITE (Master task P6c merged @ b18c0ca/69899c5 — see the brief's "POST-P6c REWRITE"
// section and packages/identity/src/login.ts, both read in full before this rewrite):
//   - handleRequestOtpCode/handleVerifyOtpCode's response bodies are now `{ expiresInMinutes }` and
//     `{ token, expiresAt }` respectively (never `expiresAt` on request, never `userId`/`sessionId`
//     on verify) — see api/otp-login/handlers.ts's own header.
//   - `OtpLoginDeps` is now `{ clock, logger }` ONLY — there is no mechanism/repository port left to
//     inject a throwing fake into (application/otp-login/ports.ts). To force an unexpected (500) or
//     a specific typed (422 replay-signal) outcome from the OUTSIDE, this file uses
//     `vi.mock('@pg-eos/identity-mechanisms', importOriginal)` as a PASSTHROUGH — every test that
//     does not explicitly override `requestLoginOtp`/`verifyLoginOtp` for one call
//     (`mockResolvedValueOnce`/`mockRejectedValueOnce`) still runs the REAL mechanism against the
//     real DB, so the anti-enumeration/idempotency tests below are unaffected by the mock.
//   - NO 409 mapping exists any more: IdempotencyConflictError is absorbed inside login.ts on both
//     flows (login.ts header) and never reaches this layer — the old "same key, different body ->
//     409 for a known email" test is GONE; replaced by an assertion that BOTH known and unknown
//     emails return 200 uniformly for that same reuse pattern (finding 8, pg-reviewer round 1).
//   - The old "issueSession throws UnknownOrInactiveUserError" 422 test is simplified per the
//     coordinator's own note: that race is now fully absorbed inside login.ts as `{valid:false}`,
//     indistinguishable from any other invalid verification — there is nothing left to simulate
//     from outside the package, so it collapses into the plain "resolves invalid -> 422" test below.
//
// TEST-DB PATTERN: same independent `pg.Pool` + randomUUID()-suffixed fixture + threshold-seeding
// convention as ./otp-login.test.ts (needed for the anti-enumeration/idempotency-replay tests,
// which drive the REAL mechanism through the REAL handler entry points with REAL Idempotency-Key
// headers — the whole point of finding 8, pg-reviewer round 1: exercise the actual production path,
// not a fake standing in for it).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
import type { LoginOtpVerification } from '@pg-eos/identity-mechanisms';

vi.mock('@pg-eos/identity-mechanisms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pg-eos/identity-mechanisms')>();
  return {
    ...actual,
    // Default implementation is the REAL flow — only `mockResolvedValueOnce`/`mockRejectedValueOnce`
    // below ever diverges from it, and only for the ONE call that uses it.
    requestLoginOtp: vi.fn(actual.requestLoginOtp),
    verifyLoginOtp: vi.fn(actual.verifyLoginOtp),
  };
});

// Imported AFTER vi.mock (hoisted by vitest regardless of source position) so these bindings are
// the mocked ones — `vi.mocked(...)` below narrows them to their Mock type for `.mockOnce` calls.
import { requestLoginOtp, verifyLoginOtp } from '@pg-eos/identity-mechanisms';

// The module under test.
import {
  handleRequestOtpCode,
  handleVerifyOtpCode,
  type ApiRequest,
} from '../../api/otp-login/handlers.js';
import { createOtpLoginDeps } from '../../api/otp-login/composition.js';
import type { Logger } from '../../application/otp-login/ports.js';

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body };
}

function spyLogger(): Logger & { readonly errorCalls: Array<[Record<string, unknown>, string]> } {
  const errorCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    errorCalls,
    error: (obj, msg) => {
      errorCalls.push([obj, msg]);
    },
    info: () => {
      // not asserted here.
    },
  };
}

const VALID_EMAIL = `pg-eos-2.16-handlers-${randomUUID()}@example.invalid`;

// --- Real-DB fixtures (anti-enumeration/idempotency-replay tests below drive the REAL mechanism,
// through the REAL handlers, with a REAL Idempotency-Key header) --------------------------------

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';
const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';
const THRESHOLD_FIXTURES = [
  {
    key: OTP_EXPIRY_MINUTES_KEY,
    value: '7',
    unit: 'minutes',
    descriptionAr: 'صلاحية رمز الدخول لمرة واحدة بالدقائق — صف اختباري (WBS 2.16، معالجات)',
  },
  {
    key: SESSION_LIFETIME_MINUTES_KEY,
    value: '480',
    unit: 'minutes',
    descriptionAr: 'مدة صلاحية الجلسة بالدقائق — صف اختباري (WBS 2.16، معالجات)',
  },
] as const;
const thresholdRowsSeededByThisRun: { key: string; value: string }[] = [];
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
      thresholdRowsSeededByThisRun.push({ key: fixture.key, value: fixture.value });
    }
  }
}

async function createFixtureUser(): Promise<{ id: string; email: string }> {
  const email = `pg-eos-2.16-handlers-fixture-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', true)
     returning id`,
    [email, 'مستخدم اختبار — WBS 2.16 (معالجات)'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture user insert returned no row');
  return { id: row.id, email };
}

function uniqueUnknownEmail(): string {
  return `pg-eos-2.16-handlers-unknown-${randomUUID()}@example.invalid`;
}

beforeAll(async () => {
  await seedThresholdFixtures();
});

afterAll(async () => {
  if (fixtureEmails.length > 0) {
    await pool.query(
      'delete from platform.idempotency_keys where user_id in (select id from identity.users where email = any($1::text[]))',
      [fixtureEmails],
    );
    await pool.query(
      'delete from identity.sessions where user_id in (select id from identity.users where email = any($1::text[]))',
      [fixtureEmails],
    );
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

describe('a missing Idempotency-Key is rejected with a 400 Problem before any command runs', () => {
  it('handleRequestOtpCode: no Idempotency-Key header -> 400', async () => {
    const deps = createOtpLoginDeps({});
    const result = await handleRequestOtpCode(
      requestWithoutKey({ email: VALID_EMAIL, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });

  it('handleVerifyOtpCode: no Idempotency-Key header -> 400', async () => {
    const deps = createOtpLoginDeps({});
    const result = await handleVerifyOtpCode(
      requestWithoutKey({ email: VALID_EMAIL, code: '000000', correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('a malformed body is rejected with a 400 Problem, not a thrown exception', () => {
  it('handleRequestOtpCode: a body missing "email" -> 400, title "ZodError"', async () => {
    const deps = createOtpLoginDeps({});
    const result = await handleRequestOtpCode(
      requestWithKey({ correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ title: 'ZodError' });
  });

  it('handleVerifyOtpCode: a body missing "code" -> 400, title "ZodError"', async () => {
    const deps = createOtpLoginDeps({});
    const result = await handleVerifyOtpCode(
      requestWithKey({ email: VALID_EMAIL, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ title: 'ZodError' });
  });
});

describe('InvalidOtpError maps to 422, title = error.name (Master decision 2 — never 4xx-distinguishable from an unknown user); NO 409 exists at this layer any more', () => {
  it('handleVerifyOtpCode: verifyLoginOtp resolving { valid: false } (a wrong/unmatched code) -> 422, title "InvalidOtpError"', async () => {
    vi.mocked(verifyLoginOtp).mockResolvedValueOnce({ valid: false });
    const logger = spyLogger();
    const deps = createOtpLoginDeps({ logger });

    const result = await handleVerifyOtpCode(
      requestWithKey({ email: VALID_EMAIL, code: '000000', correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'InvalidOtpError' });
    expect(logger.errorCalls).toHaveLength(0);
  });

  it('handleVerifyOtpCode: verifyLoginOtp resolving a REPLAY signal ({ valid: true, token: null }) -> 422, title "InvalidOtpError", never a 200 without a token (POST-P6c rule 3)', async () => {
    const replaySignal: LoginOtpVerification = {
      valid: true,
      userId: randomUUID(),
      sessionId: randomUUID(),
      token: null,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    };
    vi.mocked(verifyLoginOtp).mockResolvedValueOnce(replaySignal);
    const logger = spyLogger();
    const deps = createOtpLoginDeps({ logger });

    const result = await handleVerifyOtpCode(
      requestWithKey({ email: VALID_EMAIL, code: '000000', correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'InvalidOtpError' });
    expect(logger.errorCalls).toHaveLength(0);
  });
});

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error (never console.log)', () => {
  it('handleRequestOtpCode: an unexpected mechanism failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const thrown = new TypeError('unexpected mechanism failure — never sent to the client');
    vi.mocked(requestLoginOtp).mockRejectedValueOnce(thrown);
    const logger = spyLogger();
    const deps = createOtpLoginDeps({ logger });
    const correlationId = randomUUID();

    const result = await handleRequestOtpCode(
      requestWithKey({ email: VALID_EMAIL, correlationId }),
      deps,
    );

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(
      /unexpected mechanism failure/,
    );

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });

  it('handleVerifyOtpCode: an unexpected mechanism failure -> 500, generic detail, logged', async () => {
    const thrown = new TypeError('unexpected verify failure — never sent to the client');
    vi.mocked(verifyLoginOtp).mockRejectedValueOnce(thrown);
    const logger = spyLogger();
    const deps = createOtpLoginDeps({ logger });
    const correlationId = randomUUID();

    const result = await handleVerifyOtpCode(
      requestWithKey({ email: VALID_EMAIL, code: '000000', correlationId }),
      deps,
    );

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(
      /unexpected verify failure/,
    );
    expect(logger.errorCalls).toHaveLength(1);
  });
});

describe('requestOtpCode — anti-enumeration under a REAL Idempotency-Key, through the REAL handler (pg-reviewer round 1, finding 8)', () => {
  it('first call: a known, active email and an unknown email both return 200 { expiresInMinutes } — identical shape', async () => {
    const known = await createFixtureUser();
    const deps = createOtpLoginDeps({});

    const knownResult = await handleRequestOtpCode(
      requestWithKey({ email: known.email, correlationId: randomUUID() }),
      deps,
    );
    const unknownResult = await handleRequestOtpCode(
      requestWithKey({ email: uniqueUnknownEmail(), correlationId: randomUUID() }),
      deps,
    );

    expect(knownResult.status).toBe(200);
    expect(unknownResult.status).toBe(200);
    expect('body' in knownResult ? Object.keys(knownResult.body) : []).toEqual(['expiresInMinutes']);
    expect('body' in unknownResult ? Object.keys(unknownResult.body) : []).toEqual(['expiresInMinutes']);
  });

  it('exact replay (same key, same body) is byte-identical for a KNOWN email', async () => {
    const known = await createFixtureUser();
    const deps = createOtpLoginDeps({});
    const key = randomUUID();
    const body = { email: known.email, correlationId: randomUUID() };

    const first = await handleRequestOtpCode(requestWithKey(body, key), deps);
    const second = await handleRequestOtpCode(requestWithKey(body, key), deps);

    expect(first.status).toBe(200);
    expect(second).toEqual(first);
  });

  it('exact replay (same key, same body) is byte-identical for an UNKNOWN email', async () => {
    const deps = createOtpLoginDeps({});
    const key = randomUUID();
    const body = { email: uniqueUnknownEmail(), correlationId: randomUUID() };

    const first = await handleRequestOtpCode(requestWithKey(body, key), deps);
    const second = await handleRequestOtpCode(requestWithKey(body, key), deps);

    expect(first.status).toBe(200);
    expect(second).toEqual(first);
  });

  it('same key + a DIFFERENT body (same KNOWN email, different correlationId) returns 200 { expiresInMinutes } — no error leaks that the email is known (login.ts absorbs the idempotency conflict)', async () => {
    const known = await createFixtureUser();
    const deps = createOtpLoginDeps({});
    const key = randomUUID();

    const first = await handleRequestOtpCode(
      requestWithKey({ email: known.email, correlationId: randomUUID() }, key),
      deps,
    );
    const second = await handleRequestOtpCode(
      requestWithKey({ email: known.email, correlationId: randomUUID() }, key),
      deps,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect('body' in second ? Object.keys(second.body) : []).toEqual(['expiresInMinutes']);
  });

  it('same key + a DIFFERENT body (same UNKNOWN email, different correlationId) ALSO returns 200 { expiresInMinutes } — identical outward behaviour to the known case above', async () => {
    const unknownEmail = uniqueUnknownEmail();
    const deps = createOtpLoginDeps({});
    const key = randomUUID();

    const first = await handleRequestOtpCode(
      requestWithKey({ email: unknownEmail, correlationId: randomUUID() }, key),
      deps,
    );
    const second = await handleRequestOtpCode(
      requestWithKey({ email: unknownEmail, correlationId: randomUUID() }, key),
      deps,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect('body' in second ? Object.keys(second.body) : []).toEqual(['expiresInMinutes']);
  });
});

describe('handleVerifyOtpCode — a REPLAY of a completed verification is 422 through the REAL handler, never a 409 (POST-P6c rule 3)', () => {
  it('the same Idempotency-Key + body verified twice: first call succeeds with a token, second call -> 422 InvalidOtpError', async () => {
    const user = await createFixtureUser();
    // Mint a real code via the real (unmocked, passthrough) mechanism through requestOtpCode's own
    // handler so this test drives the whole real path, then read it back is impossible (the code is
    // never returned) — so this test uses the real generateOtp import instead, same as
    // ./otp-login.test.ts, to obtain a KNOWN code for the SAME fixture user.
    const { generateOtp } = await import('@pg-eos/identity-mechanisms');
    const otp = await generateOtp(user.email);
    const deps = createOtpLoginDeps({});
    const key = randomUUID();
    const body = { email: user.email, code: otp.code, correlationId: randomUUID() };

    const first = await handleVerifyOtpCode(requestWithKey(body, key), deps);
    expect(first.status).toBe(200);

    const second = await handleVerifyOtpCode(requestWithKey(body, key), deps);
    expect(second.status).toBe(422);
    expect(second.body).toMatchObject({ title: 'InvalidOtpError' });

    const sessionRows: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.sessions where user_id = $1',
      [user.id],
    );
    expect(sessionRows.rows).toHaveLength(1);
  });
});

describe('createOtpLoginDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createOtpLoginDeps({ logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createOtpLoginDeps({});
    expect(typeof defaultDeps.logger.error).toBe('function');
    expect(typeof defaultDeps.logger.info).toBe('function');
  });
});
