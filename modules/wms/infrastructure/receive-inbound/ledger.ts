// modules/wms/infrastructure/receive-inbound/ledger.ts — WBS 2.9, THE GOLDEN SLICE.
//
// infrastructure/ layer: the ONE file that imports ../../src/stock-ledger (REPLACE-ON-COPY: a
// later slice importing a different mechanism package changes only this file's two import lines
// and the two function bodies — every application/ file stays untouched). Implements
// ../../application/receive-inbound/ports.ts's `LedgerPort` as a thin adapter over the reused,

import { Quantity } from '@pg-eos/domain-kit';

import { postMovementInTx, postTransferInTx } from '../../src/stock-ledger/post-movement.js';
import type { LedgerPort } from '../../application/receive-inbound/ports.js';

// REPLACE-ON-COPY: the wms.stock_movements movement_type this use case posts a receipt as.
const RECEIPT_MOVEMENT_TYPE = 'receipt';
// REPLACE-ON-COPY: the ref_table every posted ledger row cites back to.
const REF_TABLE_INBOUND_ORDERS = 'wms.inbound_orders';

export const inboundLedgerPort: LedgerPort = {
  async postReceipt(tx, params, actorId, deps) {
    return postMovementInTx(
      tx,
      {
        entityId: params.entityId,
        entry: {
          clientId: params.clientId,
          skuId: params.skuId,
          fromLocationId: null,
          toLocationId: params.toLocationId,
          qty: Quantity.of(params.qty),
          batchNo: params.batchNo,
          movementType: RECEIPT_MOVEMENT_TYPE,
          uom: params.uom,
        },
        correlationId: params.correlationId,
        performedBy: actorId,
        refTable: REF_TABLE_INBOUND_ORDERS,
        refId: params.refId,
      },
      actorId,
      deps,
    );
  },

  async postPutawayTransfer(tx, params, actorId, deps) {
    return postTransferInTx(
      tx,
      {
        entityId: params.entityId,
        base: { clientId: params.clientId, skuId: params.skuId, qty: Quantity.of(params.qty), batchNo: params.batchNo, uom: params.uom },
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        correlationId: params.correlationId,
        performedBy: actorId,
        refTable: REF_TABLE_INBOUND_ORDERS,
        refId: params.refId,
      },
      actorId,
      deps,
    );
  },
};
