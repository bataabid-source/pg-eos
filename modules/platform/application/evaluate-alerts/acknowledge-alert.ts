// modules/platform/application/evaluate-alerts/acknowledge-alert.ts — WBS 5.13 part 1.
//
// Note (INPUT-FIRST — deliberately different from the golden slice's ctx-first order, per the
// build brief): `acknowledgeAlert(input, ctx, deps)`.
//
// Guards BEFORE the transaction even opens (mirrors evaluateAlertRules and the golden slice's own
// approveInbound):
//   0a. RoleRequiredError — ctx.isInternal === false (platform.alert_log carries an
//       `internal_only` RLS policy keyed on platform.is_internal(); this is the proactive
//       application-layer guard mirroring it — pg-reviewer round-1 finding 7).
//   0b. MissingActorError — ctx.userId is null (every command's actor is ctx.userId ONLY; a null
//       one would otherwise write acknowledged_by/audit user_id as a silent NULL — golden slice's
//       own MissingActorError pattern, pg-reviewer round-1 finding 6).
//
// ONE withIdempotentContext transaction (step 0 — see packages/db/src/idempotency.ts — runs first
// when input.idem is set). Lock order:
//   1. platform.alert_log row lock, joined (read-only) to its platform.alert_rules row for
//      `ruleId` (repo.getAlertLogForUpdate) — throws AlertLogNotFoundError when no row is visible
//      (unknown id, or RLS hides it — finding 7) — + expectedVersion check -> StaleVersionError.
//   2. the row's current status is derived from acknowledged_at (null -> 'fired', else
//      'acknowledged') and asked of ../../domain/evaluate-alerts/machine.js — an offered
//      ACKNOWLEDGE edge drives the update; no edge -> AlertAlreadyAcknowledgedError (never a
//      silent no-op). Legality comes from the machine alone (CLAUDE.md · AGENT CONSTRAINTS: "No
//      if/switch for state transitions — XState").
//   3. the unconditional version bump (repo.acknowledgeAlertLog), on the row already locked in
//      step 1 — no new lock.
//   4. the audit row, last (ADR-0002 discipline, same as the golden slice's own commands).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import type {
  AcknowledgeAlertInput as ContractAcknowledgeAlertInput,
  AcknowledgeAlertResult,
} from '@pg-eos/contracts/platform/evaluate-alerts';

import { ALERT_LOG_EVENTS, ALERT_LOG_STATUS, canTransition } from '../../domain/evaluate-alerts/machine.js';
import {
  AlertAlreadyAcknowledgedError,
  MissingActorError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/evaluate-alerts/errors.js';
import type { EvaluateAlertsDeps } from './ports.js';

const AUDIT_OPERATION_ALERT_ACKNOWLEDGED = 'update'; // 13B ~L193 audit_log.operation list.
// platform.audit_log.record_id is nullable (13B ~L189) — platform.alert_rules.id dangling under
// table_name='alert_log' would not identify an alert_log row (pg-reviewer round-1 finding 5).
const AUDIT_RECORD_ID = null;

export interface AcknowledgeAlertInput extends ContractAcknowledgeAlertInput {
  readonly idem?: IdempotencyInput | undefined;
}

export type { AcknowledgeAlertResult };

export async function acknowledgeAlert(
  input: AcknowledgeAlertInput,
  ctx: WithContextCtx,
  deps: EvaluateAlertsDeps,
): Promise<AcknowledgeAlertResult> {
  if (!ctx.isInternal) {
    throw new RoleRequiredError(
      'AcknowledgeAlert requires an internal caller (platform.is_internal()). ' +
        '(Allowed: ctx.isInternal = true)',
    );
  }
  if (!ctx.userId) {
    throw new MissingActorError('AcknowledgeAlert requires ctx.userId. (Allowed: an authenticated caller)');
  }
  const actorId = ctx.userId;

  return withIdempotentContext<AcknowledgeAlertResult>(ctx, input.idem, async (tx) => {
    const row = await deps.repo.getAlertLogForUpdate(tx, input.alertLogId);

    if (row.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `AcknowledgeAlert: expectedVersion ${input.expectedVersion} no longer matches alert_log ` +
          `${input.alertLogId}'s version ${row.version} (optimistic lock). ` +
          `(Allowed: re-read alert_log ${input.alertLogId} and retry with version ${row.version})`,
      );
    }

    const currentStatus = row.acknowledgedAt === null ? ALERT_LOG_STATUS.FIRED : ALERT_LOG_STATUS.ACKNOWLEDGED;
    if (!canTransition(currentStatus, ALERT_LOG_EVENTS.ACKNOWLEDGE)) {
      throw new AlertAlreadyAcknowledgedError(
        `alert_log ${input.alertLogId} is already acknowledged — the machine offers no ACKNOWLEDGE ` +
          `edge from "${currentStatus}". (Allowed: acknowledge an unacknowledged alert only)`,
      );
    }

    const acknowledgedAt = deps.clock.now();
    const newVersion = await deps.repo.acknowledgeAlertLog(tx, {
      id: input.alertLogId,
      acknowledgedAt,
      acknowledgedBy: actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      recordId: AUDIT_RECORD_ID,
      operation: AUDIT_OPERATION_ALERT_ACKNOWLEDGED,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        id: row.id,
        acknowledgedAt: acknowledgedAt.toISOString(),
        acknowledgedBy: actorId,
        version: newVersion,
      },
      occurredAt: acknowledgedAt,
    });

    deps.logger.info(
      { correlationId: input.correlationId, alertLogId: row.id, version: newVersion },
      'acknowledge-alert: acknowledged',
    );

    return { alertLogId: row.id, version: newVersion };
  });
}
