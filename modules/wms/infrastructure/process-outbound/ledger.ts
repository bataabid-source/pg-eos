// modules/wms/infrastructure/process-outbound/ledger.ts — WBS 2.12 part 1, fix round 1 finding 1
// (_slice-2.12.brief.md).
//
// infrastructure/ layer: the ONE file that imports ../../src/stock-ledger (REPLACE-ON-COPY, same
// discipline as ../receive-inbound/ledger.ts / ../count-inventory/ledger.ts). Implements
// ../../application/process-outbound/ports.ts's `LedgerPort` as a thin adapter over the reused,
// transaction-scoped stock ledger (`postMovementInTx`) — this is what gives PickLine the shared
// rebuild-key lock, the balance advisory lock, `validateEntry` (rejects qty<=0 before the DB), the
// `no_negative_stock`->`NegativeStockError` mapping, `last_movement_at`, and the per-movement
// `wms.stock.moved` outbox+audit pairing (G9), none of which the hand-written SQL this replaces
// (../../infrastructure/process-outbound/repository.ts's former `postPickMovement`) ever had.
//
// A pick removes stock — it is not a transfer (unlike putaway): `fromLocationId` is the line's own
// reserved lot, `toLocationId` is always null.

import { Quantity } from '@pg-eos/domain-kit';

import { postMovementInTx } from '../../src/stock-ledger/post-movement.js';
import type { LedgerPort } from '../../application/process-outbound/ports.js';

// REPLACE-ON-COPY: the wms.stock_movements movement_type this use case posts a pick as.
const PICK_MOVEMENT_TYPE = 'pick';
// Fix round 1 finding 2: keyed to the LINE, never the order — the double-pick guard's own
// precedent, same as ../count-inventory/ledger.ts's `ref_table='wms.inventory_count_lines'`.
const REF_TABLE_ORDER_LINES = 'wms.order_lines';

export const outboundLedgerPort: LedgerPort = {
  async postPick(tx, params, actorId, deps) {
    return postMovementInTx(
      tx,
      {
        entityId: params.entityId,
        entry: {
          clientId: params.clientId,
          skuId: params.skuId,
          fromLocationId: params.fromLocationId,
          toLocationId: null,
          qty: Quantity.of(params.qty),
          batchNo: params.batchNo,
          movementType: PICK_MOVEMENT_TYPE,
          uom: params.uom,
        },
        correlationId: params.correlationId,
        performedBy: actorId,
        refTable: REF_TABLE_ORDER_LINES,
        refId: params.lineId,
      },
      actorId,
      deps,
    );
  },
};
