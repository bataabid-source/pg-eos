// modules/wms/infrastructure/count-inventory/repository.ts — WBS 2.13 (lane 2).
//
// infrastructure/ layer: every DB statement for the count-inventory use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/count-inventory/ports.ts's `InventoryCountRepository`.
//
// LOCK ORDER — the one every command follows (see each command file's own header):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's
//      own input carries an `idem` (every write command here does).
//   1. getCountForUpdate — `select ... for update` on the ONE parent aggregate row (brief D3 —
//      this serializes concurrent line writes against the same count; CountLocation/Recount never
//      take a client-visible expectedVersion, only this lock).
//   2. getLineForUpdate — `select ... for update` on the ONE line row, bound to its already-locked
//      parent (id + count_id together).
//   3. every OTHER statement (line write, completeness re-check, the ledger's own advisory locks
//      in AdjustCount) — the reused stock-ledger mechanism's own lock order (shared rebuild ->
//      location limits -> balance -> audit) is documented in ../../src/stock-ledger/post-movement.ts.
//   4. updateCountStatus (the version bump, on the row already locked in step 1 — no new lock),
//      then writeAuditRow, last (ADR-0002: no row lock is taken after the audit-chain advisory
//      lock).
//
// wms.inventory_count_lines carries NO entity_id column (brief Facts — RLS internal_only). A line
// is reached ONLY through findLineCountId -> getCountForUpdate (RLS-scoped, entity_scope) ->
// getLineForUpdate(tx, countId, lineId) — never by lineId alone against a caller-supplied countId.
// findLineCountId's own read is ITSELF entity-scoped (it JOINs to the entity-scoped parent
// wms.inventory_counts so RLS actually filters it, finding 5) but is still never trusted as
// authorization by itself — getCountForUpdate's own RLS-scoped read is the authorization step.

const COUNT_SCHEMA = 'wms';
const COUNT_TABLE_NAME = 'inventory_counts';
const COUNT_TABLE = `${COUNT_SCHEMA}.${COUNT_TABLE_NAME}`;
const LINE_TABLE_NAME = 'inventory_count_lines';
const LINE_TABLE = `${COUNT_SCHEMA}.${LINE_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user';
const AUDIT_TABLE_BY_TARGET = { count: COUNT_TABLE_NAME, line: LINE_TABLE_NAME } as const;

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { CountNotFoundError, LineNotFoundError, SkuNotFoundError, WarehouseNotFoundError } from '../../domain/count-inventory/errors.js';
import type { InventoryCountStatus } from '../../domain/count-inventory/machine.js';
import type {
  AuditTarget,
  CountInsertColumns,
  CountLineInsertColumns,
  CountLineRow,
  CountRow,
  CountUpdateColumns,
  InventoryCountRepository,
  StockSnapshotRow,
} from '../../application/count-inventory/ports.js';

async function hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roleCodes.some((roleCode) => roles.includes(roleCode));
}

async function getWarehouseEntityId(tx: NodePgDatabase, warehouseId: string): Promise<string> {
  // finding 11: wms.warehouses is reference_read (readable cross-entity by RLS) — filter to
  // platform.allowed_entities() explicitly here, or a foreign warehouse would pass this lookup
  // and only fail later at the RLS WITH CHECK on the INSERT, surfacing as an untyped 500.
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

async function nextDocNo(tx: NodePgDatabase, entityId: string, docType: string): Promise<string> {
  const result = await tx.execute<{ doc_no: string }>(sql`select platform.next_doc_no(${entityId}::uuid, ${docType}) as doc_no`);
  const row = result.rows[0];
  if (!row) throw new Error(`platform.next_doc_no returned no row for entity ${entityId} / doc type ${docType}`);
  return row.doc_no;
}

async function snapshotStockForCount(
  tx: NodePgDatabase,
  params: {
    readonly warehouseId: string;
    readonly locationIds?: readonly string[] | undefined;
    readonly skuIds?: readonly string[] | undefined;
    readonly clientId?: string | undefined;
  },
): Promise<readonly StockSnapshotRow[]> {
  const hasFilter = params.locationIds !== undefined && params.skuIds !== undefined;
  // finding 10: a client-scoped count (input.clientId supplied) must only snapshot THAT client's
  // SKUs — inventory_counts.client_id is nullable and a count may otherwise span several clients'
  // SKUs in the same warehouse, so this filter is opt-in.
  const clientFilter = params.clientId ?? null;

  const result = hasFilter
    ? await tx.execute<{ location_id: string; sku_id: string; batch_no: string; qty_system: string }>(sql`
        select sb.location_id, sb.sku_id, coalesce(sb.batch_no, '') as batch_no, sb.qty_on_hand::text as qty_system
          from wms.stock_balance sb
          join wms.locations l on l.id = sb.location_id
         where l.warehouse_id = ${params.warehouseId}::uuid
           and sb.qty_on_hand <> 0
           and sb.location_id = any(${sql.param(params.locationIds)}::uuid[])
           and sb.sku_id = any(${sql.param(params.skuIds)}::uuid[])
           and (${clientFilter}::uuid is null or sb.client_id = ${clientFilter}::uuid)
         order by l.code
      `)
    : await tx.execute<{ location_id: string; sku_id: string; batch_no: string; qty_system: string }>(sql`
        select sb.location_id, sb.sku_id, coalesce(sb.batch_no, '') as batch_no, sb.qty_on_hand::text as qty_system
          from wms.stock_balance sb
          join wms.locations l on l.id = sb.location_id
         where l.warehouse_id = ${params.warehouseId}::uuid
           and sb.qty_on_hand <> 0
           and (${clientFilter}::uuid is null or sb.client_id = ${clientFilter}::uuid)
         order by l.code
      `);

  return result.rows.map((row) => ({
    locationId: row.location_id,
    skuId: row.sku_id,
    batchNo: row.batch_no,
    qtySystem: row.qty_system,
  }));
}

async function insertCount(
  tx: NodePgDatabase,
  columns: CountInsertColumns,
): Promise<{ readonly id: string; readonly version: number }> {
  const result = await tx.execute<{ id: string; version: number }>(sql`
    insert into ${sql.raw(COUNT_TABLE)}
      (entity_id, doc_no, warehouse_id, client_id, count_type, status, started_at, counted_by)
    values
      (${columns.entityId}::uuid, ${columns.docNo}, ${columns.warehouseId}::uuid, ${columns.clientId}::uuid,
       ${columns.countType}, ${columns.status}, ${columns.startedAt.toISOString()}::timestamptz,
       ${columns.countedBy}::uuid)
    returning id, version
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${COUNT_TABLE} returned no row`);
  return { id: row.id, version: row.version };
}

async function insertCountLines(
  tx: NodePgDatabase,
  countId: string,
  lines: readonly CountLineInsertColumns[],
): Promise<void> {
  for (const line of lines) {
    await tx.execute(sql`
      insert into ${sql.raw(LINE_TABLE)} (count_id, location_id, sku_id, batch_no, qty_system)
      values (${countId}::uuid, ${line.locationId}::uuid, ${line.skuId}::uuid, ${line.batchNo}, ${line.qtySystem}::numeric)
    `);
  }
}

async function getCountForUpdate(tx: NodePgDatabase, countId: string): Promise<CountRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    warehouse_id: string;
    client_id: string | null;
    status: string;
    version: number;
  }>(sql`
    select id, entity_id, warehouse_id, client_id, status, version
      from ${sql.raw(COUNT_TABLE)} where id = ${countId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new CountNotFoundError(`no ${COUNT_TABLE} row visible for id ${countId} (Allowed: an existing count in the caller's entities)`);
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    warehouseId: row.warehouse_id,
    clientId: row.client_id,
    status: row.status as InventoryCountStatus,
    version: row.version,
  };
}

async function updateCountStatus(tx: NodePgDatabase, countId: string, columns: CountUpdateColumns): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(COUNT_TABLE)}
       set status = ${columns.status}, version = ${columns.version},
           finished_at = coalesce(${columns.finishedAt?.toISOString() ?? null}::timestamptz, finished_at),
           approved_by = coalesce(${columns.approvedBy ?? null}::uuid, approved_by)
     where id = ${countId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`updateCountStatus: no ${COUNT_TABLE} row for id ${countId} (lock was already held)`);
  return row.version;
}

async function findLineCountId(tx: NodePgDatabase, lineId: string): Promise<string> {
  // finding 5: wms.inventory_count_lines has no entity_id (RLS internal_only) — a bare
  // `select ... where id = $1` against it would return a row regardless of the caller's entity,
  // leaking cross-entity row EXISTENCE as an oracle (CountNotFoundError-on-the-parent-lookup vs
  // LineNotFoundError-here would tell an attacker whether a foreign-entity line exists). JOINing
  // to the entity-scoped parent `wms.inventory_counts` makes RLS actually filter this query, and
  // BOTH "truly missing" and "belongs to another entity" collapse into the same LineNotFoundError.
  const result = await tx.execute<{ count_id: string }>(sql`
    select l.count_id
      from ${sql.raw(LINE_TABLE)} l
      join ${sql.raw(COUNT_TABLE)} c on c.id = l.count_id
     where l.id = ${lineId}::uuid
  `);
  const row = result.rows[0];
  if (!row) {
    throw new LineNotFoundError(`no ${LINE_TABLE} row with id ${lineId}. (Allowed: an existing inventory-count line id)`);
  }
  return row.count_id;
}

async function getLineForUpdate(tx: NodePgDatabase, countId: string, lineId: string): Promise<CountLineRow> {
  const result = await tx.execute<{
    id: string;
    count_id: string;
    location_id: string;
    sku_id: string;
    batch_no: string | null;
    qty_system: string;
    qty_counted: string | null;
    recount_qty: string | null;
  }>(sql`
    select id, count_id, location_id, sku_id, batch_no, qty_system::text as qty_system,
           qty_counted::text as qty_counted, recount_qty::text as recount_qty
      from ${sql.raw(LINE_TABLE)}
     where id = ${lineId}::uuid and count_id = ${countId}::uuid
     for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new LineNotFoundError(
      `no ${LINE_TABLE} row with id ${lineId} belonging to count ${countId}. ` +
        `(Allowed: a lineId that is one of this count's own lines)`,
    );
  }
  return {
    id: row.id,
    countId: row.count_id,
    locationId: row.location_id,
    skuId: row.sku_id,
    batchNo: row.batch_no,
    qtySystem: row.qty_system,
    qtyCounted: row.qty_counted,
    recountQty: row.recount_qty,
  };
}

async function updateLineQtyCounted(tx: NodePgDatabase, countId: string, lineId: string, qtyCounted: string): Promise<boolean> {
  // finding 5: count_id in the WHERE clause is defence-in-depth — the caller always already holds
  // the parent count's row lock, but the write itself never trusts lineId alone.
  const result = await tx.execute(sql`
    update ${sql.raw(LINE_TABLE)} set qty_counted = ${qtyCounted}::numeric
     where id = ${lineId}::uuid and count_id = ${countId}::uuid and qty_counted is null
  `);
  return (result.rowCount ?? 0) > 0;
}

async function updateLineRecountQty(tx: NodePgDatabase, countId: string, lineId: string, recountQty: string): Promise<boolean> {
  const result = await tx.execute(sql`
    update ${sql.raw(LINE_TABLE)} set recount_qty = ${recountQty}::numeric
     where id = ${lineId}::uuid and count_id = ${countId}::uuid and recount_qty is null
  `);
  return (result.rowCount ?? 0) > 0;
}

async function getLineCountedFlags(
  tx: NodePgDatabase,
  countId: string,
): Promise<ReadonlyArray<{ readonly qtyCounted: string | null }>> {
  const result = await tx.execute<{ qty_counted: string | null }>(
    sql`select qty_counted::text as qty_counted from ${sql.raw(LINE_TABLE)} where count_id = ${countId}::uuid`,
  );
  return result.rows.map((row) => ({ qtyCounted: row.qty_counted }));
}

/** every variant line (qty_counted set, variance <> 0 — the DB's own generated column, exact
 *  numeric(14,3) arithmetic) with whether recount_qty has been set yet. */
async function getVariantLineRecountFlags(
  tx: NodePgDatabase,
  countId: string,
): Promise<ReadonlyArray<{ readonly recounted: boolean }>> {
  const result = await tx.execute<{ recounted: boolean }>(sql`
    select (recount_qty is not null) as recounted
      from ${sql.raw(LINE_TABLE)}
     where count_id = ${countId}::uuid and qty_counted is not null and variance <> 0
  `);
  return result.rows.map((row) => ({ recounted: row.recounted }));
}

async function getLinesForAdjustment(tx: NodePgDatabase, countId: string): Promise<readonly CountLineRow[]> {
  const result = await tx.execute<{
    id: string;
    count_id: string;
    location_id: string;
    sku_id: string;
    batch_no: string | null;
    qty_system: string;
    qty_counted: string | null;
    recount_qty: string | null;
  }>(sql`
    select id, count_id, location_id, sku_id, batch_no, qty_system::text as qty_system,
           qty_counted::text as qty_counted, recount_qty::text as recount_qty
      from ${sql.raw(LINE_TABLE)}
     where count_id = ${countId}::uuid
  `);
  return result.rows.map((row) => ({
    id: row.id,
    countId: row.count_id,
    locationId: row.location_id,
    skuId: row.sku_id,
    batchNo: row.batch_no,
    qtySystem: row.qty_system,
    qtyCounted: row.qty_counted,
    recountQty: row.recount_qty,
  }));
}

async function getSkuClientId(tx: NodePgDatabase, skuId: string): Promise<string> {
  const result = await tx.execute<{ client_id: string }>(sql`select client_id from wms.skus where id = ${skuId}::uuid`);
  const row = result.rows[0];
  // finding 13: a typed error, never a plain `Error` reaching the api/ layer as an unmapped 500 —
  // defensive, should be unreachable (a count line's sku_id is a FK to wms.skus).
  if (!row) {
    throw new SkuNotFoundError(`no wms.skus row for id ${skuId}. (Allowed: an existing sku id — should be unreachable)`);
  }
  return row.client_id;
}

/** finding 9: the uom of the MOST RECENT wms.stock_movements row for this exact
 *  (client, sku, location, batch) combination — never fabricated. `batch_no` is nullable on
 *  wms.stock_movements; `coalesce(batch_no, '')` matches the '' convention this module's own
 *  snapshot already uses for an unbatched line. */
async function getLatestMovementUom(
  tx: NodePgDatabase,
  params: { readonly clientId: string; readonly skuId: string; readonly locationId: string; readonly batchNo: string },
): Promise<string | null> {
  const result = await tx.execute<{ uom: string }>(sql`
    select uom
      from wms.stock_movements
     where client_id = ${params.clientId}::uuid
       and sku_id = ${params.skuId}::uuid
       and coalesce(batch_no, '') = ${params.batchNo}
       and (from_location_id = ${params.locationId}::uuid or to_location_id = ${params.locationId}::uuid)
     order by occurred_at desc
     limit 1
  `);
  return result.rows[0]?.uom ?? null;
}

async function setLineAdjustedMovementId(tx: NodePgDatabase, countId: string, lineId: string, movementId: string): Promise<void> {
  // finding 5: count_id in the WHERE clause is defence-in-depth, same as updateLineQtyCounted/
  // updateLineRecountQty above.
  await tx.execute(sql`
    update ${sql.raw(LINE_TABLE)} set adjusted_movement_id = ${movementId}::uuid
     where id = ${lineId}::uuid and count_id = ${countId}::uuid
  `);
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with any outbox row the
 *  same call writes (G9). `occurredAt` is mandatory (always from the injected Clock, never the
 *  column's own `default now()`). */
async function writeAuditRow(
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
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${COUNT_SCHEMA}, ${AUDIT_TABLE_BY_TARGET[params.target]}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const countInventoryRepository: InventoryCountRepository = {
  hasAnyRole,
  getWarehouseEntityId,
  nextDocNo,
  snapshotStockForCount,
  insertCount,
  insertCountLines,
  getCountForUpdate,
  updateCountStatus,
  findLineCountId,
  getLineForUpdate,
  updateLineQtyCounted,
  updateLineRecountQty,
  getLineCountedFlags,
  getVariantLineRecountFlags,
  getLinesForAdjustment,
  getSkuClientId,
  getLatestMovementUom,
  setLineAdjustedMovementId,
  writeAuditRow,
};

export { COUNT_SCHEMA, COUNT_TABLE_NAME, COUNT_TABLE, LINE_TABLE_NAME, LINE_TABLE };
