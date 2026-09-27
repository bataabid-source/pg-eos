// packages/identity/tests/session-subject.test.ts — X part 5a (Master pre-task inside this
// slice, brief `docs/notes/slice-briefs/_slice-X-part-5a.brief.md` §"Session subject").
//
// RED, and why it is the right RED: `verifySessionSubject` does not exist yet on
// `packages/identity/src/session.ts` — session.ts itself already exists (WBS 0.17), so the import
// resolves the module but the named binding is `undefined` (vitest's esbuild transform, unlike
// native Node ESM, does not statically enforce named exports); every test below calls it and fails
// with `TypeError: verifySessionSubject is not a function` — the same "fails on the missing
// export" RED the brief requires, confirmed by the actual RED run (see closing report).
//
// Contract under test (brief, "Session subject"): `verifySessionSubject(token, opts?) →
// { valid: false } | { valid: true, userId, sessionId, userType: 'internal'|'client'|'agent',
// clientId: string | null, isActive: boolean }` — the same predicate as `verifySession` (token
// hash lookup, not revoked, not expired), joined to `identity.users` for `user_type, client_id,
// is_active` under `INTERNAL_NO_ACTOR_CTX`. It reports facts only; the host (apps/api) decides
// which facts it accepts (fail-closed to 401) — that mapping is server.test.ts's job, not this
// file's.
//
// Schema (database/schema/01-Data-Model.sql:227-234): identity.users.user_type not null default
// 'internal', .client_id uuid nullable (no FK: `client_user_has_client` only requires it be
// non-null when user_type = 'client' — verified by grep against 01-Data-Model.sql; a fixture
// client_id is therefore a plain randomUUID(), never a sales.accounts row), .is_active not null
// default true. Same identity.sessions table as session.test.ts.
//
// Same PG*/OTP_HMAC_SECRET env convention as session.test.ts (packages/identity/vitest.config.ts
// sets OTP_HMAC_SECRET at test.env — this suite does not touch OTP directly but session.ts's
// token hash shares the keyed-hash module, hmac.ts, which reads that same env var).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The export under test — does not exist yet. This is the RED.
import { issueSession, revokeSession, verifySessionSubject } from '../src/session.js';

const SESSION_LIFETIME_MINUTES_KEY = 'identity.session.lifetime_minutes';

// Same "not a round number" discipline as session.test.ts — a plausible hardcoded default cannot
// accidentally satisfy the lifetime read this suite relies on through issueSession.
const SESSION_LIFETIME_FIXTURE = {
  key: SESSION_LIFETIME_MINUTES_KEY,
  value: '43',
  unit: 'minutes',
  descriptionAr: 'عمر الجلسة بالدقائق — صف اختباري (X part 5a)',
} as const;

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const fixtureEmails: string[] = [];

async function createFixtureUser(overrides: {
  // `identity.users.user_type` is plain `text` with no CHECK restricting its values
  // (01-Data-Model.sql:227-234 — only `client_user_has_client` constrains `client_id`, not
  // `user_type` itself) — a fixture may therefore insert a value outside the closed
  // 'internal'|'client'|'agent' union verifySessionSubject's own type narrows to.
  readonly userType?: string;
  readonly clientId?: string | null;
  readonly isActive?: boolean;
}): Promise<{ id: string; email: string }> {
  const email = `pg-eos-x5a-session-subject-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const userType = overrides.userType ?? 'internal';
  const clientId = overrides.clientId ?? null;
  const isActive = overrides.isActive ?? true;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, client_id, is_active)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [email, 'مستخدم اختبار — X part 5a', userType, clientId, isActive],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('fixture user insert returned no row');
  }
  return { id: row.id, email };
}

async function readExpiresAt(sessionId: string): Promise<Date> {
  const result: QueryResult<{ expires_at: Date }> = await pool.query(
    'select expires_at from identity.sessions where id = $1',
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`identity.sessions row not found: ${sessionId}`);
  }
  return row.expires_at;
}

beforeAll(async () => {
  await pool.query(
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
});

afterAll(async () => {
  if (fixtureEmails.length > 0) {
    // identity.sessions.user_id is `on delete cascade` — same teardown shape as session.test.ts.
    await pool.query('delete from identity.users where email = any($1::text[])', [fixtureEmails]);
  }
  // SEED-ONLY, NEVER DELETE — same shared-key discipline as session.test.ts: this key is written
  // `on conflict do nothing` and other suites in this package depend on the row surviving.
  await pool.end();
});

describe('verifySessionSubject — session validity joined to identity.users (X part 5a brief, "Session subject")', () => {
  it('an active internal user: valid true, userType internal, clientId null, isActive true', async () => {
    const user = await createFixtureUser({ userType: 'internal', isActive: true });
    const issuedAt = new Date();
    const session = await issueSession(user.id, { now: () => issuedAt });

    const subject = await verifySessionSubject(session.token, { now: () => issuedAt });

    expect(subject.valid).toBe(true);
    if (!subject.valid) throw new Error('expected a valid subject for a freshly issued session');
    expect(subject.userId).toBe(user.id);
    expect(subject.sessionId).toBe(session.sessionId);
    expect(subject.userType).toBe('internal');
    expect(subject.clientId).toBeNull();
    expect(subject.isActive).toBe(true);
  });

  it('a client-type user: valid true, userType client, clientId equal to the user row\'s client_id', async () => {
    const clientId = randomUUID();
    const user = await createFixtureUser({ userType: 'client', clientId, isActive: true });
    const issuedAt = new Date();
    const session = await issueSession(user.id, { now: () => issuedAt });

    const subject = await verifySessionSubject(session.token, { now: () => issuedAt });

    expect(subject.valid).toBe(true);
    if (!subject.valid) throw new Error('expected a valid subject for a freshly issued session');
    expect(subject.userType).toBe('client');
    expect(subject.clientId).toBe(clientId);
    expect(subject.isActive).toBe(true);
  });

  it('an agent-type user: valid true, userType agent', async () => {
    const user = await createFixtureUser({ userType: 'agent', isActive: true });
    const issuedAt = new Date();
    const session = await issueSession(user.id, { now: () => issuedAt });

    const subject = await verifySessionSubject(session.token, { now: () => issuedAt });

    expect(subject.valid).toBe(true);
    if (!subject.valid) throw new Error('expected a valid subject for a freshly issued session');
    expect(subject.userType).toBe('agent');
  });

  it("a user_type outside the known ('internal'|'client'|'agent') set: valid false", async () => {
    // No CHECK constraint on identity.users.user_type rejects this insert (verified against
    // 01-Data-Model.sql:227-234); verifySessionSubject's own closed union type means it cannot
    // represent an unrecognised value as valid, so it reports the same fail-closed `{ valid: false
    // }` an unknown/revoked/expired session gets — never a userType value outside its own type.
    const user = await createFixtureUser({ userType: 'vendor', isActive: true });
    const issuedAt = new Date();
    const session = await issueSession(user.id, { now: () => issuedAt });

    const subject = await verifySessionSubject(session.token, { now: () => issuedAt });

    expect(subject.valid).toBe(false);
  });

  it('a user deactivated after their session was issued: valid true (session itself is intact) but isActive false', async () => {
    const user = await createFixtureUser({ userType: 'internal', isActive: true });
    const issuedAt = new Date();
    const session = await issueSession(user.id, { now: () => issuedAt });

    await pool.query('update identity.users set is_active = false where id = $1', [user.id]);

    const subject = await verifySessionSubject(session.token, { now: () => issuedAt });

    expect(subject.valid).toBe(true);
    if (!subject.valid) throw new Error('expected a valid subject — the session row itself was never revoked or expired');
    expect(subject.isActive).toBe(false);
  });

  it('a revoked session: valid false', async () => {
    const user = await createFixtureUser({ userType: 'internal', isActive: true });
    const issuedAt = new Date();
    const session = await issueSession(user.id, { now: () => issuedAt });

    await revokeSession(session.sessionId, { now: () => issuedAt });

    const subject = await verifySessionSubject(session.token, { now: () => issuedAt });

    expect(subject.valid).toBe(false);
  });

  it('an expired session: valid false', async () => {
    const user = await createFixtureUser({ userType: 'internal', isActive: true });
    const issuedAt = new Date();
    const session = await issueSession(user.id, { now: () => issuedAt });

    const expiresAt = await readExpiresAt(session.sessionId);
    const justAfterExpiry = new Date(expiresAt.getTime() + 1);

    const subject = await verifySessionSubject(session.token, { now: () => justAfterExpiry });

    expect(subject.valid).toBe(false);
  });

  it('an unknown token: valid false', async () => {
    const subject = await verifySessionSubject(`never-issued-${randomUUID()}`, { now: () => new Date() });

    expect(subject.valid).toBe(false);
  });
});
