// modules/wms/application/count-inventory/start-count.ts — WBS 2.13 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set).
// Order: (1) the role gate (brief D4: WH_MGR or WH_SUP), (2) the cycle/spot filter invariant
// (brief D6, before any DB access), (3) resolve the warehouse's own entity (brief Facts — the
// count's entity_id, never the caller's resolved entity), (4) allocate the doc_no, (5) the frozen
// stock snapshot (brief D6; filtered by `clientId` when supplied, finding 10 — a client-scoped
// count must not pick up another client's SKUs), (6) the machine-driven initial status —
// draft -> in_progress -> review IN THE SAME CALL when the snapshot is empty (finding 12: a
// warehouse with zero matching stock has nothing to count, so the count opens vacuously
// "complete" in 'review' rather than getting stuck 'in_progress' forever with no line that could
// ever satisfy "every line counted" — same multi-event-in-one-call pattern as ./recount.ts /
// receive-line.ts:157), (7) the INSERT of the count row and its lines, (8) the audit row, last
// (ADR-0002 — this command takes no row lock, only inserts, so there is no lock-order hazard).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { INVENTORY_COUNT_EVENTS, INVENTORY_COUNT_STATUS, advanceInventoryCount } from '../../domain/count-inventory/machine.js';
import { MissingActorError, RoleRequiredError } from '../../domain/count-inventory/errors.js';
import { assertFilterProvidedForPartialCount } from '../../domain/count-inventory/invariants.js';
import type { CountInventoryDeps } from './ports.js';

// brief D4: StartCount -> WH_MGR or WH_SUP (initiating a count is supervisory).
const START_COUNT_ROLES = ['WH_MGR', 'WH_SUP'] as const;
const AUDIT_OPERATION_START = 'insert';
// platform.counters seed (01-Data-Model.sql:1589-1598) — 'CNT' is the inventory-count doc series.
const COUNT_DOC_TYPE = 'CNT';
const COUNT_TYPE_FULL = 'full';

export interface StartCountInput {
  readonly warehouseId: string;
  readonly countType: string;
  readonly locationIds?: readonly string[] | undefined;
  readonly skuIds?: readonly string[] | undefined;
  readonly clientId?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface StartCountResult {
  readonly id: string;
  // finding 12: a warehouse/filter with zero matching stock has no lines to count — the count
  // lands directly in 'review' (vacuously complete) instead of the usual 'in_progress'.
  readonly status: 'in_progress' | 'review';
  readonly version: number;
}

export async function startCount(
  ctx: WithContextCtx,
  input: StartCountInput,
  deps: CountInventoryDeps,
): Promise<StartCountResult> {
  if (!ctx.userId) throw new MissingActorError('StartCount requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<StartCountResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, START_COUNT_ROLES))) {
      throw new RoleRequiredError(
        `StartCount requires role ${START_COUNT_ROLES.join(' or ')} (platform.my_roles()). ` +
          `(Allowed: WH_MGR or WH_SUP)`,
      );
    }

    // brief D6 — thrown BEFORE any DB write for a 'cycle'/'spot' count missing its filter.
    assertFilterProvidedForPartialCount(input.countType, input.locationIds, input.skuIds);

    const entityId = await deps.repo.getWarehouseEntityId(tx, input.warehouseId);

    const docNo = await deps.repo.nextDocNo(tx, entityId, COUNT_DOC_TYPE);
    const occurredAt = deps.clock.now();

    // finding 10: a client-scoped count must only snapshot THAT client's SKUs.
    const snapshot = await deps.repo.snapshotStockForCount(tx, {
      warehouseId: input.warehouseId,
      locationIds: input.countType === COUNT_TYPE_FULL ? undefined : input.locationIds,
      skuIds: input.countType === COUNT_TYPE_FULL ? undefined : input.skuIds,
      clientId: input.clientId,
    });

    // No if on the status string — the machine alone decides the initial status. START is always
    // legal from 'draft'. finding 12: an EMPTY snapshot sends COMPLETE in the SAME call (P3's
    // isCountComplete is vacuously true for zero lines), landing directly in 'review' instead of a
    // permanently-stuck 'in_progress' with nothing to count.
    const startEvents =
      snapshot.length === 0
        ? [INVENTORY_COUNT_EVENTS.START, INVENTORY_COUNT_EVENTS.COMPLETE]
        : [INVENTORY_COUNT_EVENTS.START];
    const initialStatus = advanceInventoryCount(INVENTORY_COUNT_STATUS.DRAFT, startEvents);

    const inserted = await deps.repo.insertCount(tx, {
      entityId,
      docNo,
      warehouseId: input.warehouseId,
      clientId: input.clientId ?? null,
      countType: input.countType,
      status: initialStatus,
      startedAt: occurredAt,
      countedBy: actorId,
    });

    await deps.repo.insertCountLines(
      tx,
      inserted.id,
      snapshot.map((row) => ({
        locationId: row.locationId,
        skuId: row.skuId,
        batchNo: row.batchNo,
        qtySystem: row.qtySystem,
      })),
    );

    await deps.repo.writeAuditRow(tx, {
      entityId,
      target: 'count',
      recordId: inserted.id,
      operation: AUDIT_OPERATION_START,
      correlationId: input.correlationId,
      actorId,
      newValue: { docNo, status: initialStatus, version: inserted.version, lineCount: snapshot.length },
      occurredAt,
    });

    return { id: inserted.id, status: initialStatus as 'in_progress' | 'review', version: inserted.version };
  });
}
