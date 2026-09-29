// modules/billing/application/accounting-periods/apply-period-reopen-decision.ts — WBS 4.19 (lane 2).
//
// application/ layer, INTERNAL (no contract route — called once the Decision Inbox records the
// approval), ONE withContext transaction (golden slice:
// modules/wms/application/receive-inbound/approve-inbound.ts). 4.19 pre-build review D9, in order:
//   (1) the decision must be a visible accounting_period_reopen decision, status 'decided',
//       decision 'approved' — IllegalPeriodTransitionError otherwise (REOPEN is not yet legal);
//   (2) SelfApprovalNotAllowedError if decided_by = context.requestedBy (SoD);
//   (3) RoleRequiredError if the session user is not decided_by, or lacks the approver role
//       platform.approval_chains names for the reopen request (D1 — data, never a literal);
//   (4) period-row lock; StaleVersionError if context.periodVersion <> the current version (a
//       decision is spent once the period moves on — no replay after a later close);
//   (5) the machine's REOPEN edge (closed -> open), the outbox row, the status change + version
//       bump, and the audit row, last — same transaction. The DB trigger
//       billing.guard_accounting_period() re-checks (1)-(4) itself (migration 0040).

import { withIdempotentContext, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import {
  IllegalPeriodTransitionError,
  MissingActorError,
  RoleRequiredError,
  SelfApprovalNotAllowedError,
  StaleVersionError,
} from '../../domain/accounting-periods/errors.js';
import { PERIOD_EVENTS, advancePeriodStatus, type PeriodStatus } from '../../domain/accounting-periods/machine.js';
import type { AccountingPeriodsDeps } from './ports.js';

const AUDIT_OPERATION_REOPEN = 'reopen';
const PERIODS_AGGREGATE_TYPE = 'billing.accounting_periods';
const REOPENED_EVENT_TYPE: CatalogedEventType = 'billing.accounting_period.reopened';
const DECISION_STATUS_DECIDED = 'decided';
const DECISION_APPROVED = 'approved';

export interface ApplyPeriodReopenDecisionInput {
  readonly decisionId: string;
  readonly correlationId: string;
}

export interface ApplyPeriodReopenDecisionResult {
  readonly version: number;
  readonly status: PeriodStatus;
}

export async function applyPeriodReopenDecision(
  ctx: WithContextCtx,
  input: ApplyPeriodReopenDecisionInput,
  deps: AccountingPeriodsDeps,
): Promise<ApplyPeriodReopenDecisionResult> {
  if (!ctx.userId) throw new MissingActorError('ApplyPeriodReopenDecision requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ApplyPeriodReopenDecisionResult>(ctx, undefined, async (tx) => {
    const decision = await deps.repo.getReopenDecision(tx, input.decisionId);
    if (!decision || decision.status !== DECISION_STATUS_DECIDED || decision.decision !== DECISION_APPROVED) {
      throw new IllegalPeriodTransitionError(
        `ApplyPeriodReopenDecision: decision ${input.decisionId} is not a decided, approved ` +
          `accounting_period_reopen decision. (Allowed: status '${DECISION_STATUS_DECIDED}', decision '${DECISION_APPROVED}')`,
      );
    }
    if (decision.decidedBy !== null && decision.decidedBy === decision.requestedBy) {
      throw new SelfApprovalNotAllowedError(
        `ApplyPeriodReopenDecision: decision ${input.decisionId} was decided by its own requester. ` +
          '(Allowed: an approver other than the requester)',
      );
    }
    if (decision.decidedBy !== actorId || !(await deps.repo.isReopenApprover(tx))) {
      throw new RoleRequiredError(
        `ApplyPeriodReopenDecision: the caller must be the decider of ${input.decisionId} and hold the ` +
          'approver role platform.approval_chains names for accounting_period_reopen.',
      );
    }

    const period = await deps.repo.getPeriodForUpdate(tx, decision.periodId);
    if (decision.periodVersion !== period.version) {
      throw new StaleVersionError(
        `ApplyPeriodReopenDecision: decision ${input.decisionId} was filed for version ` +
          `${decision.periodVersion} but period ${period.id} is at version ${period.version} (optimistic lock).`,
      );
    }

    const newStatus = advancePeriodStatus(period.status, [PERIOD_EVENTS.REOPEN]);
    const now = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: period.entityId,
      aggregateType: PERIODS_AGGREGATE_TYPE,
      aggregateId: period.id,
      eventType: REOPENED_EVENT_TYPE,
      payload: {
        periodId: period.id,
        decisionId: input.decisionId,
        startDate: period.startDate,
        endDate: period.endDate,
        status: newStatus,
      },
      correlationId: input.correlationId,
      actorId,
    });

    const newVersion = await deps.repo.updatePeriodStatus(tx, period.id, newStatus);

    await deps.repo.writeAuditRow(tx, {
      entityId: period.entityId,
      target: 'period',
      recordId: period.id,
      operation: AUDIT_OPERATION_REOPEN,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, decision_id: input.decisionId },
      occurredAt: now,
    });

    return { version: newVersion, status: newStatus };
  });
}
