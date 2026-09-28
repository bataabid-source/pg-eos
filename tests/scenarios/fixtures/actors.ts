// tests/scenarios/fixtures/actors.ts — enablement item 3a (Master decision 7: roles WH_MGR +
// WH_SUP on the main actor; a second actor for CheckOrder with the same roles).
//
// Same identity.users / user_entities / user_roles seeding pattern as
// modules/wms/tests/receive-inbound/handlers.test.ts:110-171, parameterised over a per-run random
// actor id (never a fixed uuid — two concurrent runs of this same spec file never collide).

import { randomUUID } from 'node:crypto';

import type { Pool, QueryResult } from 'pg';

import { issueSession, SESSION_LIFETIME_MINUTES_KEY } from '@pg-eos/identity-mechanisms';

// X part 5d: issueSession (mint) and verifySessionSubject (the host's own auth hook, apps/api/src/
// auth.ts) both hash the session token via keyedHash (packages/identity/src/hmac.ts), which throws
// without OTP_HMAC_SECRET. `apps/api`'s and `packages/identity`'s own vitest.config.ts already set
// this exact test-only value for the identical purpose (never a real secret) — Playwright has no
// equivalent `env:` config and `playwright.config.ts` is frozen for this slice, so it is set here,
// once, at module load, before any actor is issued a session. DEFAULT taken (recorded in the
// closing report): reuse the established precedent value verbatim, never a new fabricated secret.
const OTP_HMAC_SECRET_ENV_VAR = 'OTP_HMAC_SECRET';
const TEST_ONLY_OTP_HMAC_SECRET = 'test-only-not-a-secret-pg-eos-identity-suite';
if (!process.env[OTP_HMAC_SECRET_ENV_VAR]) {
  process.env[OTP_HMAC_SECRET_ENV_VAR] = TEST_ONLY_OTP_HMAC_SECRET;
}

export const WH_MGR_ROLE_CODE = 'WH_MGR';
export const WH_SUP_ROLE_CODE = 'WH_SUP';
export const SCENARIO_ACTOR_ROLE_CODES = [WH_MGR_ROLE_CODE, WH_SUP_ROLE_CODE] as const;

// X part 5d (ADR-0006 Decision 2): platform.thresholds has no production seed row for
// identity.session.lifetime_minutes (issueSession throws without one — packages/identity/src/
// session.ts). SEED-ONLY, idempotent, NEVER DELETED — precedent apps/api/tests/server.test.ts:
// 411-487 seeds the exact same production key the same way (a concurrent suite may already own the
// row via the same on-conflict no-op and rely on it surviving). Value large enough to outlive this
// suite's own run (minutes, named constant — CLAUDE.md: no magic numbers).
const SCENARIO_SESSION_LIFETIME_MINUTES = '43'; // the precedent's own value, server.test.ts:422.
const SCENARIO_SESSION_LIFETIME_UNIT = 'minutes';
const SCENARIO_SESSION_LIFETIME_DESCRIPTION_AR = 'عمر الجلسة بالدقائق — صف اختباري (X part 5d fixtures/actors.ts)';

async function ensureSessionLifetimeThreshold(pool: Pool): Promise<void> {
  await pool.query(
    `insert into platform.thresholds (key, value, unit, description_ar, changed_by)
     values ($1, $2, $3, $4, $5)
     on conflict (key) do nothing`,
    [
      SESSION_LIFETIME_MINUTES_KEY,
      SCENARIO_SESSION_LIFETIME_MINUTES,
      SCENARIO_SESSION_LIFETIME_UNIT,
      SCENARIO_SESSION_LIFETIME_DESCRIPTION_AR,
      randomUUID(),
    ],
  );
}

/** Creates one identity.users row, membership on every platform.entities row (so RLS's entity
 *  scope never blocks the fixture — same "all entities" grant handlers.test.ts:156-162 uses), and
 *  a user_roles row per requested role code. Returns the new user's id. */
export async function createActor(
  pool: Pool,
  params: { readonly namePrefix: string; readonly roleCodes: readonly string[] },
): Promise<string> {
  const userId = randomUUID();
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `${params.namePrefix}_${userId}@test.invalid`, 'ممثل اختبار سيناريو القبول'],
  );

  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const row of allEntitiesResult.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, row.id]);
  }

  for (const roleCode of params.roleCodes) {
    const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
      roleCode,
    ]);
    const roleRow = roleResult.rows[0];
    if (!roleRow) throw new Error(`identity.roles row not found for code ${roleCode}`);
    await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleRow.id]);
  }

  return userId;
}

/** Issues a real `identity.sessions` row for `userId` (X part 5d) — the Bearer token S1 now sends
 *  to the host instead of calling the handler in-process. `identity.sessions.user_id` is `on delete
 *  cascade` — `teardownActor` deletes the user and the session goes with it; no separate cleanup. */
export async function issueActorSession(pool: Pool, userId: string): Promise<string> {
  await ensureSessionLifetimeThreshold(pool);
  const session = await issueSession(userId);
  return session.token;
}

/** FK-safe teardown for one actor: `platform.idempotency_keys` before `identity.users`
 *  (Master decision 5) — `platform.audit_log` is never touched. */
export async function teardownActor(pool: Pool, userId: string): Promise<void> {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
}
