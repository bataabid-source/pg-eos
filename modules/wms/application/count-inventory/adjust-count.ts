// modules/wms/application/count-inventory/adjust-count.ts — WBS 2.13 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction. Lock order: (1) count-row lock +
// expectedVersion check (brief D3 — AdjustCount is one of the two commands that takes it), (2)
// the role gate (brief D4 — WH_MGR ONLY, no OR), (3) the machine's legality check (review only,
// via advanceInventoryCount — no if/switch on the status string), (4) finding 1: the
// "recount mandatory on variance" guard (INV-C3-7) — EVERY line is checked BEFORE any adjustment
// is posted; a count with even one un-recounted variant line refuses the whole AdjustCount call,
// (5) every line's adjustment, posted through the reused ledger port (brief D5) with its uom
// looked up from the line's own prior stock_movements history (finding 9 — never fabricated),
// (6) the unconditional version bump on the row already locked in step 1, (7) the audit row,
// last (ADR-0002 — every row lock this command takes is taken in step 1, before the ledger's own
// advisory locks in step 5).
//
// D8: no outbox event of the count's own — only 'wms.stock.moved', already fired once per posted
// adjustment by postMovementInTx (via ../../infrastructure/count-inventory/ledger.ts).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { Quantity } from '@pg-eos/domain-kit';

import { INVENTORY_COUNT_EVENTS, advanceInventoryCount } from '../../domain/count-inventory/machine.js';
import { assertAllVariancesRecounted, planAdjustment } from '../../domain/count-inventory/invariants.js';
import { AdjustmentPostingError, MissingActorError, MovementUomNotFoundError, RoleRequiredError, StaleVersionError } from '../../domain/count-inventory/errors.js';
import type { CountInventoryDeps } from './ports.js';

// brief D4: AdjustCount -> WH_MGR ONLY ("approved by WH_MGR", no OR).
const ADJUST_COUNT_ROLES = ['WH_MGR'] as const;
const AUDIT_OPERATION_ADJUST = 'update';

export interface AdjustCountInput {
  readonly countId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface AdjustCountResult {
  readonly countId: string;
  readonly status: 'adjusted';
  readonly version: number;
}

export async function adjustCount(
  ctx: WithContextCtx,
  input: AdjustCountInput,
  deps: CountInventoryDeps,
): Promise<AdjustCountResult> {
  if (!ctx.userId) throw new MissingActorError('AdjustCount requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<AdjustCountResult>(ctx, input.idem, async (tx) => {
    const count = await deps.repo.getCountForUpdate(tx, input.countId);
    if (count.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `AdjustCount: expectedVersion ${input.expectedVersion} no longer matches count ` +
          `${input.countId}'s version ${count.version} (optimistic lock). ` +
          `(Allowed: re-read the count and retry with its current version)`,
      );
    }

    if (!(await deps.repo.hasAnyRole(tx, ADJUST_COUNT_ROLES))) {
      throw new RoleRequiredError(
        `AdjustCount requires role ${ADJUST_COUNT_ROLES.join(' or ')} (platform.my_roles()). ` +
          `(Allowed: WH_MGR only)`,
      );
    }

    // no if on the status string — advanceInventoryCount asks the machine and THROWS
    // IllegalTransitionError itself when ADJUST is not legal from `count.status`.
    const newStatus = advanceInventoryCount(count.status, [INVENTORY_COUNT_EVENTS.ADJUST]);

    const lines = await deps.repo.getLinesForAdjustment(tx, input.countId);

    // finding 1 — INV-C3-7 "recount mandatory on variance": thrown BEFORE any adjustment is
    // posted for this count.
    assertAllVariancesRecounted(lines);

    const occurredAt = deps.clock.now();

    for (const line of lines) {
      // A line reaching 'review' always has qty_counted set — defensive, never expected.
      if (line.qtyCounted === null) continue;

      const finalQty = Quantity.of(line.recountQty ?? line.qtyCounted);
      const systemQty = Quantity.of(line.qtySystem);
      const plan = planAdjustment(finalQty, systemQty);
      // brief D5: a line with zero final variance is skipped — no movement posted for it.
      if (plan.direction === null) continue;

      const clientId = await deps.repo.getSkuClientId(tx, line.skuId);
      const batchNo = line.batchNo ?? '';

      // finding 9: the uom is NEVER fabricated — looked up from the most recent prior
      // wms.stock_movements row for this exact (client, sku, location, batch). A
      // wms.stock_balance row cannot exist without at least one prior movement (G1), so this
      // should be unreachable — but a broken invariant must fail loudly, not silently default.
      const uom = await deps.repo.getLatestMovementUom(tx, {
        clientId,
        skuId: line.skuId,
        locationId: line.locationId,
        batchNo,
      });
      if (!uom) {
        throw new MovementUomNotFoundError(
          `AdjustCount: no prior wms.stock_movements row found for client ${clientId} / sku ` +
            `${line.skuId} / location ${line.locationId} / batch "${batchNo}" — cannot determine ` +
            `uom (should be unreachable given G1). (Allowed: adjust only a line whose stock has ` +
            `at least one prior movement)`,
        );
      }

      const posted = await deps.ledger.postAdjustment(
        tx,
        {
          entityId: count.entityId,
          clientId,
          skuId: line.skuId,
          locationId: line.locationId,
          direction: plan.direction,
          qty: plan.magnitude.toString(),
          uom,
          batchNo,
          correlationId: input.correlationId,
          refId: line.id,
        },
        actorId,
        deps,
      );
      const movementId = posted.movementIds[0];
      if (!movementId) {
        throw new AdjustmentPostingError(
          `AdjustCount: postAdjustment returned no movement id for line ${line.id}. ` +
            `(Allowed: unreachable — report this as a defect)`,
        );
      }
      await deps.repo.setLineAdjustedMovementId(tx, input.countId, line.id, movementId);
    }

    const newVersion = await deps.repo.updateCountStatus(tx, input.countId, {
      status: newStatus,
      version: count.version + 1,
      finishedAt: occurredAt,
      approvedBy: actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: count.entityId,
      target: 'count',
      recordId: input.countId,
      operation: AUDIT_OPERATION_ADJUST,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion },
      occurredAt,
    });

    return { countId: input.countId, status: 'adjusted', version: newVersion };
  });
}
