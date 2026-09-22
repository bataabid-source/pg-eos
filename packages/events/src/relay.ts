// packages/events/src/relay.ts — WBS 0.12.
//
// relayOnce(pool, opts) — doc 40 §B3: "A relay publishes at-least-once." Reads unpublished
// platform.outbox rows, invokes every currently-registered subscriber (registry.ts) for each row
// in order, and marks a row published only once every subscriber has succeeded for it. A row whose
// subscriber throws is left unpublished (attempts incremented, last_error recorded) so the NEXT
// relayOnce() call redelivers it — that redelivery, never dropping a row, IS the at-least-once
// mechanism (proven by tests/relay.test.ts's retry-then-success case).
//
// This is infrastructure reading/writing platform.outbox directly — not business domain state —
// so it takes a plain node-postgres `Pool` and does NOT go through withContext, mirroring how
// packages/db's own internal client.ts/with-context.ts are exempt from the
// no-db-outside-withContext lint rule for the same reason (WBS 0.12 brief). packages/events never
// imports @pg-eos/db's `db` export, so that lint rule never applies to this package regardless.
//
// Rows are processed sequentially (not Promise.all): a thrown error from one row's subscriber
// must not leave a later row's subscriber racing ahead, and subscribers for the SAME row are
// awaited one at a time and in registration order for the same reason.
//
// `id` (platform.outbox.id, bigserial/int8) is selected as `id::text` and parsed locally with
// Number.parseInt below, instead of relying on a process-wide node-postgres type-parser override —
// this keeps the int8-as-number decision local to this call site rather than mutating pg.types for
// the whole process. platform.outbox.id values are ordinary auto-incrementing row counters, well
// within Number.MAX_SAFE_INTEGER, so this remains a correct, sufficient representation.
//
// ZERO SUBSCRIBERS (Finding 1, review round 2): if no subscriber is currently registered,
// relayOnce returns { processed: 0, published: 0, failed: 0 } immediately and does NOT query
// platform.outbox at all — it must never mark a row published without having actually delivered it
// to anyone. Delivering to nobody and marking published anyway would be silent, permanent event
// loss.
//
// SCOPING (Finding 2, review round 2): relayOnce's SELECT is unscoped by default — with no
// `opts.eventType`, it sweeps every pending row in platform.outbox, which is the correct behavior
// for a real production relay with no reason to filter. `opts.eventType`, when provided, adds an
// exact-match `and event_type = $2` to the WHERE clause so a caller — most importantly a test —
// can scope a single relayOnce() call to rows it itself is responsible for, without touching
// unrelated pending rows that happen to share the table (a real risk on a shared dev database).
//
// CONCURRENCY (Finding 3, review round 2): relayOnce takes NO row lock (no `FOR UPDATE SKIP
// LOCKED`) and assumes a single caller/instance runs at a time. Running two relayOnce() calls
// concurrently against the same database — whether two overlapping invocations in one process or
// two separate relay instances — can select and process the SAME row in both before either has
// marked it published, causing double-delivery to subscribers for that row beyond what
// "at-least-once" already tolerates. Doc 40 describes the relay as a recurring job, so this is
// worth stating explicitly: adding `FOR UPDATE SKIP LOCKED` (or equivalent) for concurrent-instance
// safety is a known, deliberately deferred improvement, not built in this slice.
//
// RLS / SUPERUSER GAP (Finding 8, review round 2): relayOnce sets no GUCs and goes through no
// withContext call — it works today ONLY because the local dev connection is the `postgres`
// superuser, which bypasses RLS unconditionally (the same accepted gap WBS 0.11 documented for
// packages/db). This is a NEW, OPPOSITE-DIRECTION consequence of that gap, not the same one:
// platform.outbox has `force row level security` and the generic `entity_scope` policy
// (`entity_id is null or entity_id = any(platform.allowed_entities())`), and
// platform.allowed_entities() depends on current_user_id() — an authenticated human session's
// role/entity assignments, which a background relay process has no natural way to set. WBS 0.11's gap
// makes today's relayOnce accidentally WORK (superuser bypasses RLS entirely). The MOMENT that gap
// closes — a real, non-superuser application role is introduced for this connection — relayOnce
// will STOP working for every real business event: RLS will let it see only entity_id is null
// (platform-level) rows, and it will silently report processed: 0 for every actual business event,
// with no error. Do NOT fix this in this slice: a background-worker RLS access strategy (dedicated
// non-login role, bypass policy, service-account entity-membership scheme) is real security/
// architecture design work requiring a schema-change decision (G-01), not something to invent here.
// This paragraph exists so that future failure mode is discoverable before it happens silently.
//
// ATTEMPT CEILING (Finding 12, review round 2): `attempts` is tracked (incremented on every
// failure) but never capped, and there is no dead-letter mechanism. A row whose subscriber fails
// permanently is retried forever and, being selected first (`order by id`), can head-of-line-block
// a batch behind it. This is a deliberately deferred limitation for this slice's 3-clause
// acceptance criterion, not an oversight.

import type { Pool, QueryResult } from 'pg';

import type { OutboxEvent } from './registry.js';
import { listSubscribersWithNames } from './registry.js';

/** Default number of unpublished rows a single relayOnce() call processes when the caller does
 * not pass an explicit `limit`. A reasonable, documented batch size — not asserted on by any
 * test, which always passes an explicit limit. */
const DEFAULT_RELAY_LIMIT = 100;

export interface RelayResult {
  readonly processed: number;
  readonly published: number;
  readonly failed: number;
}

interface OutboxRow {
  readonly id: string;
  readonly entity_id: string | null;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly created_at: Date;
  readonly actor_id: string | null;
}

function toOutboxEvent(row: OutboxRow): OutboxEvent {
  return {
    id: Number.parseInt(row.id, 10),
    entityId: row.entity_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    createdAt: row.created_at,
    actorId: row.actor_id,
  };
}

export async function relayOnce(
  pool: Pool,
  opts?: { limit?: number; eventType?: string },
): Promise<RelayResult> {
  // Finding 1: zero registered subscribers means nobody can ever receive a delivery — return
  // immediately, without touching platform.outbox at all, rather than silently marking rows
  // published without having delivered them.
  const subscribers = listSubscribersWithNames();
  if (subscribers.length === 0) {
    return { processed: 0, published: 0, failed: 0 };
  }

  const limit = opts?.limit ?? DEFAULT_RELAY_LIMIT;

  const params: unknown[] = [limit];
  let eventTypeFilter = '';
  if (opts?.eventType !== undefined) {
    params.push(opts.eventType);
    eventTypeFilter = 'and event_type = $2';
  }

  const selected: QueryResult<OutboxRow> = await pool.query(
    `select id::text as id, entity_id, aggregate_type, aggregate_id, event_type, payload,
            correlation_id, causation_id, created_at, actor_id
       from platform.outbox
      where published_at is null
            ${eventTypeFilter}
      order by id
      limit $1`,
    params,
  );

  let published = 0;
  let failed = 0;

  // Finding 13: read the subscriber list once, before the loop, and reuse it for every row in
  // this batch — a subscriber registered mid-call must not see only some of the batch's rows.
  for (const row of selected.rows) {
    const event = toOutboxEvent(row);

    let didFail = false;
    let failure: unknown;
    let failedSubscriberName = '';
    for (const subscriber of subscribers) {
      try {
        await subscriber.handler(event);
      } catch (error) {
        didFail = true;
        failure = error;
        failedSubscriberName = subscriber.name;
        break;
      }
    }

    if (!didFail) {
      await pool.query('update platform.outbox set published_at = now() where id = $1', [row.id]);
      published += 1;
    } else {
      const message = failure instanceof Error ? failure.message : String(failure);
      await pool.query(
        'update platform.outbox set attempts = attempts + 1, last_error = $2 where id = $1',
        [row.id, `${failedSubscriberName}: ${message}`],
      );
      failed += 1;
    }
  }

  return { processed: selected.rows.length, published, failed };
}
