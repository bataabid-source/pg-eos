// packages/events/src/outbox.ts — WBS 0.12.
//
// writeOutboxEvent(tx, input) — CLAUDE.md · ARCHITECTURE: "Domain events are written to
// platform.outbox IN THE SAME TRANSACTION as the state change." doc 40 §B3: "The event is written
// in the same transaction as the state change — written or not written with the state, never a
// third case."
//
// `tx` is the SAME scoped drizzle handle withContext(ctx, fn)'s callback receives
// (@pg-eos/db, WBS 0.11) — typed as `NodePgDatabase` to match exactly what packages/db's own
// with-context.ts passes to `fn`. writeOutboxEvent never opens its own transaction: it participates
// in whatever transaction `tx` is already inside, which is the entire mechanism that makes the
// same-transaction guarantee hold (proven by packages/events/tests/outbox-write.test.ts: a row
// written here is rolled back when the caller's withContext callback throws, and committed when it
// resolves).
//
// The payload is bound as a query parameter (drizzle's `sql` tagged template), never
// string-concatenated into the SQL text — same parameterization discipline
// packages/db/src/with-context.ts uses for its set_config(...) calls. Cast to jsonb in SQL, so a
// plain JSON-serializable JS value can be passed straight through.
//
// `id` (platform.outbox.id, bigserial/int8) is cast to text in the RETURNING clause
// (`returning id::text as id`) and parsed locally with Number.parseInt below, instead of relying
// on a process-wide node-postgres type-parser override — node-postgres's stock int8 parser returns
// a string because int8 can exceed Number.MAX_SAFE_INTEGER; casting to text and parsing here keeps
// that choice local to this call site rather than mutating pg.types for the whole process. This
// package's platform.outbox.id values are ordinary auto-incrementing row counters, well within
// Number.MAX_SAFE_INTEGER, so Number.parseInt is a correct, sufficient representation for this
// table specifically — not a general-purpose bigint policy.
//
// IMPORTANT — G9 guard obligation: writing this row does NOT satisfy G9 (doc 40 Part F) by itself.
// G9 requires every recent platform.outbox row to have a matching platform.audit_log row carrying
// the SAME correlation_id. writeOutboxEvent does not — and must not — write that audit_log row
// itself (audit_log's required fields vary per caller and are out of this function's scope). Every
// caller of writeOutboxEvent is responsible for ALSO writing a platform.audit_log row, in the same
// transaction, with input.correlationId, by whatever mechanism applies to that caller. Omitting
// this will make G9 go red.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface OutboxEventInput {
  readonly entityId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly actorId?: string | null;
}

/**
 * Writes one platform.outbox row inside the caller's already-open transaction (`tx`).
 *
 * Caller obligation (G9, doc 40 Part F): this function does NOT write the matching
 * platform.audit_log row that G9 requires (a recent platform.outbox row must have an
 * platform.audit_log row with the SAME correlation_id). The caller is responsible for ALSO
 * writing that audit_log row, in the same transaction, with `input.correlationId` — by whatever
 * mechanism applies to that caller — or G9 will go red. writeOutboxEvent's scope is the outbox row
 * only.
 */
export async function writeOutboxEvent(
  tx: NodePgDatabase,
  input: OutboxEventInput,
): Promise<{ id: number }> {
  const causationId = input.causationId ?? null;
  const actorId = input.actorId ?? null;

  const result = await tx.execute<{ id: string }>(sql`
    insert into platform.outbox
      (entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id, actor_id)
    values
      (
        ${input.entityId},
        ${input.aggregateType},
        ${input.aggregateId},
        ${input.eventType},
        ${JSON.stringify(input.payload)}::jsonb,
        ${input.correlationId},
        ${causationId},
        ${actorId}
      )
    returning id::text as id
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error('writeOutboxEvent: insert into platform.outbox returned no row');
  }
  return { id: Number.parseInt(row.id, 10) };
}
