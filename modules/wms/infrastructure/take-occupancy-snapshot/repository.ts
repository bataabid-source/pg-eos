// modules/wms/infrastructure/take-occupancy-snapshot/repository.ts — WBS 2.14 (lane 2).
//
// infrastructure/ layer: every DB statement for the take-occupancy-snapshot use case, run against
// the `tx` the caller's own withContext(ctx, fn)/withIdempotentContext already opened. Implements
// ../../application/take-occupancy-snapshot/ports.ts's `OccupancySnapshotRepository`.
//
// Cross-module reads via raw SQL, no TypeScript import (precedent: modules/sales/application/
// resolve-price/*, WBS 1.4; brief Read ONLY list): this file reads `sales.contracts`/
// `wms.space_allocations`/`catalog.services` and writes `billing.billable_events` directly — never
// a `modules/billing` import.
//
// LOCK ORDER: this use case takes NO row lock of its own — every statement is an insert, upsert
// (on conflict), or a plain read. `wms.occupancy_snapshots` carries no version column (brief D1:
// a derived, idempotently-upserted daily row, not a user-edited aggregate), so there is no
// "getXForUpdate" step here, unlike ../count-inventory/repository.ts's own lock order.

const SNAPSHOT_SCHEMA = 'wms';
const SNAPSHOT_TABLE_NAME = 'occupancy_snapshots';
const SNAPSHOT_TABLE = `${SNAPSHOT_SCHEMA}.${SNAPSHOT_TABLE_NAME}`;
const BILLING_SOURCE_MODULE = 'wms';
const BILLING_STATUS_PENDING = 'pending';
const PALLET_UOM = 'pallet';
const ALLOC_STATUS_ACTIVE = 'active';
const AUDIT_ACTOR_TYPE_USER = 'user';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { ServiceNotFoundError, WarehouseNotFoundError } from '../../domain/take-occupancy-snapshot/errors.js';
import type {
  ClientContractedPalletsRow,
  ClientOccupiedLocationRow,
  InsertBillableEventColumns,
  OccupancySnapshotRepository,
  UpsertSnapshotColumns,
} from '../../application/take-occupancy-snapshot/ports.js';

async function hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roleCodes.some((roleCode) => roles.includes(roleCode));
}

/** brief D8/Facts: fail-closed — a `wms.warehouses` row not visible in the caller's own entities
 *  (`platform.allowed_entities()`) is indistinguishable from a missing one (finding 11 of
 *  ../count-inventory/repository.ts: `wms.warehouses` is reference_read, readable cross-entity by
 *  RLS, so this filter must be explicit or a foreign warehouse would only fail later, as an
 *  untyped 500, at some other table's RLS WITH CHECK). */
async function getWarehouseEntityId(tx: NodePgDatabase, warehouseId: string): Promise<string> {
  const result = await tx.execute<{ entity_id: string }>(
    sql`select entity_id from wms.warehouses
         where id = ${warehouseId}::uuid and entity_id = any(platform.allowed_entities())`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new WarehouseNotFoundError(
      `no wms.warehouses row visible for id ${warehouseId} in the caller's entities. ` +
        `(Allowed: an existing warehouse in one of the caller's own entities)`,
    );
  }
  return row.entity_id;
}

async function getServiceIdByCode(tx: NodePgDatabase, code: string): Promise<string> {
  const result = await tx.execute<{ id: string }>(sql`select id from catalog.services where code = ${code}`);
  const row = result.rows[0];
  if (!row) {
    throw new ServiceNotFoundError(
      `no catalog.services row for code ${code} — expected pre-seeded at 13B. (Allowed: an existing catalog.services code)`,
    );
  }
  return row.id;
}

/** brief CORRECTION/D2: one row per DISTINCT (client, location, space_block) with a positive
 *  `wms.stock_balance` row in the warehouse — `select distinct` on (client_id, location id)
 *  dedupes across several SKUs/batches sharing the same location for the same client. A location
 *  with `space_block_id is null` is excluded entirely (a data-quality gap outside this slice's
 *  scope, never attributed to an arbitrary block). */
async function getOccupiedLocationsByClient(
  tx: NodePgDatabase,
  warehouseId: string,
): Promise<readonly ClientOccupiedLocationRow[]> {
  const result = await tx.execute<{ client_id: string; location_type: string; space_block_id: string }>(sql`
    select distinct sb.client_id, l.id as location_id, l.location_type, l.space_block_id
      from wms.stock_balance sb
      join wms.locations l on l.id = sb.location_id
     where l.warehouse_id = ${warehouseId}::uuid and sb.qty_on_hand > 0
       and l.space_block_id is not null
  `);
  return result.rows.map((row) => ({
    clientId: row.client_id,
    locationType: row.location_type,
    spaceBlockId: row.space_block_id,
  }));
}

/** brief CORRECTION/D3: a (client, block) pair's contracted pallet capacity — `sum(qty) where
 *  block_id = <this block>, uom='pallet', status='active'` and the snapshot date falls inside
 *  `[valid_from, valid_to]`. `wms.space_allocations.block_id` already ties the allocation to
 *  exactly one block, so grouping by `(sa.client_id, sa.block_id)` gives the SAME block's own
 *  contracted capacity directly — no cross-block summing, and the `wms.space_blocks` join is only
 *  to scope to the target warehouse's own blocks (the block id itself already pins the
 *  warehouse). */
async function getContractedPalletsByClient(
  tx: NodePgDatabase,
  params: { readonly warehouseId: string; readonly snapshotDate: string },
): Promise<readonly ClientContractedPalletsRow[]> {
  const result = await tx.execute<{ client_id: string; block_id: string; contracted: string }>(sql`
    select sa.client_id, sa.block_id, sum(sa.qty)::text as contracted
      from wms.space_allocations sa
      join wms.space_blocks sb on sb.id = sa.block_id
     where sb.warehouse_id = ${params.warehouseId}::uuid
       and sa.uom = ${PALLET_UOM}
       and sa.status = ${ALLOC_STATUS_ACTIVE}
       and sa.valid_from <= ${params.snapshotDate}::date
       and (sa.valid_to is null or sa.valid_to >= ${params.snapshotDate}::date)
     group by sa.client_id, sa.block_id
  `);
  return result.rows.map((row) => ({
    clientId: row.client_id,
    blockId: row.block_id,
    contractedPallets: Number(row.contracted),
  }));
}

/** Round-1 review finding 2 resolution: the live unique constraint is `occupancy_snapshots_grain_uq
 *  (snapshot_date, entity_id, client_id, warehouse_id, space_block_id)` — one row per (client,
 *  space_block). `ON CONFLICT ... DO NOTHING` (not `DO UPDATE`): the FIRST snapshot of a given
 *  (day, client, block) stands permanently, so a same-day re-run never lets `pallets_occupied`
 *  drift out of step with the (also frozen, `ON CONFLICT DO NOTHING`) ST-01/ST-12 billing rows
 *  that already trace back to this row's id (`billing.billable_events`'s own "every event traces
 *  back to its own operation" invariant). `INSERT ... ON CONFLICT DO NOTHING RETURNING *` returns
 *  no row on a conflict, so the conflict path falls back to a plain `SELECT` by the natural key to
 *  fetch the row that already stands, INCLUDING its `pallets_occupied`/`locations_used` — the
 *  caller prices billing rows off these (possibly pre-existing) values, never off the freshly
 *  recomputed ones. `sqm_occupied`/`cbm_occupied` are left at the column's own default (brief D2 —
 *  not computed this slice).
 *
 *  Round-2 review finding 1: `created` reports whether THIS call's own `RETURNING` clause got a row
 *  back (`true`) or the conflict branch fired (`false`) — `contracted` (the allocation sum) is
 *  never stored on the snapshot row, so the caller must use `created` to skip BOTH billing inserts
 *  on a re-run, not just freeze `palletsOccupied`. */
async function upsertSnapshot(
  tx: NodePgDatabase,
  columns: UpsertSnapshotColumns,
): Promise<{
  readonly id: string;
  readonly palletsOccupied: number;
  readonly locationsUsed: number;
  readonly created: boolean;
}> {
  const inserted = await tx.execute<{ id: string; pallets_occupied: string; locations_used: number }>(sql`
    insert into ${sql.raw(SNAPSHOT_TABLE)}
      (snapshot_date, entity_id, client_id, warehouse_id, pallets_occupied, locations_used, space_block_id)
    values
      (${columns.snapshotDate}::date, ${columns.entityId}::uuid, ${columns.clientId}::uuid,
       ${columns.warehouseId}::uuid, ${columns.palletsOccupied}::numeric, ${columns.locationsUsed},
       ${columns.spaceBlockId}::uuid)
    on conflict (snapshot_date, entity_id, client_id, warehouse_id, space_block_id)
    do nothing
    returning id, pallets_occupied, locations_used
  `);
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    return {
      id: insertedRow.id,
      palletsOccupied: Number(insertedRow.pallets_occupied),
      locationsUsed: Number(insertedRow.locations_used),
      created: true,
    };
  }

  // Conflict: the FIRST snapshot of this (day, client, block) already stands — fetch it by the
  // same natural key (occupancy_snapshots_grain_uq) rather than treating the no-op as an error.
  const existing = await tx.execute<{ id: string; pallets_occupied: string; locations_used: number }>(sql`
    select id, pallets_occupied, locations_used
      from ${sql.raw(SNAPSHOT_TABLE)}
     where snapshot_date = ${columns.snapshotDate}::date
       and entity_id = ${columns.entityId}::uuid
       and client_id = ${columns.clientId}::uuid
       and warehouse_id = ${columns.warehouseId}::uuid
       and space_block_id = ${columns.spaceBlockId}::uuid
  `);
  const existingRow = existing.rows[0];
  if (!existingRow) {
    throw new Error(`no-op insert into ${SNAPSHOT_TABLE} (on conflict do nothing) but no existing row found`);
  }
  return {
    id: existingRow.id,
    palletsOccupied: Number(existingRow.pallets_occupied),
    locationsUsed: Number(existingRow.locations_used),
    created: false,
  };
}

/** brief D4/D5: `source_table = 'wms.occupancy_snapshots'`, `source_id` = the snapshot row's own
 *  id (shared by both the ST-01 and ST-12 rows of one snapshot — `service_id` is what keeps them
 *  distinct in the table's own unique index). `on conflict (source_table, source_id, service_id)
 *  do nothing` is the table's own idempotency mechanism, not a hand-rolled check.
 *  `unit_price`/`price_source`/`price_ref_id`/`amount` all stay null — priced at month-end. */
async function insertBillableEvent(tx: NodePgDatabase, columns: InsertBillableEventColumns): Promise<void> {
  await tx.execute(sql`
    insert into billing.billable_events
      (entity_id, occurred_at, client_id, service_id, qty, uom, source_module, source_table, source_id, status)
    values
      (${columns.entityId}::uuid, ${columns.occurredAt.toISOString()}::timestamptz, ${columns.clientId}::uuid,
       ${columns.serviceId}::uuid, ${columns.qty}::numeric, ${PALLET_UOM}, ${BILLING_SOURCE_MODULE},
       ${SNAPSHOT_TABLE}, ${columns.sourceId}::uuid, ${BILLING_STATUS_PENDING})
    on conflict (source_table, source_id, service_id) do nothing
  `);
}

/** Round-3 review finding 2: a read-only probe of the SAME natural key `insertBillableEvent`'s own
 *  `on conflict (source_table, source_id, service_id)` targets — does a billing row already stand
 *  for this snapshot and service? Used on a re-run (`upsertSnapshot` returned `created: false`) so
 *  the reported overflow reflects the ST-12 row a PRIOR call actually wrote, never a fresh
 *  recomputation against a since-changed allocation. */
async function hasBillableEvent(
  tx: NodePgDatabase,
  params: { readonly sourceId: string; readonly serviceId: string },
): Promise<boolean> {
  const result = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from billing.billable_events
       where source_table = ${SNAPSHOT_TABLE}
         and source_id = ${params.sourceId}::uuid
         and service_id = ${params.serviceId}::uuid
    ) as found
  `);
  return result.rows[0]?.found === true;
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the outbox row this
 *  call also writes (G9). Brief D8: ONE row for the whole call — `record_id` is null (no single
 *  `wms.occupancy_snapshots` row represents a multi-client batch; the summary lives in
 *  `new_value`). `occurredAt` is mandatory (always from the injected Clock, never the column's own
 *  `default now()`). */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly operation: string;
    readonly correlationId: string;
    readonly actorId: string;
    readonly newValue: unknown;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${SNAPSHOT_SCHEMA}, ${SNAPSHOT_TABLE_NAME}, null,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const occupancySnapshotRepository: OccupancySnapshotRepository = {
  hasAnyRole,
  getWarehouseEntityId,
  getServiceIdByCode,
  getOccupiedLocationsByClient,
  getContractedPalletsByClient,
  upsertSnapshot,
  insertBillableEvent,
  hasBillableEvent,
  writeAuditRow,
};

export { SNAPSHOT_SCHEMA, SNAPSHOT_TABLE_NAME, SNAPSHOT_TABLE };
