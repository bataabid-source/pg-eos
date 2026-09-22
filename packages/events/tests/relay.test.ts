// WBS 0.12 (pg-tester). RED phase: packages/events does not exist yet — see outbox-write.test.ts
// header for the full RED-phase rationale (same as WBS 0.11's packages/db suite). Every import
// below fails to resolve until pg-backend builds packages/events/src/relay.ts and
// packages/events/src/registry.ts, to the exact contract in the WBS 0.12 brief's "PLANNED SHAPE".
//
// Proves doc-38 acceptance criterion #2 of three: "relay at-least-once" — doc 40 §B3: "A relay
// publishes at-least-once." relayOnce(pool, opts) is infrastructure reading/writing
// platform.outbox directly (not business domain state), so it takes a plain node-postgres Pool and
// does NOT go through withContext — per the WBS 0.12 brief, this mirrors how packages/db's own
// internal client.ts/with-context.ts are exempt from the no-db-outside-withContext lint rule for
// the same reason.
//
// Seeded rows use aggregate_type = 'platform.test_probe' with entity_id null (outbox_business_needs_
// entity constraint, database/schema/13B-Schema-Reference-Consolidation.sql:1542-1553 — satisfied
// because the aggregate_type is prefixed 'platform.'). Each test uses its own event_type (unique per
// test run — see the "second pass" note below) and cleans up by the exact ids it seeded, not by
// event_type match (round-2-second-pass fix, below).
//
// REVIEW ROUND 2 FIX (pg-reviewer FAIL(16), finding 2): relay.ts's SELECT
// (`where published_at is null order by id limit $1`) was unscoped — no filter by event_type or
// aggregate_type. The "limit respected" test used to pass `limit: preExistingCount + 2`, which
// measured how many OTHER unrelated pending rows already existed in the shared dev database and
// sized the limit to cover them. That meant relayOnce swept up and permanently marked published
// EVERY pre-existing pending row in the database — not just this suite's own seeded rows — with
// only a no-op subscriber registered, silently "delivering to nobody" and losing real or other
// tests' pending events. "Measure, don't assume" was the WRONG mitigation: it proved the bug was
// contained for that one assertion, but every other relayOnce() call in this file was still
// capable of the same destructive sweep.
//
// THE REAL FIX: relayOnce(pool, opts) now accepts `opts.eventType`. When provided, the SQL WHERE
// clause adds an exact-match filter on event_type, so ONLY rows with that specific event_type are
// ever selected, touched, or published. Every relayOnce() call below now passes its test's own
// event_type string. No test needs to measure "how many other rows are pending" ever again.
//
// REVIEW ROUND 2, SECOND PASS FIX (pg-reviewer's re-review, finding 1): a hardcoded event_type
// string only prevents collision WITHIN one run — it does nothing against a concurrent session on
// this shared dev database (CLAUDE.md · PARALLEL LANES allows up to three) using the exact same
// string, which pg-reviewer reproduced live: a foreign row seeded with this suite's own hardcoded
// event_type was destroyed by this file's delete-by-event_type cleanup, and separately caused a
// false assertion failure. Every event_type below is now suffixed with a fresh randomUUID() per
// test run, making it session-unique, not just file-unique — genuinely unreachable by anything
// this run didn't seed itself.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// The package under test. Neither file exists yet (WBS 0.12 RED) — pg-backend builds both next.
import { relayOnce } from '../src/relay.js';
import { clearSubscribers, registerSubscriber } from '../src/registry.js';
import type { OutboxEvent } from '../src/registry.js';

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

// Isolation from any other test/file that may have registered subscribers — WBS 0.12 brief:
// clearSubscribers() is the test-only reset for exactly this purpose.
beforeEach(() => {
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
  // Number.parseInt() local to itself, per its "process-wide type-parser override" review finding,
  // rather than mutating pg.types for the whole process). Coerce explicitly here so every
  // comparison against relay.ts's own (genuinely numeric) OutboxEvent.id below is number-to-number,
  // never the string-vs-number mismatch that silently never matches.
  return Number(row.id);
}

describe('relayOnce — happy path: invokes every registered subscriber once per unpublished row and marks each row published (WBS 0.12, doc 38 "relay at-least-once")', () => {
  it('calls the subscriber once for each of the seeded rows, reports them as published, and sets published_at on all of them', async () => {
    const eventType = `platform.test_probe.relay_happy_path.${randomUUID()}`;
    const ids: number[] = [];

    try {
      ids.push(await seedOutboxRow(eventType, { n: 1 }));
      ids.push(await seedOutboxRow(eventType, { n: 2 }));
      ids.push(await seedOutboxRow(eventType, { n: 3 }));

      const received: OutboxEvent[] = [];
      registerSubscriber('relay-happy-path-subscriber', async (event) => {
        received.push(event);
      });

      const result = await relayOnce(pool, { limit: 10, eventType });

      const receivedForThisTest = received.filter((event) => ids.includes(event.id));
      expect(receivedForThisTest).toHaveLength(ids.length);
      expect(receivedForThisTest.map((event) => event.id).sort((a, b) => a - b)).toEqual(
        [...ids].sort((a, b) => a - b),
      );
      // Sanity: the events the subscriber actually saw match what was seeded, field for field.
      for (const event of receivedForThisTest) {
        expect(event.aggregateType).toBe('platform.test_probe');
        expect(event.eventType).toBe(eventType);
      }
      expect(result.published).toBeGreaterThanOrEqual(ids.length);

      const after: QueryResult<{ id: number; published_at: string | null }> = await pool.query(
        'select id, published_at from platform.outbox where id = any($1::bigint[])',
        [ids],
      );
      expect(after.rows).toHaveLength(ids.length);
      for (const row of after.rows) {
        expect(row.published_at).not.toBeNull();
      }
    } finally {
      // Delete by the exact ids this test seeded, not by event_type match (round-2-second-pass
      // fix, pg-reviewer's finding 1) — even a session-unique event_type is a weaker guarantee than
      // "the specific rows I inserted", and costs nothing extra here since `ids` is already known.
      await pool.query('delete from platform.outbox where id = any($1::bigint[])', [ids]);
    }
  });
});

describe('relayOnce — a row whose subscriber fails is retried on the NEXT relayOnce() call, not dropped: this IS the "at-least-once" mechanism (WBS 0.12, doc 38 "relay at-least-once")', () => {
  it('first call: subscriber throws, row stays unpublished, attempts increments by 1, last_error records the thrown message. Second call: subscriber is invoked again (redelivery) and succeeds, row becomes published', async () => {
    const eventType = `platform.test_probe.relay_retry_then_success.${randomUUID()}`;
    const errorMessage = 'intentional-subscriber-failure-for-retry-proof';
    let invocationCount = 0;

    const id = await seedOutboxRow(eventType, { attempt: 'expect-retry' });

    try {
      const baseline: QueryResult<{ attempts: number }> = await pool.query(
        'select attempts from platform.outbox where id = $1',
        [id],
      );
      const baselineAttempts = baseline.rows[0]?.attempts;
      if (baselineAttempts === undefined) {
        throw new Error('seeded row not found before first relayOnce call');
      }

      registerSubscriber('relay-retry-then-success-subscriber', async (event) => {
        if (event.id !== id) {
          return;
        }
        invocationCount += 1;
        if (invocationCount === 1) {
          throw new Error(errorMessage);
        }
      });

      const firstResult = await relayOnce(pool, { limit: 50, eventType });
      expect(invocationCount).toBe(1);
      expect(firstResult.failed).toBeGreaterThanOrEqual(1);

      const afterFirst: QueryResult<{
        published_at: string | null;
        attempts: number;
        last_error: string | null;
      }> = await pool.query(
        'select published_at, attempts, last_error from platform.outbox where id = $1',
        [id],
      );
      const rowAfterFirst = afterFirst.rows[0];
      if (!rowAfterFirst) {
        throw new Error('seeded row missing after first relayOnce call');
      }
      expect(rowAfterFirst.published_at).toBeNull();
      expect(rowAfterFirst.attempts).toBe(baselineAttempts + 1);
      expect(rowAfterFirst.last_error).toContain(errorMessage);

      const secondResult = await relayOnce(pool, { limit: 50, eventType });
      expect(invocationCount).toBe(2);
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

describe('relayOnce — respects the `limit` option rather than silently processing every unpublished row (WBS 0.12)', () => {
  it('seeding 3 unpublished rows, all sharing this test\'s own unique event_type, and calling relayOnce with { limit: 2, eventType } results in exactly 2 of our 3 rows being published and 1 left unpublished', async () => {
    const eventType = `platform.test_probe.relay_limit_respected.${randomUUID()}`;

    // The eventType filter (review round 2 fix, see file header) makes rows outside this test's
    // own seeded set unreachable by relayOnce, so there is nothing to measure or reason about:
    // exactly 3 rows exist that could ever match this call, no matter what else is pending in the
    // shared dev database.
    const ids: number[] = [];
    try {
      ids.push(await seedOutboxRow(eventType, { n: 1 }));
      ids.push(await seedOutboxRow(eventType, { n: 2 }));
      ids.push(await seedOutboxRow(eventType, { n: 3 }));

      registerSubscriber('relay-limit-respected-subscriber', async () => {
        // no-op — this test only cares about which rows relayOnce chooses to touch when `limit`
        // is smaller than the number of eligible rows, not about subscriber side effects.
      });

      const result = await relayOnce(pool, { limit: 2, eventType });
      expect(result.processed).toBe(2);

      const after: QueryResult<{ id: number; published_at: string | null }> = await pool.query(
        'select id, published_at from platform.outbox where id = any($1::bigint[]) order by id asc',
        [ids],
      );
      expect(after.rows).toHaveLength(3);
      const publishedOurs = after.rows.filter((row) => row.published_at !== null);
      const unpublishedOurs = after.rows.filter((row) => row.published_at === null);
      expect(publishedOurs).toHaveLength(2);
      expect(unpublishedOurs).toHaveLength(1);
    } finally {
      await pool.query('delete from platform.outbox where id = any($1::bigint[])', [ids]);
    }
  });
});

describe('relayOnce — zero registered subscribers is a safe no-op: it must NOT silently mark pending rows published to nobody (WBS 0.12, pg-reviewer FAIL(16) finding 1)', () => {
  it('with no subscriber registered at all, relayOnce({ eventType, limit }) reports processed/published/failed all 0 and leaves the seeded row\'s published_at untouched (still null)', async () => {
    const eventType = `platform.test_probe.relay_zero_subscribers.${randomUUID()}`;
    const id = await seedOutboxRow(eventType, { probe: 'zero-subscribers' });

    try {
      // clearSubscribers() already ran in beforeEach; this call is explicit and redundant on
      // purpose — this test's entire point is "no subscriber is registered", so it must not rely
      // on ordering with any other test to guarantee that.
      clearSubscribers();

      const result = await relayOnce(pool, { eventType, limit: 10 });

      // Before the review-round-2 fix, relay.ts's SELECT was unscoped by event_type and would
      // have selected this row (and every other pending row in the database), invoked zero
      // subscribers against it (vacuously "succeeding"), and marked it published — silently
      // delivering it to nobody and permanently losing it. These three assertions are exactly the
      // ones that fail against that old behavior: published would have been >= 1 and the row's
      // published_at would have been set.
      expect(result.processed).toBe(0);
      expect(result.published).toBe(0);
      expect(result.failed).toBe(0);

      const after: QueryResult<{ published_at: string | null }> = await pool.query(
        'select published_at from platform.outbox where id = $1',
        [id],
      );
      expect(after.rows[0]?.published_at).toBeNull();
    } finally {
      await pool.query('delete from platform.outbox where id = $1', [id]);
    }
  });
});
