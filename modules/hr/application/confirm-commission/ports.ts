// modules/hr/application/confirm-commission/ports.ts — WBS 3.13 part 4.
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: ConfirmCommissionDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/confirm-commission/repository.ts implements `CommissionDailyRepository`;
// ../../api/confirm-commission/composition.ts wires it.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { CommissionDailyStatus } from '../../domain/dispute-commission/machine.js';

// platform.thresholds key this use case reads at runtime — NEVER a magic `48` literal.
export const DISPUTE_WINDOW_THRESHOLD_KEY = 'hr.commission.dispute_window_hours';

export const AUDIT_OPERATION_UPDATE = 'update';

export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** The subset of an hr.commission_daily row ConfirmCommission needs to validate a confirmation — a
 *  plain SELECT, genuinely subject to the table's own `own_commission` RLS policy. */
export interface CommissionDailyRow {
  readonly id: string;
  readonly entityId: string;
  readonly status: CommissionDailyStatus;
  readonly employeeId: string;
  readonly workDate: string;
  readonly createdAt: Date;
  readonly version: number;
  /** round-1 review finding 7: the row's REAL prior values, read before the UPDATE, so the audit
   *  row's `old_value` never assumes a `calculated`/`disputed` row's `confirmed_by`/`confirmed_at`/
   *  `payroll_period` are null (the table's own CHECK constraints do not guarantee it,
   *  13-Schema-Additions.sql:381-383). */
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
  readonly payrollPeriod: string | null;
}

/** Every DB statement the confirm-commission use case needs, as an interface. Implemented by
 *  ../../infrastructure/confirm-commission/repository.ts. */
export interface CommissionDailyRepository {
  /** platform.thresholds `hr.commission.dispute_window_hours` (migration 0033). */
  getDisputeWindowHours(tx: NodePgDatabase): Promise<number>;

  /** `null` when no row is visible for `id`. */
  getCommissionDailyById(tx: NodePgDatabase, id: string): Promise<CommissionDailyRow | null>;

  /** brief decision 3 / migration 0033's own DB-backstop trigger check, mirrored here at the
   *  application layer so a real actor gets a typed `SelfReviewNotAllowedError` instead of the raw
   *  trigger rejection: `EXISTS (SELECT 1 FROM identity.users WHERE id = confirmerUserId AND
   *  employee_id = employeeId)` — an EXISTS check, never a naive single-row lookup (employee_id
   *  carries no unique constraint). */
  isSelfReview(
    tx: NodePgDatabase,
    params: { readonly confirmerUserId: string; readonly employeeId: string },
  ): Promise<boolean>;

  /** SCR-HR-COMM-01 (APPROVED, D-190) / migration 0033's own `hr.guard_commission_daily_status()`
   *  trigger, round-4 finding 3: does the CALLER (bound to `platform.current_user_id()`, i.e. the
   *  actor `withIdempotentContext` already set for this transaction — never a client-supplied id)
   *  hold `hr.commission.confirm`? Mirrored here so a real actor resolving a DISPUTE without the
   *  permission gets a typed `ConfirmPermissionRequiredError` instead of the trigger's own raw
   *  42501/insufficient_privilege rejection. `select platform.has_perm($1) as granted` — the same
   *  mechanism every other authorization check in this codebase uses (packages/identity/src/rbac.ts
   *  `hasPermission`). Callers scope this to the `disputed -> confirmed` edge only (brief/trigger:
   *  no document gates the plain window-expiry auto-confirm path on this permission). */
  hasConfirmPermission(tx: NodePgDatabase): Promise<boolean>;

  /** `UPDATE hr.commission_daily SET status='confirmed', confirmed_by=$, confirmed_at=$,
   *  payroll_period=$, version=version+1 WHERE id=$1 AND version=$2` — no RETURNING (same
   *  discipline as dispute-commission's own `updateToDisputed`). Returns `true` iff exactly one row
   *  was updated. */
  updateToConfirmed(
    tx: NodePgDatabase,
    params: {
      readonly id: string;
      readonly expectedVersion: number;
      readonly confirmedBy: string;
      readonly confirmedAt: Date;
      readonly payrollPeriod: string;
    },
  ): Promise<boolean>;

  writeAuditRow(
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
  ): Promise<void>;
}

export interface ConfirmCommissionDeps extends ClockDeps {
  readonly repo: CommissionDailyRepository;
  readonly logger: Logger;
}
