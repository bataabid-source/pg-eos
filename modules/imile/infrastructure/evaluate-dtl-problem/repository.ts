// modules/imile/infrastructure/evaluate-dtl-problem/repository.ts — WBS 3.17 (part 1).
//
// infrastructure/ layer: every DB statement for the evaluate-dtl-problem use case, run against the
// `tx` a caller's own withIdempotentContext(ctx, idem, fn) already opened. Implements
// ../../application/evaluate-dtl-problem/ports.ts's `DtlProblemsRepository`.
//
// `insertDtlProblem` is append-only — imile.dtl_problems has no version column and this use case
// never updates a row (brief, Design: "No update path"). `auditor_decision`/`auditor_id`/
// `decided_at`/`actual_outcome`/`rule_was_correct`/`synced_to_imile_at`/`re_reviewed_at`/
// `re_review_agreed` all stay their column defaults (null) — never passed here. `closed_by` is
// always written as `null` (brief, Design: "Never sets closed_by").
//
// `writeAuditRow` follows the same doc 40 P3/P7 append-only platform.audit_log insert convention
// this module's other use cases already use — same hash-chain mechanism (a DB trigger,
// trg_audit_hash_chain; this file never computes a hash itself), kept as its own statement here,
// not imported from another use case (D-179 use-case isolation). `entity_id` is always null —
// imile.dtl_problems has no entity_id column (brief, Design; G-01 row filed in
// docs/notes/2026-09-24-imile-agent-scenario.md §4).

const DTL_PROBLEMS_SCHEMA = 'imile';
const DTL_PROBLEMS_TABLE_NAME = 'dtl_problems';
const DTL_PROBLEMS_TABLE = `${DTL_PROBLEMS_SCHEMA}.${DTL_PROBLEMS_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
// `closed_by` (text) is never set by this use case (brief, Design) — always null.
const CLOSED_BY_NEVER = null;

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { DtlProblemsRepository, InsertDtlProblemParams, InsertedDtlProblemRow } from '../../application/evaluate-dtl-problem/ports.js';

async function insertDtlProblem(
  tx: NodePgDatabase,
  params: InsertDtlProblemParams,
): Promise<InsertedDtlProblemRow> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${sql.raw(DTL_PROBLEMS_TABLE)}
      (tracking_no, raised_at, driver_code, problem_type, gate_result, engine_decision,
       engine_confidence, engine_reason, evidence_urls, customer_text, driver_text, closed_by)
    values
      (${params.trackingNo}, ${params.raisedAt.toISOString()}::timestamptz, ${params.driverCode},
       ${params.problemType}, ${JSON.stringify(params.gateResult)}::jsonb, ${params.engineDecision},
       ${params.engineConfidence}::numeric, ${params.engineReason},
       ${sql.param(params.evidenceUrls)}::text[], ${params.customerText}, ${params.driverText},
       ${CLOSED_BY_NEVER})
    returning id
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`insertDtlProblem: insert into ${DTL_PROBLEMS_TABLE} returned no row`);
  }
  return { id: row.id };
}

/** doc 40 P3/P7: one append-only audit_log row per imile.dtl_problems insert — `entity_id` is
 *  always null (imile.dtl_problems carries no such column; brief §2, G-01 row filed). */
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
       null, ${DTL_PROBLEMS_SCHEMA}, ${DTL_PROBLEMS_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const dtlProblemsRepository: DtlProblemsRepository = {
  insertDtlProblem,
  writeAuditRow,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export { DTL_PROBLEMS_SCHEMA, DTL_PROBLEMS_TABLE_NAME, DTL_PROBLEMS_TABLE };
