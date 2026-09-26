// modules/wms/infrastructure/process-outbound/repository.ts — WBS 2.11 part 1.
//
// infrastructure/ layer: every DB statement for the process-outbound use case (part 1), run
// against the `tx` a caller's own withContext(ctx, fn)/withIdempotentContext already opened.
// Implements ../../application/process-outbound/ports.ts's `OutboundOrderRepository`.
//
// Cross-schema reads via raw SQL, no TypeScript import (brief "Scope taken by the lane", same
// precedent as ../../infrastructure/take-occupancy-snapshot/repository.ts and
// modules/sales/infrastructure/resolve-price/repository.ts): this file reads
// `sales.contracts`/`sales.accounts`/`catalog.services`/`catalog.price_list_lines`/
// `catalog.price_exceptions` directly — never a `modules/sales` or `modules/catalog` import.
//
// LOCK ORDER — the one every command follows:
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST, when the command's own input carries an
//      `idem` (every write command in this use case).
//   1. getOrderForUpdate — `select ... for update` on the ONE aggregate row (CreateOutbound takes
//      no lock: it inserts a brand-new row instead).
//   2. every OTHER read this command needs (condition checks, role check) — all plain SELECTs,
//      no additional row lock.
//   3. nextDocNo (CreateOutbound only) — `platform.next_doc_no` locks a `platform.counters` row.
//   4. the insert/update on the order row already locked (or freshly inserted), then the outbox
//      event, then writeAuditRow, last (ADR-0002).

const ORDER_SCHEMA = 'wms';
const ORDER_TABLE_NAME = 'outbound_orders';
const ORDER_TABLE = `${ORDER_SCHEMA}.${ORDER_TABLE_NAME}`;
const LINE_TABLE = `${ORDER_SCHEMA}.order_lines`;
const AUDIT_ACTOR_TYPE_USER = 'user';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { OrderNotFoundError, StockBalanceRowMissingError } from '../../domain/process-outbound/errors.js';
import type { OutboundOrderStatus } from '../../domain/process-outbound/machine.js';
import type {
  AccountCreditRow,
  AllocationLineRow,
  CandidateLotRow,
  ClientQualificationRow,
  ConsumedLineRow,
  ContractCheckRow,
  ContractSkuLimitRow,
  IncrementLotAllocatedParams,
  OrderLineRow,
  OrderRow,
  OrderUpdateColumns,
  OutboundOrderRepository,
  PickListLineRow,
  PickOrderLineRow,
  SkuCheckRow,
  StockAvailabilityRow,
  StockedLocationBlockRow,
  StockLotRow,
  UpdateOrderLineAllocationParams,
  UpdateOrderLinePickParams,
} from '../../application/process-outbound/ports.js';

async function getOrderForUpdate(tx: NodePgDatabase, orderId: string): Promise<OrderRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    client_id: string;
    contract_id: string | null;
    warehouse_id: string;
    order_type: string;
    status: string;
    version: number;
    ship_to_name: string | null;
    ship_to_phone: string | null;
    ship_to_address: string | null;
    ship_to_area: string | null;
    picked_by: string | null;
    checked_by: string | null;
  }>(sql`
    select id, entity_id, client_id, contract_id, warehouse_id, order_type, status, version,
           ship_to_name, ship_to_phone, ship_to_address, ship_to_area, picked_by, checked_by
      from ${sql.raw(ORDER_TABLE)} where id = ${orderId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new OrderNotFoundError(`no ${ORDER_TABLE} row visible for id ${orderId} (Allowed: an existing order in the caller's entities)`);
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    clientId: row.client_id,
    contractId: row.contract_id,
    warehouseId: row.warehouse_id,
    orderType: row.order_type,
    status: row.status as OutboundOrderStatus,
    version: row.version,
    shipToName: row.ship_to_name,
    shipToPhone: row.ship_to_phone,
    shipToAddress: row.ship_to_address,
    shipToArea: row.ship_to_area,
    pickedBy: row.picked_by,
    checkedBy: row.checked_by,
  };
}

/** WBS 2.11 part 2 (Master decision 3): a plain, unlocked read — GeneratePickList takes no row
 *  lock (read-only, no state change). Same row shape/errors as getOrderForUpdate, minus `for
 *  update`. */
async function getOrderForRead(tx: NodePgDatabase, orderId: string): Promise<OrderRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    client_id: string;
    contract_id: string | null;
    warehouse_id: string;
    order_type: string;
    status: string;
    version: number;
    ship_to_name: string | null;
    ship_to_phone: string | null;
    ship_to_address: string | null;
    ship_to_area: string | null;
    picked_by: string | null;
    checked_by: string | null;
  }>(sql`
    select id, entity_id, client_id, contract_id, warehouse_id, order_type, status, version,
           ship_to_name, ship_to_phone, ship_to_address, ship_to_area, picked_by, checked_by
      from ${sql.raw(ORDER_TABLE)} where id = ${orderId}::uuid
  `);
  const row = result.rows[0];
  if (!row) {
    throw new OrderNotFoundError(`no ${ORDER_TABLE} row visible for id ${orderId} (Allowed: an existing order in the caller's entities)`);
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    clientId: row.client_id,
    contractId: row.contract_id,
    warehouseId: row.warehouse_id,
    orderType: row.order_type,
    status: row.status as OutboundOrderStatus,
    version: row.version,
    shipToName: row.ship_to_name,
    shipToPhone: row.ship_to_phone,
    shipToAddress: row.ship_to_address,
    shipToArea: row.ship_to_area,
    pickedBy: row.picked_by,
    checkedBy: row.checked_by,
  };
}

async function updateOrder(tx: NodePgDatabase, orderId: string, columns: OrderUpdateColumns): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(ORDER_TABLE)}
       set status = ${columns.status}, version = version + 1,
           credit_check_passed = coalesce(${columns.creditCheckPassed ?? null}::boolean, credit_check_passed),
           credit_checked_at = coalesce(${columns.creditCheckedAt?.toISOString() ?? null}::timestamptz, credit_checked_at),
           picked_by = coalesce(${columns.pickedBy ?? null}::uuid, picked_by),
           checked_by = coalesce(${columns.checkedBy ?? null}::uuid, checked_by)
     where id = ${orderId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateOrder: no ${ORDER_TABLE} row for id ${orderId} (lock was already held)`);
  }
  return row.version;
}

async function hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roles.includes(roleCode);
}

async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly target: 'order';
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
       ${params.entityId}::uuid, ${ORDER_SCHEMA}, ${ORDER_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

async function getClientQualification(tx: NodePgDatabase, clientId: string): Promise<ClientQualificationRow | null> {
  const result = await tx.execute<{ status: string; deleted_at: string | null }>(sql`
    select status, deleted_at::text as deleted_at from sales.accounts where id = ${clientId}::uuid
  `);
  const row = result.rows[0];
  return row ? { status: row.status, deletedAt: row.deleted_at ? new Date(row.deleted_at) : null } : null;
}

async function nextDocNo(tx: NodePgDatabase, entityId: string, docType: string): Promise<string> {
  const result = await tx.execute<{ doc_no: string }>(sql`select platform.next_doc_no(${entityId}::uuid, ${docType}) as doc_no`);
  const row = result.rows[0];
  if (!row) throw new Error(`platform.next_doc_no returned no row for entity ${entityId} / doc type ${docType}`);
  return row.doc_no;
}

async function insertOrder(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly docNo: string;
    readonly clientId: string;
    readonly contractId: string | null;
    readonly warehouseId: string;
    readonly orderType: string;
    readonly requiredBy: Date | null;
    readonly shipToName: string | null;
    readonly shipToPhone: string | null;
    readonly shipToAddress: string | null;
    readonly shipToArea: string | null;
    readonly clientRef: string | null;
    readonly createdBy: string;
  },
): Promise<{ readonly id: string; readonly docNo: string; readonly version: number }> {
  const result = await tx.execute<{ id: string; version: number }>(sql`
    insert into ${sql.raw(ORDER_TABLE)}
      (entity_id, doc_no, client_id, contract_id, warehouse_id, order_type, status,
       required_by, ship_to_name, ship_to_phone, ship_to_address, ship_to_area, client_ref, created_by)
    values
      (${params.entityId}::uuid, ${params.docNo}, ${params.clientId}::uuid, ${params.contractId}::uuid,
       ${params.warehouseId}::uuid, ${params.orderType}, 'draft',
       ${params.requiredBy?.toISOString() ?? null}::timestamptz, ${params.shipToName}, ${params.shipToPhone},
       ${params.shipToAddress}, ${params.shipToArea}, ${params.clientRef}, ${params.createdBy}::uuid)
    returning id, version
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${ORDER_TABLE} returned no row`);
  return { id: row.id, docNo: params.docNo, version: row.version };
}

async function getOrderLines(tx: NodePgDatabase, orderId: string): Promise<readonly OrderLineRow[]> {
  const result = await tx.execute<{ sku_id: string; qty_ordered: string }>(sql`
    select sku_id, qty_ordered::text as qty_ordered
      from ${sql.raw(LINE_TABLE)}
     where order_table = ${ORDER_TABLE} and order_id = ${orderId}::uuid
     order by line_no
  `);
  return result.rows.map((row) => ({ skuId: row.sku_id, qtyOrdered: row.qty_ordered }));
}

const CONTRACT_STATUS_ACTIVE = 'active';

async function getContractCheck(
  tx: NodePgDatabase,
  params: { readonly clientId: string; readonly entityId: string; readonly contractId?: string | undefined },
): Promise<ContractCheckRow | null> {
  // Fix round 1 finding 4: looked up by (account_id=clientId, entity_id) — `contractId` narrows
  // the same query WHEN the order carries one, never replaces the lookup key. An order created
  // without a contractId still resolves the client's own active contract. WBS 2.11 part 5 finding
  // 1: `id` is selected too — condition 10 needs to know WHICH contract resolved (an order may
  // carry no contractId at all) so it can look up sales.contract_sku_limits by THIS resolved
  // contract_id, not by order.contractId directly.
  const result = await tx.execute<{ id: string; end_date: string | null; price_list_id: string | null }>(sql`
    select id, end_date::text as end_date, price_list_id
      from sales.contracts
     where account_id = ${params.clientId}::uuid and entity_id = ${params.entityId}::uuid
       and status = ${CONTRACT_STATUS_ACTIVE}
       ${params.contractId ? sql`and id = ${params.contractId}::uuid` : sql``}
     order by end_date desc nulls first
     limit 1
  `);
  const row = result.rows[0];
  return row ? { id: row.id, endDate: row.end_date, priceListId: row.price_list_id } : null;
}

/** condition 10 (WBS 2.11 part 5, D-189, SCR-WMS-OUT-02 §6): read-only, cross-schema, same
 *  pattern as getContractCheck above — no `modules/sales` TypeScript import. `null` when no row
 *  exists for (contractId, skuId) — no cap for that line. */
async function getContractSkuLimit(
  tx: NodePgDatabase,
  params: { readonly contractId: string; readonly skuId: string },
): Promise<ContractSkuLimitRow | null> {
  const result = await tx.execute<{ max_order_qty: string }>(sql`
    select max_order_qty::text as max_order_qty
      from sales.contract_sku_limits
     where contract_id = ${params.contractId}::uuid and sku_id = ${params.skuId}::uuid
  `);
  const row = result.rows[0];
  return row ? { maxOrderQty: row.max_order_qty } : null;
}

async function getAccountCredit(tx: NodePgDatabase, clientId: string): Promise<AccountCreditRow | null> {
  const result = await tx.execute<{ credit_hold: boolean; hold_reason: string | null }>(sql`
    select credit_hold, hold_reason from sales.accounts where id = ${clientId}::uuid
  `);
  const row = result.rows[0];
  return row ? { creditHold: row.credit_hold, holdReason: row.hold_reason } : null;
}

async function getSkuCheck(tx: NodePgDatabase, skuId: string): Promise<SkuCheckRow | null> {
  const result = await tx.execute<{
    client_id: string;
    code: string;
    status: string;
    track_expiry: boolean;
    min_remaining_life_issue_days: number | null;
  }>(sql`
    select client_id, code, status, track_expiry, min_remaining_life_issue_days
      from wms.skus where id = ${skuId}::uuid
  `);
  const row = result.rows[0];
  return row
    ? {
        clientId: row.client_id,
        code: row.code,
        status: row.status,
        trackExpiry: row.track_expiry,
        minRemainingLifeIssueDays: row.min_remaining_life_issue_days,
      }
    : null;
}

async function getStockAvailability(
  tx: NodePgDatabase,
  params: { readonly clientId: string; readonly skuId: string; readonly warehouseId: string },
): Promise<StockAvailabilityRow> {
  const result = await tx.execute<{ available_sum: string; loc_count: number; single_code: string | null }>(sql`
    select coalesce(sum(sb.qty_available), 0)::text as available_sum,
           count(*) filter (where sb.qty_available > 0)::int as loc_count,
           min(l.code) filter (where sb.qty_available > 0) as single_code
      from wms.stock_balance sb
      join wms.locations l on l.id = sb.location_id
     where sb.client_id = ${params.clientId}::uuid and sb.sku_id = ${params.skuId}::uuid
       and l.warehouse_id = ${params.warehouseId}::uuid
  `);
  const row = result.rows[0];
  const availableSum = row?.available_sum ?? '0';
  const locCount = row?.loc_count ?? 0;
  return { availableSum, singleLocationCode: locCount === 1 ? (row?.single_code ?? null) : null };
}

async function getStockLots(
  tx: NodePgDatabase,
  params: { readonly clientId: string; readonly skuId: string; readonly warehouseId: string },
): Promise<readonly StockLotRow[]> {
  const result = await tx.execute<{ expiry_date: string | null; qty_available: string; batch_no: string }>(sql`
    select sb.expiry_date::text as expiry_date, sb.qty_available::text as qty_available, sb.batch_no
      from wms.stock_balance sb
      join wms.locations l on l.id = sb.location_id
     where sb.client_id = ${params.clientId}::uuid and sb.sku_id = ${params.skuId}::uuid
       and l.warehouse_id = ${params.warehouseId}::uuid and sb.qty_available > 0
  `);
  return result.rows.map((row) => ({ expiryDate: row.expiry_date, qtyAvailable: row.qty_available, batchNo: row.batch_no }));
}

async function getStockedLocationBlocks(
  tx: NodePgDatabase,
  params: { readonly clientId: string; readonly skuId: string; readonly warehouseId: string },
): Promise<readonly StockedLocationBlockRow[]> {
  const result = await tx.execute<{ is_blocked: boolean; code: string; block_reason: string | null; qty_available: string }>(sql`
    select l.is_blocked, l.code, l.block_reason, sb.qty_available::text as qty_available
      from wms.stock_balance sb
      join wms.locations l on l.id = sb.location_id
     where sb.client_id = ${params.clientId}::uuid and sb.sku_id = ${params.skuId}::uuid
       and l.warehouse_id = ${params.warehouseId}::uuid and sb.qty_available > 0
  `);
  return result.rows.map((row) => ({
    isBlocked: row.is_blocked,
    locationCode: row.code,
    blockReason: row.block_reason,
    qtyAvailable: row.qty_available,
  }));
}

async function getServiceIdByCode(tx: NodePgDatabase, code: string): Promise<string | null> {
  const result = await tx.execute<{ id: string }>(sql`select id from catalog.services where code = ${code}`);
  return result.rows[0]?.id ?? null;
}

const PRICE_LIST_STATUS_ACTIVE = 'active';

async function hasPricedLine(
  tx: NodePgDatabase,
  params: { readonly priceListId: string; readonly serviceId: string; readonly asOfDate: string },
): Promise<boolean> {
  // Fix round 1 finding 8: a draft or expired price list must not satisfy condition 9 — join
  // catalog.price_lists on status='active' and the valid_from/valid_to window.
  const result = await tx.execute<{ exists: boolean }>(sql`
    select exists (
      select 1
        from catalog.price_list_lines pll
        join catalog.price_lists pl on pl.id = pll.price_list_id
       where pll.price_list_id = ${params.priceListId}::uuid and pll.service_id = ${params.serviceId}::uuid
         and pl.status = ${PRICE_LIST_STATUS_ACTIVE}
         and pl.valid_from <= ${params.asOfDate}::date
         and (pl.valid_to is null or pl.valid_to >= ${params.asOfDate}::date)
    ) as exists
  `);
  return result.rows[0]?.exists ?? false;
}

async function hasPriceException(
  tx: NodePgDatabase,
  params: { readonly entityId: string; readonly clientId: string; readonly serviceId: string; readonly asOfDate: string },
): Promise<boolean> {
  const result = await tx.execute<{ exists: boolean }>(sql`
    select exists (
      select 1 from catalog.price_exceptions
       where entity_id = ${params.entityId}::uuid and client_id = ${params.clientId}::uuid
         and service_id = ${params.serviceId}::uuid
         and valid_from <= ${params.asOfDate}::date and valid_to >= ${params.asOfDate}::date
    ) as exists
  `);
  return result.rows[0]?.exists ?? false;
}

// --- WBS 2.11 part 2: Allocate / GeneratePickList / extended CancelOutbound (brief Master
// decisions 2/3/4) --------------------------------------------------------------------------------

async function getOrderLinesForAllocation(tx: NodePgDatabase, orderId: string): Promise<readonly AllocationLineRow[]> {
  const result = await tx.execute<{ id: string; line_no: number; sku_id: string; qty_ordered: string }>(sql`
    select id, line_no, sku_id, qty_ordered::text as qty_ordered
      from ${sql.raw(LINE_TABLE)}
     where order_table = ${ORDER_TABLE} and order_id = ${orderId}::uuid
     order by line_no
  `);
  return result.rows.map((row) => ({ lineId: row.id, lineNo: row.line_no, skuId: row.sku_id, qtyOrdered: row.qty_ordered }));
}

const SKU_PICKING_POLICY_DEFAULT = 'FIFO';

async function getSkuPickingPolicy(tx: NodePgDatabase, skuId: string): Promise<string> {
  const result = await tx.execute<{ picking_policy: string }>(sql`
    select picking_policy from wms.skus where id = ${skuId}::uuid
  `);
  return result.rows[0]?.picking_policy ?? SKU_PICKING_POLICY_DEFAULT;
}

const PICKING_POLICY_FEFO = 'FEFO';
const PICKING_POLICY_LIFO = 'LIFO';

async function getCandidateLots(
  tx: NodePgDatabase,
  params: { readonly clientId: string; readonly skuId: string; readonly warehouseId: string; readonly pickingPolicy: string },
): Promise<readonly CandidateLotRow[]> {
  // brief Master decision 2: FEFO -> expiry_date ascending (nulls last); FIFO ->
  // stock_balance.last_movement_at ascending; LIFO -> reverse of FIFO. Chosen in TS (not a
  // parameterized dynamic ORDER BY) since `pickingPolicy` is an internal, already-validated SKU
  // column value, never end-user input.
  const orderBy =
    params.pickingPolicy === PICKING_POLICY_FEFO
      ? sql`sb.expiry_date asc nulls last, sb.location_id, sb.batch_no`
      : params.pickingPolicy === PICKING_POLICY_LIFO
        ? sql`sb.last_movement_at desc nulls last, sb.location_id, sb.batch_no`
        : sql`sb.last_movement_at asc nulls last, sb.location_id, sb.batch_no`;
  // Fix round 1 finding 2: `for update of sb` locks every candidate `wms.stock_balance` row for
  // the rest of this transaction BEFORE any increment — the standard read-then-update-under-lock
  // pattern (../manage-space/repository.ts's own `getBlockEntityId` precedent), here on a joined
  // query so the lock is scoped to `sb` alone, never the joined `wms.locations` rows. A second,
  // concurrent Allocate on the same lot(s) now blocks here until the first transaction commits,
  // instead of both reading the same stale `qty_available` and both reserving it.
  const result = await tx.execute<{ location_id: string; batch_no: string; qty_available: string }>(sql`
    select sb.location_id, sb.batch_no, sb.qty_available::text as qty_available
      from wms.stock_balance sb
      join wms.locations l on l.id = sb.location_id
     where sb.client_id = ${params.clientId}::uuid and sb.sku_id = ${params.skuId}::uuid
       and l.warehouse_id = ${params.warehouseId}::uuid and sb.qty_available > 0
     order by ${orderBy}
     for update of sb
  `);
  return result.rows.map((row) => ({ locationId: row.location_id, batchNo: row.batch_no, qtyAvailable: row.qty_available }));
}

async function incrementLotAllocated(tx: NodePgDatabase, params: IncrementLotAllocatedParams): Promise<void> {
  const result = await tx.execute(sql`
    update wms.stock_balance
       set qty_allocated = qty_allocated + ${params.qty}::numeric
     where client_id = ${params.clientId}::uuid and sku_id = ${params.skuId}::uuid
       and location_id = ${params.locationId}::uuid and batch_no = ${params.batchNo}
  `);
  // Fix round 1 finding 2: the targeted row was just locked by getCandidateLots' own `for update
  // of sb` in this same transaction — zero rows matched here should never happen. Thrown rather
  // than silently doing nothing, which would leave qty_allocated un-adjusted with no trace.
  if ((result.rowCount ?? 0) === 0) {
    throw new StockBalanceRowMissingError(
      `Allocate: no stock balance found for client ${params.clientId} / sku ${params.skuId} / ` +
        `location ${params.locationId} / batch "${params.batchNo}" (the lot selected for this line).`,
      { clientId: params.clientId, skuId: params.skuId, locationId: params.locationId, batchNo: params.batchNo },
    );
  }
}

async function decrementLotAllocated(tx: NodePgDatabase, params: IncrementLotAllocatedParams): Promise<void> {
  const result = await tx.execute(sql`
    update wms.stock_balance
       set qty_allocated = qty_allocated - ${params.qty}::numeric
     where client_id = ${params.clientId}::uuid and sku_id = ${params.skuId}::uuid
       and location_id = ${params.locationId}::uuid and batch_no = ${params.batchNo}
  `);
  // Same defensive rowCount check as incrementLotAllocated above (fix round 1 finding 2) — the
  // CancelOutbound release step must not silently skip a lot it expected to find.
  if ((result.rowCount ?? 0) === 0) {
    throw new StockBalanceRowMissingError(
      `CancelOutbound: no stock balance found for client ${params.clientId} / sku ${params.skuId} / ` +
        `location ${params.locationId} / batch "${params.batchNo}" (the lot reserved on this line).`,
      { clientId: params.clientId, skuId: params.skuId, locationId: params.locationId, batchNo: params.batchNo },
    );
  }
}

async function updateOrderLineAllocation(tx: NodePgDatabase, params: UpdateOrderLineAllocationParams): Promise<void> {
  await tx.execute(sql`
    update ${sql.raw(LINE_TABLE)}
       set status = ${params.status}, location_id = ${params.locationId}::uuid,
           batch_no = ${params.batchNo}, qty_actual = ${params.qtyActual}::numeric,
           variance_reason = ${params.varianceReason}
     where id = ${params.lineId}::uuid
  `);
}

async function getAllocatedPickListLines(tx: NodePgDatabase, orderId: string): Promise<readonly PickListLineRow[]> {
  const result = await tx.execute<{
    line_id: string;
    line_no: number;
    sku_id: string;
    qty_ordered: string;
    location_id: string;
    location_code: string;
    position_no: number | null;
    batch_no: string | null;
  }>(sql`
    select ol.id as line_id, ol.line_no, ol.sku_id, ol.qty_ordered::text as qty_ordered,
           ol.location_id, l.code as location_code, l.position_no, ol.batch_no
      from ${sql.raw(LINE_TABLE)} ol
      join wms.locations l on l.id = ol.location_id
     where ol.order_table = ${ORDER_TABLE} and ol.order_id = ${orderId}::uuid
       and ol.location_id is not null
     order by l.position_no asc nulls last, ol.line_no asc
  `);
  return result.rows.map((row) => ({
    lineId: row.line_id,
    lineNo: row.line_no,
    skuId: row.sku_id,
    qtyOrdered: row.qty_ordered,
    locationId: row.location_id,
    locationCode: row.location_code,
    positionNo: row.position_no,
    batchNo: row.batch_no,
  }));
}

async function getConsumedLinesForRelease(tx: NodePgDatabase, orderId: string): Promise<readonly ConsumedLineRow[]> {
  const result = await tx.execute<{
    line_id: string;
    sku_id: string;
    location_id: string;
    batch_no: string | null;
    qty_actual: string | null;
  }>(sql`
    select id as line_id, sku_id, location_id, batch_no, qty_actual::text as qty_actual
      from ${sql.raw(LINE_TABLE)}
     where order_table = ${ORDER_TABLE} and order_id = ${orderId}::uuid
       and location_id is not null
  `);
  return result.rows.map((row) => ({
    lineId: row.line_id,
    skuId: row.sku_id,
    locationId: row.location_id,
    batchNo: row.batch_no ?? '',
    qtyActual: row.qty_actual ?? '0',
  }));
}

// --- PickLine / CheckOrder (WBS 2.12 part 1) -----------------------------------------------------

async function getOrderLineForPick(
  tx: NodePgDatabase,
  params: { readonly lineId: string; readonly orderId: string },
): Promise<PickOrderLineRow | null> {
  const result = await tx.execute<{
    id: string;
    sku_id: string;
    qty_ordered: string;
    uom: string;
    location_id: string | null;
    batch_no: string | null;
    qty_actual: string | null;
    status: string;
  }>(sql`
    select id, sku_id, qty_ordered::text as qty_ordered, uom, location_id, batch_no,
           qty_actual::text as qty_actual, status
      from ${sql.raw(LINE_TABLE)}
     where id = ${params.lineId}::uuid and order_table = ${ORDER_TABLE} and order_id = ${params.orderId}::uuid
  `);
  const row = result.rows[0];
  return row
    ? {
        lineId: row.id,
        skuId: row.sku_id,
        qtyOrdered: row.qty_ordered,
        uom: row.uom,
        locationId: row.location_id,
        batchNo: row.batch_no,
        // fix round 1 finding 3: Allocate's own reserved-quantity stamp, read BEFORE this call's
        // own updateOrderLinePick overwrites the column with the actually-picked amount.
        reservedQty: row.qty_actual,
        // part 2 item 3: the "never picked" signal for an unreserved line.
        status: row.status,
      }
    : null;
}

/** Fix round 1 finding 2: the double-pick guard — a matching `wms.stock_movements` 'pick' row for
 *  THIS line, never the order. */
async function hasPickMovementForLine(tx: NodePgDatabase, params: { readonly lineId: string }): Promise<boolean> {
  const result = await tx.execute<{ exists: boolean }>(sql`
    select exists (
      select 1 from wms.stock_movements
       where movement_type = 'pick' and ref_table = 'wms.order_lines'
         and ref_id = ${params.lineId}::uuid
    ) as exists
  `);
  return result.rows[0]?.exists ?? false;
}

/** WBS 2.12 part 2 item 4: `true` when a `wms.stock_movements` 'pick' row exists on THIS ORDER
 *  whose `performed_by` is `actorId` — every line of the order, not just one. */
async function hasPickMovementByActor(
  tx: NodePgDatabase,
  params: { readonly orderId: string; readonly actorId: string },
): Promise<boolean> {
  const result = await tx.execute<{ exists: boolean }>(sql`
    select exists (
      select 1 from wms.stock_movements sm
      join ${sql.raw(LINE_TABLE)} ol on ol.id = sm.ref_id and sm.ref_table = 'wms.order_lines'
       where ol.order_table = ${ORDER_TABLE} and ol.order_id = ${params.orderId}::uuid
         and sm.movement_type = 'pick' and sm.performed_by = ${params.actorId}::uuid
    ) as exists
  `);
  return result.rows[0]?.exists ?? false;
}

async function countOpenPickLines(tx: NodePgDatabase, orderId: string): Promise<number> {
  // Fix round 1 findings 2/5 (see ports.ts's own doc comment): a reserved line (location_id is not
  // null) is open until EITHER a matching 'pick' movement row exists for THAT LINE (never the
  // order — the double-pick fix), OR its own qty_actual already reads 0 (a zero-quantity pick
  // intentionally posts no ledger row, finding 5 — a reserved line's qty_actual is always positive
  // until PickLine records a zero pick on it, since Allocate never reserves a zero-quantity lot).
  const result = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n
      from ${sql.raw(LINE_TABLE)} ol
     where ol.order_table = ${ORDER_TABLE} and ol.order_id = ${orderId}::uuid
       and ol.location_id is not null
       and coalesce(ol.qty_actual, 0) <> 0
       and not exists (
         select 1 from wms.stock_movements sm
          where sm.movement_type = 'pick' and sm.ref_table = 'wms.order_lines' and sm.ref_id = ol.id
       )
  `);
  return Number(result.rows[0]?.n ?? '0');
}

async function updateOrderLinePick(tx: NodePgDatabase, params: UpdateOrderLinePickParams): Promise<void> {
  await tx.execute(sql`
    update ${sql.raw(LINE_TABLE)}
       set status = ${params.status}, qty_actual = ${params.qtyActual}::numeric,
           variance_reason = ${params.varianceReason}
     where id = ${params.lineId}::uuid
  `);
}

export const outboundOrderRepository: OutboundOrderRepository = {
  getOrderForUpdate,
  getOrderForRead,
  updateOrder,
  hasRole,
  writeAuditRow,
  getClientQualification,
  nextDocNo,
  insertOrder,
  getOrderLines,
  getContractCheck,
  getAccountCredit,
  getSkuCheck,
  getStockAvailability,
  getStockLots,
  getStockedLocationBlocks,
  getServiceIdByCode,
  hasPricedLine,
  hasPriceException,
  getContractSkuLimit,
  getOrderLinesForAllocation,
  getSkuPickingPolicy,
  getCandidateLots,
  incrementLotAllocated,
  updateOrderLineAllocation,
  getAllocatedPickListLines,
  getConsumedLinesForRelease,
  decrementLotAllocated,
  getOrderLineForPick,
  hasPickMovementForLine,
  hasPickMovementByActor,
  countOpenPickLines,
  updateOrderLinePick,
};

export { ORDER_SCHEMA, ORDER_TABLE_NAME, ORDER_TABLE, LINE_TABLE };
