// modules/hr/infrastructure/confirm-commission/repository.ts — WBS 3.13 part 4.
//
// infrastructure/ layer: every DB statement for the confirm-commission use case, run against the
// `tx` a caller's own withIdempotentContext(ctx, idem, fn) already opened. Implements
// ../../application/confirm-commission/ports.ts's `CommissionDailyRepository`.
//
// RESOLVED (was a KNOWN GAP reported to the Master; SCR-HR-COMM-01 APPROVED, D-190, migration
// 0033): a DEL_SUP actor previously held no read-visibility permission over a commission_daily row
// that is not their own — `own_commission`'s SELECT policy is implicitly ANDed onto the
// row-visibility of ANY UPDATE targeting this table, not only a `RETURNING` clause, so this also
// blocked `updateToConfirmed` below for a non-owning DEL_SUP actor. Migration 0033 seeds the NEW
// `hr.driver_commission.read_all` permission to DEL_SUP (plus every role that already held
// `hr.commission.read_all`) and recreates `own_commission` to check it — DEL_SUP can now both SELECT
// and UPDATE another employee's row. The SEPARATE write authority for resolving a dispute
// (`disputed -> confirmed`) is the NEW `hr.commission.confirm` permission, checked here via
// `hasConfirmPermission` below. `isSelfReview`'s own read of `identity.users` was never affected by
// either gap (that table's own RLS is `internal_only`, no ownership restriction).

const COMMISSION_DAILY_TABLE = 'hr.commission_daily';
const THRESHOLDS_TABLE = 'platform.thresholds';
const USERS_TABLE = 'identity.users';
const AUDIT_ACTOR_TYPE_USER = 'user';

const DISPUTE_WINDOW_THRESHOLD_KEY = 'hr.commission.dispute_window_hours';
const CONFIRM_PERMISSION_CODE = 'hr.commission.confirm';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { CommissionDailyStatus } from '../../domain/dispute-commission/machine.js';
import type { CommissionDailyRepository, CommissionDailyRow } from '../../application/confirm-commission/ports.js';

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

async function getCommissionDailyById(tx: NodePgDatabase, id: string): Promise<CommissionDailyRow | null> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    status: string;
    employee_id: string;
    work_date: string;
    created_at: string;
    version: number;
    confirmed_by: string | null;
    confirmed_at: string | null;
    payroll_period: string | null;
  }>(sql`
    select id, entity_id, status, employee_id, work_date::text as work_date, created_at, version,
           confirmed_by, confirmed_at, payroll_period::text as payroll_period
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
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
    payrollPeriod: row.payroll_period,
  };
}

/** mirrors migration 0033's own DB-backstop trigger check exactly: an EXISTS check (employee_id
 *  carries no unique constraint on identity.users, so a naive single-row lookup could silently
 *  pick the wrong account). `identity.users`' own RLS (`internal_only`) has no ownership
 *  restriction, so this read is never blocked by the gap this file's own header describes. */
async function isSelfReview(
  tx: NodePgDatabase,
  params: { readonly confirmerUserId: string; readonly employeeId: string },
): Promise<boolean> {
  const result = await tx.execute<{ exists: boolean }>(sql`
    select exists (
      select 1 from ${sql.raw(USERS_TABLE)}
       where id = ${params.confirmerUserId}::uuid and employee_id = ${params.employeeId}::uuid
    ) as exists
  `);
  return result.rows[0]?.exists ?? false;
}

/** SCR-HR-COMM-01 (APPROVED, D-190) / migration 0033's own `hr.guard_commission_daily_status()`
 *  trigger, round-4 finding 3: `platform.has_perm()` is defined over `platform.current_user_id()`
 *  and takes no subject argument, so it reads the actor `withIdempotentContext` already bound to
 *  this transaction (`app.user_id`) — never a client-supplied id, same discipline as
 *  packages/identity/src/rbac.ts's own `hasPermission`. */
async function hasConfirmPermission(tx: NodePgDatabase): Promise<boolean> {
  const result = await tx.execute<{ granted: boolean }>(sql`
    select platform.has_perm(${CONFIRM_PERMISSION_CODE}) as granted
  `);
  return result.rows[0]?.granted ?? false;
}

async function updateToConfirmed(
  tx: NodePgDatabase,
  params: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly confirmedBy: string;
    readonly confirmedAt: Date;
    readonly payrollPeriod: string;
  },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update ${sql.raw(COMMISSION_DAILY_TABLE)}
       set status = 'confirmed',
           confirmed_by = ${params.confirmedBy}::uuid,
           confirmed_at = ${params.confirmedAt.toISOString()}::timestamptz,
           payroll_period = ${params.payrollPeriod}::date,
           version = version + 1
     where id = ${params.id}::uuid and version = ${params.expectedVersion}
  `);
  return (result.rowCount ?? 0) > 0;
}

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
  isSelfReview,
  hasConfirmPermission,
  updateToConfirmed,
  writeAuditRow,
};

export { COMMISSION_DAILY_TABLE };
