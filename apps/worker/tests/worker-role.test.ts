// apps/worker/tests/worker-role.test.ts — X part 5b (brief
// `docs/notes/slice-briefs/_slice-X-part-5b.brief.md`, "Tests" section: "worker-role.test.ts —
// scenarios 1–2"). ONE `it` per Gherkin scenario of `apps/worker/features/x-part-5b.feature`,
// titled verbatim.
//
// RED, and why it is the right RED: migration `0039_M_worker-role-outbox-relay.sql` does not exist
// yet, so the `pgeos_worker` role does not exist — `workerPool.connect()` fails
// (`password authentication failed` / `role "pgeos_worker" does not exist`, depending on the
// cluster's auth config) before any assertion runs. `apps/worker/src/role.ts` also does not exist
// yet, so nothing in this file imports it directly (scenario 1/2 assert role/grant/RLS facts
// through raw SQL only, per the brief's Scenario block) — RED is carried entirely by the missing
// role and the missing migration's grants/policies, matching the brief's "Migration" §0039.
//
// Fixture style modelled on `apps/api/tests/server.test.ts` (env from process.env PG*, plain
// `pg.Pool`, correlation_id-scoped teardown, all deletes deferred to a single `afterAll`) — that
// sibling app's DB-backed test file was read as a style model OUTSIDE this brief's own Read ONLY
// list; the Master explicitly permitted the extra read and it is recorded in the CHANGELOG.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// PostgreSQL error code for insufficient_privilege (PG manual §Appendix A) — every GRANT-boundary
// assertion below expects exactly this code, never a generic "it threw" check.
const PG_INSUFFICIENT_PRIVILEGE = '42501';

const REQUIRED_ROLE = 'pgeos_worker';
const APP_ROLE = 'pgeos_app';

const DEFAULT_PG_PORT = '5432';
const POOL_MAX_TEST = 5;

// Fixture rows must never collide with another lane's or another run's rows on the shared dev
// database (CLAUDE.md · PARALLEL LANES) — every event_type is suffixed with a fresh randomUUID().
const FIXTURE_EVENT_TYPE = `x-part-5b.test.${randomUUID()}`;
const FIXTURE_CORRELATION_ID = randomUUID();

// The entity_id-null row's aggregate_type must satisfy `outbox_business_needs_entity`
// (13B:1651-1656): entity_id is null only admitted when split_part(aggregate_type, '.', 1) is
// 'platform' or 'identity'.
const NULL_ROW_AGGREGATE_TYPE = 'platform.x-part-5b';

const postgresPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? DEFAULT_PG_PORT),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: POOL_MAX_TEST,
});

const workerPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? DEFAULT_PG_PORT),
  user: REQUIRED_ROLE,
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: POOL_MAX_TEST,
});

const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? DEFAULT_PG_PORT),
  user: APP_ROLE,
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: POOL_MAX_TEST,
});

let existingEntityId = '';
let entitySetRowId = 0;

// Teardown is a single delete-by-correlation_id in afterAll (tests/scenarios's own pattern) —
// never a per-scenario finally/afterEach delete, so a scenario that fails mid-assertion never
// leaves the suite unable to clean up its own rows.
const seededCorrelationIds: string[] = [];

/** pg returns int8 (platform.outbox.id) as a string by default — every caller parses it the same
 * way (one id approach across both test files), rather than casting in SQL. */
function parseOutboxId(id: number | string): number {
  return typeof id === 'string' ? Number.parseInt(id, 10) : id;
}

async function seedOutboxRow(params: {
  readonly entityId: string | null;
  readonly aggregateType: string;
  readonly eventType?: string;
  readonly correlationId?: string;
}): Promise<number> {
  const correlationId = params.correlationId ?? FIXTURE_CORRELATION_ID;
  seededCorrelationIds.push(correlationId);
  const result: QueryResult<{ id: number | string }> = await postgresPool.query(
    `insert into platform.outbox
       (entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id, actor_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, null, null)
     returning id`,
    [
      params.entityId,
      params.aggregateType,
      randomUUID(),
      params.eventType ?? FIXTURE_EVENT_TYPE,
      JSON.stringify({ scenario: 'x-part-5b-worker-role' }),
      correlationId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture outbox insert returned no row');
  return parseOutboxId(row.id);
}

async function readOutboxRow(id: number): Promise<{
  readonly published_at: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
}> {
  const result: QueryResult<{ published_at: string | null; attempts: number; last_error: string | null }> =
    await postgresPool.query('select published_at, attempts, last_error from platform.outbox where id = $1', [id]);
  const row = result.rows[0];
  if (!row) throw new Error(`fixture outbox row ${id} missing`);
  return row;
}

beforeAll(async () => {
  // The entity_id-SET fixture row references an EXISTING platform.entities id, read by the
  // fixture, never inserted (FK 13B:1646, D-183).
  const entities: QueryResult<{ id: string }> = await postgresPool.query(
    'select id from platform.entities order by id limit 1',
  );
  const entity = entities.rows[0];
  if (!entity) throw new Error('platform.entities needs at least 1 seeded row for X part 5b fixtures');
  existingEntityId = entity.id;

  // Scenario 1 (below) only asserts on the entity_id-SET row (the row only outbox_relay_update
  // admits, per the feature file); the entity_id-null row is scenario 2's own fixture, seeded
  // there with its own event_type/correlation_id.
  entitySetRowId = await seedOutboxRow({ entityId: existingEntityId, aggregateType: 'wms.test_probe' });
});

afterAll(async () => {
  if (seededCorrelationIds.length > 0) {
    await postgresPool.query('delete from platform.outbox where correlation_id = any($1::uuid[])', [
      seededCorrelationIds,
    ]);
  }
  await postgresPool.end();
  await workerPool.end();
  await appPool.end();
});

describe('Feature: X part 5b — one worker drains the outbox as a service role', () => {
  it("the service role is a non-superuser with the relay's privileges only", async () => {
    // Given migration 0039 is applied
    // Then pg_roles shows pgeos_worker with rolsuper false, rolbypassrls false, rolcanlogin true
    const roleRow: QueryResult<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }> = await postgresPool.query(
      'select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = $1',
      [REQUIRED_ROLE],
    );
    expect(roleRow.rows[0]).toEqual({
      rolname: REQUIRED_ROLE,
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });

    // And pg_auth_members has no row with pgeos_worker as member or as role
    const membership: QueryResult<{ count: string }> = await postgresPool.query(
      `select count(*)::text as count from pg_auth_members
        where member = $1::regrole or roleid = $1::regrole`,
      [REQUIRED_ROLE],
    );
    expect(membership.rows[0]?.count).toBe('0');

    // And connected as pgeos_worker: select on platform.outbox and update of published_at,
    // attempts, last_error succeed on the entity_id-SET fixture row (the row only
    // outbox_relay_update admits)
    const selected: QueryResult<{ id: number | string }> = await workerPool.query(
      'select id from platform.outbox where id = $1',
      [entitySetRowId],
    );
    expect(selected.rows).toHaveLength(1);

    const lastError = 'x-part-5b fixture probe';
    const updateResult = await workerPool.query(
      'update platform.outbox set published_at = now(), attempts = attempts + 1, last_error = $2 where id = $1',
      [entitySetRowId, lastError],
    );
    // RLS filters an UPDATE's WHERE silently (a row a policy hides is simply not matched, never an
    // error) — asserting rowCount catches a policy/grant regression that would otherwise leave
    // this update a silent no-op instead of failing loudly.
    expect(updateResult.rowCount).toBe(1);

    // Read the written values back as postgres (bypasses RLS) to prove the update actually took
    // effect, not merely that it didn't throw.
    const afterUpdate = await readOutboxRow(entitySetRowId);
    expect(afterUpdate.published_at).not.toBeNull();
    expect(afterUpdate.attempts).toBe(1);
    expect(afterUpdate.last_error).toBe(lastError);

    // And update of payload (a non-granted column), insert, delete and truncate on
    // platform.outbox fail with 42501 — every probe runs inside its own savepoint on ONE
    // pgeos_worker client wrapped in begin … rollback, so a grant regression that unexpectedly
    // SUCCEEDS can never permanently destroy shared fixture/other-test data: the whole transaction
    // is rolled back at the end regardless of outcome.
    const client: PoolClient = await workerPool.connect();
    try {
      await client.query('begin');

      await client.query('savepoint probe_payload_update');
      await expect(
        client.query('update platform.outbox set payload = $2 where id = $1', [
          entitySetRowId,
          JSON.stringify({ tampered: true }),
        ]),
      ).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
      await client.query('rollback to savepoint probe_payload_update');

      await client.query('savepoint probe_insert');
      await expect(
        client.query(
          `insert into platform.outbox
             (entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id, actor_id)
           values (null, $1, $2, $3, '{}'::jsonb, $4, null, null)`,
          [NULL_ROW_AGGREGATE_TYPE, randomUUID(), FIXTURE_EVENT_TYPE, FIXTURE_CORRELATION_ID],
        ),
      ).rejects.toMatchObject({ code: PG_INSUFFICIENT_PRIVILEGE });
      await client.query('rollback to savepoint probe_insert');

      await client.query('savepoint probe_delete');
      await expect(client.query('delete from platform.outbox where id = $1', [entitySetRowId])).rejects.toMatchObject(
        { code: PG_INSUFFICIENT_PRIVILEGE },
      );
      await client.query('rollback to savepoint probe_delete');

      await client.query('savepoint probe_truncate');
      await expect(client.query('truncate platform.outbox')).rejects.toMatchObject({
        code: PG_INSUFFICIENT_PRIVILEGE,
      });
      await client.query('rollback to savepoint probe_truncate');
    } finally {
      await client.query('rollback');
      client.release();
    }

    // And select on platform.thresholds, identity.users, wms.inbound_orders and
    // platform.audit_log fails with 42501
    await expect(workerPool.query('select 1 from platform.thresholds limit 1')).rejects.toMatchObject({
      code: PG_INSUFFICIENT_PRIVILEGE,
    });
    await expect(workerPool.query('select 1 from identity.users limit 1')).rejects.toMatchObject({
      code: PG_INSUFFICIENT_PRIVILEGE,
    });
    await expect(workerPool.query('select 1 from wms.inbound_orders limit 1')).rejects.toMatchObject({
      code: PG_INSUFFICIENT_PRIVILEGE,
    });
    await expect(workerPool.query('select 1 from platform.audit_log limit 1')).rejects.toMatchObject({
      code: PG_INSUFFICIENT_PRIVILEGE,
    });

    // And select platform.purge_idempotency_keys() fails with 42501
    await expect(workerPool.query('select platform.purge_idempotency_keys()')).rejects.toMatchObject({
      code: PG_INSUFFICIENT_PRIVILEGE,
    });
  });

  it('RLS lets the worker see every pending row and nothing else changes for other roles', async () => {
    // Given two pending outbox rows of one fixture event_type, one with entity_id set and one
    // with entity_id null (written as postgres). Seeded with their OWN event_type/correlation_id
    // — never reused from scenario 1's fixture row, which scenario 1 publishes via its update
    // assertions (so it is no longer "pending"). Teardown is deferred to the module-level
    // afterAll — no per-scenario delete.
    const scenarioEventType = `x-part-5b.test.${randomUUID()}`;
    const scenarioCorrelationId = randomUUID();
    const scenarioEntitySetRowId = await seedOutboxRow({
      entityId: existingEntityId,
      aggregateType: 'wms.test_probe',
      eventType: scenarioEventType,
      correlationId: scenarioCorrelationId,
    });
    const scenarioEntityNullRowId = await seedOutboxRow({
      entityId: null,
      aggregateType: NULL_ROW_AGGREGATE_TYPE,
      eventType: scenarioEventType,
      correlationId: scenarioCorrelationId,
    });

    // When pgeos_worker selects the unpublished rows of that event_type
    // Then both rows are visible
    const workerView: QueryResult<{ id: number | string }> = await workerPool.query(
      'select id from platform.outbox where event_type = $1 and published_at is null order by id',
      [scenarioEventType],
    );
    expect(workerView.rows.map((row) => parseOutboxId(row.id))).toEqual(
      expect.arrayContaining([scenarioEntitySetRowId, scenarioEntityNullRowId]),
    );
    expect(workerView.rows).toHaveLength(2);

    // And connected as pgeos_app with no session GUCs, only the entity_id-null row of that
    // event_type is visible (entity_scope untouched)
    const appView: QueryResult<{ id: number | string }> = await appPool.query(
      'select id from platform.outbox where event_type = $1',
      [scenarioEventType],
    );
    expect(appView.rows.map((row) => parseOutboxId(row.id))).toEqual([scenarioEntityNullRowId]);
  });
});
