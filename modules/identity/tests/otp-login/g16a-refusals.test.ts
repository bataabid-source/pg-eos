// modules/identity/tests/otp-login/g16a-refusals.test.ts — WBS 2.16 part 1a-5 (pg-tester), RED phase.
//
// Endpoint-layer (handlers / requestOtpCode / verifyOtpCode) tests for the two G-16a requirements
// that only make sense at THIS layer (../../../../packages/identity/tests/g16a-limits.test.ts and
// ./g16a-limits.property.test.ts cover the mechanism layer):
//   D6 — every refusal reason (wrong code, exhausted attempts, an invalidated code) maps to the
//        IDENTICAL HTTP status, Problem `title` and `detail` — no field lets a caller distinguish
//        which case occurred (brief, Decision 4; ./g16a-limits.feature's own "Every refusal has the
//        same problem shape to the caller" scenario). A fourth case, a locked-out email, is OUT OF
//        SCOPE (pre-build review round 1, finding 1 — SCR-IDENTITY-AUTH-01; see
//        ../../../../packages/identity/tests/g16a-limits.feature's own header).
//   D7 — no OTP code, its keyed hash, or an email address ever appears in any log line, across a
//        full request + wrong-verify + correct-verify + refused-request + unhandled-failure (500)
//        sequence (brief, Decision 4; ./g16a-limits.feature's own "No OTP code, hash or email
//        appears in any log line" scenario).
//
// TEST-DB / MOCK PATTERN — copied from ./handlers.test.ts (viewed in full, same directory, same
// convention already established there): an independent `pg.Pool`, randomUUID()-suffixed fixture
// users/emails, the EXISTING two threshold keys (identity.otp.expiry_minutes,
// identity.session.lifetime_minutes) seeded by THIS file with `on conflict (key) do nothing` (same
// as ./handlers.test.ts's own seedThresholdFixtures), and `vi.mock('@pg-eos/identity-mechanisms',
// importOriginal)` as a PASSTHROUGH — every call not explicitly overridden with
// `mockRejectedValueOnce` still runs the REAL mechanism against the real DB.
//
// RED, and why it is the right RED. D6's exhausted-attempts/invalidated-code setups, and D7's
// refused-request step, all depend on the G-16a enforcement this slice builds
// (packages/identity/src/otp.ts's new resend/hourly-cap/attempts-cap logic and migration 0042's
// seed rows) — none of which exists yet:
//   - the exhausted-attempts setup reads `identity.otp.max_attempts` directly from
//     platform.thresholds (a literal key string, deliberately NOT imported from
//     '@pg-eos/identity-mechanisms' — this file's RED does not depend on that package's export
//     surface, only on modules/identity's own behaviour) — with no migration 0042, this row does
//     not exist and the setup throws;
//   - the "refused request" row-count assertion (D7's sequence, and D6/D4's endpoint parity) is RED
//     today because NOTHING refuses a second, immediate request for the same email yet — it would
//     mint a SECOND real otp_codes row instead of being absorbed into the anti-enumeration 200.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';

vi.mock('@pg-eos/identity-mechanisms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pg-eos/identity-mechanisms')>();
  return {
    ...actual,
    // Default implementation is the REAL flow — only `mockRejectedValueOnce` below (the 500-path
    // test) ever diverges from it, and only for the ONE call that uses it.
    requestLoginOtp: vi.fn(actual.requestLoginOtp),
    verifyLoginOtp: vi.fn(actual.verifyLoginOtp),
  };
});

// Imported AFTER vi.mock (hoisted by vitest) so these bindings are the mocked ones for the 500-path
// test; `generateOtp` is never wrapped above (`...actual`), so it is always the real mechanism.
import { generateOtp, requestLoginOtp } from '@pg-eos/identity-mechanisms';

import {
  handleRequestOtpCode,
  handleVerifyOtpCode,
  type ApiRequest,
} from '../../api/otp-login/handlers.js';
import { createOtpLoginDeps } from '../../api/otp-login/composition.js';
import type { Logger, LogFields } from '../../application/otp-login/ports.js';

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body };
}

// A code guaranteed to differ from `code` — same derivation as every sibling suite's wrongCodeFor.
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

// The two PRE-EXISTING keys this use case already needs on every call (unchanged by this slice) —
// seeded exactly as ./handlers.test.ts already does. The NEW G-16a keys below are deliberately NEVER
// seeded by this file (see header) — migration 0042 is their only permitted writer.
const OTP_EXPIRY_MINUTES_KEY = 'identity.otp.expiry_minutes';
const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';
const PRE_EXISTING_THRESHOLD_FIXTURES = [
  {
    key: OTP_EXPIRY_MINUTES_KEY,
    value: '7',
    unit: 'minutes',
    descriptionAr: 'صلاحية رمز الدخول لمرة واحدة بالدقائق — صف اختباري (WBS 2.16 part 1a-5)',
  },
  {
    key: SESSION_LIFETIME_MINUTES_KEY,
    value: '480',
    unit: 'minutes',
    descriptionAr: 'مدة صلاحية الجلسة بالدقائق — صف اختباري (WBS 2.16 part 1a-5)',
  },
] as const;
const thresholdRowsSeededByThisRun: { key: string; value: string }[] = [];

// New G-16a keys (literal strings — see header for why they are not imported).
const OTP_MAX_ATTEMPTS_KEY = 'identity.otp.max_attempts';
const OTP_RESEND_SECONDS_KEY = 'identity.otp.resend_seconds';

// Unit conversion constants only (same discipline as ../../../../packages/identity/tests/
// g16a-limits.test.ts) — not a business number.
const MILLISECONDS_PER_SECOND = 1000;
const BOUNDARY_MARGIN_SECONDS = 1;

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

async function seedPreExistingThresholdFixtures(): Promise<void> {
  for (const fixture of PRE_EXISTING_THRESHOLD_FIXTURES) {
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

const fixtureEmails: string[] = [];

async function createFixtureUser(label: string): Promise<{ id: string; email: string }> {
  const email = `pg-eos-2.16-g16a-refusals-${label}-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', true)
     returning id`,
    [email, 'مستخدم اختبار — WBS 2.16 part 1a-5 (رفض موحّد)'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture user insert returned no row');
  return { id: row.id, email };
}

async function countOtpRows(email: string): Promise<number> {
  const result = await pool.query('select id from identity.otp_codes where email = $1', [email]);
  return result.rows.length;
}

beforeAll(async () => {
  await seedPreExistingThresholdFixtures();
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
    await pool.query('delete from identity.otp_codes where email = any($1::text[])', [
      fixtureEmails,
    ]);
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

describe('D6 — every refusal reason produces the identical problem shape at the endpoint', () => {
  it('wrong code, exhausted attempts, and an invalidated code all map to the same status, title, and detail', async () => {
    const deps = createOtpLoginDeps({});
    const maxAttempts = await readThresholdValue(OTP_MAX_ATTEMPTS_KEY);
    const resendSeconds = await readThresholdValue(OTP_RESEND_SECONDS_KEY);

    // 1. A plain wrong code — the baseline every other case is compared against.
    const wrongCodeUser = await createFixtureUser('wrong-code');
    const wrongCodeOtp = await generateOtp(wrongCodeUser.email);
    const wrongCodeResult = await handleVerifyOtpCode(
      requestWithKey({
        email: wrongCodeUser.email,
        code: wrongCodeFor(wrongCodeOtp.code),
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(wrongCodeResult.status).toBe(422);

    // 2. Exhausted attempts (D2) — maxAttempts wrong submissions through the REAL endpoint, then the
    //    correct code.
    const exhaustedUser = await createFixtureUser('exhausted');
    const exhaustedOtp = await generateOtp(exhaustedUser.email);
    for (let i = 0; i < maxAttempts; i += 1) {
      await handleVerifyOtpCode(
        requestWithKey({
          email: exhaustedUser.email,
          code: wrongCodeFor(exhaustedOtp.code),
          correlationId: randomUUID(),
        }),
        deps,
      );
    }
    const exhaustedResult = await handleVerifyOtpCode(
      requestWithKey({
        email: exhaustedUser.email,
        code: exhaustedOtp.code,
        correlationId: randomUUID(),
      }),
      deps,
    );

    // 3. An invalidated code (D3) — a second real OTP request supersedes the first.
    const invalidatedUser = await createFixtureUser('invalidated');
    const firstIssuedAt = new Date();
    const invalidatedFirst = await generateOtp(invalidatedUser.email, {
      now: () => firstIssuedAt,
    });
    const secondIssuedAt = new Date(
      firstIssuedAt.getTime() +
        (resendSeconds + BOUNDARY_MARGIN_SECONDS) * MILLISECONDS_PER_SECOND,
    );
    await generateOtp(invalidatedUser.email, { now: () => secondIssuedAt });
    const invalidatedResult = await handleVerifyOtpCode(
      requestWithKey({
        email: invalidatedUser.email,
        code: invalidatedFirst.code,
        correlationId: randomUUID(),
      }),
      deps,
    );

    for (const result of [exhaustedResult, invalidatedResult]) {
      expect(result.status).toBe(wrongCodeResult.status);
      expect(result.body).toEqual(wrongCodeResult.body);
    }
  });
});

describe('D7 — no OTP code, hash, or email ever appears in a log line', () => {
  it('across a request, a wrong verify, a correct verify, a refused (rate-limited) request, and an unhandled (500) failure', async () => {
    const capturedLines: Array<{ obj: LogFields; msg: string }> = [];
    const logger: Logger = {
      error: (obj, msg) => {
        capturedLines.push({ obj, msg });
      },
      info: (obj, msg) => {
        capturedLines.push({ obj, msg });
      },
    };
    const deps = createOtpLoginDeps({ logger });

    // --- step 1: a request, and step 2: an immediate second request for the SAME email is refused
    // (D4 endpoint parity) — both must be logged (if logged at all) without leaking the email.
    const requestUser = await createFixtureUser('log-request');
    const firstRequest = await handleRequestOtpCode(
      requestWithKey({ email: requestUser.email, correlationId: randomUUID() }),
      deps,
    );
    expect(firstRequest.status).toBe(200);

    const secondRequest = await handleRequestOtpCode(
      requestWithKey({ email: requestUser.email, correlationId: randomUUID() }),
      deps,
    );
    expect(secondRequest.status).toBe(200);
    expect('body' in secondRequest ? Object.keys(secondRequest.body) : []).toEqual([
      'expiresInMinutes',
    ]);
    // The second, immediate request must have been REFUSED internally (resend window) — only ONE
    // identity.otp_codes row exists, even though the endpoint returned 200 twice (D4 endpoint
    // parity: the caller cannot tell request 1 and request 2 apart).
    expect(await countOtpRows(requestUser.email)).toBe(1);

    // --- step 3 (wrong verify) and step 4 (correct verify): a real code, minted directly via the
    // mechanism (the request endpoint never returns the plaintext — same precedent as
    // ./otp-login.test.ts's own "its plaintext value is known" scenario).
    const verifyUser = await createFixtureUser('log-verify');
    const otp = await generateOtp(verifyUser.email);
    const codeRow: QueryResult<{ code_hash: string }> = await pool.query(
      'select code_hash from identity.otp_codes where id = $1',
      [otp.otpId],
    );
    const codeHash = codeRow.rows[0]?.code_hash;
    if (!codeHash) throw new Error('fixture otp row missing code_hash');

    const wrongVerify = await handleVerifyOtpCode(
      requestWithKey({
        email: verifyUser.email,
        code: wrongCodeFor(otp.code),
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(wrongVerify.status).toBe(422);

    const correctVerify = await handleVerifyOtpCode(
      requestWithKey({ email: verifyUser.email, code: otp.code, correlationId: randomUUID() }),
      deps,
    );
    expect(correctVerify.status).toBe(200);

    // --- step 5: an unhandled (500) failure — the thrown error's own message is deliberately
    // generic (it must never itself carry the email/code, same as ./handlers.test.ts's own 500
    // tests), but the ASSERTION here is that the SURROUNDING log call (correlationId + err) does
    // not add the email or code either.
    const failureUser = await createFixtureUser('log-failure');
    const thrown = new TypeError('unexpected mechanism failure — never sent to the client');
    vi.mocked(requestLoginOtp).mockRejectedValueOnce(thrown);
    const failureResult = await handleRequestOtpCode(
      requestWithKey({ email: failureUser.email, correlationId: randomUUID() }),
      deps,
    );
    expect(failureResult.status).toBe(500);

    // --- the assertion: nowhere in ANY captured log line (obj or msg, Error objects serialised by
    // their own message/stack so a leak inside an Error is not hidden by JSON.stringify(Error) ===
    // '{}') does the plaintext code, its stored hash, or any fixture email appear.
    const errorReplacer = (_key: string, value: unknown): unknown => {
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      return value;
    };
    const haystack = capturedLines
      .map((line) => `${JSON.stringify(line.obj, errorReplacer)} ${line.msg}`)
      .join('\n');

    expect(haystack).not.toContain(otp.code);
    expect(haystack).not.toContain(codeHash);
    for (const email of [requestUser.email, verifyUser.email, failureUser.email]) {
      expect(haystack).not.toContain(email);
    }
  });
});
