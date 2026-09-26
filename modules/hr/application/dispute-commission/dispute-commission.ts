// modules/hr/application/dispute-commission/dispute-commission.ts — WBS 3.13 part 4.
//
// ONE withIdempotentContext transaction (step 0 — see ../../../../packages/db/src/idempotency.ts —
// runs first when input.idem is set). Order (brief, Scenario/Deliver; round-1 review finding 2
// inserts step 2b):
//   1. read the target hr.commission_daily row (RLS-scoped `own_commission` SELECT policy — a row
//      invisible to the caller reads back `null`, treated the same as a stale/missing row —
//      StaleVersionError, this module's own PullShipments-precedent shape).
//   2. the shared commission-daily-status machine's own `canTransition` — DISPUTE only legal from
//      'calculated' (no if/switch on the status string, CLAUDE.md · ARCHITECTURE).
//   2b. SoD (round-1 review finding 2, SECURITY): the disputing actor must be the row's OWN
//      employee's own linked user — checked BEFORE the window check and BEFORE the write, so a
//      non-owning internal actor (DEL_SUP/SALES_MGR/CFO/GM, all visible via
//      `hr.driver_commission.read_all`) cannot raise a dispute on someone else's row and later
//      resolve their own dispute (ConfirmCommission's own SoD only checks the confirmer against the
//      row's OWN employee, not against who raised the dispute).
//   3. the 48-hour (platform.thresholds `hr.commission.dispute_window_hours`, NEVER a magic `48`)
//      dispute-window check — `isWithinDisputeWindow`; outside the window -> DisputeWindowExpiredError.
//   4. optimistic-lock UPDATE (`WHERE id=$1 AND version=$2`) — zero rows -> StaleVersionError.
//   5. ONE platform.audit_log row, `old_value` populated from the row's REAL prior values (round-1
//      review finding 7 — never an assumed null).
//   6. NO outbox event this slice (brief, Deliver names none for this command).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { isWithinDisputeWindow } from '../../domain/dispute-commission/invariants.js';
import { COMMISSION_DAILY_EVENTS, canTransition } from '../../domain/dispute-commission/machine.js';
import {
  CannotDisputeAnotherEmployeesRowError,
  DisputeWindowExpiredError,
  IllegalTransitionError,
  MissingActorError,
  StaleVersionError,
} from '../../domain/dispute-commission/errors.js';
import { AUDIT_OPERATION_UPDATE, type DisputeCommissionDeps } from './ports.js';

const COMMISSION_DAILY_SCHEMA = 'hr';
const COMMISSION_DAILY_TABLE_NAME = 'commission_daily';

export interface DisputeCommissionInput {
  readonly commissionDailyId: string;
  readonly disputeNote: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface DisputeCommissionResult {
  readonly commissionDailyId: string;
  readonly status: 'disputed';
}

export async function disputeCommission(
  ctx: WithContextCtx,
  input: DisputeCommissionInput,
  deps: DisputeCommissionDeps,
): Promise<DisputeCommissionResult> {
  // doc 40 P3/P7: every audit row this command writes needs an actor — ctx.userId ONLY, same
  // discipline as calculate-daily-commission/register-employee precedents.
  if (!ctx.userId) throw new MissingActorError('DisputeCommission requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<DisputeCommissionResult>(ctx, input.idem, async (tx) => {
    const occurredAt = deps.clock.now();

    const row = await deps.repo.getCommissionDailyById(tx, input.commissionDailyId);
    if (!row) {
      throw new StaleVersionError(
        `no hr.commission_daily row is visible for id ${input.commissionDailyId}. (Allowed: an ` +
          `existing, visible row.)`,
      );
    }

    // Step 2 — the machine decides legality, never an if/switch on the status string.
    if (!canTransition(row.status, COMMISSION_DAILY_EVENTS.DISPUTE)) {
      throw new IllegalTransitionError(
        `DISPUTE is not a legal transition from hr.commission_daily status "${row.status}" ` +
          `(id ${row.id}). (Allowed: only from "calculated".)`,
      );
    }

    // Step 2b — SoD: the disputing actor must be the row's own employee's own linked user.
    const ownRow = await deps.repo.isOwnRow(tx, {
      disputingUserId: actorId,
      employeeId: row.employeeId,
    });
    if (!ownRow) {
      throw new CannotDisputeAnotherEmployeesRowError(
        `ctx.userId ${actorId} is not the row's own employee's own linked user — an actor may only ` +
          `dispute their own commission (doc 10 §14 (l.300)). (Allowed: only the row's own employee.)`,
      );
    }

    // Step 3 — the 48-hour window, read from platform.thresholds, never a magic literal.
    const thresholdHours = await deps.repo.getDisputeWindowHours(tx);
    if (!isWithinDisputeWindow(row.createdAt, occurredAt, thresholdHours)) {
      throw new DisputeWindowExpiredError(
        `hr.commission_daily ${row.id}'s dispute window (${thresholdHours}h from ${row.createdAt.toISOString()}) ` +
          `has closed. (Allowed: dispute within the window only.)`,
      );
    }

    // Test-only seam (undefined in production): fires after the SELECT/checks above and before
    // the optimistic-lock UPDATE — same placement as pull-shipments.ts's own `onBeforeUpdate`.
    if (deps.onBeforeUpdate) {
      await deps.onBeforeUpdate();
    }

    // Step 4 — optimistic-lock UPDATE.
    const updated = await deps.repo.updateToDisputed(tx, {
      id: row.id,
      expectedVersion: row.version,
      disputeNote: input.disputeNote,
      disputedAt: occurredAt,
    });
    if (!updated) {
      throw new StaleVersionError(
        `hr.commission_daily ${row.id} was updated concurrently (expected version ${row.version}). ` +
          `(Allowed: retry with the row's fresh version.)`,
      );
    }

    // Step 5.
    await deps.repo.writeAuditRow(tx, {
      entityId: row.entityId,
      recordId: row.id,
      operation: AUDIT_OPERATION_UPDATE,
      correlationId: input.correlationId,
      actorId,
      oldValue: {
        status: row.status,
        disputeNote: row.disputeNote,
        disputedAt: row.disputedAt ? row.disputedAt.toISOString() : null,
      },
      newValue: { status: 'disputed', disputeNote: input.disputeNote, disputedAt: occurredAt.toISOString() },
      changedFields: ['status', 'dispute_note', 'disputed_at'],
      occurredAt,
    });

    return { commissionDailyId: row.id, status: 'disputed' };
  });
}

// REPLACE-ON-COPY: schema-qualified constants a later slice's copy must change.
export { COMMISSION_DAILY_SCHEMA, COMMISSION_DAILY_TABLE_NAME };
