// packages/identity/tests/session.test.ts — WBS 0.17 (pg-tester), RED phase.
//
// RED, and why it is the right RED: `packages/identity/src/session.ts` does not exist yet —
// pg-backend builds it next, to exactly the contract these tests pin down. The import below fails
// to resolve; that is the same class of RED as WBS 0.11 and WBS 0.12 in this repo.
//
// Scope: "Feature: Session mechanism" of the WBS 0.17 slice brief — four Gherkin scenarios, the
// last of which the brief itself states as a property test ("the stored value never equals any
// plaintext-token fixture used in the suite"), plus the threshold-derived lifetime the brief's
// Deliver section requires (no embedded default).
//
// Schema this suite depends on (database/schema/01-Data-Model.sql:267-277):
//   identity.sessions (id uuid pk, user_id uuid not null references identity.users(id) on delete
//                      cascade, token_hash text not null, issued_at timestamptz not null default
//                      now(), expires_at timestamptz not null, revoked_at timestamptz,
//                      ip_address inet, user_agent text)
// and platform.thresholds (13B:328-335).
//
// KNOWN SCHEMA GAP, same as the OTP suite (WBS 0.17 brief, "Known schema gap"): platform.thresholds
// has no production seed row for a session lifetime, and CLAUDE.md forbids inventing one. This
// suite seeds its own fixture row under `identity.session.lifetime_minutes` and never asserts the
// seeded number as a literal — it re-reads `value` at assert time.
//
// CONCURRENCY — KNOWN, ACCEPTED, NARROW FLAKE (not an oversight), identical to the OTP suite's,
// whose header carries the full reasoning. This key and `identity.otp.expiry_minutes` are the only
// two fixture rows in the whole WBS 0.17 suite that cannot be randomUUID()-suffixed, because the
// implementation reads a FIXED key. afterAll deletes the row only if THIS run inserted it AND the
// row still holds the value this run wrote, so it can never remove a row another run or a future
// production seed has replaced. It does NOT close the remaining window: a run that inserted the
// row and finishes first will delete it out from under a concurrent run whose own insert was a
// no-op, and that run then fails with "threshold fixture missing at assert time". Accepted for
// this mechanism-only slice; it disappears for good when the Master's follow-up lands real
// production seed rows for these keys. Re-run the suite if it is hit — do not add fixture
// machinery here.
//
// Fixture users are deleted in afterAll; identity.sessions.user_id is `on delete cascade`, so the
// session rows go with them — no separate session cleanup is needed or written.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The package under test — does not exist yet. This is the RED.
import { issueSession, verifySession, revokeSession, UnknownOrInactiveUserError } from '../src/session.js';
import type { IssuedSession, SessionVerification } from '../src/session.js';

const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';

// Fixture value, deliberately not a round number, so a plausible hardcoded default (30 / 60 / 1440
// minutes) cannot accidentally satisfy the lifetime assertion below.
const SESSION_LIFETIME_FIXTURE = {
  key: SESSION_LIFETIME_MINUTES_KEY,
  value: '43',
  unit: 'minutes',
  descriptionAr: 'عمر الجلسة بالدقائق — صف اختباري (WBS 0.17)',
} as const;

// Unit conversion only — platform.thresholds.unit is 'minutes', JS works in milliseconds.
const MILLISECONDS_PER_MINUTE = 60_000;

// How many sessions the one-wayness property test issues. The property is checked over every
// (stored hash × raw token) pair of the whole suite, so this is a sample size, not a business
// number: it only has to be > 1 for the cross-product to be meaningful.
const PROPERTY_SAMPLE_SESSIONS = 12;

// Same PG* env-var convention as packages/db/src/client.ts and packages/events/tests/*.test.ts.
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const fixtureEmails: string[] = [];
let lifetimeThresholdSeededByThisRun = false;

// Every raw token this suite has ever held in plaintext. The property test at the bottom asserts
// that NONE of them appears in identity.sessions.token_hash — for any session, not just its own.
const allRawTokensUsedInThisSuite: string[] = [];

function rememberToken(token: string): string {
  allRawTokensUsedInThisSuite.push(token);
  return token;
}

async function createFixtureUser(): Promise<{ id: string; email: string }> {
  const email = `pg-eos-0.17-session-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', true)
     returning id`,
    [email, 'مستخدم اختبار — WBS 0.17'],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('fixture user insert returned no row');
  }
  return { id: row.id, email };
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

async function readSessionRow(sessionId: string): Promise<SessionRow> {
  const result: QueryResult<SessionRow> = await pool.query(
    'select id, user_id, token_hash, issued_at, expires_at, revoked_at from identity.sessions where id = $1',
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`identity.sessions row not found: ${sessionId}`);
  }
  return row;
}

async function readThresholdValue(key: string): Promise<number> {
  const result: QueryResult<{ value: string }> = await pool.query(
    'select value from platform.thresholds where key = $1',
    [key],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`threshold fixture missing at assert time: ${key}`);
  }
  // numeric(14,3) arrives as a string from node-postgres — parsed, not assumed.
  return Number(row.value);
}

beforeAll(async () => {
  const inserted = await pool.query(
    `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
     values ($1, $2, $3, $4, $5)
     on conflict (key) do nothing`,
    [
      SESSION_LIFETIME_FIXTURE.key,
      SESSION_LIFETIME_FIXTURE.value,
      SESSION_LIFETIME_FIXTURE.unit,
      SESSION_LIFETIME_FIXTURE.descriptionAr,
      randomUUID(),
    ],
  );
  lifetimeThresholdSeededByThisRun = inserted.rowCount === 1;
});

afterAll(async () => {
  if (fixtureEmails.length > 0) {
    // identity.sessions.user_id is `on delete cascade` — session rows go with the users.
    await pool.query('delete from identity.users where email = any($1::text[])', [fixtureEmails]);
  }
  if (lifetimeThresholdSeededByThisRun) {
    // `and value = …` is the narrowing guard: if anything else — a concurrent run, or the
    // Master's eventual production seed — has replaced this row's value since this run inserted
    // it, the row is no longer this run's to remove and the delete matches nothing.
    await pool.query('delete from platform.thresholds where key = $1 and value = $2::numeric', [
      SESSION_LIFETIME_MINUTES_KEY,
      SESSION_LIFETIME_FIXTURE.value,
    ]);
  }
  await pool.end();
});

describe('Session mechanism — issueSession / verifySession / revokeSession (WBS 0.17 brief, Feature: Session mechanism)', () => {
  it('verifySession with the raw token of a freshly issued session reports valid and returns that user id and session id', async () => {
    const user = await createFixtureUser();
    const issuedAt = new Date();

    const session: IssuedSession = await issueSession(user.id, { now: () => issuedAt });
    rememberToken(session.token);

    const verification: SessionVerification = await verifySession(session.token, {
      now: () => issuedAt,
    });

    expect(verification.valid).toBe(true);
    if (!verification.valid) {
      throw new Error('expected a valid verification for a freshly issued session');
    }
    expect(verification.userId).toBe(user.id);
    expect(verification.sessionId).toBe(session.sessionId);
  });

  it('verifySession reports invalid after revokeSession, and identity.sessions.revoked_at is set', async () => {
    const user = await createFixtureUser();
    const issuedAt = new Date();

    const session = await issueSession(user.id, { now: () => issuedAt });
    rememberToken(session.token);

    // Proved valid BEFORE the revoke, so the assertion after it cannot be vacuously true.
    const beforeRevoke = await verifySession(session.token, { now: () => issuedAt });
    expect(beforeRevoke.valid).toBe(true);

    await revokeSession(session.sessionId, { now: () => issuedAt });

    const row = await readSessionRow(session.sessionId);
    expect(row.revoked_at).not.toBeNull();

    const afterRevoke = await verifySession(session.token, { now: () => issuedAt });
    expect(afterRevoke.valid).toBe(false);
  });

  it('verifySession reports invalid once the instant is past identity.sessions.expires_at, even though the session was never revoked', async () => {
    const user = await createFixtureUser();
    const issuedAt = new Date();

    const session = await issueSession(user.id, { now: () => issuedAt });
    rememberToken(session.token);

    // One millisecond past the row's OWN expires_at, read back from the database — the injected
    // clock is what makes this deterministic instead of a sleep (WBS 0.17 brief).
    const row = await readSessionRow(session.sessionId);
    expect(row.revoked_at).toBeNull();
    const justAfterExpiry = new Date(row.expires_at.getTime() + 1);

    const verification = await verifySession(session.token, { now: () => justAfterExpiry });

    expect(verification.valid).toBe(false);
  });

  it('issueSession sets identity.sessions.expires_at to the injected instant plus the identity.session.lifetime_minutes threshold — no embedded default', async () => {
    const user = await createFixtureUser();
    const issuedAt = new Date();

    const session = await issueSession(user.id, { now: () => issuedAt });
    rememberToken(session.token);

    const lifetimeMinutes = await readThresholdValue(SESSION_LIFETIME_MINUTES_KEY);
    const expected = issuedAt.getTime() + lifetimeMinutes * MILLISECONDS_PER_MINUTE;

    expect(session.expiresAt.getTime()).toBe(expected);

    const row = await readSessionRow(session.sessionId);
    expect(row.expires_at.getTime()).toBe(expected);
    expect(row.issued_at.getTime()).toBe(issuedAt.getTime());
  });

  it('verifySession reports invalid for a token that was never issued', async () => {
    // Not a Gherkin scenario of its own, but the complement that stops "always valid" from being a
    // passing implementation of the three scenarios above.
    const neverIssued = rememberToken(`never-issued-${randomUUID()}`);

    const verification = await verifySession(neverIssued, { now: () => new Date() });

    expect(verification.valid).toBe(false);
  });

  it('issueSession rejects with UnknownOrInactiveUserError for a deactivated user, and creates no identity.sessions row', async () => {
    // Round-2 review finding 2 (pg-reviewer): issueSession's is_active guard (session.ts:83-106)
    // shared no test with the OTP path's — this proves it directly, on the session side, rather
    // than only through generateOtp's already-covered check. is_active is the same column doc 01
    // already gates OTP issuance on (01-Data-Model.sql:220); no new rule is invented here.
    const user = await createFixtureUser();
    await pool.query('update identity.users set is_active = false where id = $1', [user.id]);

    await expect(issueSession(user.id, { now: () => new Date() })).rejects.toBeInstanceOf(
      UnknownOrInactiveUserError,
    );

    const sessions: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.sessions where user_id = $1',
      [user.id],
    );
    expect(sessions.rows).toHaveLength(0);
  });
});

describe('Session token storage — property: the raw token is never recoverable from identity.sessions (WBS 0.17 brief, scenario "the raw token is never recoverable from storage")', () => {
  it(`no identity.sessions.token_hash equals or contains any of the ${PROPERTY_SAMPLE_SESSIONS} plaintext tokens issued in this property, and every issued token is distinct`, async () => {
    const user = await createFixtureUser();
    const issuedAt = new Date();

    const issued: IssuedSession[] = [];
    for (let i = 0; i < PROPERTY_SAMPLE_SESSIONS; i += 1) {
      const session = await issueSession(user.id, { now: () => issuedAt });
      rememberToken(session.token);
      issued.push(session);
    }

    const rows = await Promise.all(issued.map(async (s) => readSessionRow(s.sessionId)));

    // The property, checked over the full cross-product: no stored hash is any raw token this
    // suite has ever held — not its own, and not another session's.
    for (const row of rows) {
      for (const rawToken of allRawTokensUsedInThisSuite) {
        expect(row.token_hash).not.toBe(rawToken);
        expect(row.token_hash).not.toContain(rawToken);
      }
    }

    // A one-way, keyed hash of distinct high-entropy inputs must itself be distinct: equal stored
    // hashes here would mean the token is not actually the hashed input (a constant, a counter, or
    // the user id), which would defeat the property above without failing it.
    const distinctTokens = new Set(issued.map((s) => s.token));
    const distinctHashes = new Set(rows.map((r) => r.token_hash));
    expect(distinctTokens.size).toBe(PROPERTY_SAMPLE_SESSIONS);
    expect(distinctHashes.size).toBe(PROPERTY_SAMPLE_SESSIONS);
  });

  it('a stored token_hash is not a reversible encoding of its raw token (base64 / hex / URI decoding never yields it back)', async () => {
    const user = await createFixtureUser();
    const session = await issueSession(user.id, { now: () => new Date() });
    rememberToken(session.token);

    const row = await readSessionRow(session.sessionId);

    expect(row.token_hash).not.toBe(session.token);
    expect(Buffer.from(row.token_hash, 'base64').toString('utf8')).not.toBe(session.token);
    expect(Buffer.from(row.token_hash, 'hex').toString('utf8')).not.toBe(session.token);
    expect(decodeURIComponent(row.token_hash)).not.toBe(session.token);
  });
});
