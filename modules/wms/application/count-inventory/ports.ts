// modules/wms/application/count-inventory/ports.ts — WBS 2.13 (lane 2).
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: CountInventoryDeps` (clock, ids, repo, ledger, logger) and never imports
// infrastructure/. ../../infrastructure/count-inventory/repository.ts implements
// `InventoryCountRepository`; ../../infrastructure/count-inventory/ledger.ts implements
// `LedgerPort` (a thin adapter over the module's transaction-scoped stock ledger, brief Facts).
// ../../api/count-inventory/composition.ts wires them.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { InventoryCountStatus } from '../../domain/count-inventory/machine.js';

/** The clock and id generator every command and the ledger port need (injected — domain-kit
 *  adapters in production, fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/count-inventory/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/count-inventory/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface CountInventoryDeps extends ClockDeps {
  readonly repo: InventoryCountRepository;
  readonly ledger: LedgerPort;
  readonly logger: Logger;
}

/** What an audit row is about: the count row itself, or one of its lines. The adapter maps this
 *  to schema_name/table_name — the application layer never names a table. */
export type AuditTarget = 'count' | 'line';

/** The ledger rows one posting wrote. */
export interface PostedLedgerMovement {
  readonly movementIds: readonly string[];
  readonly correlationId: string;
}

export interface CountRow {
  readonly id: string;
  readonly entityId: string;
  readonly warehouseId: string;
  readonly clientId: string | null;
  readonly status: InventoryCountStatus;
  readonly version: number;
}

export interface CountLineRow {
  readonly id: string;
  readonly countId: string;
  readonly locationId: string;
  readonly skuId: string;
  readonly batchNo: string | null;
  readonly qtySystem: string;
  readonly qtyCounted: string | null;
  readonly recountQty: string | null;
}

export interface StockSnapshotRow {
  readonly locationId: string;
  readonly skuId: string;
  readonly batchNo: string;
  readonly qtySystem: string;
}

export interface CountInsertColumns {
  readonly entityId: string;
  readonly docNo: string;
  readonly warehouseId: string;
  readonly clientId: string | null;
  readonly countType: string;
  readonly status: InventoryCountStatus;
  readonly startedAt: Date;
  readonly countedBy: string;
}

export interface CountLineInsertColumns {
  readonly locationId: string;
  readonly skuId: string;
  readonly batchNo: string;
  readonly qtySystem: string;
}

export interface CountUpdateColumns {
  readonly status: InventoryCountStatus;
  readonly version: number;
  readonly finishedAt?: Date;
  readonly approvedBy?: string;
}

/** Every DB statement the count-inventory use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/count-inventory/repository.ts. */
export interface InventoryCountRepository {
  hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean>;
  /** throws WarehouseNotFoundError when no wms.warehouses row is visible for the id, OR when the
   *  id resolves to a warehouse in an entity outside platform.allowed_entities() (finding 11 —
   *  wms.warehouses is reference_read, readable cross-entity; without this filter a foreign
   *  warehouse would pass this lookup and only fail later at the RLS WITH CHECK on the INSERT,
   *  surfacing as an untyped 500). */
  getWarehouseEntityId(tx: NodePgDatabase, warehouseId: string): Promise<string>;
  nextDocNo(tx: NodePgDatabase, entityId: string, docType: string): Promise<string>;
  /** brief D6: every (location, sku, batch_no) combination in the warehouse with a non-zero
   *  wms.stock_balance, filtered to `locationIds`/`skuIds` when both are supplied (cycle/spot),
   *  and to `clientId` when supplied (finding 10 — a client-scoped count must not pick up other
   *  clients' SKUs). */
  snapshotStockForCount(
    tx: NodePgDatabase,
    params: {
      readonly warehouseId: string;
      readonly locationIds?: readonly string[] | undefined;
      readonly skuIds?: readonly string[] | undefined;
      readonly clientId?: string | undefined;
    },
  ): Promise<readonly StockSnapshotRow[]>;
  insertCount(tx: NodePgDatabase, columns: CountInsertColumns): Promise<{ readonly id: string; readonly version: number }>;
  insertCountLines(tx: NodePgDatabase, countId: string, lines: readonly CountLineInsertColumns[]): Promise<void>;
  /** count-row lock, FIRST (brief D3) — `select ... for update`. Throws CountNotFoundError. */
  getCountForUpdate(tx: NodePgDatabase, countId: string): Promise<CountRow>;
  /** unconditional version bump — the caller already validated expectedVersion (AdjustCount) or
   *  computed the new status itself, and holds the count-row lock for the whole transaction. */
  updateCountStatus(tx: NodePgDatabase, countId: string, columns: CountUpdateColumns): Promise<number>;
  /** a quick, UNLOCKED read of a line's own count_id — used only to learn which parent count row
   *  to lock next (brief Facts: a line is reached only through its parent). JOINS to the
   *  entity-scoped `wms.inventory_counts` row so RLS actually filters (finding 5 — the line table
   *  itself has no entity_id / is internal_only RLS; a bare `select ... where id = $1` against it
   *  would leak cross-entity row EXISTENCE as an oracle between "foreign entity" and "truly
   *  missing"). Throws ONE LineNotFoundError for both cases. */
  findLineCountId(tx: NodePgDatabase, lineId: string): Promise<string>;
  /** line bound to its (already-locked) parent count — `select ... where id=$1 and count_id=$2
   *  for update`. Throws LineNotFoundError. */
  getLineForUpdate(tx: NodePgDatabase, countId: string, lineId: string): Promise<CountLineRow>;
  /** the re-entry guard is IN the WHERE clause (`qty_counted is null`) — the atomic backstop
   *  behind the locked-row check the caller already made. `countId` is defence-in-depth (finding
   *  5) — the caller always already holds the parent count's lock, but the WHERE clause repeats
   *  the binding rather than trusting `lineId` alone. Returns true iff a row was updated. */
  updateLineQtyCounted(tx: NodePgDatabase, countId: string, lineId: string, qtyCounted: string): Promise<boolean>;
  /** same pattern — `where recount_qty is null`, `countId` defence-in-depth. */
  updateLineRecountQty(tx: NodePgDatabase, countId: string, lineId: string, recountQty: string): Promise<boolean>;
  /** every line's qty_counted flag, for isCountComplete (P3). */
  getLineCountedFlags(tx: NodePgDatabase, countId: string): Promise<ReadonlyArray<{ readonly qtyCounted: string | null }>>;
  /** every variant line (qty_counted set, variance <> 0) with whether it has been recounted yet —
   *  used to decide the recount -> review auto-transition (brief D1). */
  getVariantLineRecountFlags(tx: NodePgDatabase, countId: string): Promise<ReadonlyArray<{ readonly recounted: boolean }>>;
  /** every line of the count, for AdjustCount's own iteration (brief D5). */
  getLinesForAdjustment(tx: NodePgDatabase, countId: string): Promise<readonly CountLineRow[]>;
  /** brief Facts: the clientId postMovementInTx needs comes from the line's own sku_id ->
   *  skus.client_id join, NEVER from inventory_counts.client_id. */
  getSkuClientId(tx: NodePgDatabase, skuId: string): Promise<string>;
  /** finding 9: the uom of the MOST RECENT wms.stock_movements row for this exact
   *  (client, sku, location, batch) combination — a wms.stock_balance row cannot exist without at
   *  least one prior movement (G1), so this should never be null in practice; returns `null`
   *  rather than fabricating a default when it is. */
  getLatestMovementUom(
    tx: NodePgDatabase,
    params: {
      readonly clientId: string;
      readonly skuId: string;
      readonly locationId: string;
      readonly batchNo: string;
    },
  ): Promise<string | null>;
  /** `countId` is defence-in-depth (finding 5), matching updateLineQtyCounted/updateLineRecountQty. */
  setLineAdjustedMovementId(tx: NodePgDatabase, countId: string, lineId: string, movementId: string): Promise<void>;
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
 *  ../../infrastructure/count-inventory/ledger.ts. */
export interface LedgerPort {
  /** brief D5: movement_type 'adjust', ref_table 'wms.inventory_count_lines', ref_id = the
   *  line's own id; exactly one of fromLocationId/toLocationId is set, per `direction`
   *  ('outflow' -> fromLocationId, 'inflow' -> toLocationId), both at the line's own locationId. */
  postAdjustment(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly clientId: string;
      readonly skuId: string;
      readonly locationId: string;
      readonly direction: 'inflow' | 'outflow';
      readonly qty: string;
      /** finding 9: looked up by the caller (adjust-count.ts) via
       *  repo.getLatestMovementUom — never fabricated here. */
      readonly uom: string;
      readonly batchNo: string;
      readonly correlationId: string;
      readonly refId: string;
    },
    actorId: string,
    deps: ClockDeps,
  ): Promise<PostedLedgerMovement>;
}
