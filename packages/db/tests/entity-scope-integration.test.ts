// packages/db/tests/entity-scope-integration.test.ts — Master task P6b-1 (pg-tester), RED-first.
//
// Proves resolveActiveEntityId + the PRODUCTION createUserEntitiesLookup + WithContextCtx.entityId
// end-to-end against a REAL database: two real identity.users rows, each holding real
// identity.user_entities rows (seeded through the admin/superuser pool, bypassing RLS — same
// discipline as every other fixture in this codebase, e.g.
// tests/isolation/tests/client-isolation.test.ts's own `seedClient`), and a real write
// (platform.outbox — the one table every module already writes entity-scoped events to,
// packages/events/src/outbox.ts; its `entity_id` column is nullable, so no other fixture row is
// needed) whose `entity_id` is read back, from a SEPARATE connection, to equal the resolved entity.
//
// PRODUCTION SIGNATURE (confirmed from packages/db/src/entity-scope.ts, pg-backend's fix):
//   `createUserEntitiesLookup(ctx: WithContextCtx): UserEntitiesLookup` — SELF-CONTAINED: it opens
//   its OWN `withContext(ctx, ...)` session internally (never needs to be handed an already-open
//   `tx`) and reads `platform.allowed_entities()` — the SECURITY DEFINER function keyed on
//   `platform.current_user_id()` (i.e. `ctx.userId`, via the `app.user_id` GUC `withContext`
//   itself sets). The returned function FAILS CLOSED on a caller-supplied id that does not match
//   `ctx.userId` (throws, rather than silently reading the session's own scope for a different
//   id) — review round 1 finding 2's security fix.
//
// REVIEW ROUND 1 — this file's own findings:
//   - finding 4: NO hard-coded database name. The admin pool and `@pg-eos/db` both take
//     `PGDATABASE` from the environment as-is (falling back to 'pgeos', same default as
//     packages/db/src/client.ts) — CI sets `pgeos`, the Master sets `pgeos_p6b` locally; this file
//     does not choose or override either.
//   - finding 3: `createUserEntitiesLookup` — the PRODUCTION lookup `@pg-eos/db` exports — is
//     imported dynamically (after the env-derived connection constants are read, same ordering
//     discipline as tests/isolation/tests/client-isolation.test.ts) and exercised directly, running
//     as `PG_APP_USER=pgeos_app` (via its own internal `withContext` call) when that is set in the
//     environment (the Master's own run command sets it). Two things are proved: (a) the two-entity
//     set for user A, and (b) a cross-user case — bound to user A's own ctx, the lookup never
//     returns user B's entity, even when user B's id is passed as the argument: it REJECTS instead
//     (the production mismatch guard), so B's entities can never leak through A's session.
//   - finding 5 (D-183): no DELETE sweep in `beforeAll` — every fixture email carries its own
//     `randomUUID()` suffix, so two runs never collide on name alone, and there is nothing stale to
//     sweep. The written `platform.outbox` row's id is recorded in a module-level variable and
//     deleted ONLY in `afterAll`, which runs unconditionally (vitest always runs `afterAll` even
//     when an `it` above it threw) — never inline after the assertion, so a failed assertion can
//     never skip cleanup and leak the row.
//
// RED — none of this exists yet at the time this file was first written:
//   - `packages/db/src/entity-scope.ts` (resolveActiveEntityId, EntityScopeForbiddenError,
//     EntityScopeRequiredError, UserEntitiesLookup, createUserEntitiesLookup) — see
//     entity-scope.test.ts's header comment.
//   - `WithContextCtx.entityId` (packages/db/src/with-context.ts) — a new OPTIONAL field.

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '../src/with-context.js';

import { resolveActiveEntityId } from '../src/entity-scope.js';

// finding 4 — taken from the environment as-is, no override, no hard-coded database name.
const CONNECTION_HOST = process.env['PGHOST'] ?? 'localhost';
const CONNECTION_PORT = Number(process.env['PGPORT'] ?? '5432');
const CONNECTION_USER = process.env['PGUSER'] ?? 'postgres';
const CONNECTION_PASSWORD = process.env['PGPASSWORD'];
const CONNECTION_DATABASE = process.env['PGDATABASE'] ?? 'pgeos';

// Admin/superuser pool, pointed at whatever PGDATABASE already resolves to — used to seed and read
// back fixture rows, bypassing RLS (same discipline as every other fixture in this codebase).
const admin = new Pool({
  host: CONNECTION_HOST,
  port: CONNECTION_PORT,
  user: CONNECTION_USER,
  password: CONNECTION_PASSWORD,
  database: CONNECTION_DATABASE,
});

// Dynamic, after the env-derived constants above are read — same ordering discipline as
// tests/isolation/tests/client-isolation.test.ts (packages/db/src/client.ts builds its own `Pool`
// at MODULE LOAD time from process.env). Whether `createUserEntitiesLookup`'s own internal
// `withContext` call connects as `pgeos_app` depends on `PG_APP_USER` already being set in the
// environment when this file is loaded (the Master's own run command:
// `PGHOST=localhost PGUSER=postgres PGDATABASE=pgeos_p6b PG_APP_USER=pgeos_app`) — this file does
// not set it itself (finding 4's "no override" discipline extends to this var too).
const { withContext } = await import('../src/with-context.js');
const { createUserEntitiesLookup } = await import('../src/entity-scope.js');

function firstRow<T extends QueryResultRow>(result: QueryResult<T>, what: string): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`${what}: query returned no rows where at least one was expected`);
  }
  return row;
}

async function resolveEntityId(code: string): Promise<string> {
  const result = await admin.query<{ id: string }>('select id from platform.entities where code = $1', [code]);
  return firstRow(result, `platform.entities lookup for code ${code}`).id;
}

const FIXTURE_EMAIL_PREFIX = 'p6b1-entity-scope-integration-test';

let userAId: string;
let userBId: string;
let entityA1: string;
let entityA2: string;
let entityB: string;
// finding 5 — recorded here, deleted ONLY in afterAll (never inline in the `it`), so a failed
// assertion above it can never skip cleanup.
let outboxRowId: string | undefined;

beforeAll(async () => {
  // Three real, already-seeded platform.entities rows (database/schema/019-Warehouse-WH1-Setup.sql /
  // 01-Data-Model.sql seed) — never invented ids.
  entityA1 = await resolveEntityId('PST');
  entityA2 = await resolveEntityId('PDL');
  entityB = await resolveEntityId('PCC');

  const userA = await admin.query<{ id: string }>(
    `insert into identity.users (email, full_name_ar, user_type) values ($1, $2, 'internal') returning id`,
    [`${FIXTURE_EMAIL_PREFIX}-a-${randomUUID()}@example.invalid`, 'مستخدم اختبار P6b-1 — كيانان (أ)'],
  );
  userAId = firstRow(userA, 'insert identity.users P6b-1 fixture (A)').id;
  await admin.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2), ($1, $3)`, [
    userAId,
    entityA1,
    entityA2,
  ]);

  const userB = await admin.query<{ id: string }>(
    `insert into identity.users (email, full_name_ar, user_type) values ($1, $2, 'internal') returning id`,
    [`${FIXTURE_EMAIL_PREFIX}-b-${randomUUID()}@example.invalid`, 'مستخدم اختبار P6b-1 — كيان واحد (ب)'],
  );
  userBId = firstRow(userB, 'insert identity.users P6b-1 fixture (B)').id;
  await admin.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userBId, entityB]);
});

afterAll(async () => {
  // finding 5 — runs unconditionally, regardless of any assertion failure above.
  try {
    if (outboxRowId) {
      await admin.query('delete from platform.outbox where id = $1', [outboxRowId]);
    }
  } finally {
    try {
      if (userAId) {
        await admin.query('delete from identity.user_entities where user_id = $1', [userAId]);
        await admin.query('delete from identity.users where id = $1', [userAId]);
      }
    } finally {
      try {
        if (userBId) {
          await admin.query('delete from identity.user_entities where user_id = $1', [userBId]);
          await admin.query('delete from identity.users where id = $1', [userBId]);
        }
      } finally {
        await admin.end();
      }
    }
  }
});

describe('P6b-1 — createUserEntitiesLookup (production), bound to a real ctx, returns exactly the caller\'s own seeded entities', () => {
  it("createUserEntitiesLookup({ userId: userA }) called with userA's own id returns user A's two seeded entities", async () => {
    const ctxA: WithContextCtx = { userId: userAId, clientId: null, isInternal: true };
    const lookup = createUserEntitiesLookup(ctxA);

    const entities = await lookup(userAId);

    expect([...entities].sort()).toEqual([entityA1, entityA2].sort());
  });

  it("createUserEntitiesLookup bound to user A's own ctx REJECTS when called with user B's id — user B's entity can never leak through A's session (review finding 3)", () => {
    const ctxA: WithContextCtx = { userId: userAId, clientId: null, isInternal: true };
    const lookup = createUserEntitiesLookup(ctxA);

    // The mismatch guard throws SYNCHRONOUSLY (before the returned function ever reaches
    // `withContext`) — `expect(() => ...).toThrow()`, not `expect(promise).rejects`, is the
    // correct matcher shape for that.
    expect(() => lookup(userBId)).toThrow();
  });
});

describe('P6b-1 — ctx.entityId, resolved via the production lookup, drives a real write (entity_id column)', () => {
  it('resolveActiveEntityId(header=entityA1) against the production lookup resolves entityA1, and a withContext write\'s platform.outbox row carries entity_id = entityA1', async () => {
    const ctxA: WithContextCtx = { userId: userAId, clientId: null, isInternal: true };
    const lookup = createUserEntitiesLookup(ctxA);

    const resolvedEntityId = await resolveActiveEntityId(entityA1, userAId, lookup);
    expect(resolvedEntityId).toBe(entityA1);

    const ctx: WithContextCtx = { userId: userAId, clientId: null, isInternal: true, entityId: resolvedEntityId };
    const correlationId = randomUUID();
    const aggregateId = randomUUID();

    const inserted = await withContext(ctx, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into platform.outbox (entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
        values (${ctx.entityId}, 'p6b1.entity-scope-test', ${aggregateId}, 'p6b1.entity-scope-test.written', '{}'::jsonb, ${correlationId})
        returning id::text as id
      `),
    );
    outboxRowId = firstRow(inserted, 'insert platform.outbox (P6b-1 wiring proof)').id;

    // Read back from a GUARANTEED separate connection (the admin pool) — proves the write is
    // durable and that entity_id really is what ctx.entityId resolved to.
    const readBack = await admin.query<{ entity_id: string }>(
      'select entity_id from platform.outbox where id = $1',
      [outboxRowId],
    );
    expect(firstRow(readBack, 'read back platform.outbox row').entity_id).toBe(entityA1);
  });
});
