// modules/wms/application/count-inventory/count-location.ts — WBS 2.13 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction. No expectedVersion from the caller
// (brief D3) — the line's own state guards re-entry (AlreadyCountedError), serialized by a
// `select ... for update` on the PARENT count row taken FIRST, so two counters working different
// locations of the same count never conflict with each other.
//
// Order: (1) the role gate (brief D4: WH_OP, WH_SUP, or WH_MGR — any warehouse worker counts),
// (2) find the line's own count_id (unlocked — brief Facts: a line is reached only through its
// parent), (3) lock the parent count row, (4) the status gate — via the machine's own
// COUNT_LINE self-loop event (canTransition, no if/switch on the status string — CLAUDE.md ·
// ARCHITECTURE, matching ../receive-inbound/cancel-inbound.ts:59), (5) lock the line bound to
// that count, (6) the re-entry guard (AlreadyCountedError), (7) the line write, (8) the
// auto-transition decision (in_progress -> review once every line is counted, brief D1/P3),
// bumping the count's version itself when it fires, (9) audit rows, last (ADR-0002).
//
// D2 — the blind-count contract: this command returns ONLY { lineId, recorded: true }. It never
// reads qty_system for the response (it is read only to decide the auto-transition — P3's
// isCountComplete needs qty_counted, not qty_system, so this file never even fetches qty_system).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { INVENTORY_COUNT_EVENTS, advanceInventoryCount, canTransition } from '../../domain/count-inventory/machine.js';
import { isCountComplete } from '../../domain/count-inventory/invariants.js';
import { AlreadyCountedError, IllegalTransitionError, MissingActorError, RoleRequiredError } from '../../domain/count-inventory/errors.js';
import type { CountInventoryDeps } from './ports.js';

// brief D4: CountLocation -> WH_OP, WH_SUP, or WH_MGR (any warehouse worker counts).
const COUNT_LOCATION_ROLES = ['WH_OP', 'WH_SUP', 'WH_MGR'] as const;
const AUDIT_OPERATION_COUNT_LOCATION = 'update';
const AUDIT_OPERATION_AUTO_REVIEW = 'update';

export interface CountLocationInput {
  readonly lineId: string;
  readonly qtyCounted: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CountLocationResult {
  readonly lineId: string;
  readonly recorded: true;
}

export async function countLocation(
  ctx: WithContextCtx,
  input: CountLocationInput,
  deps: CountInventoryDeps,
): Promise<CountLocationResult> {
  if (!ctx.userId) throw new MissingActorError('CountLocation requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CountLocationResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, COUNT_LOCATION_ROLES))) {
      throw new RoleRequiredError(
        `CountLocation requires role ${COUNT_LOCATION_ROLES.join(', ')} (platform.my_roles()). ` +
          `(Allowed: WH_OP, WH_SUP, or WH_MGR)`,
      );
    }

    const countId = await deps.repo.findLineCountId(tx, input.lineId);
    const count = await deps.repo.getCountForUpdate(tx, countId);

    // No if/switch on the status string — the machine's own COUNT_LINE self-loop event decides
    // whether a line may be written right now (CLAUDE.md · ARCHITECTURE).
    if (!canTransition(count.status, INVENTORY_COUNT_EVENTS.COUNT_LINE)) {
      throw new IllegalTransitionError(
        `CountLocation: count ${countId} is "${count.status}"; COUNT_LINE is not legal from that ` +
          `status. (Allowed: CountLocation only while the count is in_progress)`,
      );
    }

    const line = await deps.repo.getLineForUpdate(tx, countId, input.lineId);
    if (line.qtyCounted !== null) {
      throw new AlreadyCountedError(
        `inventory_count_lines row ${input.lineId} already has qty_counted set (re-entry guard). ` +
          `(Allowed: CountLocation only once per line)`,
      );
    }

    const updated = await deps.repo.updateLineQtyCounted(tx, countId, input.lineId, input.qtyCounted);
    if (!updated) {
      throw new AlreadyCountedError(
        `inventory_count_lines row ${input.lineId} was counted concurrently (atomic guard). ` +
          `(Allowed: CountLocation only once per line)`,
      );
    }

    const occurredAt = deps.clock.now();

    // P3 — auto-transition once every line of the count has qty_counted set (brief D1).
    const flags = await deps.repo.getLineCountedFlags(tx, countId);
    if (isCountComplete(flags)) {
      const newStatus = advanceInventoryCount(count.status, [INVENTORY_COUNT_EVENTS.COMPLETE]);
      const newVersion = await deps.repo.updateCountStatus(tx, countId, { status: newStatus, version: count.version + 1 });
      await deps.repo.writeAuditRow(tx, {
        entityId: count.entityId,
        target: 'count',
        recordId: countId,
        operation: AUDIT_OPERATION_AUTO_REVIEW,
        correlationId: input.correlationId,
        actorId,
        newValue: { status: newStatus, version: newVersion },
        occurredAt,
      });
    }

    await deps.repo.writeAuditRow(tx, {
      entityId: count.entityId,
      target: 'line',
      recordId: input.lineId,
      operation: AUDIT_OPERATION_COUNT_LOCATION,
      correlationId: input.correlationId,
      actorId,
      newValue: { qtyCounted: input.qtyCounted },
      occurredAt,
    });

    return { lineId: input.lineId, recorded: true };
  });
}
