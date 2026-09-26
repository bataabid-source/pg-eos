// modules/hr/infrastructure/dispute-commission/repository.ts — WBS 3.13 part 4.
//
// infrastructure/ layer: every DB statement for the dispute-commission use case, run against the
// `tx` a caller's own withIdempotentContext(ctx, idem, fn) already opened. Implements
// ../../application/dispute-commission/ports.ts's `CommissionDailyRepository`.
//
// RESOLVED (was a KNOWN GAP reported to the Master; SCR-HR-COMM-01 APPROVED, D-190, migration
// 0033): `getCommissionDailyById`'s own plain SELECT, and `updateToDisputed`'s own UPDATE, are BOTH
// genuinely subject to hr.commission_daily's `own_commission` SELECT policy — Postgres implicitly
// ANDs a table's SELECT policy onto the target-row visibility of an UPDATE (not only its own
// RETURNING clause). Migration 0033 seeds the NEW `hr.driver_commission.read_all` permission (plus
// every role that already held `hr.commission.read_all`) and recreates `own_commission` to check
// it OR the row's own employee — the disputing driver's own positive-path scenario (this use
// case's own actor IS the row's own employee) was always covered by `own_commission`'s ownership
// arm and is unaffected either way; this header now records the resolution for the module-wide
// read-visibility gap, not an open one.

const COMMISSION_DAILY_TABLE = 'hr.commission_daily';
const THRESHOLDS_TABLE = 'platform.thresholds';
const USERS_TABLE = 'identity.users';
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

// platform.thresholds key seeded by migration 0033.
const DISPUTE_WINDOW_THRESHOLD_KEY = 'hr.commission.dispute_window_hours';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { CommissionDailyStatus } from '../../domain/dispute-commission/machine.js';
import type { CommissionDailyRepository, CommissionDailyRow } from '../../application/dispute-commission/ports.js';

/** platform.thresholds `hr.commission.dispute_window_hours` (migration 0033) — read at runtime,
 *  NEVER hardcoded (CLAUDE.md · AGENT CONSTRAINTS). `reference_read`'s own RLS policy
 *  (`platform.is_internal()`) governs this table — no ownership restriction. */
async function getDisputeWindowHours(tx: NodePgDatabase): Promise<number> {
  const result = await tx.execute<{ value: string }>(sql`
    select value::text as value from ${sql.raw(THRESHOLDS_TABLE)} where key = ${DISPUTE_WINDOW_THRESHOLD_KEY}
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `platform.thresholds row '${DISPUTE_WINDOW_THRESHOLD_KEY}' not found — is migration 0033 applied?`,
    );
  }
  return Number(row.value);
}

/** `null` when no row is visible for `id` (does not exist, or `own_commission`'s own RLS policy
 *  hides it from the caller — see this file's own header). */
async function getCommissionDailyById(tx: NodePgDatabase, id: string): Promise<CommissionDailyRow | null> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    status: string;
    employee_id: string;
    work_date: string;
    created_at: string;
    version: number;
    dispute_note: string | null;
    disputed_at: string | null;
  }>(sql`
    select id, entity_id, status, employee_id, work_date::text as work_date, created_at, version,
           dispute_note, disputed_at
      from ${sql.raw(COMMISSION_DAILY_TABLE)}
     where id = ${id}::uuid
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    entityId: row.entity_id,
    status: row.status as CommissionDailyStatus,
    employeeId: row.employee_id,
    workDate: row.work_date,
    createdAt: new Date(row.created_at),
    version: row.version,
    disputeNote: row.dispute_note,
    disputedAt: row.disputed_at ? new Date(row.disputed_at) : null,
  };
}

/** round-1 review finding 2 (SECURITY) — mirrors ../confirm-commission/repository.ts's own
 *  `isSelfReview` EXISTS-check shape (employee_id carries no unique constraint on identity.users,
 *  so a naive single-row lookup could silently pick the wrong account); read for the OPPOSITE
 *  conclusion here (TRUE is required to proceed, not a blocker). */
async function isOwnRow(
  tx: NodePgDatabase,
  params: { readonly disputingUserId: string; readonly employeeId: string },
): Promise<boolean> {
  const result = await tx.execute<{ exists: boolean }>(sql`
    select exists (
      select 1 from ${sql.raw(USERS_TABLE)}
       where id = ${params.disputingUserId}::uuid and employee_id = ${params.employeeId}::uuid
    ) as exists
  `);
  return result.rows[0]?.exists ?? false;
}

/** `WHERE id=$1 AND version=$2` — no RETURNING (see this file's own header). Returns `true` iff
 *  exactly one row was updated. */
async function updateToDisputed(
  tx: NodePgDatabase,
  params: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly disputeNote: string;
    readonly disputedAt: Date;
  },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update ${sql.raw(COMMISSION_DAILY_TABLE)}
       set status = 'disputed',
           dispute_note = ${params.disputeNote},
           disputed_at = ${params.disputedAt.toISOString()}::timestamptz,
           version = version + 1
     where id = ${params.id}::uuid and version = ${params.expectedVersion}
  `);
  return (result.rowCount ?? 0) > 0;
}

/** doc 40 P3/P7: one append-only platform.audit_log row per write this use case performs — same
 *  hash-chain mechanism (a DB trigger, not application code) every prior slice already writes
 *  through its own `writeAuditRow`. */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly recordId: string;
    readonly operation: string;
    readonly correlationId: string;
    readonly actorId: string;
    readonly oldValue: unknown;
    readonly newValue: unknown;
    readonly changedFields: readonly string[];
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       changed_fields, old_value, new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, 'hr', 'commission_daily', ${params.recordId}::uuid, ${params.operation},
       ${sql.param(params.changedFields)}::text[], ${JSON.stringify(params.oldValue)}::jsonb,
       ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const commissionDailyRepository: CommissionDailyRepository = {
  getDisputeWindowHours,
  getCommissionDailyById,
  isOwnRow,
  updateToDisputed,
  writeAuditRow,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export { COMMISSION_DAILY_TABLE };
