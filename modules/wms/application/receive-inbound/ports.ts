// modules/wms/application/receive-inbound/ports.ts — WBS 2.9, THE GOLDEN SLICE.
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: ReceiveInboundDeps` (clock, ids, repo, ledger) and never imports infrastructure/.
// ../../infrastructure/receive-inbound/repository.ts implements `InboundOrderRepository`;
// ../../infrastructure/receive-inbound/ledger.ts implements `LedgerPort` (an adapter over the
// module's transaction-scoped stock ledger). ../../api/receive-inbound/composition.ts wires them.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN two interfaces named after its
// own aggregate — do not import this file from another use case.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { InboundOrderStatus } from '../../domain/receive-inbound/machine.js';
import type { RankableLocationCandidate } from '../../domain/receive-inbound/suggest-location-ranking.js';

/** The clock and id generator every command and the ledger port need (injected — domain-kit
 *  adapters in production, fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/receive-inbound/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface ReceiveInboundDeps extends ClockDeps {
  readonly repo: InboundOrderRepository;
  readonly ledger: LedgerPort;
}

/** What an audit row is about: the aggregate row itself, or one of its lines. The adapter maps
 *  this to schema_name/table_name — the application layer never names a table. */
export type AuditTarget = 'order' | 'line';

/** The ledger rows one posting wrote. */
export interface PostedLedgerMovement {
  readonly movementIds: readonly string[];
  readonly correlationId: string;
}

export interface OrderRow {
  readonly id: string;
  readonly entityId: string;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly status: InboundOrderStatus;
  readonly version: number;
}

export interface OrderLineRow {
  readonly id: string;
  readonly orderId: string;
  readonly skuId: string;
  readonly qtyOrdered: string;
  readonly qtyActual: string | null;
  readonly uom: string;
  readonly batchNo: string | null;
  readonly status: string;
  readonly locationId: string | null;
}

export interface SuggestLocationCandidateRow extends RankableLocationCandidate {
  readonly code: string;
  readonly locationType: string;
}

export interface OrderUpdateColumns {
  readonly status: InboundOrderStatus;
  readonly arrivedAt?: Date;
  readonly receivedBy?: string;
  readonly closedAt?: Date;
  readonly closedBy?: string;
}

/** Every DB statement the receive-inbound use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/receive-inbound/repository.ts. */
export interface InboundOrderRepository {
  /** order-row lock, FIRST — `select ... for update`. */
  getOrderForUpdate(tx: NodePgDatabase, orderId: string): Promise<OrderRow>;
  /** unconditional version bump — the caller already validated expectedVersion against the
   *  locked row and holds that lock for the whole transaction, so this never races. */
  updateOrder(tx: NodePgDatabase, orderId: string, columns: OrderUpdateColumns): Promise<number>;
  /** line bound to its order AND locked — `select ... where id=$1 and order_id=$2 ...
   *  for update`. Throws LineNotFoundError when no row matches. */
  getOrderLineForUpdate(tx: NodePgDatabase, orderId: string, lineId: string): Promise<OrderLineRow>;
  /** the re-entry guard is IN the WHERE clause (`qty_actual is null`) — zero rows updated
   *  means the caller should already have caught this via the locked row's own state, but this is
   *  the atomic backstop. Returns true iff a row was updated. */
  updateLineReceipt(
    tx: NodePgDatabase,
    params: {
      readonly lineId: string;
      readonly qtyActual: string;
      readonly batchNo: string | null;
      readonly expiryDate: string | null;
      readonly varianceReason: string | null;
      readonly status: string;
    },
  ): Promise<boolean>;
  /** same pattern — `where status <> 'complete' and location_id is null`. */
  updateLineLocation(
    tx: NodePgDatabase,
    params: { readonly lineId: string; readonly locationId: string; readonly status: string },
  ): Promise<boolean>;
  countUnreceiptedLines(tx: NodePgDatabase, orderId: string): Promise<number>;
  hasBlockingOpenLines(tx: NodePgDatabase, orderId: string): Promise<boolean>;
  pickRcvLocation(tx: NodePgDatabase, warehouseId: string): Promise<{ readonly id: string }>;
  findRcvBalanceLocation(
    tx: NodePgDatabase,
    params: { readonly warehouseId: string; readonly clientId: string; readonly skuId: string; readonly batchNo: string },
  ): Promise<{ readonly id: string } | null>;
  suggestLocationCandidatesQuery(
    tx: NodePgDatabase,
    params: { readonly skuId: string; readonly qty: string; readonly warehouseId: string; readonly clientId: string },
  ): Promise<readonly SuggestLocationCandidateRow[]>;
  getSkuClientId(tx: NodePgDatabase, skuId: string): Promise<string>;
  hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean>;
  getDocumentTemplateId(tx: NodePgDatabase, templateCode: string): Promise<string>;
  nextDocNo(tx: NodePgDatabase, entityId: string, docType: string): Promise<string>;
  insertGrnDocument(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly templateId: string;
      readonly docNo: string;
      readonly sourceId: string;
      readonly renderedData: unknown;
      readonly generatedBy: string;
    },
  ): Promise<{ readonly id: string }>;
  /** doc 40 §C3 order snapshot for the GRN — order fields plus every line's SKU code. */
  getGrnSnapshotData(
    tx: NodePgDatabase,
    orderId: string,
  ): Promise<{
    readonly docNo: string;
    readonly clientId: string;
    readonly warehouseCode: string;
    readonly arrivedAt: string | null;
    readonly lines: ReadonlyArray<{
      readonly skuCode: string;
      readonly qtyOrdered: string;
      readonly qtyActual: string | null;
      readonly uom: string;
      readonly batchNo: string | null;
      readonly expiryDate: string | null;
      readonly varianceReason: string | null;
    }>;
  }>;
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly target: AuditTarget;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}

/** a thin port over ../../src/stock-ledger's reused, transaction-scoped mechanism — the
 *  application layer never imports modules/wms/src/stock-ledger directly. Implemented by
 *  ../../infrastructure/receive-inbound/ledger.ts. */
export interface LedgerPort {
  postReceipt(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly clientId: string;
      readonly skuId: string;
      readonly toLocationId: string;
      readonly qty: string;
      readonly batchNo: string;
      readonly uom: string;
      readonly correlationId: string;
      readonly refId: string;
    },
    actorId: string,
    deps: ClockDeps,
  ): Promise<PostedLedgerMovement>;
  postPutawayTransfer(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly clientId: string;
      readonly skuId: string;
      readonly qty: string;
      readonly batchNo: string;
      readonly uom: string;
      readonly fromLocationId: string;
      readonly toLocationId: string;
      readonly correlationId: string;
      readonly refId: string;
    },
    actorId: string,
    deps: ClockDeps,
  ): Promise<PostedLedgerMovement>;
}
