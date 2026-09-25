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

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/receive-inbound/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/receive-inbound/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface ReceiveInboundDeps extends ClockDeps {
  readonly repo: InboundOrderRepository;
  readonly ledger: LedgerPort;
  readonly logger: Logger;
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

/** WBS 2.9b round-1 review finding 2: the columns ApproveInbound's optional appointment-slot path
 *  (D2, ../../application/receive-inbound/approve-inbound.ts) writes — the same
 *  expected_at/scheduled_by/scheduled_at/dock_code + four-logistics-term shape as
 *  ../../application/schedule-inbound/schedule-inbound.ts's own update, WITHOUT touching `version`
 *  a second time (the caller already bumped it via `updateOrder` in the same transaction). Every
 *  optional field is coalesce()-preserved against the existing stored value when omitted, mirroring
 *  `updateOrder`'s own coalesce() style. */
export interface OrderScheduleAndTermsUpdateColumns {
  readonly expectedAt: Date;
  readonly scheduledBy: string;
  readonly scheduledAt: Date;
  readonly dockCode?: string | undefined | null;
  readonly handoverPoint?: string | undefined | null;
  readonly transportBy?: string | undefined | null;
  readonly vehicleType?: string | undefined | null;
  readonly labourBy?: string | undefined | null;
  readonly labourCount?: number | undefined | null;
}

/** The RETURNING row of `updateOrderScheduleAndTerms` — the actual stored values (post-coalesce),
 *  used to build the `wms.inbound.scheduled` event payload and the audit `newValue` (round-1 review
 *  finding 6 — never built from raw `input`). `expectedAt` is a Date (round-2 review finding 7) —
 *  the caller serialises it with `.toISOString()`, the same canonical ISO 8601 format
 *  ../schedule-inbound/ports.ts's `ScheduleInboundUpdateResult` already yields, so
 *  `wms.inbound.scheduled` carries one timestamp format whichever command emits it. */
export interface OrderScheduleAndTermsUpdateResult {
  readonly expectedAt: Date;
  readonly dockCode: string | null;
  readonly handoverPoint: string | null;
  readonly transportBy: string | null;
  readonly vehicleType: string | null;
  readonly labourBy: string | null;
  readonly labourCount: number | null;
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
  /** WBS 2.9b round-1 review finding 2: ApproveInbound's optional appointment-slot path (D2) goes
   *  through this port method instead of a raw `tx.execute()` in the application layer — no version
   *  increment here (the caller already bumped it via `updateOrder` in the same transaction, before
   *  calling this). Returns the RETURNING row (finding 6 — event/audit payloads built from the
   *  actual stored values). */
  updateOrderScheduleAndTerms(
    tx: NodePgDatabase,
    orderId: string,
    columns: OrderScheduleAndTermsUpdateColumns,
  ): Promise<OrderScheduleAndTermsUpdateResult>;
  /** WBS 2.9b round-1 review finding 2: CancelInbound's `cancel_reason` persistence (D3) goes
   *  through this port method instead of a raw `tx.execute()` in the application layer — no version
   *  increment here (the caller already bumped it via `updateOrder` in the same transaction, before
   *  calling this). */
  updateOrderCancelReason(tx: NodePgDatabase, orderId: string, cancelReason: string): Promise<void>;
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
      /** Both null or both set — the contract and assertVariancePhotoRequiresVariance both
       *  enforce this before the write is attempted (SCR-WMS-INB-01 §4). */
      readonly variancePhotoUrl: string | null;
      readonly variancePhotoSha256: string | null;
      readonly status: string;
    },
  ): Promise<boolean>;
  /** same pattern — `where status <> 'complete' and location_id is null`. */
  updateLineLocation(
    tx: NodePgDatabase,
    params: { readonly lineId: string; readonly locationId: string; readonly status: string },
  ): Promise<boolean>;
  countUnreceiptedLines(tx: NodePgDatabase, orderId: string): Promise<number>;
  /** SCR-WMS-INB-01 §6: every line's qty_actual, called only once the order's last line has just
   *  been receipted (so every value is non-null) — taken under the order-row lock already held,
   *  no new lock. */
  getAllLineQtyActual(tx: NodePgDatabase, orderId: string): Promise<readonly string[]>;
  hasBlockingOpenLines(tx: NodePgDatabase, orderId: string): Promise<boolean>;
  /** CancelInbound's own business rule (SCR-WMS-INB-01 §1/§3): true iff any line of the order
   *  already has qty_actual > 0 — stock has physically moved and the order may no longer be
   *  cancelled. */
  hasPhysicallyReceivedLines(tx: NodePgDatabase, orderId: string): Promise<boolean>;
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
      /** Null when the line carries no variance photo; the caller (./receive-line.ts) includes
       *  these keys in the rendered GRN snapshot ONLY when both are non-null (SCR-WMS-INB-01 §4,
       *  §6). */
      readonly variancePhotoUrl: string | null;
      readonly variancePhotoSha256: string | null;
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
