// WBS 0.12 (pg-tester). RED phase: packages/events does not exist yet at all — no package.json,
// no src/**, no index.ts (only pg-backend builds those next, per the WBS 0.12 brief: "Write ONLY:
// packages/events/tests/**/*.test.ts"). Every import below fails to resolve. That import-resolution
// failure IS the correct RED for this task — same class of RED as WBS 0.11's packages/db suite
// (packages/db/tests/with-context.test.ts).
//
// Proves doc-38 acceptance criterion #1 of three: "Event written in same tx as state" — doc 40 §B3
// (docs/package/40-Build-Specification-EN.md:146-158, quoted in the WBS 0.12 brief): "The event is
// written in the same transaction as the state change — written or not written with the state,
// never a third case." Uses withContext(ctx, fn) from the already-built, already-proven @pg-eos/db
// package (WBS 0.11, commit e138ba2) exactly as its own contract requires — this suite does not
// re-prove withContext's transactionality (packages/db/tests/with-context.test.ts already does,
// exhaustively), it proves that writeOutboxEvent(tx, input), called INSIDE a withContext callback,
// participates in that same transaction: rolled back when the callback throws, committed when it
// resolves.
//
// platform.outbox DDL (database/schema/13B-Schema-Reference-Consolidation.sql:131-145, 1542-1553,
// quoted verbatim in the WBS 0.12 brief — not re-derived, not touched): id bigserial primary key,
// entity_id uuid references platform.entities(id) [nullable only for platform.*/identity.*
// aggregate_type, per check constraint outbox_business_needs_entity], aggregate_type text not null,
// aggregate_id uuid not null, event_type text not null, payload jsonb not null, correlation_id uuid
// not null, causation_id uuid, created_at timestamptz default now(), published_at timestamptz,
// attempts int default 0, last_error text, actor_id uuid.
//
// aggregate_type is prefixed 'platform.' throughout this file (`platform.test_probe`) specifically
// so entity_id can safely be null without needing a real seeded platform.entities row — per the
// WBS 0.12 brief's own guidance.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

// The public contract of the already-built @pg-eos/db package (WBS 0.11) — not part of this task,
// used exactly as-is.
import { withContext } from '@pg-eos/db';

// The package under test. packages/events/src/outbox.ts does not exist yet (WBS 0.12 RED) —
// pg-backend builds it next, to the exact contract in the WBS 0.12 brief's "PLANNED SHAPE" section.
import { writeOutboxEvent } from '../src/outbox.js';
import type { OutboxEventInput } from '../src/outbox.js';

// A plain, independent pg.Pool — genuinely separate from whatever withContext/writeOutboxEvent use
// internally — used ONLY to read back platform.outbox from outside the transaction under test. Same
// PG* env-var convention as packages/db/tests/with-context.test.ts and
// modules/platform/tests/integration/*.test.ts.
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

afterAll(async () => {
  await pool.end();
});

describe('writeOutboxEvent — the event row is written in the SAME transaction as the state change: rolled back with it, never a third case (WBS 0.12, doc 38 acceptance criterion #1)', () => {
  it('a row written via writeOutboxEvent(tx, ...) inside a withContext callback that then throws is NOT present in platform.outbox afterward — rolled back with everything else in that transaction', async () => {
    const correlationId = randomUUID();
    const aggregateId = randomUUID();
    const marker = new Error('intentional-throw-for-outbox-rollback-proof');

    const input: OutboxEventInput = {
      entityId: null,
      aggregateType: 'platform.test_probe',
      aggregateId,
      eventType: 'platform.test_probe.rollback_proof',
      payload: { probe: 'rollback', n: 1 },
      correlationId,
      causationId: null,
      actorId: null,
    };

    await expect(
      withContext({ userId: null, clientId: null, isInternal: true }, async (tx) => {
        const written = await writeOutboxEvent(tx, input);
        // Prove the write really happened (mid-transaction) before the throw below, so the throw
        // is a meaningful abort of real work, not a no-op that would make this test vacuously true.
        expect(written.id).toBeGreaterThan(0);
        throw marker;
      }),
    ).rejects.toBe(marker);

    const after: QueryResult<{ id: number }> = await pool.query(
      'select id from platform.outbox where correlation_id = $1',
      [correlationId],
    );
    expect(after.rows).toHaveLength(0);
  });

  it('a row written via writeOutboxEvent(tx, ...) inside a withContext callback that resolves normally IS present in platform.outbox afterward, with the fields it was written with', async () => {
    const correlationId = randomUUID();
    const aggregateId = randomUUID();
    const causationId = randomUUID();
    const actorId = randomUUID();
    let insertedId: number | undefined;

    const input: OutboxEventInput = {
      entityId: null,
      aggregateType: 'platform.test_probe',
      aggregateId,
      eventType: 'platform.test_probe.commit_proof',
      payload: { probe: 'commit', n: 2 },
      correlationId,
      causationId,
      actorId,
    };

    try {
      await withContext({ userId: null, clientId: null, isInternal: true }, async (tx) => {
        const written = await writeOutboxEvent(tx, input);
        insertedId = written.id;
        expect(written.id).toBeGreaterThan(0);
      });

      const after: QueryResult<{
        id: number;
        entity_id: string | null;
        aggregate_type: string;
        aggregate_id: string;
        event_type: string;
        payload: unknown;
        correlation_id: string;
        causation_id: string | null;
        actor_id: string | null;
        published_at: string | null;
        attempts: number;
      }> = await pool.query(
        `select id, entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id,
                causation_id, actor_id, published_at, attempts
           from platform.outbox where correlation_id = $1`,
        [correlationId],
      );
      expect(after.rows).toHaveLength(1);
      const row = after.rows[0];
      if (!row) {
        throw new Error('committed outbox row not found on independent read-back');
      }
      // platform.outbox.id is int8/bigserial; node-postgres returns it as a string by default
      // (round 2 of this review removed the process-wide pg.types override that used to mask this
      // — see packages/events/src/relay.ts's header). Parse locally for this one comparison, same
      // discipline pg-backend's fix applies inside the package itself.
      expect(Number(row.id)).toBe(insertedId);
      expect(row.entity_id).toBeNull();
      expect(row.aggregate_type).toBe('platform.test_probe');
      expect(row.aggregate_id).toBe(aggregateId);
      expect(row.event_type).toBe('platform.test_probe.commit_proof');
      expect(row.payload).toEqual({ probe: 'commit', n: 2 });
      expect(row.causation_id).toBe(causationId);
      expect(row.actor_id).toBe(actorId);
      // Freshly written, never yet relayed — outbox rows are transient event records (WBS 0.12
      // brief), not reference/config data, so this suite asserts the untouched-by-relay baseline
      // rather than restoring an "original value" the way WBS 0.10's thresholds tests do.
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(0);
    } finally {
      // Outbox rows are transient event records, not reference/config data — a straightforward
      // delete-in-finally is correct here (WBS 0.12 brief), no "restore original value" pattern.
      await pool.query('delete from platform.outbox where correlation_id = $1', [correlationId]);
    }
  });
});
