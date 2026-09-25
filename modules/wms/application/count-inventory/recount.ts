// modules/wms/application/count-inventory/recount.ts — WBS 2.13 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction. No expectedVersion from the caller
// (brief D3), same lock order as ./count-location.ts: parent count row FIRST, then the line bound
// to it.
//
// Order: (1) the role gate (brief D4: WH_OP, WH_SUP, or WH_MGR), (2) find the line's own
// count_id, (3) lock the parent count row, (4) the status gate — via the machine's own
// RECOUNT_LINE self-loop event (canTransition, no if/switch — CLAUDE.md · ARCHITECTURE), legal
// only from 'review'/'recount', (5) lock the line, (6) the "flagged for recount" guard —
// hasVariance (P1) AND recount_qty not already set — NotFlaggedForRecountError otherwise, (7) the
// line write, (8) the auto-transition decision, built from BOTH status-changing events this ONE
// call may legally need, sent together to the same actor (matching the golden slice's
// receive-line.ts:157 multi-event-in-one-call pattern) so a count can never get stuck in
// 'recount':
//   - FLAG_RECOUNT, iff canTransition(count.status, FLAG_RECOUNT) — i.e. the count is still
//     'review' when this call starts (the first Recount call on a variant line always flags
//     recount, brief D1); no if/switch on the status string (CLAUDE.md · ARCHITECTURE);
//   - RECOUNT_COMPLETE, iff — AFTER this call's own line write — no variant line is still
//     awaiting its recount (getVariantLineRecountFlags). This is re-checked on EVERY call
//     (including the very first one), so a count whose first-ever Recount call also happens to
//     recount the LAST/ONLY variant line lands back on 'review' in this same call instead of
//     getting stuck on 'recount' forever.
// Both events, when both apply, are sent to ONE actor in the same locked transaction and bump
// `version` ONCE (review -> recount -> review nets to the same status value, but the version DID
// bump, so it still gets its own audit_log row — the audit write below is gated on events.length >
// 0 (the count row was actually written), never on the status value having changed, brief D8).
// (9) audit rows, last (ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { Quantity } from '@pg-eos/domain-kit';

import { INVENTORY_COUNT_EVENTS, advanceInventoryCount, canTransition, type InventoryCountEventType } from '../../domain/count-inventory/machine.js';
import { hasVariance } from '../../domain/count-inventory/invariants.js';
import { IllegalTransitionError, MissingActorError, NotFlaggedForRecountError, RoleRequiredError } from '../../domain/count-inventory/errors.js';
import type { CountInventoryDeps } from './ports.js';

// brief D4: Recount -> WH_OP, WH_SUP, or WH_MGR (any warehouse worker counts).
const RECOUNT_ROLES = ['WH_OP', 'WH_SUP', 'WH_MGR'] as const;
const AUDIT_OPERATION_RECOUNT = 'update';
const AUDIT_OPERATION_AUTO_TRANSITION = 'update';

export interface RecountInput {
  readonly lineId: string;
  readonly recountQty: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface RecountResult {
  readonly lineId: string;
  readonly recorded: true;
}

export async function recount(
  ctx: WithContextCtx,
  input: RecountInput,
  deps: CountInventoryDeps,
): Promise<RecountResult> {
  if (!ctx.userId) throw new MissingActorError('Recount requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<RecountResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, RECOUNT_ROLES))) {
      throw new RoleRequiredError(
        `Recount requires role ${RECOUNT_ROLES.join(', ')} (platform.my_roles()). ` +
          `(Allowed: WH_OP, WH_SUP, or WH_MGR)`,
      );
    }

    const countId = await deps.repo.findLineCountId(tx, input.lineId);
    const count = await deps.repo.getCountForUpdate(tx, countId);

    // No if/switch on the status string — the machine's own RECOUNT_LINE self-loop event decides
    // whether a line may be written right now (CLAUDE.md · ARCHITECTURE).
    if (!canTransition(count.status, INVENTORY_COUNT_EVENTS.RECOUNT_LINE)) {
      throw new IllegalTransitionError(
        `Recount: count ${countId} is "${count.status}"; RECOUNT_LINE is not legal from that status. ` +
          `(Allowed: Recount only while the count is review or recount)`,
      );
    }

    const line = await deps.repo.getLineForUpdate(tx, countId, input.lineId);
    const isFlagged =
      line.qtyCounted !== null &&
      line.recountQty === null &&
      hasVariance(Quantity.of(line.qtyCounted), Quantity.of(line.qtySystem));
    if (!isFlagged) {
      throw new NotFlaggedForRecountError(
        `inventory_count_lines row ${input.lineId} is not flagged for recount (no variance, ` +
          `not yet counted, or already recounted). (Allowed: Recount only a line with a variance ` +
          `that has not yet been recounted)`,
      );
    }

    const updated = await deps.repo.updateLineRecountQty(tx, countId, input.lineId, input.recountQty);
    if (!updated) {
      throw new NotFlaggedForRecountError(
        `inventory_count_lines row ${input.lineId} was recounted concurrently (atomic guard). ` +
          `(Allowed: Recount only a line with a variance that has not yet been recounted)`,
      );
    }

    const occurredAt = deps.clock.now();

    // Finding 2 fix: build BOTH status-changing events this call may legally need — FLAG_RECOUNT
    // (this is the first Recount call, count still 'review') and/or RECOUNT_COMPLETE (no variant
    // line is still awaiting its recount, RE-CHECKED after this call's own write) — and send them
    // to ONE actor together, so a count whose first Recount call also recounts the last/only
    // variant line lands back on 'review' in this same call instead of getting stuck on 'recount'.
    const events: InventoryCountEventType[] = [];
    if (canTransition(count.status, INVENTORY_COUNT_EVENTS.FLAG_RECOUNT)) {
      events.push(INVENTORY_COUNT_EVENTS.FLAG_RECOUNT);
    }
    const variantFlags = await deps.repo.getVariantLineRecountFlags(tx, countId);
    const stillAwaiting = variantFlags.some((flag) => !flag.recounted);
    if (!stillAwaiting) {
      events.push(INVENTORY_COUNT_EVENTS.RECOUNT_COMPLETE);
    }

    let newStatus = count.status;
    let newVersion = count.version;
    if (events.length > 0) {
      newStatus = advanceInventoryCount(count.status, events);
      newVersion = await deps.repo.updateCountStatus(tx, countId, { status: newStatus, version: count.version + 1 });
    }

    // Finding 1 fix: gate the count-level audit row on the count row actually having been WRITTEN
    // (version bumped, i.e. events.length > 0) — never on the net status value having changed.
    // review -> recount -> review nets to the SAME status but is still a real state change (the
    // version DID bump) and still needs its own audit_log row (brief D8).
    if (events.length > 0) {
      await deps.repo.writeAuditRow(tx, {
        entityId: count.entityId,
        target: 'count',
        recordId: countId,
        operation: AUDIT_OPERATION_AUTO_TRANSITION,
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
      operation: AUDIT_OPERATION_RECOUNT,
      correlationId: input.correlationId,
      actorId,
      newValue: { recountQty: input.recountQty },
      occurredAt,
    });

    return { lineId: input.lineId, recorded: true };
  });
}
