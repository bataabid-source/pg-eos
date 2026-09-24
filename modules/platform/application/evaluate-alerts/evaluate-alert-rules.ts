// modules/platform/application/evaluate-alerts/evaluate-alert-rules.ts — WBS 5.13 part 1 (alert
// evaluation mechanism, doc 40 §B6 / doc 25 §1-§2).
//
// Note (INPUT-FIRST — deliberately different from the golden slice's ctx-first order, per the
// build brief): `evaluateAlertRules(input, ctx, deps)`.
//
// ONE withContext transaction (no `idem` — this is the pg-boss job body / internal trigger, never
// an HTTP write endpoint in part 1, so it carries no Idempotency-Key). Per rule:
//   1. RoleRequiredError up front (ctx.isInternal === false) — BEFORE the transaction even opens
//      (platform.alert_log / identity.user_roles both carry an `internal_only` RLS policy keyed
//      on platform.is_internal()).
//   2. load the rule(s): one by input.ruleCode, else every platform.alert_rules row — either way,
//      `shouldEvaluate` (is_active / muted_until) is the ONLY gate, so an explicitly-named
//      inactive rule (N-16) is fetched but never fires (doc 25 §1).
//   3. assertActionLinkPresent (doc 40 §B6) — before running the rule's own query.
//   4. skip the rule entirely when `rule.quietHours && isWithinQuietHours(...)` — N-01/N-03 have
//      quiet_hours = false and therefore always reach step 5 (doc 25 §1's only two exemptions).
//   5. execute rule.sourceQuery read-only, inside its OWN savepoint (repo.runSourceQueryReadOnly —
//      see infrastructure/evaluate-alerts/repository.ts for the two independent defenses). Its
//      first column is entity_ref; a null one is skipped with a warning (finding 17), never
//      stringified to the literal text "null".
//   6. per returned entity_ref: isDeduped(lastFiredAt, now, rule.dedupeWindowHours) skips it;
//      otherwise resolve recipients (static target_roles, part 1), insert the alert_log row, write
//      the outbox event and the audit row in the SAME transaction (doc 40 §B3 / G9) — ALL inside
//      one savepoint per rule, so a write failure for this rule never aborts the whole pass
//      (pg-reviewer round-1 finding 2) and never touches another rule's already-fired alerts.
//
// A rule's own failure (ActionLinkMissingError, a source_query error caught by the read-only
// savepoint, or a write error) is caught, logged via deps.logger.error, and recorded in the
// result's `failed` list — the pass itself still returns normally (doc 25 §1: "only THAT alert is
// not sent").

import { withContext, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  AlertFired,
  EvaluateAlertRulesInput,
  EvaluateAlertRulesResult,
} from '@pg-eos/contracts/platform/evaluate-alerts';

import {
  ALERT_QUIET_HOURS_TIMEZONE,
  assertActionLinkPresent,
  isDeduped,
  isWithinQuietHours,
  shouldEvaluate,
} from '../../domain/evaluate-alerts/invariants.js';
import { MissingActorError, RoleRequiredError } from '../../domain/evaluate-alerts/errors.js';
import type { AlertRuleRow, EvaluateAlertsDeps } from './ports.js';

export type { EvaluateAlertRulesInput, EvaluateAlertRulesResult, AlertFired };

const AUDIT_OPERATION_ALERT_FIRED = 'insert'; // 13B ~L193 audit_log.operation list — not 'alert_fired'.
const ALERT_FIRED_EVENT_TYPE: CatalogedEventType = 'platform.alert.fired';
const ALERT_RULES_AGGREGATE_TYPE = 'platform.alert_rules';
// platform.outbox.entity_id is nullable — platform.alert_rules is not entity-scoped (platform
// brief §2: alert_rules `entity_id: no`).
const ALERT_OUTBOX_ENTITY_ID = null;
// platform.audit_log.record_id is nullable (13B ~L189); platform.alert_rules.id dangling under
// table_name='alert_log' would not identify an alert_log row — always null (finding 5).
const AUDIT_RECORD_ID = null;
// Part 1 never dispatches a channel — nothing is delivered yet (N-01 has two channels, an
// arbitrary rule.channels[0] would misrepresent what actually happened). Part 2 records the real
// channel at dispatch time (finding 9).
const ALERT_LOG_CHANNEL = null;

async function loadCandidateRules(
  tx: NodePgDatabase,
  ruleCode: string | undefined,
  deps: EvaluateAlertsDeps,
): Promise<readonly AlertRuleRow[]> {
  if (ruleCode === undefined) return deps.repo.getAllRules(tx);
  const rule = await deps.repo.getRuleByCode(tx, ruleCode);
  return rule ? [rule] : [];
}

/** The innermost message of an error chain. Drizzle wraps a failed statement in a DrizzleQueryError
 *  whose own `message` is only "Failed query: …"; the Postgres text ("cannot execute nextval() in a
 *  read-only transaction") sits in `cause`. `failed[].reason` must carry the real cause (pg-reviewer
 *  round 2 finding 1 / round 3 Master fix, D-117 step). Bounded walk — a self-referential `cause`
 *  cannot loop it. */
const MAX_CAUSE_DEPTH = 8;
function reasonOf(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error && current.cause !== undefined; depth += 1) {
    current = current.cause;
    if (current instanceof Error && current.message.length > 0) message = current.message;
  }
  return message;
}

export async function evaluateAlertRules(
  input: EvaluateAlertRulesInput,
  ctx: WithContextCtx,
  deps: EvaluateAlertsDeps,
): Promise<EvaluateAlertRulesResult> {
  if (!ctx.isInternal) {
    throw new RoleRequiredError(
      'EvaluateAlertRules requires an internal caller (platform.is_internal()). ' +
        '(Allowed: ctx.isInternal = true)',
    );
  }
  if (!ctx.userId) {
    throw new MissingActorError('EvaluateAlertRules requires ctx.userId. (Allowed: an authenticated caller)');
  }

  return withContext(ctx, async (tx) => {
    const now = deps.clock.now();
    const candidateRules = await loadCandidateRules(tx, input.ruleCode, deps);

    const fired: AlertFired[] = [];
    const failed: Array<{ ruleCode: string; reason: string }> = [];
    let evaluated = 0;
    let deduped = 0;
    let quietSkipped = 0;

    for (const rule of candidateRules) {
      if (!shouldEvaluate({ isActive: rule.isActive, mutedUntil: rule.mutedUntil }, now)) continue;

      try {
        assertActionLinkPresent({ actionLabel: rule.actionLabel, actionLink: rule.actionLink });

        if (rule.quietHours && isWithinQuietHours(now, ALERT_QUIET_HOURS_TIMEZONE)) {
          quietSkipped += 1;
          continue;
        }

        const rawEntityRefs = await deps.repo.runSourceQueryReadOnly(tx, rule.sourceQuery);
        evaluated += 1;

        // One savepoint per rule for every write this rule's fired entity_refs need — a write
        // failure rolls back only THIS rule's alerts and is recorded in `failed`; every other
        // rule's already-written alerts, and every rule still to come, are unaffected
        // (pg-reviewer round-1 finding 2). The savepoint itself lives entirely behind the
        // repository port — the application layer issues no raw SQL (round-2 finding 3).
        // The per-rule counters are built INSIDE the savepoint and merged into the pass result
        // only after it releases: a write failure after a successful insert rolls back every row
        // of this rule, and the result must never name an alert_log id that no longer exists
        // (pg-reviewer round 3 finding 1, Master fix under D-117).
        const outcome = await deps.repo.withRuleSavepoint(tx, async () => {
          const ruleFired: AlertFired[] = [];
          let ruleDeduped = 0;
          for (const rawEntityRef of rawEntityRefs) {
            if (rawEntityRef === null) {
              deps.logger.warn(
                { ruleCode: rule.code, correlationId: input.correlationId },
                'evaluate-alert-rules: source_query returned a null entity_ref, skipping row',
              );
              continue;
            }
            const entityRef = rawEntityRef;

            const lastFiredAt = await deps.repo.getLastFiredAt(tx, rule.code, entityRef);
            if (isDeduped(lastFiredAt, now, rule.dedupeWindowHours)) {
              ruleDeduped += 1;
              continue;
            }

            const recipients = await deps.repo.resolveRecipients(tx, rule.targetRoles);

            const inserted = await deps.repo.insertAlertLog(tx, {
              ruleCode: rule.code,
              entityRef,
              firedAt: now,
              recipients,
              channel: ALERT_LOG_CHANNEL,
            });

            await writeOutboxEvent(tx, {
              entityId: ALERT_OUTBOX_ENTITY_ID,
              aggregateType: ALERT_RULES_AGGREGATE_TYPE,
              aggregateId: rule.id,
              eventType: ALERT_FIRED_EVENT_TYPE,
              payload: {
                alertLogId: inserted.id,
                ruleCode: rule.code,
                entityRef,
                recipients,
                firedAt: now.toISOString(),
              },
              correlationId: input.correlationId,
              actorId: ctx.userId,
            });

            await deps.repo.writeAuditRow(tx, {
              recordId: AUDIT_RECORD_ID,
              operation: AUDIT_OPERATION_ALERT_FIRED,
              correlationId: input.correlationId,
              actorId: ctx.userId,
              newValue: {
                id: inserted.id,
                ruleCode: rule.code,
                entityRef,
                firedAt: now.toISOString(),
                recipients,
                version: inserted.version,
              },
              occurredAt: now,
            });

            ruleFired.push({
              alertLogId: inserted.id,
              ruleCode: rule.code,
              entityRef,
              recipients: [...recipients],
              targetRoles: [...rule.targetRoles],
            });
          }
          return { ruleFired, ruleDeduped };
        });
        fired.push(...outcome.ruleFired);
        deduped += outcome.ruleDeduped;
      } catch (ruleError) {
        deps.logger.error(
          { ruleCode: rule.code, correlationId: input.correlationId, err: ruleError },
          'evaluate-alert-rules: rule failed, its alert(s) were not sent (doc 25 §1)',
        );
        failed.push({ ruleCode: rule.code, reason: reasonOf(ruleError) });
      }
    }

    deps.logger.info(
      { correlationId: input.correlationId, evaluated, fired: fired.length, deduped, quietSkipped, failed },
      'evaluate-alert-rules: pass complete',
    );

    return { fired, evaluated, deduped, quietSkipped, failed };
  });
}
