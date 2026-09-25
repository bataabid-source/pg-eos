// modules/wms/application/take-occupancy-snapshot/ports.ts — WBS 2.14 (lane 2).
//
// application/ layer: the ports this use case programs against. The one command
// (../../application/take-occupancy-snapshot/take-occupancy-snapshot.ts) takes ONE
// `deps: TakeOccupancySnapshotDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/take-occupancy-snapshot/repository.ts implements
// `OccupancySnapshotRepository`. ../../api/take-occupancy-snapshot/composition.ts wires it.
//
// D1 (brief): no `ledger` port here — this use case does not touch `wms.stock_movements`; it reads
// `wms.stock_balance`/`wms.locations`/`wms.space_allocations` and writes
// `wms.occupancy_snapshots`/`billing.billable_events` directly.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). `ids` is unused by this use case's own inserts (both
 *  `wms.occupancy_snapshots.id` and `billing.billable_events.id` default to `gen_random_uuid()`
 *  in the schema) — carried for parity with every other use case's `ClockDeps` shape. */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by
 *  ../../infrastructure/take-occupancy-snapshot/logger.ts (a @pg-eos/logger child-logger
 *  adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/take-occupancy-snapshot/composition.ts). The application layer programs only
 *  against these ports — it never imports infrastructure/. */
export interface TakeOccupancySnapshotDeps extends ClockDeps {
  readonly repo: OccupancySnapshotRepository;
  readonly logger: Logger;
}

/** brief CORRECTION/D2: one row per DISTINCT (client, location) the repository finds occupied (a
 *  positive `wms.stock_balance` row) in the target warehouse, EXCLUDING a location with
 *  `space_block_id is null` (a data-quality gap outside this slice's scope — never attributed to
 *  an arbitrary block). `spaceBlockId` is always a real, non-null block id: the grain this slice
 *  snapshots at is (client, space_block), per `occupancy_snapshots_grain_uq`. */
export interface ClientOccupiedLocationRow {
  readonly clientId: string;
  readonly locationType: string;
  readonly spaceBlockId: string;
}

/** brief CORRECTION/D3: a (client, space_block) pair's contracted pallet capacity — `sum(qty)
 *  where block_id = <this block>, uom='pallet', status='active'` and the snapshot date falls
 *  inside `[valid_from, valid_to]`. `wms.space_allocations.block_id` already ties the allocation
 *  to exactly one block, so no cross-block summing or separate warehouse scoping is needed — the
 *  block itself already pins the warehouse. */
export interface ClientContractedPalletsRow {
  readonly clientId: string;
  readonly blockId: string;
  readonly contractedPallets: number;
}

export interface UpsertSnapshotColumns {
  readonly entityId: string;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly snapshotDate: string;
  readonly palletsOccupied: number;
  readonly locationsUsed: number;
  readonly spaceBlockId: string;
}

export interface InsertBillableEventColumns {
  readonly entityId: string;
  readonly occurredAt: Date;
  readonly clientId: string;
  readonly serviceId: string;
  readonly qty: number;
  readonly sourceId: string;
}

/** Every DB statement the take-occupancy-snapshot use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/take-occupancy-snapshot/repository.ts. */
export interface OccupancySnapshotRepository {
  hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean>;
  /** brief D8/Facts: entity_id resolution is fail-closed, scoped through the warehouse itself (a
   *  `wms.warehouses` row not visible in the caller's own entities is indistinguishable from a
   *  missing one — same discipline as ../count-inventory/repository.ts's own
   *  getWarehouseEntityId). Throws WarehouseNotFoundError. */
  getWarehouseEntityId(tx: NodePgDatabase, warehouseId: string): Promise<string>;
  /** brief Facts: `catalog.services` id for a code ('ST-01'/'ST-12') — looked up, never inserted
   *  (both are pre-seeded at 13B). Throws ServiceNotFoundError. */
  getServiceIdByCode(tx: NodePgDatabase, code: string): Promise<string>;
  /** brief CORRECTION/D2: one row per DISTINCT (client, location, space_block) with a positive
   *  `wms.stock_balance` row in the warehouse, excluding locations with no `space_block_id` —
   *  never one row per SKU/batch (a location with several SKUs for the same client still counts
   *  once). */
  getOccupiedLocationsByClient(tx: NodePgDatabase, warehouseId: string): Promise<readonly ClientOccupiedLocationRow[]>;
  /** brief CORRECTION/D3: one row per (client, block) pair with at least one active pallet-uom
   *  allocation covering `snapshotDate`, already summed. A (client, block) pair with no matching
   *  row has contracted = 0 (the application layer's own lookup, not this method). */
  getContractedPalletsByClient(
    tx: NodePgDatabase,
    params: { readonly warehouseId: string; readonly snapshotDate: string },
  ): Promise<readonly ClientContractedPalletsRow[]>;
  /** Round-1 review finding 2 resolution: `on conflict (snapshot_date, entity_id, client_id,
   *  warehouse_id, space_block_id) do nothing` — the FIRST snapshot of a (day, client, block)
   *  stands permanently; a same-day re-run is a genuine no-op. Returns the row that now stands
   *  (the one just inserted, or the pre-existing one on conflict) INCLUDING its `palletsOccupied`/
   *  `locationsUsed` — the caller must price billing rows off these frozen values, never off the
   *  freshly recomputed ones, so a no-op path never drifts billing.billable_events out of sync
   *  with the snapshot it traces back to. Round-2 review finding 1: `created` tells the caller
   *  whether THIS call's own insert won the race (`true`, `RETURNING` gave back a row) or the
   *  conflict branch fired and an already-standing row was fetched instead (`false`) — the caller
   *  must skip BOTH billing inserts entirely when `created` is false, since `contracted` (the
   *  allocation sum) is read fresh every call and is not itself frozen on the snapshot row. */
  upsertSnapshot(
    tx: NodePgDatabase,
    columns: UpsertSnapshotColumns,
  ): Promise<{
    readonly id: string;
    readonly palletsOccupied: number;
    readonly locationsUsed: number;
    readonly created: boolean;
  }>;
  /** brief D4/D5: `on conflict (source_table, source_id, service_id) do nothing` — the table's own
   *  unique index is the idempotency mechanism, not a hand-rolled check. */
  insertBillableEvent(tx: NodePgDatabase, columns: InsertBillableEventColumns): Promise<void>;
  /** Round-3 review finding 2: read-only — whether a `billing.billable_events` row already stands
   *  for `(source_table='wms.occupancy_snapshots', source_id, service_id)` (the same natural key
   *  `insertBillableEvent`'s own `on conflict` targets). On a re-run (`upsertSnapshot` returned
   *  `created: false`) the caller derives "in overflow" from whether the ST-12 row exists, never
   *  from a freshly-read `contracted`, so the reported count matches the billing rows that stand. */
  hasBillableEvent(
    tx: NodePgDatabase,
    params: { readonly sourceId: string; readonly serviceId: string },
  ): Promise<boolean>;
  /** brief D8: ONE row for the whole call — `recordId` is `null` (no single
   *  `wms.occupancy_snapshots` row represents the whole multi-client batch; the summary lives in
   *  `newValue`). */
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}
