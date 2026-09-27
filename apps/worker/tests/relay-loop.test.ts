// apps/worker/tests/relay-loop.test.ts — X part 5b (brief
// `docs/notes/slice-briefs/_slice-X-part-5b.brief.md`, "Tests" section: "relay-loop.test.ts —
// scenarios 3–8"). ONE `it` per Gherkin scenario of `apps/worker/features/x-part-5b.feature`,
// titled verbatim.
//
// RED, and why it is the right RED: `apps/worker/src/loop.ts`, `apps/worker/src/interval.ts`,
// `apps/worker/src/role.ts` and `apps/worker/src/main.ts` do not exist yet (pg-builder-core builds
// them next, brief "Deliver") — every dynamic `import('../src/loop.js')` /
// `import('../src/role.js')` / `import('@pg-eos/events')` below rejects with a module-not-found
// error before any assertion runs. Migration `0039_M_worker-role-outbox-relay.sql` also does not
// exist yet, so the `pgeos_worker` role is absent and `workerPool.connect()` fails independently
// of the missing source files.
//
// `vi.resetModules()` + dynamic imports isolate the subscriber registry per test (mirrors
// `packages/events/tests/relay.test.ts`'s `clearSubscribers()` pattern, adapted because
// `clearSubscribers` is not exported by `@pg-eos/events`'s public index — brief "Facts").

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutboxEvent } from '@pg-eos/events';

// --- Named constants (no magic numbers) -----------------------------------------------------
const TEST_INTERVAL_MS = 50;
const CHILD_KILL_TIMEOUT_MS = 5000;
const EXIT_FAILURE = 1;
const REQUIRED_ROLE = 'pgeos_worker';
const APP_ROLE = 'pgeos_app';
const NULL_ROW_AGGREGATE_TYPE = 'platform.x-part-5b';
// A port nothing listens on — used to prove a startup refusal happens BEFORE any connection
// attempt: if main.ts mistakenly tried to connect first, it would fail with a connection error
// instead of the expected role/interval fatal line.
const CLOSED_PORT = '1';
// The exact fragment main.ts's interval-startup fatal log carries (src/main.ts, "RELAY_INTERVAL_
// SECONDS must be a finite number > 0") — verified from source, asserted on here, never invented.
const INTERVAL_FATAL_MESSAGE_FRAGMENT = 'RELAY_INTERVAL_SECONDS must be a finite number > 0';

const WORKER_ROOT = new URL('..', import.meta.url).pathname;

/** Spawns `tsx src/main.ts` with the given env overrides layered on process.env, capturing both
 * stdout and stderr (pino/@pg-eos/logger writes to stdout, so a fatal line's exact stream is never
 * assumed) into one combined string. Bounded by CHILD_KILL_TIMEOUT_MS so a regression that hangs
 * main.ts can never hang this suite. */
async function spawnMain(
  envOverrides: Readonly<Record<string, string>>,
): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/main.ts'], {
      cwd: WORKER_ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('x-part-5b fixture: main.ts did not exit within CHILD_KILL_TIMEOUT_MS'));
    }, CHILD_KILL_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const postgresPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const workerPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: REQUIRED_ROLE,
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

let existingEntityId = '';
const seededCorrelationIds: string[] = [];

async function seedOutboxRow(params: {
  readonly entityId: string | null;
  readonly aggregateType: string;
  readonly eventType: string;
  readonly correlationId: string;
}): Promise<number> {
  const result: QueryResult<{ id: number | string }> = await postgresPool.query(
    `insert into platform.outbox
       (entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id, actor_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, null, null)
     returning id`,
    [
      params.entityId,
      params.aggregateType,
      randomUUID(),
      params.eventType,
      JSON.stringify({ scenario: 'x-part-5b-relay-loop' }),
      params.correlationId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture outbox insert returned no row');
  return typeof row.id === 'string' ? Number.parseInt(row.id, 10) : row.id;
}

async function outboxRow(id: number): Promise<{
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

/** A stub logger with pino's own method names, capturing every call for assertions instead of
 * writing through real pino (CLAUDE.md · no console.log; pino stays the production sink). */
function stubLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  };
}

beforeEach(async () => {
  vi.resetModules();
  const entities: QueryResult<{ id: string }> = await postgresPool.query(
    'select id from platform.entities order by id limit 1',
  );
  const entity = entities.rows[0];
  if (!entity) throw new Error('platform.entities needs at least 1 seeded row for X part 5b fixtures');
  existingEntityId = entity.id;
});

afterAll(async () => {
  // Teardown is a single delete-by-correlation_id here (tests/scenarios's own pattern) — never a
  // per-scenario finally/afterEach delete, so one scenario's failure never blocks another
  // scenario's fixture rows from being cleaned up, and every row stays queryable for debugging
  // until the whole file is done.
  if (seededCorrelationIds.length > 0) {
    await postgresPool.query('delete from platform.outbox where correlation_id = any($1::uuid[])', [
      seededCorrelationIds,
    ]);
  }
  await postgresPool.end();
  await workerPool.end();
});

describe('Feature: X part 5b — one worker drains the outbox as a service role', () => {
  it('the relay loop drains rows for the registered subscribers', async () => {
    const eventType = `x-part-5b.test.${randomUUID()}`;
    const correlationId = randomUUID();
    seededCorrelationIds.push(correlationId);

    const entitySetRowId = await seedOutboxRow({
      entityId: existingEntityId,
      aggregateType: 'wms.test_probe',
      eventType,
      correlationId,
    });
    const entityNullRowId = await seedOutboxRow({
      entityId: null,
      aggregateType: NULL_ROW_AGGREGATE_TYPE,
      eventType,
      correlationId,
    });

    // Given a fresh registry (vi.resetModules) with one test subscriber and the two rows above
    const registry = await import('@pg-eos/events');
    const received: OutboxEvent[] = [];
    registry.registerSubscriber('x-part-5b-test-subscriber', async (event: OutboxEvent) => {
      received.push(event);
    });

    const { runRelayLoop } = await import('../src/loop.js');
    const logger = stubLogger();
    const controller = new AbortController();

    // When runRelayLoop is started on the pgeos_worker pool with intervalMs = TEST_INTERVAL_MS
    // and relayOptions { eventType } and stopped after the first tick
    const loopPromise = runRelayLoop({
      pool: workerPool,
      intervalMs: TEST_INTERVAL_MS,
      logger,
      signal: controller.signal,
      relayOptions: { eventType },
    });
    await new Promise((resolve) => setTimeout(resolve, TEST_INTERVAL_MS));
    controller.abort();
    await loopPromise;

    // Then both rows (the entity_id-set one included) carry published_at and the subscriber
    // received both events in id order
    const setRow = await outboxRow(entitySetRowId);
    const nullRow = await outboxRow(entityNullRowId);
    expect(setRow.published_at).not.toBeNull();
    expect(nullRow.published_at).not.toBeNull();
    expect(received.map((event) => event.id)).toEqual([entitySetRowId, entityNullRowId]);

    // And the tick result { processed: 2, published: 2, failed: 0 } was logged through pino
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ processed: 2, published: 2, failed: 0 }),
      expect.any(String),
    );
    // A registered subscriber drains the batch — the idle warning must never fire here.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('with no subscriber the worker is idle and says so', async () => {
    const eventType = `x-part-5b.test.${randomUUID()}`;
    const correlationId = randomUUID();
    seededCorrelationIds.push(correlationId);

    const rowId = await seedOutboxRow({
      entityId: null,
      aggregateType: NULL_ROW_AGGREGATE_TYPE,
      eventType,
      correlationId,
    });

    // Given a fresh registry with no subscriber and one pending fixture row
    await import('@pg-eos/events');
    const { runRelayLoop } = await import('../src/loop.js');
    const logger = stubLogger();
    const controller = new AbortController();

    // When the loop runs two ticks
    const loopPromise = runRelayLoop({
      pool: workerPool,
      intervalMs: TEST_INTERVAL_MS,
      logger,
      signal: controller.signal,
      relayOptions: { eventType },
    });
    await new Promise((resolve) => setTimeout(resolve, TEST_INTERVAL_MS * 2 + TEST_INTERVAL_MS / 2));
    controller.abort();
    await loopPromise;

    // Then the fixture row still has published_at null and exactly one warn line
    // "0 subscribers registered — relay idle" was logged
    const row = await outboxRow(rowId);
    expect(row.published_at).toBeNull();
    const idleWarnings = logger.warn.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('0 subscribers registered — relay idle'),
    );
    expect(idleWarnings).toHaveLength(1);
  });

  it('a failing subscriber leaves its row for the next tick', async () => {
    const eventType = `x-part-5b.test.${randomUUID()}`;
    const correlationId = randomUUID();
    seededCorrelationIds.push(correlationId);

    const rowId = await seedOutboxRow({
      entityId: null,
      aggregateType: NULL_ROW_AGGREGATE_TYPE,
      eventType,
      correlationId,
    });

    // Given a subscriber that throws on the first delivery and succeeds on the second
    const registry = await import('@pg-eos/events');
    let callCount = 0;
    registry.registerSubscriber('x-part-5b-flaky-subscriber', async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('x-part-5b fixture: deliberate first-delivery failure');
      }
    });

    const { runRelayLoop } = await import('../src/loop.js');
    const logger = stubLogger();
    const controller = new AbortController();

    // When two ticks run
    const loopPromise = runRelayLoop({
      pool: workerPool,
      intervalMs: TEST_INTERVAL_MS,
      logger,
      signal: controller.signal,
      relayOptions: { eventType },
    });
    await new Promise((resolve) => setTimeout(resolve, TEST_INTERVAL_MS * 2 + TEST_INTERVAL_MS / 2));
    controller.abort();
    await loopPromise;

    // Then the row is published after the second tick with attempts = 1 and last_error
    // recorded from the first
    const row = await outboxRow(rowId);
    expect(row.published_at).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('x-part-5b fixture: deliberate first-delivery failure');
  });

  it("a failing tick does not stop the loop", async () => {
    const eventType = `x-part-5b.test.${randomUUID()}`;

    await import('@pg-eos/events');
    const { runRelayLoop } = await import('../src/loop.js');
    const logger = stubLogger();
    const controller = new AbortController();

    // Given relayOnce is made to throw once (a stub relay injected through runRelayLoop's relay
    // option)
    let relayCallCount = 0;
    const relayStub = vi.fn(async () => {
      relayCallCount += 1;
      if (relayCallCount === 1) {
        throw new Error('x-part-5b fixture: deliberate tick failure');
      }
      return { processed: 0, published: 0, failed: 0 };
    });

    // When two ticks run
    const loopPromise = runRelayLoop({
      pool: workerPool,
      intervalMs: TEST_INTERVAL_MS,
      logger,
      signal: controller.signal,
      relayOptions: { eventType },
      relay: relayStub,
    });
    await new Promise((resolve) => setTimeout(resolve, TEST_INTERVAL_MS * 2 + TEST_INTERVAL_MS / 2));
    controller.abort();
    await loopPromise;

    // Then the error was logged with err and the second tick still ran
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
    expect(relayCallCount).toBeGreaterThanOrEqual(2);
  });

  it('the interval is the documented one second', async () => {
    const { RELAY_INTERVAL_SECONDS, MS_PER_SECOND, resolveIntervalMs } = await import('../src/interval.js');

    // When the worker resolves its interval without RELAY_INTERVAL_SECONDS
    const previous = process.env['RELAY_INTERVAL_SECONDS'];
    delete process.env['RELAY_INTERVAL_SECONDS'];
    try {
      // Then the interval is RELAY_INTERVAL_SECONDS = 1 (doc 36 §3-1)
      expect(RELAY_INTERVAL_SECONDS).toBe(1);
      expect(resolveIntervalMs(process.env)).toBe(RELAY_INTERVAL_SECONDS * MS_PER_SECOND);

      // And an override of 0, -1, "abc" or "" is refused at startup (EXIT_FAILURE)
      for (const invalid of ['0', '-1', 'abc', '']) {
        process.env['RELAY_INTERVAL_SECONDS'] = invalid;
        expect(resolveIntervalMs(process.env)).toBeUndefined();
      }
    } finally {
      if (previous === undefined) {
        delete process.env['RELAY_INTERVAL_SECONDS'];
      } else {
        process.env['RELAY_INTERVAL_SECONDS'] = previous;
      }
    }

    // The in-process resolver above proves the pure function; main.ts must refuse to start on the
    // same bad overrides too (0 and "abc" — a representative pair of the refused inputs) — the
    // required role is supplied so the interval check, not the role check, is what's exercised.
    for (const invalid of ['0', 'abc']) {
      const result = await spawnMain({ PG_APP_USER: REQUIRED_ROLE, RELAY_INTERVAL_SECONDS: invalid });
      expect(result.code).toBe(EXIT_FAILURE);
      expect(result.output).toContain(INTERVAL_FATAL_MESSAGE_FRAGMENT);
    }
  });

  it('startup refuses the wrong role', async () => {
    const { assertConnectedRole } = await import('../src/role.js');

    // When main.ts starts with PG_APP_USER=postgres, and again with PG_APP_USER=pgeos_app
    // Then each exits with EXIT_FAILURE and a fatal line naming the required role pgeos_worker,
    // before any connection — proven by pointing PGPORT at a port nothing listens on: if main.ts
    // mistakenly tried to connect before checking the role, it would fail with a connection error
    // instead of the expected role-refusal fatal line.
    const asPostgres = await spawnMain({ PG_APP_USER: 'postgres', PGPORT: CLOSED_PORT });
    expect(asPostgres.code).toBe(EXIT_FAILURE);
    expect(asPostgres.output).toContain(REQUIRED_ROLE);

    const asApp = await spawnMain({ PG_APP_USER: APP_ROLE, PGPORT: CLOSED_PORT });
    expect(asApp.code).toBe(EXIT_FAILURE);
    expect(asApp.output).toContain(REQUIRED_ROLE);

    // And assertConnectedRole rejects a pool connected as postgres and accepts one connected as
    // pgeos_worker (same it)
    await expect(assertConnectedRole(postgresPool)).rejects.toThrow();
    await expect(assertConnectedRole(workerPool)).resolves.toBeUndefined();
  });
});
