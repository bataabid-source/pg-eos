// packages/contracts/platform/evaluate-alerts.ts — WBS 5.13 part 1 (alert evaluation mechanism),
// replicated from the golden slice's contract (packages/contracts/wms/receive-inbound.ts).
//
// Zod input schemas for the evaluate-alerts use case's two commands. Shapes derive from
// platform.alert_rules / platform.alert_log (13B §13B-4 + migration 0011) — no invented column.
// The actor is ALWAYS `ctx.userId`, never a caller-supplied field. The mutating command
// (AcknowledgeAlert) carries `expectedVersion` — the optimistic-lock token the caller read most
// recently on the alert_log row (0011: `version integer not null default 1`); a stale one ->
// StaleVersionError (409). Idempotency-Key travels in the request header, not the body.
//
// EvaluateAlertRules is the pg-boss job body / internal trigger: with `ruleCode` it evaluates one
// rule; without it, every `is_active` rule. `ruleCode` is the seed's `code` (N-01 … N-22).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// platform.alert_rules.code — seed 13B L2839-3043: 'N-01' … 'N-22'.
const RULE_CODE = z.string().regex(/^N-\d{2}$/);
// platform.alert_log.id is bigserial — a positive integer, transported as a number.
const ALERT_LOG_ID = z.number().int().positive();
// platform.alert_log.version starts at 1 (migration 0011: integer not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);

export const EvaluateAlertRulesInputSchema = z
  .object({
    ruleCode: RULE_CODE.optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'EvaluateAlertRulesInput' });

export type EvaluateAlertRulesInput = z.infer<typeof EvaluateAlertRulesInputSchema>;

export const AcknowledgeAlertInputSchema = z
  .object({
    alertLogId: ALERT_LOG_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'AcknowledgeAlertInput' });

export type AcknowledgeAlertInput = z.infer<typeof AcknowledgeAlertInputSchema>;

// Result schemas (pg-reviewer round-1 finding 14a: the brief asked for them; OpenAPI response
// bodies derive from these, never from an ad-hoc object).
const ROLE_CODE = z.string().min(1);

export const AlertFiredSchema = z
  .object({
    alertLogId: ALERT_LOG_ID,
    ruleCode: RULE_CODE,
    entityRef: z.string().min(1),
    recipients: z.array(UUID_ID),
    targetRoles: z.array(ROLE_CODE),
  })
  .meta({ id: 'AlertFired' });

export type AlertFired = z.infer<typeof AlertFiredSchema>;

/** One evaluation pass. `failed` lists rules whose source_query or action-link check failed and
 *  were skipped in their own savepoint (doc 25 §1: only THAT alert is not sent) — the pass itself
 *  still succeeds. */
export const EvaluateAlertRulesResultSchema = z
  .object({
    fired: z.array(AlertFiredSchema),
    evaluated: z.number().int().nonnegative(),
    deduped: z.number().int().nonnegative(),
    quietSkipped: z.number().int().nonnegative(),
    failed: z.array(z.object({ ruleCode: RULE_CODE, reason: z.string().min(1) })),
  })
  .meta({ id: 'EvaluateAlertRulesResult' });

export type EvaluateAlertRulesResult = z.infer<typeof EvaluateAlertRulesResultSchema>;

export const AcknowledgeAlertResultSchema = z
  .object({
    alertLogId: ALERT_LOG_ID,
    version: EXPECTED_VERSION,
  })
  .meta({ id: 'AcknowledgeAlertResult' });

export type AcknowledgeAlertResult = z.infer<typeof AcknowledgeAlertResultSchema>;
