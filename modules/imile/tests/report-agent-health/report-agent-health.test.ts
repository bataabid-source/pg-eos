// modules/imile/tests/report-agent-health/report-agent-health.test.ts — WBS 3.14.
//
// Integration tests, one per scenario in ./report-agent-health.feature, against the real database
// as pgeos_app. Sources: docs/package/40-Build-Specification-EN.md §C8, .claude/briefs/imile.brief.md,
// database/schema/01-Data-Model.sql:1426-1436, 13B-Schema-Reference-Consolidation.sql:2845-2850.
//
// Binding behaviour this suite asserts (RED until pg-backend's implementation lands):
//   - `imile.agent_health` has NO version column — it is an append-only heartbeat log, not a
//     mutable aggregate. Every ReportAgentHealth call INSERTs a new row; nothing is ever UPDATEd.
//     There is therefore no expectedVersion/StaleVersionError pattern in this slice (brief, Read
//     ONLY list item 5).
//   - "active session" is derived from the log itself, never held in server memory: the agentId of
//     the most-recently-inserted row (order by reported_at desc, id desc) IS the active session
//     FOR THAT AGENT'S OWN VIEW ONLY — there is no cross-agentId exclusivity rule. Reviewer finding
//     1 (2026-09-24, WBS 3.14 fix round): doc 40 §C8's "single session — any other login drops it"
//     describes ONE iMile account's OWN portal session, not exclusivity across agentIds. D-148/
//     D-149 (docs/notes/2026-09-24-imile-agent-scenario.md §5, §7) establish that several agentIds
//     (one station account, one per auditor, one per warehouse user) legitimately report
//     simultaneously; one must never supersede another. There is therefore no SessionSupersededError
//     in this slice and no "active session" exclusivity invariant to test.
//   - sessionValid=false requires a non-empty errorMessage -> SessionInvalidWithoutReasonError,
//     checked BEFORE any write.
//   - lastPullAt (if not null) must not be after reportedAt (= deps.clock.now() at call time) ->
//     LastPullInFutureError, checked BEFORE any write.
//   - pendingPushes < 0 is rejected by ReportAgentHealthInputSchema itself (contract boundary),
//     never reaches the command.
//   - Reviewer finding 2 (2026-09-24): the Master has deferred publishing
//     'imile.agent_health.reported' to platform.outbox for now (its aggregate has no entity_id; a
//     G-01 gap is filed, docs/notes/2026-09-24-imile-agent-scenario.md §4 row 'e'). The
//     packages/events/catalog.ts entry has been removed. Every scenario below therefore asserts
//     ZERO platform.outbox rows for its correlationId, not one.
//   - RLS: imile.agent_health is `internal_only` (13B-Schema-Reference-Consolidation.sql pattern
//     ②, `platform.is_internal()`) — a caller with ctx.isInternal=false sees zero rows on SELECT.
//     This suite exercises the READ path only; it makes no claim about write-permission under RLS
//     (no outsider-write scenario is in scope here).
//   - idempotency: the shared @pg-eos/db withIdempotentContext helper, same replay/conflict
//     contract as the golden slice (modules/wms/tests/receive-inbound/receive-inbound.test.ts).
//   - platform.alert_rules code 'N-01' (frozen, do not change) is a GLOBAL aggregate over the
//     WHOLE imile.agent_health table (`max(last_pull_at)`), not scoped per agentId — the two N-01
//     scenarios below therefore run their delete + insert + query in ONE transaction rolled back at
//     the end (reviewer finding 10, 2026-09-24): N-01's real query has no per-agent WHERE filter, so
//     a real `delete from imile.agent_health` against the shared table (no transaction) would
//     permanently destroy rows the concurrently-running 5.13 alert-evaluation suite depends on. A
//     rolled-back transaction is the faithful isolation: it never actually deletes anyone else's
//     rows. Ephemeral test database (CLAUDE.md TESTING / doc 36 §4-3 gate ③).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus a real
// identity.users row for the dedicated station-agent actor, same as
// modules/wms/tests/receive-inbound/receive-inbound.test.ts. PG_APP_USER=pgeos_app is REQUIRED to
// run this suite (every command call goes through withContext(ctx, fn) as pgeos_app, genuinely
// subject to RLS).

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test — do not exist yet (RED).
import { reportAgentHealth } from '../../application/report-agent-health/index.js';
import { createReportAgentHealthDeps } from '../../api/report-agent-health/composition.js';
import {
  LastPullInFutureError,
  SessionInvalidWithoutReasonError,
} from '../../domain/report-agent-health/errors.js';
import { ReportAgentHealthInputSchema } from '@pg-eos/contracts/imile/report-agent-health';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// pgeos_app-role pool — dedicated so the RLS test genuinely runs under RLS, not the admin
// connection.
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// 'imile.agent_health.reported' publication to platform.outbox is DEFERRED (reviewer finding 2,
// 2026-09-24) — no event-type constant is needed; every scenario asserts zero outbox rows for its
// correlationId, regardless of event_type.
const N01_ALERT_CODE = 'N-01';
const N01_ENTITY_REF = 'imile_agent';
const N01_STALE_THRESHOLD_MINUTES = 15; // doc 40 §C8 / 13B:2845-2850 (frozen).

const STATION_AGENT_ACTOR_UUID = '00000000-0000-4000-8000-0000000314a1';
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000314a2';

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(314);
const deps = createReportAgentHealthDeps({ clock, ids });

const internalCtx = { userId: STATION_AGENT_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: false };

const usedCorrelationIds = new Set<string>();
const usedAgentIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function freshAgentId(label: string): string {
  const agentId = `IMILE-STATION-${label}-${randomUUID()}`;
  usedAgentIds.add(agentId);
  return agentId;
}

// Test isolation only (not an assertion, not the tie-break itself): scenarios share one
// module-level FixedClock. Without an advance between scenarios, the LAST insert of one scenario
// and the FIRST insert of the next can land on the exact same reported_at, and
// `order by reported_at desc, id desc` then resolves the tie on a non-sequential DB-generated id.
// Every read now goes through `latestRowForAgent(agentId)`, filtered to one scenario's own
// freshly-generated agentId, so a same-reported_at collision with an unrelated scenario's DIFFERENT
// agentId can no longer make that unrelated row look "active" — but a collision could still make
// two rows of the SAME scenario's own agentId tie non-deterministically against each other.
// Advancing by 5s at the start of every scenario that reads latest-row state removes that residual
// risk by putting each scenario in its own disjoint reported_at window (well above the
// few-thousand-ms advances used *within* a scenario) while staying far below the N-01 alert rule's
// 15-minute staleness threshold (13B:2845-2850) so the "stale pull" scenario's clock-derived
// timestamp stays safely in the past relative to the database's real now(). Does not touch the
// `order by reported_at desc, id desc` tie-break or any application-level assertion.
const SCENARIO_CLOCK_STEP_MS = 5_000;
function beginScenario(): void {
  clock.advance(SCENARIO_CLOCK_STEP_MS);
}

/** sha256 hex of the canonical JSON body, the endpoint 'imile.report-agent-health.report',
 *  successStatus 200 — the same shape the api handlers build (golden-slice pattern). */
function idemFor(key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: 'imile.report-agent-health.report',
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function latestRowForAgent(agentId: string): Promise<{
  id: string;
  reported_at: Date;
  agent_id: string;
  session_valid: boolean;
  last_pull_at: Date | null;
  pending_pushes: number | null;
  engine_version: string | null;
  error_message: string | null;
} | undefined> {
  const result = await pool.query(
    `select id::text as id, reported_at, agent_id, session_valid, last_pull_at, pending_pushes, engine_version, error_message
       from imile.agent_health where agent_id = $1 order by reported_at desc, id desc limit 1`,
    [agentId],
  );
  return result.rows[0];
}

async function countRowsForAgent(agentId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from imile.agent_health where agent_id = $1`,
    [agentId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** ALL platform.outbox rows for a correlationId, regardless of event_type — 'imile.agent_health.
 *  reported' publication is deferred (reviewer finding 2), so every scenario below expects this to
 *  be empty. */
async function outboxRowsForCorrelation(correlationId: string): Promise<Array<{ id: string }>> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id::text as id from platform.outbox where correlation_id = $1`,
    [correlationId],
  );
  return result.rows;
}

async function createFixtureActor(userId: string): Promise<void> {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_imilehealth_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار صحة وكيل iMile — WBS 3.14'],
  );
}

beforeAll(async () => {
  await createFixtureActor(STATION_AGENT_ACTOR_UUID);
  await createFixtureActor(OUTSIDER_ACTOR_UUID);
});

afterAll(async () => {
  if (usedAgentIds.size > 0) {
    await pool.query(`delete from imile.agent_health where agent_id = any($1::text[])`, [[...usedAgentIds]]);
  }
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  for (const userId of [STATION_AGENT_ACTOR_UUID, OUTSIDER_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
  await appPool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/imile/report-agent-health — ReportAgentHealthInputSchema shape', () => {
  it('accepts the full valid shape from the brief', () => {
    const parsed = ReportAgentHealthInputSchema.parse({
      agentId: 'IMILE-STATION-01',
      sessionValid: true,
      lastPullAt: new Date().toISOString(),
      pendingPushes: 0,
      engineVersion: '1.0.0',
      correlationId: randomUUID(),
    });
    expect(parsed.agentId).toBe('IMILE-STATION-01');
  });

  it('rejects a negative pendingPushes before the command ever runs', () => {
    const result = ReportAgentHealthInputSchema.safeParse({
      agentId: 'IMILE-STATION-01',
      sessionValid: true,
      lastPullAt: null,
      pendingPushes: -1,
      engineVersion: '1.0.0',
      correlationId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });
});

// --- Scenario: first health report opens the active session -----------------------------------

describe('Scenario: first health report opens the active session', () => {
  it('writes a new imile.agent_health row and NO platform.outbox row (publication deferred, finding 2), and the agentId becomes active', async () => {
    beginScenario();
    const agentId = freshAgentId('FIRST');
    const correlationId = nextCorrelationId();

    const written = await reportAgentHealth(
      internalCtx,
      {
        agentId,
        sessionValid: true,
        lastPullAt: clock.now().toISOString(),
        pendingPushes: 0,
        engineVersion: '1.0.0',
        correlationId,
      },
      deps,
    );

    expect(await countRowsForAgent(agentId)).toBe(1);
    const latest = await latestRowForAgent(agentId);
    expect(latest?.id).toBe(written.id);
    const rows = await outboxRowsForCorrelation(correlationId);
    expect(rows).toHaveLength(0);
  });
});

// --- Scenario: a later report from the same agent extends the active session -------------------

describe('Scenario: a later report from the same agent extends the active session', () => {
  it('inserts a SECOND row (append-only — no update) and the session stays active for that agentId', async () => {
    beginScenario();
    const agentId = freshAgentId('EXTEND');
    await reportAgentHealth(
      internalCtx,
      { agentId, sessionValid: true, lastPullAt: clock.now().toISOString(), pendingPushes: 0, engineVersion: '1.0.0', correlationId: nextCorrelationId() },
      deps,
    );
    clock.advance(60_000);

    const second = await reportAgentHealth(
      internalCtx,
      { agentId, sessionValid: true, lastPullAt: clock.now().toISOString(), pendingPushes: 1, engineVersion: '1.0.0', correlationId: nextCorrelationId() },
      deps,
    );

    expect(await countRowsForAgent(agentId)).toBe(2);
    const latest = await latestRowForAgent(agentId);
    expect(latest?.id).toBe(second.id);
  });
});

// --- Scenario: an unhealthy report requires an error message -----------------------------------

describe('Scenario: an unhealthy report requires an error message', () => {
  it('rejects with SessionInvalidWithoutReasonError and writes nothing', async () => {
    beginScenario();
    const agentId = freshAgentId('NOREASON');

    await expect(
      reportAgentHealth(
        internalCtx,
        { agentId, sessionValid: false, lastPullAt: null, pendingPushes: 0, engineVersion: '1.0.0', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(SessionInvalidWithoutReasonError);

    expect(await countRowsForAgent(agentId)).toBe(0);
  });
});

// --- Scenario: an unhealthy report with a reason is accepted -----------------------------------

describe('Scenario: an unhealthy report with a reason is accepted', () => {
  it('writes the row with session_valid=false and the active session stays assigned to that agentId', async () => {
    beginScenario();
    const agentId = freshAgentId('WITHREASON');

    const written = await reportAgentHealth(
      internalCtx,
      {
        agentId,
        sessionValid: false,
        lastPullAt: null,
        pendingPushes: 0,
        engineVersion: '1.0.0',
        errorMessage: 'session token expired',
        correlationId: nextCorrelationId(),
      },
      deps,
    );

    const row = await latestRowForAgent(agentId);
    expect(row?.session_valid).toBe(false);
    expect(row?.id).toBe(written.id);
  });
});

// --- Scenario: pendingPushes must not be negative -----------------------------------------------

describe('Scenario: pendingPushes must not be negative', () => {
  it('rejected by the contract schema before the command runs', () => {
    const result = ReportAgentHealthInputSchema.safeParse({
      agentId: 'IMILE-STATION-NEG',
      sessionValid: true,
      lastPullAt: null,
      pendingPushes: -1,
      engineVersion: '1.0.0',
      correlationId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });
});

// --- Scenario: lastPullAt cannot be after reportedAt --------------------------------------------

describe('Scenario: lastPullAt cannot be after reportedAt', () => {
  it('rejects with LastPullInFutureError and writes nothing', async () => {
    beginScenario();
    const agentId = freshAgentId('FUTURE');
    const futurePull = new Date(clock.now().getTime() + 60_000).toISOString();

    await expect(
      reportAgentHealth(
        internalCtx,
        { agentId, sessionValid: true, lastPullAt: futurePull, pendingPushes: 0, engineVersion: '1.0.0', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(LastPullInFutureError);

    expect(await countRowsForAgent(agentId)).toBe(0);
  });
});

// --- Scenario: reports from two different agent accounts are both recorded independently ----------
// Reviewer finding 1 (2026-09-24): replaces the two removed "second login drops the first session" /
// "a late report from a superseded session is rejected" scenarios — there is no cross-agentId
// exclusivity rule (D-148/D-149, docs/notes/2026-09-24-imile-agent-scenario.md §5, §7: several
// agentIds — one station account, one per auditor, one per warehouse user — legitimately report at
// once).

describe('Scenario: reports from two different agent accounts are both recorded independently', () => {
  it('both rows are written and both are visible; neither call is rejected because of the other', async () => {
    beginScenario();
    const stationAgentId = freshAgentId('STATION-01');
    const auditorAgentId = freshAgentId('AUDITOR-07');

    await reportAgentHealth(
      internalCtx,
      { agentId: stationAgentId, sessionValid: true, lastPullAt: clock.now().toISOString(), pendingPushes: 0, engineVersion: '1.0.0', correlationId: nextCorrelationId() },
      deps,
    );
    clock.advance(1_000);

    // A DIFFERENT agentId reporting immediately after must NOT be rejected and must NOT erase the
    // first agent's own row — both coexist.
    await reportAgentHealth(
      internalCtx,
      { agentId: auditorAgentId, sessionValid: true, lastPullAt: clock.now().toISOString(), pendingPushes: 0, engineVersion: '1.0.0', correlationId: nextCorrelationId() },
      deps,
    );

    expect(await countRowsForAgent(stationAgentId)).toBe(1);
    expect(await countRowsForAgent(auditorAgentId)).toBe(1);
    const stationRow = await latestRowForAgent(stationAgentId);
    const auditorRow = await latestRowForAgent(auditorAgentId);
    expect(stationRow?.agent_id).toBe(stationAgentId);
    expect(auditorRow?.agent_id).toBe(auditorAgentId);

    // A further report from the FIRST agent afterwards is also accepted — never rejected because
    // another agentId reported in between.
    clock.advance(1_000);
    await reportAgentHealth(
      internalCtx,
      { agentId: stationAgentId, sessionValid: true, lastPullAt: clock.now().toISOString(), pendingPushes: 1, engineVersion: '1.0.0', correlationId: nextCorrelationId() },
      deps,
    );
    expect(await countRowsForAgent(stationAgentId)).toBe(2);
  });
});

// --- Scenario: RLS — outsider cannot read agent_health --------------------------------------------

describe('Scenario: RLS — a caller outside the internal roles cannot read agent_health', () => {
  it('an isInternal=false session sees zero rows even though rows exist', async () => {
    beginScenario();
    const agentId = freshAgentId('RLS');
    await reportAgentHealth(
      internalCtx,
      { agentId, sessionValid: true, lastPullAt: clock.now().toISOString(), pendingPushes: 0, engineVersion: '1.0.0', correlationId: nextCorrelationId() },
      deps,
    );
    expect(await countRowsForAgent(agentId)).toBe(1); // visible on the admin pool.

    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [outsiderCtx.userId]);
      await client.query(`select set_config('app.client_id', null, true)`);
      await client.query(`select set_config('app.is_internal', 'false', true)`);
      const result = await client.query(`select * from imile.agent_health where agent_id = $1`, [agentId]);
      expect(result.rows).toHaveLength(0);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

// --- Scenario: idempotency -------------------------------------------------------------------------

describe('Scenario: ReportAgentHealth is idempotent', () => {
  it('the second call with the SAME key and body replays the stored result without a second insert', async () => {
    beginScenario();
    const agentId = freshAgentId('IDEM-REPLAY');
    const idemKey = `report-health-replay-${randomUUID()}`;
    const correlationId = nextCorrelationId();
    const body = {
      agentId,
      sessionValid: true,
      lastPullAt: clock.now().toISOString(),
      pendingPushes: 0,
      engineVersion: '1.0.0',
      correlationId,
    };

    const first = await reportAgentHealth(internalCtx, { ...body, idem: idemFor(idemKey, body) }, deps);
    expect(await countRowsForAgent(agentId)).toBe(1);

    const second = await reportAgentHealth(internalCtx, { ...body, idem: idemFor(idemKey, body) }, deps);
    expect(second).toEqual(first);

    expect(await countRowsForAgent(agentId)).toBe(1); // no second insert.
    expect(await outboxRowsForCorrelation(correlationId)).toHaveLength(0); // publication deferred (finding 2).
  });

  it('the same Idempotency-Key with a DIFFERENT body is rejected with IdempotencyConflictError (409)', async () => {
    beginScenario();
    const agentId = freshAgentId('IDEM-MISMATCH');
    const idemKey = `report-health-mismatch-${randomUUID()}`;
    const firstBody = {
      agentId,
      sessionValid: true,
      lastPullAt: clock.now().toISOString(),
      pendingPushes: 0,
      engineVersion: '1.0.0',
      correlationId: nextCorrelationId(),
    };
    await reportAgentHealth(internalCtx, { ...firstBody, idem: idemFor(idemKey, firstBody) }, deps);

    const differentBody = { ...firstBody, correlationId: nextCorrelationId() }; // different correlationId -> different hash.
    await expect(
      reportAgentHealth(internalCtx, { ...differentBody, idem: idemFor(idemKey, differentBody) }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- Scenario: N-01 alert rule (frozen) -------------------------------------------------------------

describe('Scenario: N-01 alert rule matches/does not match a stale pull (13B:2845-2850, frozen)', () => {
  async function n01SourceQuery(): Promise<string> {
    const result: QueryResult<{ source_query: string }> = await pool.query(
      `select source_query from platform.alert_rules where code = $1`,
      [N01_ALERT_CODE],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`platform.alert_rules row not found for code ${N01_ALERT_CODE}`);
    return row.source_query;
  }

  // N-01's source_query is `max(h.last_pull_at)` over the WHOLE table, with no per-agent WHERE
  // filter (frozen). Reviewer finding 10 (2026-09-24): a bare `delete from imile.agent_health`
  // against the shared table would permanently destroy rows the concurrently-running 5.13
  // alert-evaluation suite depends on. The faithful isolation is a transaction, BEGUN on its own
  // dedicated client, that deletes + inserts + runs N-01's own query, then ROLLS BACK — it clears
  // the table for the duration of this one query and never actually deletes anyone else's rows.
  async function withIsolatedAgentHealthTable<T>(
    fn: (client: import('pg').PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`delete from imile.agent_health`);
      return await fn(client);
    } finally {
      await client.query('rollback');
      client.release();
    }
  }

  it('a stale pull (last_pull_at older than 15 minutes) returns exactly one row for entity_ref "imile_agent"', async () => {
    await withIsolatedAgentHealthTable(async (client) => {
      const agentId = freshAgentId('N01-STALE');
      const staleAt = new Date(clock.now().getTime() - (N01_STALE_THRESHOLD_MINUTES + 5) * 60_000);
      await client.query(
        `insert into imile.agent_health (agent_id, session_valid, last_pull_at, pending_pushes, engine_version)
         values ($1, true, $2, 0, '1.0.0')`,
        [agentId, staleAt.toISOString()],
      );

      const sourceQuery = await n01SourceQuery();
      const result: QueryResult<{ entity_ref: string }> = await client.query(sourceQuery);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.entity_ref).toBe(N01_ENTITY_REF);
    });
  });

  it('a fresh pull (within the last 15 minutes) returns zero rows', async () => {
    await withIsolatedAgentHealthTable(async (client) => {
      const agentId = freshAgentId('N01-FRESH');
      await client.query(
        `insert into imile.agent_health (agent_id, session_valid, last_pull_at, pending_pushes, engine_version)
         values ($1, true, now(), 0, '1.0.0')`,
        [agentId],
      );

      const sourceQuery = await n01SourceQuery();
      const result = await client.query(sourceQuery);
      expect(result.rows).toHaveLength(0);
    });
  });
});
