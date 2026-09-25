// modules/wms/infrastructure/count-inventory/ledger.ts — WBS 2.13 (lane 2).
//
// infrastructure/ layer: the ONE file that imports ../../src/stock-ledger (same REPLACE-ON-COPY
// discipline as ../receive-inbound/ledger.ts). Implements
// ../../application/count-inventory/ports.ts's `LedgerPort` as a thin adapter over the reused,
// transaction-scoped stock ledger (brief Facts / D5): movement_type 'adjust', ref_table
// 'wms.inventory_count_lines', ref_id = the line's own id, exactly one of
// fromLocationId/toLocationId set per `direction`.

import { Quantity } from '@pg-eos/domain-kit';

import { postMovementInTx } from '../../src/stock-ledger/post-movement.js';
import type { LedgerPort } from '../../application/count-inventory/ports.js';

// brief D5: the wms.stock_movements movement_type this use case posts an adjustment as.
const ADJUST_MOVEMENT_TYPE = 'adjust';
// brief D5 / Facts: the ref_table every posted adjustment cites back to.
const REF_TABLE_COUNT_LINES = 'wms.inventory_count_lines';

export const countInventoryLedgerPort: LedgerPort = {
  async postAdjustment(tx, params, actorId, deps) {
    const isOutflow = params.direction === 'outflow';
    return postMovementInTx(
      tx,
      {
        entityId: params.entityId,
        entry: {
          clientId: params.clientId,
          skuId: params.skuId,
          fromLocationId: isOutflow ? params.locationId : null,
          toLocationId: isOutflow ? null : params.locationId,
          qty: Quantity.of(params.qty),
          batchNo: params.batchNo,
          movementType: ADJUST_MOVEMENT_TYPE,
          // finding 9: never fabricated — looked up by the caller from the most recent prior
          // wms.stock_movements row for this exact (client, sku, location, batch).
          uom: params.uom,
        },
        correlationId: params.correlationId,
        performedBy: actorId,
        refTable: REF_TABLE_COUNT_LINES,
        refId: params.refId,
      },
      actorId,
      deps,
    );
  },
};
