// modules/imile/application/report-agent-health/report-agent-health.ts — WBS 3.14.
//
// ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set). Steps:
//   1. pure domain invariants (../../domain/report-agent-health/invariants.ts), before any read or
//      write: sessionValid=false requires a non-empty errorMessage; lastPullAt (if any) must not be
//      after reportedAt (= deps.clock.now()).
//   2. the row write (repo.insertAgentHealth) — append-only INSERT, never an UPDATE (imile.
//      agent_health has no version column, brief Read ONLY list item 5). A report from any
//      agentId is accepted independently — there is no cross-agentId "active session" exclusivity
//      rule (reviewer finding 1, 2026-09-24: doc 40 §C8's "single session — any other login drops
//      it" describes ONE iMile account's OWN portal session, not exclusivity across agentIds;
//      D-148/D-149, docs/notes/2026-09-24-imile-agent-scenario.md §5, §7, and N-01's own ungrouped
//      `max(last_pull_at)` query, confirm several agentIds legitimately report simultaneously). No
//      prior-state lookup is needed — every call is a pure validate-then-insert.
//   3. the audit row, last (ADR-0002 discipline, same order as the golden slice).
//
// Reviewer finding 2 (2026-09-24): publishing 'imile.agent_health.reported' to platform.outbox is
// DEFERRED — the event has no entity_id and using the `platform.*` aggregate-type exemption to
// dodge that was rejected as an invented rule (a G-01 gap is filed,
// docs/notes/2026-09-24-imile-agent-scenario.md §4 row 'e', for a future ruling). This command
// writes only the imile.agent_health row and the audit row — no platform.outbox insert.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { assertLastPullNotInFuture, assertSessionValidHasReason } from '../../domain/report-agent-health/invariants.js';
import { MissingActorError } from '../../domain/report-agent-health/errors.js';
import type { ReportAgentHealthDeps } from './ports.js';

const AUDIT_OPERATION_INSERT = 'insert';

export interface ReportAgentHealthInput {
  readonly agentId: string;
  readonly sessionValid: boolean;
  readonly lastPullAt: string | null;
  readonly pendingPushes: number;
  readonly engineVersion: string;
  readonly errorMessage?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ReportAgentHealthResult {
  readonly id: string;
  readonly agentId: string;
  readonly reportedAt: string;
}

export async function reportAgentHealth(
  ctx: WithContextCtx,
  input: ReportAgentHealthInput,
  deps: ReportAgentHealthDeps,
): Promise<ReportAgentHealthResult> {
  if (!ctx.userId) throw new MissingActorError('ReportAgentHealth requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ReportAgentHealthResult>(ctx, input.idem, async (tx) => {
    // Step 1 — pure domain invariants, before any read or write.
    const errorMessage = input.errorMessage ?? null;
    assertSessionValidHasReason(input.sessionValid, errorMessage);

    const reportedAt = deps.clock.now();
    const lastPullAt = input.lastPullAt === null ? null : new Date(input.lastPullAt);
    assertLastPullNotInFuture(lastPullAt, reportedAt);

    // Step 2 — the append-only write. No prior-state lookup: every agentId is accepted
    // independently (reviewer finding 1).
    const inserted = await deps.repo.insertAgentHealth(tx, {
      agentId: input.agentId,
      sessionValid: input.sessionValid,
      lastPullAt,
      pendingPushes: input.pendingPushes,
      engineVersion: input.engineVersion,
      errorMessage,
      reportedAt,
    });

    // Step 3 — the audit row, last (ADR-0002). platform.outbox publication is deferred (reviewer
    // finding 2) — no outbox insert here.
    await deps.repo.writeAuditRow(tx, {
      recordId: inserted.id,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        agentId: input.agentId,
        sessionValid: input.sessionValid,
        lastPullAt: input.lastPullAt,
        pendingPushes: input.pendingPushes,
        engineVersion: input.engineVersion,
        errorMessage,
      },
      occurredAt: reportedAt,
    });

    return { id: inserted.id, agentId: input.agentId, reportedAt: inserted.reportedAt.toISOString() };
  });
}
