// modules/hr/application/confirm-commission/confirm-commission.ts — WBS 3.13 part 4.
//
// ONE withIdempotentContext transaction (step 0). Order (brief, Scenario/Deliver):
//   1. read the target hr.commission_daily row (RLS-scoped `own_commission` SELECT policy — a row
//      invisible to the caller reads back `null` -> StaleVersionError).
//   2. the shared commission-daily-status machine's own `canTransition` — CONFIRM legal from
//      'calculated' (the window-expiry auto-confirm path) or 'disputed' (DEL_SUP resolves the
//      dispute); anything else -> IllegalTransitionError.
//   3. SoD (brief decision 3): the caller must not be the row's own employee's own linked user —
//      checked at the application layer BEFORE the write, so a real actor gets a typed
//      SelfReviewNotAllowedError instead of the DB-level `hr.guard_commission_daily_status()`
//      trigger's own raw rejection (migration 0033 — that trigger stays an independent backstop).
//   3b. when the row's own state carries the `requiresConfirmPermission` tag (exactly 'disputed' —
//      resolving an ACTIVE dispute, NOT the plain 'calculated' window-expiry auto-confirm path —
//      brief/migration 0033 round-4 finding 3, no document gates the auto-confirm path on this
//      permission; round-1 review finding 1: this is a state TAG read via the shared machine's own
//      `stateHasTag`, never an if/switch on the status string): the caller must hold
//      `hr.commission.confirm` (SCR-HR-COMM-01, APPROVED, D-190) — checked via
//      `platform.has_perm()`, mirrored here so a real actor gets a typed
//      ConfirmPermissionRequiredError instead of the DB trigger's own raw 42501/
//      insufficient_privilege rejection (the trigger stays an independent backstop).
//   4. when the row's own state carries the `requiresWindowElapsed` tag (exactly 'calculated'):
//      its own 48-hour dispute window (platform.thresholds `hr.commission.dispute_window_hours`,
//      NEVER a magic `48`) must have ELAPSED — confirming too early (skipping 'disputed' entirely)
//      is refused with DisputeWindowStillOpenError. A 'disputed' row carries no such tag (brief
//      decision 2 — a DEL_SUP reviewing an active dispute may confirm any time).
//   5. optimistic-lock UPDATE (`WHERE id=$1 AND version=$2`) — zero rows -> StaleVersionError.
//      `payroll_period` is set to the work_date's own month, first-of-month (brief decision 5) via
//      the domain/ invariant `payrollPeriodOf` (round-1 review finding 8 — a pure invariant with no
//      I/O, moved out of application/) — a plain string slice of the already-known `workDate`
//      (YYYY-MM-DD), never a `new Date()` construction.
//   6. ONE platform.audit_log row, `old_value` populated from the row's REAL prior values (round-1
//      review finding 7 — never an assumed null).
//   7. NO outbox event this slice (brief, Deliver names none for this command).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { payrollPeriodOf } from '../../domain/confirm-commission/invariants.js';
import { isWithinDisputeWindow } from '../../domain/dispute-commission/invariants.js';
import {
  COMMISSION_DAILY_EVENTS,
  COMMISSION_DAILY_TAGS,
  canTransition,
  stateHasTag,
} from '../../domain/dispute-commission/machine.js';
import {
  ConfirmPermissionRequiredError,
  DisputeWindowStillOpenError,
  IllegalTransitionError,
  MissingActorError,
  SelfReviewNotAllowedError,
  StaleVersionError,
} from '../../domain/confirm-commission/errors.js';
import { AUDIT_OPERATION_UPDATE, type ConfirmCommissionDeps } from './ports.js';

const COMMISSION_DAILY_SCHEMA = 'hr';
const COMMISSION_DAILY_TABLE_NAME = 'commission_daily';

export interface ConfirmCommissionInput {
  readonly commissionDailyId: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ConfirmCommissionResult {
  readonly commissionDailyId: string;
  readonly status: 'confirmed';
  readonly payrollPeriod: string;
}

export async function confirmCommission(
  ctx: WithContextCtx,
  input: ConfirmCommissionInput,
  deps: ConfirmCommissionDeps,
): Promise<ConfirmCommissionResult> {
  if (!ctx.userId) throw new MissingActorError('ConfirmCommission requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ConfirmCommissionResult>(ctx, input.idem, async (tx) => {
    const occurredAt = deps.clock.now();

    const row = await deps.repo.getCommissionDailyById(tx, input.commissionDailyId);
    if (!row) {
      throw new StaleVersionError(
        `no hr.commission_daily row is visible for id ${input.commissionDailyId}. (Allowed: an ` +
          `existing, visible row.)`,
      );
    }

    // Step 2 — the machine decides legality, never an if/switch on the status string.
    if (!canTransition(row.status, COMMISSION_DAILY_EVENTS.CONFIRM)) {
      throw new IllegalTransitionError(
        `CONFIRM is not a legal transition from hr.commission_daily status "${row.status}" ` +
          `(id ${row.id}). (Allowed: only from "calculated" or "disputed".)`,
      );
    }

    // Step 3 — SoD: the caller must not be the row's own employee's own linked user.
    const selfReview = await deps.repo.isSelfReview(tx, {
      confirmerUserId: actorId,
      employeeId: row.employeeId,
    });
    if (selfReview) {
      throw new SelfReviewNotAllowedError(
        `ctx.userId ${actorId} is the row's own employee's own linked user — a driver cannot ` +
          `confirm/resolve their own dispute (doc 10 §14 (l.300), DEL_SUP only). (Allowed: any ` +
          `non-owning internal actor.)`,
      );
    }

    // Step 3b — resolving an ACTIVE dispute ('disputed' -> 'confirmed') is DEL_SUP-only (doc 10
    // §14 (l.300)); scoped to exactly the state the shared machine tags `requiresConfirmPermission`
    // ('disputed' only — round-1 review finding 1: read via the machine's own state tag, never an
    // if/switch on the status string), never the plain 'calculated' window-expiry auto-confirm path
    // (migration 0033 round-4 finding 3 — no document gates that path on this permission).
    if (stateHasTag(row.status, COMMISSION_DAILY_TAGS.REQUIRES_CONFIRM_PERMISSION)) {
      const hasPermission = await deps.repo.hasConfirmPermission(tx);
      if (!hasPermission) {
        throw new ConfirmPermissionRequiredError(
          `ctx.userId ${actorId} does not hold hr.commission.confirm — resolving an active dispute ` +
            `(hr.commission_daily ${row.id}, disputed -> confirmed) requires the DEL_SUP write ` +
            `permission (doc 10 §14 (l.300), SCR-HR-COMM-01). (Allowed: a DEL_SUP actor holding ` +
            `hr.commission.confirm.)`,
        );
      }
    }

    // Step 4 — only for the state the shared machine tags `requiresWindowElapsed` ('calculated'
    // only — round-1 review finding 1): the window must have ELAPSED.
    if (stateHasTag(row.status, COMMISSION_DAILY_TAGS.REQUIRES_WINDOW_ELAPSED)) {
      const thresholdHours = await deps.repo.getDisputeWindowHours(tx);
      if (isWithinDisputeWindow(row.createdAt, occurredAt, thresholdHours)) {
        throw new DisputeWindowStillOpenError(
          `hr.commission_daily ${row.id}'s dispute window (${thresholdHours}h from ` +
            `${row.createdAt.toISOString()}) has not yet closed. (Allowed: confirm once the window ` +
            `elapses, or once it is 'disputed'.)`,
        );
      }
    }

    const payrollPeriod = payrollPeriodOf(row.workDate);

    // Step 5 — optimistic-lock UPDATE.
    const updated = await deps.repo.updateToConfirmed(tx, {
      id: row.id,
      expectedVersion: row.version,
      confirmedBy: actorId,
      confirmedAt: occurredAt,
      payrollPeriod,
    });
    if (!updated) {
      throw new StaleVersionError(
        `hr.commission_daily ${row.id} was updated concurrently (expected version ${row.version}). ` +
          `(Allowed: retry with the row's fresh version.)`,
      );
    }

    // Step 6.
    await deps.repo.writeAuditRow(tx, {
      entityId: row.entityId,
      recordId: row.id,
      operation: AUDIT_OPERATION_UPDATE,
      correlationId: input.correlationId,
      actorId,
      oldValue: {
        status: row.status,
        confirmedBy: row.confirmedBy,
        confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
        payrollPeriod: row.payrollPeriod,
      },
      newValue: {
        status: 'confirmed',
        confirmedBy: actorId,
        confirmedAt: occurredAt.toISOString(),
        payrollPeriod,
      },
      changedFields: ['status', 'confirmed_by', 'confirmed_at', 'payroll_period'],
      occurredAt,
    });

    return { commissionDailyId: row.id, status: 'confirmed', payrollPeriod };
  });
}

// REPLACE-ON-COPY: schema-qualified constants a later slice's copy must change.
export { COMMISSION_DAILY_SCHEMA, COMMISSION_DAILY_TABLE_NAME };
