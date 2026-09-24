// modules/wms/application/receive-inbound/receive-line.ts — WBS 2.9, THE GOLDEN SLICE.
//
// ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set). Lock order
// (full rationale in ../../infrastructure/receive-inbound/repository.ts's own header):
//   1. order-row lock (repo.getOrderForUpdate) + expectedVersion check.
//   2. line-row lock, bound to the order (repo.getOrderLineForUpdate: a mismatched
//      lineId/orderId pair is LineNotFoundError, never a cross-order leak).
//   3. re-entry guard: the locked line's own qty_actual — already receipted -> typed
//      LineAlreadyReceivedError, BEFORE any further read/write.
//   4. pure domain invariants (../../domain/receive-inbound/invariants.ts) — SKU/client match,
//      variance-reason — thrown before any write.
//   5. the line write (repo.updateLineReceipt), then the machine-driven transition decision.
//   6. IF this is the order's last open line: allocate the GRN doc_no (platform.next_doc_no —
//      a platform.counters ROW lock) and insert the GRN document. This MUST precede step 7:
//      ADR-0002 forbids taking any row lock after the audit-chain advisory lock, and the ledger
//      port writes an audit row. Every row lock in this command is taken before step 7.
//   7. the reused ledger port's own advisory locks (shared rebuild -> location limits -> balance
//      -> audit) — SKIPPED entirely for a fully-short receipt (qtyActual=0 posts NO ledger row).
//   8. outbox events ('wms.inbound.received' on the last line, doc 40 §C3 line 262 — NOT at
//      Close; 'wms.inbound.variance' on a variance) — inserts only, no row locks.
//   9. the unconditional version bump on the order row already locked in step 1, with
//      arrived_at/received_by set only on the FIRST receipt.
//  10. audit rows, last (ADR-0002).
//
// (Master default, recorded here): a fully-short receipt (qtyActual = 0, WITH a
// varianceReason like any other variance) posts NO ledger row and its line goes straight to
// status 'complete' with location_id left null — ConfirmPutaway is never called for it, and
// CloseInbound's own gate (repo.hasBlockingOpenLines) treats status='complete' + qty_actual=0 as
// non-blocking even without a location_id.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { Quantity } from '@pg-eos/domain-kit';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { INBOUND_ORDER_EVENTS, advanceInboundOrder, canTransition } from '../../domain/receive-inbound/machine.js';
import { assertSkuBelongsToOrderClient, assertVarianceHasReason, assertVariancePhotoRequiresVariance, isFullyShortReceipt, isVarianceReceipt } from '../../domain/receive-inbound/invariants.js';
import { LineAlreadyReceivedError, MissingActorError, StaleVersionError } from '../../domain/receive-inbound/errors.js';
import type { ReceiveInboundDeps } from './ports.js';

const LINE_STATUS_COMPLETE = 'complete';
const LINE_STATUS_PARTIAL = 'partial';
const LINE_STATUS_OPEN = 'open';
const AUDIT_OPERATION_RECEIVE_LINE = 'update';
const AUDIT_OPERATION_RECEIVED_EVENT = 'update';
const AUDIT_OPERATION_VARIANCE_EVENT = 'update';
// REPLACE-ON-COPY: the use case's own catalogued events and aggregate names.
const INBOUND_RECEIVED_EVENT_TYPE: CatalogedEventType = 'wms.inbound.received';
const INBOUND_VARIANCE_EVENT_TYPE: CatalogedEventType = 'wms.inbound.variance';
const INBOUND_ORDERS_AGGREGATE_TYPE = 'wms.inbound_orders'; // REPLACE-ON-COPY: the aggregate this use case writes.
const ORDER_LINES_AGGREGATE_TYPE = 'wms.order_lines'; // REPLACE-ON-COPY: the aggregate this use case writes.
// the GRN doc number comes from the platform-wide DOC series (platform brief §4), NOT
// the module's own INB series.
const GRN_DOC_TYPE = 'DOC'; // REPLACE-ON-COPY: the document series this use case numbers from.
// 01-Data-Model.sql:143's own named example — the GRN template code.
const GRN_TEMPLATE_CODE = 'GRN-01'; // REPLACE-ON-COPY: the use case's document template.

export interface ReceiveLineInput {
  readonly orderId: string;
  readonly lineId: string;
  readonly qtyActual: string;
  readonly batchNo?: string | undefined;
  readonly expiryDate?: string | undefined;
  readonly varianceReason?: string | undefined;
  /** Both present or both absent — enforced by the contract
   *  (packages/contracts/wms/receive-inbound.ts) AND allowed only on a variance receipt
   *  (assertVariancePhotoRequiresVariance below) — SCR-WMS-INB-01 §4. */
  readonly variancePhotoUrl?: string | undefined;
  readonly variancePhotoSha256?: string | undefined;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ReceiveLineResult {
  readonly orderStatus: string;
  readonly lineStatus: string;
  readonly movementIds: readonly string[];
}

export async function receiveLine(
  ctx: WithContextCtx,
  input: ReceiveLineInput,
  deps: ReceiveInboundDeps,
): Promise<ReceiveLineResult> {
  if (!ctx.userId) throw new MissingActorError('ReceiveLine requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ReceiveLineResult>(ctx, input.idem, async (tx) => {
    // Steps 1-3 — lock order, lock the bound line, re-entry guard.
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    // NOTE: StaleVersionError is thrown here on a version mismatch — same pattern as every other
    // command; kept inline rather than a shared helper to keep each command file self-contained
    // (template guidance: a future slice's copy edits ONE file per command).
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ReceiveLine: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    const line = await deps.repo.getOrderLineForUpdate(tx, input.orderId, input.lineId);
    if (line.qtyActual !== null) {
      throw new LineAlreadyReceivedError(
        `order line ${input.lineId} already has qty_actual set (re-entry guard).`,
      );
    }

    // The receipt's own event: RECEIVE_LINE_FIRST from 'approved', RECEIVE_LINE on 'receiving'.
    // Legality comes from the machine alone; an illegal status throws here, before any write.
    const isFirstReceipt = canTransition(order.status, INBOUND_ORDER_EVENTS.RECEIVE_LINE_FIRST);
    const receiptEvent = isFirstReceipt ? INBOUND_ORDER_EVENTS.RECEIVE_LINE_FIRST : INBOUND_ORDER_EVENTS.RECEIVE_LINE;
    advanceInboundOrder(order.status, [receiptEvent]);

    // Step 4 — pure domain invariants, before any write.
    const skuClientId = await deps.repo.getSkuClientId(tx, line.skuId);
    assertSkuBelongsToOrderClient(skuClientId, order.clientId);

    const qtyActual = Quantity.of(input.qtyActual);
    const qtyOrdered = Quantity.of(line.qtyOrdered);
    assertVarianceHasReason(qtyActual, qtyOrdered, input.varianceReason);
    assertVariancePhotoRequiresVariance(qtyActual, qtyOrdered, input.variancePhotoUrl !== undefined);

    const isVariance = isVarianceReceipt(qtyActual, qtyOrdered);
    const isFullyShort = isFullyShortReceipt(qtyActual);
    // a fully-short line skips put-away entirely — 'complete' with location_id left null.
    const persistedLineStatus = isFullyShort ? LINE_STATUS_COMPLETE : isVariance ? LINE_STATUS_PARTIAL : LINE_STATUS_OPEN;
    const receiptLineStatus = isVariance ? LINE_STATUS_PARTIAL : LINE_STATUS_COMPLETE;

    // Step 5 — the line write (still holding both row locks).
    const lineUpdated = await deps.repo.updateLineReceipt(tx, {
      lineId: input.lineId,
      qtyActual: input.qtyActual,
      batchNo: input.batchNo ?? line.batchNo,
      expiryDate: input.expiryDate ?? null,
      varianceReason: input.varianceReason ?? null,
      variancePhotoUrl: input.variancePhotoUrl ?? null,
      variancePhotoSha256: input.variancePhotoSha256 ?? null,
      status: persistedLineStatus,
    });
    if (!lineUpdated) {
      throw new LineAlreadyReceivedError(
        `order line ${input.lineId} was receipted concurrently (atomic guard).`,
      );
    }

    // Step 5b — the transition decision, from the machine alone (no if on the status string).
    // An all-zero-qty order stays 'received' — the machine has no received->CLOSE edge, so such
    // an order is CANCELLED, not closed (./cancel-inbound.ts). It still gets the GRN and
    // 'wms.inbound.received' event below like any other order reaching 'received' — see
    // SCR-WMS-INB-01 §6 (WAITING_GM) for whether that stands.
    const unreceipted = await deps.repo.countUnreceiptedLines(tx, input.orderId);
    const isLastLine = unreceipted === 0;
    const events = [receiptEvent, ...(isLastLine ? [INBOUND_ORDER_EVENTS.RECEIVE_LINE_LAST] : [])];
    const finalStatus = advanceInboundOrder(order.status, events);
    const occurredAt = deps.clock.now();

    // Step 6 — every ROW lock before the ledger (ADR-0002): the GRN doc_no allocation locks a
    // platform.counters row, so it happens here, never after the ledger's audit insert.
    let grnDocument: { readonly id: string; readonly docNo: string } | null = null;
    if (isLastLine) {
      const templateId = await deps.repo.getDocumentTemplateId(tx, GRN_TEMPLATE_CODE);
      const docNo = await deps.repo.nextDocNo(tx, order.entityId, GRN_DOC_TYPE);
      const snapshot = await deps.repo.getGrnSnapshotData(tx, input.orderId);
      // frozen snapshot — order fields + every line's sku/ordered/actual/uom/batch/expiry/
      // variance_reason. No location — put-away has not happened yet. A line's
      // variancePhotoUrl/variancePhotoSha256 are included ONLY when present, never as an
      // explicit null key.
      const renderedData = {
        docNo,
        clientId: snapshot.clientId,
        warehouse: snapshot.warehouseCode,
        arrivedAt: snapshot.arrivedAt,
        lines: snapshot.lines.map(({ variancePhotoUrl, variancePhotoSha256, ...line }) => ({
          ...line,
          ...(variancePhotoUrl !== null && variancePhotoSha256 !== null
            ? { variancePhotoUrl, variancePhotoSha256 }
            : {}),
        })),
      };
      const inserted = await deps.repo.insertGrnDocument(tx, {
        entityId: order.entityId,
        templateId,
        docNo,
        sourceId: input.orderId,
        renderedData,
        generatedBy: actorId,
      });
      grnDocument = { id: inserted.id, docNo };
    }

    // Step 7 — the reused ledger port, SKIPPED for a fully-short receipt.
    let movementIds: readonly string[] = [];
    if (!isFullyShort) {
      const rcvLocation = await deps.repo.pickRcvLocation(tx, order.warehouseId);
      const posted = await deps.ledger.postReceipt(
        tx,
        {
          entityId: order.entityId,
          clientId: order.clientId,
          skuId: line.skuId,
          toLocationId: rcvLocation.id,
          qty: input.qtyActual,
          batchNo: input.batchNo ?? line.batchNo ?? '',
          uom: line.uom,
          correlationId: input.correlationId,
          refId: input.orderId,
        },
        actorId,
        deps,
      );
      movementIds = posted.movementIds;
    }

    // Step 8 — the order just reached 'received' -> 'wms.inbound.received' (doc 40 §C3 line 262).
    if (grnDocument) {
      await writeOutboxEvent(tx, {
        entityId: order.entityId,
        aggregateType: INBOUND_ORDERS_AGGREGATE_TYPE,
        aggregateId: input.orderId,
        eventType: INBOUND_RECEIVED_EVENT_TYPE,
        payload: { orderId: input.orderId, docNo: grnDocument.docNo, documentId: grnDocument.id },
        correlationId: input.correlationId,
        actorId,
      });
      await deps.repo.writeAuditRow(tx, {
        entityId: order.entityId,
        target: 'order',
        recordId: input.orderId,
        operation: AUDIT_OPERATION_RECEIVED_EVENT,
        correlationId: input.correlationId,
        actorId,
        newValue: { status: finalStatus, docNo: grnDocument.docNo, documentId: grnDocument.id },
        occurredAt,
      });
    }

    // Step 8b — this receipt is a variance -> 'wms.inbound.variance'. The variance
    // REPORT DOCUMENT is deferred (it needs a template) — recorded here as a follow-up, not
    // invented.
    if (isVariance) {
      await writeOutboxEvent(tx, {
        entityId: order.entityId,
        aggregateType: ORDER_LINES_AGGREGATE_TYPE,
        aggregateId: input.lineId,
        eventType: INBOUND_VARIANCE_EVENT_TYPE,
        payload: {
          orderId: input.orderId,
          lineId: input.lineId,
          qtyOrdered: line.qtyOrdered,
          qtyActual: input.qtyActual,
          varianceReason: input.varianceReason ?? null,
        },
        correlationId: input.correlationId,
        actorId,
      });
      await deps.repo.writeAuditRow(tx, {
        entityId: order.entityId,
        target: 'line',
        recordId: input.lineId,
        operation: AUDIT_OPERATION_VARIANCE_EVENT,
        correlationId: input.correlationId,
        actorId,
        newValue: { qtyOrdered: line.qtyOrdered, qtyActual: input.qtyActual, varianceReason: input.varianceReason ?? null },
        occurredAt,
      });
    }

    // Step 9 — the unconditional version bump; arrived_at/received_by only on the very first
    // receipt for this order.
    const newVersion = await deps.repo.updateOrder(tx, input.orderId, {
      status: finalStatus,
      ...(isFirstReceipt ? { arrivedAt: occurredAt, receivedBy: actorId } : {}),
    });

    // Step 10 — the line's own audit row, last.
    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'line',
      recordId: input.lineId,
      operation: AUDIT_OPERATION_RECEIVE_LINE,
      correlationId: input.correlationId,
      actorId,
      newValue: { qtyActual: input.qtyActual, lineStatus: receiptLineStatus, orderStatus: finalStatus, version: newVersion },
      occurredAt,
    });

    return { orderStatus: finalStatus, lineStatus: receiptLineStatus, movementIds };
  });
}
