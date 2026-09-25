// modules/wms/infrastructure/receive-inbound/repository.ts — WBS 2.9, THE GOLDEN SLICE.
//
// infrastructure/ layer: every DB statement for the receive-inbound use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/receive-inbound/ports.ts's `InboundOrderRepository`.
//
// LOCK ORDER — the one every command follows (each command's header points here):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's
//      own input carries an `idem` (every write command in this use case). A copy of this file
//      keeps this as its own step 0; it is not a row lock on this module's own tables, but it is
//      still the first thing the transaction does.
//   1. getOrderForUpdate — `select ... for update` on the ONE aggregate row. Held for the rest of
//      the transaction; the caller compares its own version to expectedVersion here.
//   2. getOrderLineForUpdate — `select ... for update` on the ONE line row, bound to its order
//      (id + order_id + order_table together — a mismatched pair is LineNotFoundError).
//   3. every OTHER row lock the command needs — today only nextDocNo (platform.next_doc_no locks a
//      platform.counters row) when ReceiveLine completes the last line and writes the GRN. An
//      all-zero order (SCR-WMS-INB-01 §6) simply skips step 3 — no GRN, so no doc-no allocation
//      and no platform.counters lock.
//   4. the reused stock-ledger mechanism's own advisory locks (shared rebuild -> location limits
//      -> sorted balance -> audit chain) — see ./ledger.ts and ../../src/stock-ledger.
//   5. outbox inserts, then updateOrder (the version bump, on the row already locked in step 1 —
//      no new lock), then writeAuditRow, last (ADR-0002).
// ADR-0002: no row lock may be taken after the audit-chain advisory lock. Steps 1-3 therefore
// always precede step 4 in every call path; nothing takes those locks in the opposite order, so
// there is no cycle. A copied command that needs another row lock adds it to step 3, never later.
//
// TEMPLATE GUIDANCE — every module-specific literal a later slice's copy must change is a
// named constant in this ONE file:
const ORDER_SCHEMA = 'wms'; // REPLACE-ON-COPY: the module schema.
const ORDER_TABLE_NAME = 'inbound_orders'; // REPLACE-ON-COPY: the aggregate table.
const ORDER_TABLE = `${ORDER_SCHEMA}.${ORDER_TABLE_NAME}`; // dotted, so sed-rename catches both halves.
const LINE_TABLE_NAME = 'order_lines'; // REPLACE-ON-COPY: the line table (audited separately).
const LINE_TABLE = `${ORDER_SCHEMA}.${LINE_TABLE_NAME}`; // dotted, like ORDER_TABLE.
// REPLACE-ON-COPY: this file also reads wms-owned reference tables directly — wms.locations,
// wms.zones, wms.stock_balance, wms.skus, wms.warehouses (RCV staging, SKU-client check, location
// suggestions, GRN snapshot). A copy for another module must replace each of those reads with its
// own tables or a declared contract; after the rename they point at non-existent tables and fail
// loudly in the copy's tests, which is intended.
const RCV_ZONE_TYPE = 'receiving'; // REPLACE-ON-COPY: the operational zone this use case stages into.
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
// The audited table for each AuditTarget — the application layer names a target, never a table.
const AUDIT_TABLE_BY_TARGET = { order: ORDER_TABLE_NAME, line: LINE_TABLE_NAME } as const;

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { LineNotFoundError, OrderNotFoundError } from '../../domain/receive-inbound/errors.js';
import type { InboundOrderStatus } from '../../domain/receive-inbound/machine.js';
import {
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
} from '../../domain/schedule-inbound/errors.js';
import type {
  AuditTarget,
  InboundOrderRepository,
  OrderLineRow,
  OrderRow,
  OrderScheduleAndTermsUpdateColumns,
  OrderScheduleAndTermsUpdateResult,
  OrderUpdateColumns,
  SuggestLocationCandidateRow,
} from '../../application/receive-inbound/ports.js';

async function getOrderForUpdate(tx: NodePgDatabase, orderId: string): Promise<OrderRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    client_id: string;
    warehouse_id: string;
    status: string;
    version: number;
  }>(sql`
    select id, entity_id, client_id, warehouse_id, status, version
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
    warehouseId: row.warehouse_id,
    status: row.status as InboundOrderStatus,
    version: row.version,
  };
}

async function updateOrder(tx: NodePgDatabase, orderId: string, columns: OrderUpdateColumns): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(ORDER_TABLE)}
       set status = ${columns.status}, version = version + 1,
           arrived_at = coalesce(${columns.arrivedAt?.toISOString() ?? null}::timestamptz, arrived_at),
           received_by = coalesce(${columns.receivedBy ?? null}::uuid, received_by),
           closed_at = coalesce(${columns.closedAt?.toISOString() ?? null}::timestamptz, closed_at),
           closed_by = coalesce(${columns.closedBy ?? null}::uuid, closed_by)
     where id = ${orderId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateOrder: no ${ORDER_TABLE} row for id ${orderId} (lock was already held)`);
  }
  return row.version;
}

// WBS 2.9b round-2 review finding 10: migration 0023's logistics-term CHECKs raise SQLSTATE 23514
// (check_violation) — mapped by constraint name to the same typed 422 errors as
// ../schedule-inbound/repository.ts's own backstop, behind approve-inbound.ts's domain pre-checks
// (belt-and-braces), never an unmapped 500.
const CHECK_VIOLATION_SQLSTATE = '23514';
const VEHICLE_TYPE_CONSTRAINT = 'chk_inbound_orders_vehicle_type';
const HANDOVER_POINT_CONSTRAINT = 'chk_inbound_orders_handover_point';
const TRANSPORT_BY_CONSTRAINT = 'chk_inbound_orders_transport_by';
const LABOUR_BY_CONSTRAINT = 'chk_inbound_orders_labour_by';
const LABOUR_COUNT_CONSTRAINT = 'chk_inbound_orders_labour_count';

/** Walks `error`'s own cause chain for a Postgres error with the given SQLSTATE — same
 *  discipline as ../schedule-inbound/repository.ts's findRaisedException. Returns the MATCHING
 *  error in the chain (never drizzle's own outer "Failed query: ..." wrapper). */
function findRaisedException(error: unknown, sqlstate: string): Error | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (code === sqlstate) {
      return current;
    }
    current = current.cause;
  }

  return undefined;
}

/** Maps a CHECK violation on `raised` to its typed error by constraint name — copied from
 *  ../schedule-inbound/repository.ts's mapCheckViolation. Returns `undefined` (caller rethrows the
 *  original error) when the constraint is not one of these five. */
function mapScheduleTermsCheckViolation(
  raised: Error,
  columns: OrderScheduleAndTermsUpdateColumns,
): Error | undefined {
  const constraint = 'constraint' in raised ? raised.constraint : undefined;
  switch (constraint) {
    case VEHICLE_TYPE_CONSTRAINT:
      return new InvalidVehicleTypeError(
        `ApproveInbound: ${ORDER_TABLE}.vehicle_type must be one of the closed list; received ` +
          `${columns.vehicleType}. (Allowed: container_20, container_40, truck, trailer, van, ` +
          `pickup, other) — ${raised.message}`,
      );
    case HANDOVER_POINT_CONSTRAINT:
      return new InvalidHandoverPointError(
        `ApproveInbound: ${ORDER_TABLE}.handover_point must be one of the closed list; received ` +
          `${columns.handoverPoint}. (Allowed: premium_warehouse, client_site) — ${raised.message}`,
      );
    case TRANSPORT_BY_CONSTRAINT:
      return new InvalidTransportByError(
        `ApproveInbound: ${ORDER_TABLE}.transport_by must be one of the closed list; received ` +
          `${columns.transportBy}. (Allowed: client, premium) — ${raised.message}`,
      );
    case LABOUR_BY_CONSTRAINT:
      return new InvalidLabourByError(
        `ApproveInbound: ${ORDER_TABLE}.labour_by must be one of the closed list; received ` +
          `${columns.labourBy}. (Allowed: client, premium, shared) — ${raised.message}`,
      );
    case LABOUR_COUNT_CONSTRAINT:
      return new InvalidLabourCountError(
        `ApproveInbound: ${ORDER_TABLE}.labour_count must be >= 0; received ` +
          `${columns.labourCount}. — ${raised.message}`,
      );
    default:
      return undefined;
  }
}

/** WBS 2.9b round-1 review finding 2: ApproveInbound's optional appointment-slot path (D2) —
 *  mirrors `updateOrder`'s own coalesce() style, but never touches `version` (the caller already
 *  bumped it via `updateOrder` in the same transaction, before calling this). */
async function updateOrderScheduleAndTerms(
  tx: NodePgDatabase,
  orderId: string,
  columns: OrderScheduleAndTermsUpdateColumns,
): Promise<OrderScheduleAndTermsUpdateResult> {
  let result;
  try {
    result = await tx.execute<{
      expected_at: string;
      dock_code: string | null;
      handover_point: string | null;
      transport_by: string | null;
      vehicle_type: string | null;
      labour_by: string | null;
      labour_count: number | null;
    }>(sql`
      update ${sql.raw(ORDER_TABLE)}
         set expected_at = ${columns.expectedAt.toISOString()}::timestamptz,
             scheduled_by = ${columns.scheduledBy}::uuid,
             scheduled_at = ${columns.scheduledAt.toISOString()}::timestamptz,
             dock_code = coalesce(${columns.dockCode ?? null}, dock_code),
             handover_point = coalesce(${columns.handoverPoint ?? null}, handover_point),
             transport_by = coalesce(${columns.transportBy ?? null}, transport_by),
             vehicle_type = coalesce(${columns.vehicleType ?? null}, vehicle_type),
             labour_by = coalesce(${columns.labourBy ?? null}, labour_by),
             labour_count = coalesce(${columns.labourCount ?? null}, labour_count)
       where id = ${orderId}::uuid
      returning expected_at::text as expected_at, dock_code, handover_point, transport_by,
                vehicle_type, labour_by, labour_count
    `);
  } catch (error) {
    const raised = findRaisedException(error, CHECK_VIOLATION_SQLSTATE);
    const mapped = raised ? mapScheduleTermsCheckViolation(raised, columns) : undefined;
    if (mapped) throw mapped;
    throw error;
  }
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateOrderScheduleAndTerms: no ${ORDER_TABLE} row for id ${orderId} (lock was already held)`);
  }
  return {
    // Round-2 review finding 7: parsed to a Date, serialised by the caller via .toISOString().
    expectedAt: new Date(row.expected_at),
    dockCode: row.dock_code,
    handoverPoint: row.handover_point,
    transportBy: row.transport_by,
    vehicleType: row.vehicle_type,
    labourBy: row.labour_by,
    labourCount: row.labour_count,
  };
}

/** WBS 2.9b round-1 review finding 2: CancelInbound's `cancel_reason` persistence (D3) — no
 *  `version` touch here (the caller already bumped it via `updateOrder` in the same transaction,
 *  before calling this). */
async function updateOrderCancelReason(tx: NodePgDatabase, orderId: string, cancelReason: string): Promise<void> {
  const result = await tx.execute(sql`
    update ${sql.raw(ORDER_TABLE)} set cancel_reason = ${cancelReason} where id = ${orderId}::uuid
  `);
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`updateOrderCancelReason: no ${ORDER_TABLE} row for id ${orderId} (lock was already held)`);
  }
}

async function getOrderLineForUpdate(tx: NodePgDatabase, orderId: string, lineId: string): Promise<OrderLineRow> {
  const result = await tx.execute<{
    id: string;
    order_id: string;
    sku_id: string;
    qty_ordered: string;
    qty_actual: string | null;
    uom: string;
    batch_no: string | null;
    status: string;
    location_id: string | null;
  }>(sql`
    select id, order_id, sku_id, qty_ordered::text as qty_ordered, qty_actual::text as qty_actual,
           uom, batch_no, status, location_id
      from ${sql.raw(LINE_TABLE)}
     where id = ${lineId}::uuid and order_id = ${orderId}::uuid and order_table = ${ORDER_TABLE}
     for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new LineNotFoundError(
      `no ${LINE_TABLE} row with id ${lineId} belonging to order ${orderId}. ` +
        `(Allowed: a lineId that is one of this order's own lines)`,
    );
  }
  return {
    id: row.id,
    orderId: row.order_id,
    skuId: row.sku_id,
    qtyOrdered: row.qty_ordered,
    qtyActual: row.qty_actual,
    uom: row.uom,
    batchNo: row.batch_no,
    status: row.status,
    locationId: row.location_id,
  };
}

async function updateLineReceipt(
  tx: NodePgDatabase,
  params: {
    readonly lineId: string;
    readonly qtyActual: string;
    readonly batchNo: string | null;
    readonly expiryDate: string | null;
    readonly varianceReason: string | null;
    readonly variancePhotoUrl: string | null;
    readonly variancePhotoSha256: string | null;
    readonly status: string;
  },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update ${sql.raw(LINE_TABLE)}
       set qty_actual = ${params.qtyActual}::numeric,
           batch_no = ${params.batchNo},
           expiry_date = ${params.expiryDate}::date,
           variance_reason = ${params.varianceReason},
           variance_photo_url = ${params.variancePhotoUrl},
           variance_photo_sha256 = ${params.variancePhotoSha256},
           status = ${params.status}
     where id = ${params.lineId}::uuid and qty_actual is null
  `);
  return (result.rowCount ?? 0) > 0;
}

async function updateLineLocation(
  tx: NodePgDatabase,
  params: { readonly lineId: string; readonly locationId: string; readonly status: string },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update ${sql.raw(LINE_TABLE)}
       set location_id = ${params.locationId}::uuid, status = ${params.status}
     where id = ${params.lineId}::uuid and status <> 'complete' and location_id is null
  `);
  return (result.rowCount ?? 0) > 0;
}

async function countUnreceiptedLines(tx: NodePgDatabase, orderId: string): Promise<number> {
  const result = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from ${sql.raw(LINE_TABLE)}
     where order_table = ${ORDER_TABLE} and order_id = ${orderId}::uuid and qty_actual is null
  `);
  return Number(result.rows[0]?.n ?? '0');
}

/** SCR-WMS-INB-01 §6: every line's qty_actual, called only once the order's last line has just
 *  been receipted (so every value is non-null) — under the order-row lock already held, no new
 *  lock. */
async function getAllLineQtyActual(tx: NodePgDatabase, orderId: string): Promise<readonly string[]> {
  const result = await tx.execute<{ qty_actual: string }>(sql`
    select qty_actual::text as qty_actual from ${sql.raw(LINE_TABLE)}
     where order_table = ${ORDER_TABLE} and order_id = ${orderId}::uuid and qty_actual is not null
  `);
  return result.rows.map((row) => row.qty_actual);
}

/** CloseInbound's own gate: true iff at least one line is still open. a fully-short receipt
 *  (qty_actual = 0) counts as complete for this gate even with location_id still null — put-away
 *  is skipped for it entirely. */
async function hasBlockingOpenLines(tx: NodePgDatabase, orderId: string): Promise<boolean> {
  const result = await tx.execute<{ blocked: boolean }>(sql`
    select exists (
      select 1 from ${sql.raw(LINE_TABLE)}
       where order_table = ${ORDER_TABLE} and order_id = ${orderId}::uuid
         and not (
           status = 'cancelled'
           or (status = 'complete' and (location_id is not null or qty_actual = 0))
         )
    ) as blocked
  `);
  return result.rows[0]?.blocked ?? true;
}

/** CancelInbound's own business rule (SCR-WMS-INB-01 §1/§3): true iff at least one line of the
 *  order already has qty_actual > 0 — stock has physically moved. */
async function hasPhysicallyReceivedLines(tx: NodePgDatabase, orderId: string): Promise<boolean> {
  const result = await tx.execute<{ moved: boolean }>(sql`
    select exists (
      select 1 from ${sql.raw(LINE_TABLE)}
       where order_table = ${ORDER_TABLE} and order_id = ${orderId}::uuid and qty_actual > 0
    ) as moved
  `);
  return result.rows[0]?.moved ?? false;
}

async function pickRcvLocation(tx: NodePgDatabase, warehouseId: string): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    select l.id
      from wms.locations l
      join wms.zones z on z.id = l.zone_id
     where l.warehouse_id = ${warehouseId}::uuid and z.zone_type = ${RCV_ZONE_TYPE}
       and l.location_type = 'operational' and l.is_blocked = false
     order by l.code
     limit 1
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`no unblocked ${RCV_ZONE_TYPE}-zone operational location for warehouse ${warehouseId}`);
  }
  return { id: row.id };
}

async function findRcvBalanceLocation(
  tx: NodePgDatabase,
  params: { readonly warehouseId: string; readonly clientId: string; readonly skuId: string; readonly batchNo: string },
): Promise<{ readonly id: string } | null> {
  const result = await tx.execute<{ id: string }>(sql`
    select sb.location_id as id
      from wms.stock_balance sb
      join wms.locations l on l.id = sb.location_id
      join wms.zones z on z.id = l.zone_id
     where l.warehouse_id = ${params.warehouseId}::uuid and z.zone_type = ${RCV_ZONE_TYPE}
       and sb.client_id = ${params.clientId}::uuid and sb.sku_id = ${params.skuId}::uuid
       and coalesce(sb.batch_no, '') = ${params.batchNo} and sb.qty_on_hand > 0
     order by l.code
     limit 1
  `);
  const row = result.rows[0];
  return row ? { id: row.id } : null;
}

// wms.skus.abc_class is an unconstrained char(1) (no CHECK constraint) — a defensive read against
// a value outside the domain set (e.g. a stray lowercase 'a' or an unexpected 'D') normalizes to
// `null` rather than silently carrying a false type past this boundary (pg-reviewer round 1).
function normalizeAbcClass(value: string | null): SuggestLocationCandidateRow['abcClass'] {
  return value === 'A' || value === 'B' || value === 'C' ? value : null;
}

async function suggestLocationCandidatesQuery(
  tx: NodePgDatabase,
  params: { readonly skuId: string; readonly qty: string; readonly warehouseId: string; readonly clientId: string },
): Promise<readonly SuggestLocationCandidateRow[]> {
  const result = await tx.execute<{
    location_id: string;
    code: string;
    location_type: string;
    position_no: number | null;
    client_assigned_match: boolean;
    remaining_capacity_ratio: string;
    abc_class: string | null;
  }>(sql`
    select l.id as location_id, l.code, l.location_type, coalesce(l.position_no, 0) as position_no,
           (l.assigned_client_id = ${params.clientId}::uuid) as client_assigned_match,
           greatest(
             least(
               case when l.max_weight_kg is null or l.max_weight_kg = 0 then 1
                    else 1 - (coalesce(agg.weight_kg, 0) + ${params.qty}::numeric * coalesce(s.gross_weight_kg, 0)) / l.max_weight_kg end,
               case when l.max_volume_cbm is null or l.max_volume_cbm = 0 then 1
                    else 1 - (coalesce(agg.volume_cbm, 0) + ${params.qty}::numeric * coalesce(s.volume_cbm, 0)) / l.max_volume_cbm end
             ), 0
           )::text as remaining_capacity_ratio,
           s.abc_class
      from wms.locations l
      join wms.zones z on z.id = l.zone_id
      cross join wms.skus s
      left join lateral (
        select sum(sb.qty_on_hand * coalesce(sk.gross_weight_kg, 0)) as weight_kg,
               sum(sb.qty_on_hand * coalesce(sk.volume_cbm, 0)) as volume_cbm
          from wms.stock_balance sb
          join wms.skus sk on sk.id = sb.sku_id
         where sb.location_id = l.id
      ) agg on true
     where l.warehouse_id = ${params.warehouseId}::uuid and s.id = ${params.skuId}::uuid
       and l.location_type in ('pallet', 'shelf') and l.is_blocked = false
       and (l.max_weight_kg is null
            or (coalesce(agg.weight_kg, 0) + ${params.qty}::numeric * coalesce(s.gross_weight_kg, 0)) <= l.max_weight_kg)
       and (l.max_volume_cbm is null
            or (coalesce(agg.volume_cbm, 0) + ${params.qty}::numeric * coalesce(s.volume_cbm, 0)) <= l.max_volume_cbm)
       -- WBS 2.10 (brief Master decision 4, corrected round 1 — pg-reviewer finding 2): a
       -- candidate's zone must independently satisfy EACH side of the SKU's declared temperature
       -- requirement that is actually set. A side the SKU does not declare (null) is unconstrained;
       -- a side the SKU DOES declare needs the zone's matching bound to be explicitly set and wide
       -- enough — a zone with no bounds at all (ambient, uncontrolled) can never satisfy either
       -- clause once the SKU declares even one bound, so it is still fully excluded for any
       -- temperature-sensitive SKU (2.9's own behaviour for a SKU with no requirement at all is
       -- unchanged: both clauses vacuously pass).
       and (s.temp_min is null or (z.temp_min is not null and z.temp_min <= s.temp_min))
       and (s.temp_max is null or (z.temp_max is not null and z.temp_max >= s.temp_max))
     order by l.code
  `);

  return result.rows.map((row) => ({
    locationId: row.location_id,
    code: row.code,
    locationType: row.location_type,
    clientAssignedMatch: row.client_assigned_match,
    remainingCapacityRatio: Number(row.remaining_capacity_ratio),
    positionNo: row.position_no ?? 0,
    abcClass: normalizeAbcClass(row.abc_class),
  }));
}

async function getSkuClientId(tx: NodePgDatabase, skuId: string): Promise<string> {
  const result = await tx.execute<{ client_id: string }>(sql`select client_id from wms.skus where id = ${skuId}::uuid`);
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.skus row for id ${skuId} (Allowed: an existing sku id)`);
  return row.client_id;
}

async function hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roles.includes(roleCode);
}

async function getDocumentTemplateId(tx: NodePgDatabase, templateCode: string): Promise<string> {
  const result = await tx.execute<{ id: string }>(sql`select id from platform.document_templates where code = ${templateCode}`);
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.document_templates row for code ${templateCode}`);
  return row.id;
}

/** Atomic allocator — the ONLY way a document number is ever produced. */
async function nextDocNo(tx: NodePgDatabase, entityId: string, docType: string): Promise<string> {
  const result = await tx.execute<{ doc_no: string }>(sql`select platform.next_doc_no(${entityId}::uuid, ${docType}) as doc_no`);
  const row = result.rows[0];
  if (!row) throw new Error(`platform.next_doc_no returned no row for entity ${entityId} / doc type ${docType}`);
  return row.doc_no;
}

async function insertGrnDocument(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly templateId: string;
    readonly docNo: string;
    readonly sourceId: string;
    readonly renderedData: unknown;
    readonly generatedBy: string;
  },
): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into platform.documents
      (entity_id, template_id, doc_no, source_table, source_id, rendered_data, file_url, generated_by)
    values
      (${params.entityId}::uuid, ${params.templateId}::uuid, ${params.docNo}, ${ORDER_TABLE},
       ${params.sourceId}::uuid, ${JSON.stringify(params.renderedData)}::jsonb, null, ${params.generatedBy}::uuid)
    returning id
  `);
  const row = result.rows[0];
  if (!row) throw new Error('insert into platform.documents returned no row');
  return { id: row.id };
}

/** a frozen GRN snapshot — order fields (doc_no, client code, warehouse code, arrived_at)
 *  plus every line's SKU code/ordered/actual/uom/batch/expiry/variance_reason. No location
 *  (put-away happens later, after Close in the worst case, or even after this snapshot in the
 *  common case — see close-inbound.ts). */
async function getGrnSnapshotData(
  tx: NodePgDatabase,
  orderId: string,
): ReturnType<InboundOrderRepository['getGrnSnapshotData']> {
  const orderResult = await tx.execute<{
    doc_no: string;
    client_id: string;
    warehouse_code: string;
    arrived_at: string | null;
  }>(sql`
    -- Own-module tables only: the client is carried by id. Resolving its name is the renderer's
    -- job, through the sales module's declared contract (doc 40 §A4) — never a cross-module join.
    select o.doc_no, o.client_id, w.code as warehouse_code, o.arrived_at::text as arrived_at
      from ${sql.raw(ORDER_TABLE)} o
      join wms.warehouses w on w.id = o.warehouse_id
     where o.id = ${orderId}::uuid
  `);
  const orderRow = orderResult.rows[0];
  if (!orderRow) throw new OrderNotFoundError(`no ${ORDER_TABLE} row visible for id ${orderId}`);

  const linesResult = await tx.execute<{
    sku_code: string;
    qty_ordered: string;
    qty_actual: string | null;
    uom: string;
    batch_no: string | null;
    expiry_date: string | null;
    variance_reason: string | null;
    variance_photo_url: string | null;
    variance_photo_sha256: string | null;
  }>(sql`
    select s.code as sku_code, ol.qty_ordered::text as qty_ordered, ol.qty_actual::text as qty_actual,
           ol.uom, ol.batch_no, ol.expiry_date::text as expiry_date, ol.variance_reason,
           ol.variance_photo_url, ol.variance_photo_sha256
      from ${sql.raw(LINE_TABLE)} ol
      join wms.skus s on s.id = ol.sku_id
     where ol.order_table = ${ORDER_TABLE} and ol.order_id = ${orderId}::uuid
     order by ol.line_no
  `);

  return {
    docNo: orderRow.doc_no,
    clientId: orderRow.client_id,
    warehouseCode: orderRow.warehouse_code,
    arrivedAt: orderRow.arrived_at,
    lines: linesResult.rows.map((row) => ({
      skuCode: row.sku_code,
      qtyOrdered: row.qty_ordered,
      qtyActual: row.qty_actual,
      uom: row.uom,
      batchNo: row.batch_no,
      expiryDate: row.expiry_date,
      varianceReason: row.variance_reason,
      variancePhotoUrl: row.variance_photo_url,
      variancePhotoSha256: row.variance_photo_sha256,
    })),
  };
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with any outbox row the
 *  same call writes (G9). `target` must match `recordId`'s own table (order
 *  transitions audited as `${ORDER_SCHEMA}.${ORDER_TABLE_NAME}`, line writes as
 *  `${ORDER_SCHEMA}.${LINE_TABLE_NAME}` — never the order's table name for a line's own id).
 *  `occurredAt` is mandatory (always from the injected Clock, never the column's own
 *  `default now()`). */
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
       ${params.entityId}::uuid, ${ORDER_SCHEMA}, ${AUDIT_TABLE_BY_TARGET[params.target]}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const inboundOrderRepository: InboundOrderRepository = {
  getOrderForUpdate,
  updateOrder,
  updateOrderScheduleAndTerms,
  updateOrderCancelReason,
  getOrderLineForUpdate,
  updateLineReceipt,
  updateLineLocation,
  countUnreceiptedLines,
  getAllLineQtyActual,
  hasBlockingOpenLines,
  hasPhysicallyReceivedLines,
  pickRcvLocation,
  findRcvBalanceLocation,
  suggestLocationCandidatesQuery,
  getSkuClientId,
  hasRole,
  getDocumentTemplateId,
  nextDocNo,
  insertGrnDocument,
  getGrnSnapshotData,
  writeAuditRow,
};

// REPLACE-ON-COPY: the two module-schema-qualified constants a later slice's copy must change.
export { ORDER_SCHEMA, ORDER_TABLE_NAME, ORDER_TABLE, LINE_TABLE_NAME, LINE_TABLE };
