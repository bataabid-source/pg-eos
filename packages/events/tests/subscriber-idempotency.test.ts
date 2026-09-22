// WBS 0.12 (pg-tester). RED phase: packages/events does not exist yet — see outbox-write.test.ts
// header for the full RED-phase rationale. Every import below fails to resolve until pg-backend
// builds packages/events/src/{registry,relay}.ts, to the exact contract in the WBS 0.12 brief's
// "PLANNED SHAPE".
//
// Proves doc-38 acceptance criterion #3 of three: "subscriber idempotent" — doc 40 §B3:
// "subscribers are idempotent by (event_id) [= the row's own `id`]." This is a property the
// SUBSCRIBER must have, not something relay.ts enforces on the subscriber's behalf (WBS 0.12
// brief) — relay.ts's job (proven in relay.test.ts) is only to guarantee at-least-once delivery,
// i.e. that a failed row gets redelivered rather than dropped. What makes that safe in the real
// world is that a well-behaved subscriber does not double-apply its effect when it sees the same
// event id twice. This file proves that property directly (a subscriber invoked twice with the
// same event applies its effect once) AND end-to-end, by reusing relay.test.ts's
// failure-then-redelivery shape with an idempotent subscriber standing in for a real one.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

// The package under test. Neither file exists yet (WBS 0.12 RED) — pg-backend builds both next.
import { relayOnce } from '../src/relay.js';
import { clearSubscribers, registerSubscriber } from '../src/registry.js';
import type { OutboxEvent, Subscriber } from '../src/registry.js';

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

// Isolation from any other test/file that may have registered subscribers.
afterEach(() => {
  clearSubscribers();
});

async function seedOutboxRow(eventType: string, payload: unknown): Promise<number> {
  const result: QueryResult<{ id: number | string }> = await pool.query(
    `insert into platform.outbox
       (entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id, actor_id)
     values (null, 'platform.test_probe', $1, $2, $3::jsonb, $4, null, null)
     returning id`,
    [randomUUID(), eventType, JSON.stringify(payload), randomUUID()],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`seedOutboxRow('${eventType}') insert returned no row`);
  }
  // platform.outbox.id is int8/bigserial: node-postgres returns it as a STRING by default (no
  // global type-parser override in this suite — relay.ts intentionally keeps its own id::text +
  // Number.parseInt() local to itself, rather than mutating pg.types for the whole process).
  // Coerce explicitly here so every comparison against relay.ts's own (genuinely numeric)
  // OutboxEvent.id below is number-to-number, never a silently-always-false string/number mismatch.
  return Number(row.id);
}

describe('subscriber idempotency — a subscriber that tracks processed event ids applies its observable effect exactly once even when invoked twice with the SAME event (WBS 0.12, doc 38 "subscriber idempotent")', () => {
  it('calling an idempotent subscriber directly with the same OutboxEvent object twice in a row applies the effect on the first call only, and no-ops on the repeat', async () => {
    // Session-unique, not just file-unique (WBS 0.12 review round 2, second pass, finding 1): a
    // hardcoded event_type only guards against collision within one run, not against a concurrent
    // worktree session on this shared dev database using the same string.
    const eventType = `platform.test_probe.idempotent_direct.${randomUUID()}`;
    const id = await seedOutboxRow(eventType, { probe: 'direct' });

    try {
      const processed = new Set<number>();
      let effectCount = 0;
      const idempotentSubscriber: Subscriber = async (event) => {
        if (processed.has(event.id)) {
          return;
        }
        processed.add(event.id);
        effectCount += 1;
      };

      // Registered per the WBS 0.12 brief's instructions, even though this test invokes the
      // function directly below rather than going through relayOnce — proving registerSubscriber
      // accepts it and that the direct-invocation contract (a plain (event) => Promise<void>
      // function) is what a caller can actually register.
      registerSubscriber('idempotent-direct-subscriber', idempotentSubscriber);

      const event: OutboxEvent = {
        id,
        entityId: null,
        aggregateType: 'platform.test_probe',
        aggregateId: randomUUID(),
        eventType,
        payload: { probe: 'direct' },
        correlationId: randomUUID(),
        causationId: null,
        createdAt: new Date(),
        actorId: null,
      };

      await idempotentSubscriber(event);
      await idempotentSubscriber(event);

      expect(effectCount).toBe(1);
    } finally {
      await pool.query('delete from platform.outbox where id = $1', [id]);
    }
  });
});

describe('subscriber idempotency — end-to-end via relay redelivery: an idempotent subscriber that applies its effect and THEN fails does not re-apply the effect when relayOnce redelivers the same row (WBS 0.12, real-world justification for "idempotent by event_id")', () => {
  it('effect applies on the first relayOnce() delivery (which then fails for an unrelated reason), and is NOT re-applied on the second relayOnce() delivery (redelivery) even though the subscriber function itself runs twice and succeeds the second time', async () => {
    const eventType = `platform.test_probe.idempotent_redelivery.${randomUUID()}`;
    const id = await seedOutboxRow(eventType, { probe: 'redelivery' });

    try {
      const processedIds = new Set<number>();
      const effects: number[] = [];
      let invocationCount = 0;

      registerSubscriber('idempotent-redelivery-subscriber', async (event) => {
        if (event.id !== id) {
          return;
        }
        invocationCount += 1;
        // The idempotency check: the effect is applied at most once per event id, no matter how
        // many times relayOnce invokes this subscriber for that id.
        if (!processedIds.has(event.id)) {
          processedIds.add(event.id);
          effects.push(event.id);
        }
        // Simulate "the side effect happened but something AFTER it failed" — on the first
        // delivery only, so the relay does not mark this row published and will redeliver it.
        if (invocationCount === 1) {
          throw new Error('intentional-failure-after-effect-applied-for-idempotency-proof');
        }
      });

      const firstResult = await relayOnce(pool, { limit: 50, eventType });
      expect(invocationCount).toBe(1);
      expect(effects).toHaveLength(1);
      expect(firstResult.failed).toBeGreaterThanOrEqual(1);

      const afterFirst: QueryResult<{ published_at: string | null }> = await pool.query(
        'select published_at from platform.outbox where id = $1',
        [id],
      );
      expect(afterFirst.rows[0]?.published_at).toBeNull();

      const secondResult = await relayOnce(pool, { limit: 50, eventType });
      expect(invocationCount).toBe(2);
      // The observable effect count is exactly 1 after BOTH relayOnce() calls, even though the
      // subscriber function itself was invoked twice — this is the real-world justification for
      // "subscribers are idempotent by (event_id)".
      expect(effects).toHaveLength(1);
      expect(secondResult.published).toBeGreaterThanOrEqual(1);

      const afterSecond: QueryResult<{ published_at: string | null }> = await pool.query(
        'select published_at from platform.outbox where id = $1',
        [id],
      );
      expect(afterSecond.rows[0]?.published_at).not.toBeNull();
    } finally {
      await pool.query('delete from platform.outbox where id = $1', [id]);
    }
  });
});
