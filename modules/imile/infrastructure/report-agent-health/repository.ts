// modules/imile/infrastructure/report-agent-health/repository.ts — WBS 3.14.
//
// infrastructure/ layer: every DB statement for the report-agent-health use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/report-agent-health/ports.ts's `AgentHealthRepository`.
//
// LOCK ORDER: this use case takes NO row lock at all — imile.agent_health is an append-only
// heartbeat log (brief, Read ONLY list item 5), so there is no aggregate row to lock and no
// version to bump. Step 0 (the idempotency advisory lock + platform.idempotency_keys upsert,
// packages/db/src/idempotency.ts's withIdempotentContext) still runs first whenever the command's
// own input carries an `idem`, ahead of everything this file does — same discipline as the golden
// slice, minus the row-lock steps that do not apply here.

const AGENT_HEALTH_SCHEMA = 'imile';
const AGENT_HEALTH_TABLE_NAME = 'agent_health';
const AGENT_HEALTH_TABLE = `${AGENT_HEALTH_SCHEMA}.${AGENT_HEALTH_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { AgentHealthRepository, InsertAgentHealthParams, InsertedAgentHealthRow } from '../../application/report-agent-health/ports.js';

/** append-only INSERT — imile.agent_health has no version column, so there is no UPDATE path here
 *  at all. */
async function insertAgentHealth(
  tx: NodePgDatabase,
  params: InsertAgentHealthParams,
): Promise<InsertedAgentHealthRow> {
  const result = await tx.execute<{ id: string; reported_at: string }>(sql`
    insert into ${sql.raw(AGENT_HEALTH_TABLE)}
      (agent_id, session_valid, last_pull_at, pending_pushes, engine_version, error_message, reported_at)
    values
      (${params.agentId}, ${params.sessionValid}, ${params.lastPullAt?.toISOString() ?? null}::timestamptz,
       ${params.pendingPushes}, ${params.engineVersion}, ${params.errorMessage},
       ${params.reportedAt.toISOString()}::timestamptz)
    returning id, reported_at
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`insertAgentHealth: insert into ${AGENT_HEALTH_TABLE} returned no row`);
  }
  return { id: row.id, reportedAt: new Date(row.reported_at) };
}

/** doc 40 P3/P7: one append-only audit_log row. This call writes only this `platform.audit_log`
 *  row and the `imile.agent_health` row above — no `platform.outbox` row, for now: a heartbeat
 *  has no `entity_id` and is not a commercial/operational event of one entity, so it is not
 *  published to the outbox (G-01 gap, docs/notes/2026-09-24-imile-agent-scenario.md §4 row 'e').
 *  `entity_id` is always null — imile.agent_health carries no entity_id column (brief §2).
 *  `occurredAt` is mandatory (always from the injected Clock, never the column's own
 *  `default now()`). */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly recordId: string;
    readonly operation: string;
    readonly correlationId: string;
    readonly actorId: string;
    readonly newValue: unknown;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       null, ${AGENT_HEALTH_SCHEMA}, ${AGENT_HEALTH_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const agentHealthRepository: AgentHealthRepository = {
  insertAgentHealth,
  writeAuditRow,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export { AGENT_HEALTH_SCHEMA, AGENT_HEALTH_TABLE_NAME, AGENT_HEALTH_TABLE };
