// tests/scenarios/fixtures/actors.ts — enablement item 3a (Master decision 7: roles WH_MGR +
// WH_SUP on the main actor; a second actor for CheckOrder with the same roles).
//
// Same identity.users / user_entities / user_roles seeding pattern as
// modules/wms/tests/receive-inbound/handlers.test.ts:110-171, parameterised over a per-run random
// actor id (never a fixed uuid — two concurrent runs of this same spec file never collide).

import { randomUUID } from 'node:crypto';

import type { Pool, QueryResult } from 'pg';

import { issueSession, SESSION_LIFETIME_MINUTES_KEY } from '@pg-eos/identity-mechanisms';

// X part 5d: issueSession needs OTP_HMAC_SECRET — set once for the whole run in
// tests/scenarios/playwright.config.ts (the test-only value apps/api's and packages/identity's
// vitest.config.ts already use), never here.

export const WH_MGR_ROLE_CODE = 'WH_MGR';
export const WH_SUP_ROLE_CODE = 'WH_SUP';
export const SCENARIO_ACTOR_ROLE_CODES = [WH_MGR_ROLE_CODE, WH_SUP_ROLE_CODE] as const;

// X part 5d (ADR-0006 Decision 2, GM D-203): migration 0045 seeds platform.thresholds
// identity.session.lifetime_minutes (issueSession throws without it — packages/identity/src/
// session.ts). This fixture NEVER writes platform.thresholds: it only reads the row and hard-fails
// if the migration is not applied. The seeded value is asserted by migration-0045.spec.ts, not here.
async function requireSessionLifetimeThreshold(pool: Pool): Promise<void> {
  const result: QueryResult<{ key: string }> = await pool.query(
    `select key from platform.thresholds where key = $1`,
    [SESSION_LIFETIME_MINUTES_KEY],
  );
  if (result.rows.length === 0) {
    throw new Error('platform.thresholds identity.session.lifetime_minutes missing — apply migration 0045 (D-203)');
  }
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
  await requireSessionLifetimeThreshold(pool);
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
