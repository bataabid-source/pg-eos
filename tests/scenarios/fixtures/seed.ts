// tests/scenarios/fixtures/seed.ts — enablement item 3a (Master decision 7: client/SKU seed codes
// prefixed `_s1_`/`_s2_`/`S1-GULF-0137-` + uuid; Gherkin names go in `name_en`; contract
// `start_date` one year before the clock date, price list `valid_from` one year before the clock
// date; draft inbound/outbound order + `wms.order_lines` inserts, direct SQL, exactly as
// modules/wms/tests/process-outbound/process-outbound.test.ts:470-514 and
// modules/wms/tests/receive-inbound/handlers.test.ts:82-95 do for the same reason (order lines are
// not part of either use case's own command surface).

import { randomUUID } from 'node:crypto';

import type { Pool, QueryResult } from 'pg';

import { SCENARIO_CLOCK_DATE } from './clock.js';

const DEFAULT_UOM = 'EA';
const DEFAULT_ORDER_LINE_NO = 1;
const DEFAULT_CONTRACT_STATUS = 'active';
const DEFAULT_PRICE_LIST_STATUS = 'active';
// fix round finding 12: named, not inline magic literals.
const DEFAULT_SKU_GROSS_WEIGHT_KG = '1.000';
const DEFAULT_SKU_VOLUME_CBM = '0.00100';
const DEFAULT_PICKING_POLICY = 'FIFO';
// finding 8 (process-outbound.test.ts:224-228 precedent): a fixed one-year-back offset, written as
// a literal SQL interval anchored to the FIXED clock date parameter — never `current_date`, and
// never a `||`-concatenated parameter (postgres cannot infer $n's type against an untyped `||`).
const START_DATE_OFFSET_INTERVAL_SQL = `interval '1 year'`;

export interface InsertClientParams {
  readonly codePrefix: string;
  readonly nameEn: string;
  readonly nameAr: string;
}

export async function insertClient(pool: Pool, params: InsertClientParams): Promise<string> {
  const code = `${params.codePrefix}${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, name_en, account_type)
     values ($1, $2, $3, 'client') returning id`,
    [code, params.nameAr, params.nameEn],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.accounts insert returned no row');
  return row.id;
}

export interface InsertSkuParams {
  readonly clientId: string;
  readonly codePrefix: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly minRemainingLifeReceiptDays?: number | null;
  readonly minRemainingLifeIssueDays?: number | null;
  readonly trackBatch?: boolean;
  readonly trackExpiry?: boolean;
  readonly pickingPolicy?: 'FIFO' | 'FEFO' | 'LIFO';
}

export async function insertSku(pool: Pool, params: InsertSkuParams): Promise<string> {
  const code = `${params.codePrefix}${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus
       (client_id, code, name_ar, name_en, gross_weight_kg, volume_cbm,
        min_remaining_life_receipt_days, min_remaining_life_issue_days,
        track_batch, track_expiry, picking_policy)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      params.clientId,
      code,
      params.nameAr,
      params.nameEn,
      DEFAULT_SKU_GROSS_WEIGHT_KG,
      DEFAULT_SKU_VOLUME_CBM,
      params.minRemainingLifeReceiptDays ?? null,
      params.minRemainingLifeIssueDays ?? null,
      params.trackBatch ?? false,
      params.trackExpiry ?? false,
      params.pickingPolicy ?? DEFAULT_PICKING_POLICY,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.skus insert returned no row');
  return row.id;
}

export interface InsertPriceListParams {
  readonly entityId: string;
  readonly codePrefix: string;
  readonly nameAr: string;
}

/** `valid_from` is one year before the FIXED clock date (Master decision 7), never `current_date`. */
export async function insertPriceList(pool: Pool, params: InsertPriceListParams): Promise<string> {
  const code = `${params.codePrefix}${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_lists (entity_id, code, name_ar, valid_from, valid_to, status)
     values ($1, $2, $3, $4::date - ${START_DATE_OFFSET_INTERVAL_SQL}, null, $5)
     returning id`,
    [params.entityId, code, params.nameAr, SCENARIO_CLOCK_DATE, DEFAULT_PRICE_LIST_STATUS],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.price_lists insert returned no row');
  return row.id;
}

export async function insertPriceListLine(
  pool: Pool,
  params: { readonly priceListId: string; readonly serviceId: string; readonly price: string },
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_list_lines (price_list_id, service_id, price)
     values ($1, $2, $3::numeric) returning id`,
    [params.priceListId, params.serviceId, params.price],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture catalog.price_list_lines insert returned no row');
  return row.id;
}

export interface InsertContractParams {
  readonly entityId: string;
  readonly accountId: string;
  readonly titleAr: string;
  readonly priceListId?: string | null;
}

/** `start_date` is one year before the FIXED clock date (Master decision 7), never `current_date`. */
export async function insertContract(pool: Pool, params: InsertContractParams): Promise<string> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, 'CNT') as doc_no`,
    [params.entityId],
  );
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for CNT');
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, status, start_date, end_date, price_list_id)
     values ($1, $2, $3, $4, $5, $6::date - ${START_DATE_OFFSET_INTERVAL_SQL}, null, $7)
     returning id`,
    [
      params.entityId,
      docNo,
      params.accountId,
      params.titleAr,
      DEFAULT_CONTRACT_STATUS,
      SCENARIO_CLOCK_DATE,
      params.priceListId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.contracts insert returned no row');
  return row.id;
}

export interface DraftInboundOrderResult {
  readonly id: string;
  readonly version: number;
}

export async function insertDraftInboundOrder(
  pool: Pool,
  params: { readonly entityId: string; readonly clientId: string; readonly warehouseId: string },
): Promise<DraftInboundOrderResult> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, 'INB') as doc_no`,
    [params.entityId],
  );
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for INB');
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
     values ($1, $2, $3, $4, 'draft') returning id, version`,
    [params.entityId, docNo, params.clientId, params.warehouseId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.inbound_orders insert returned no row');
  return row;
}

export interface InsertOrderLineParams {
  readonly orderTable: 'wms.inbound_orders' | 'wms.outbound_orders';
  readonly orderId: string;
  readonly skuId: string;
  readonly qtyOrdered: string;
  readonly lineNo?: number;
}

/** Direct-SQL fixture — order LINES are not part of either use case's own command surface (same
 *  reasoning as receive-inbound.test.ts's createDraftInboundOrder / process-outbound.test.ts's
 *  createDraftOutboundOrderFixture). */
export async function insertOrderLine(pool: Pool, params: InsertOrderLineParams): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom, status)
     values ($1, $2, $3, $4, $5::numeric, $6, 'open') returning id`,
    [params.orderTable, params.orderId, params.lineNo ?? DEFAULT_ORDER_LINE_NO, params.skuId, params.qtyOrdered, DEFAULT_UOM],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.order_lines insert returned no row');
  return row.id;
}

export interface EnsuredDocumentTemplate {
  readonly id: string;
  /** true only when THIS call inserted the row — D-183: never touch a row this run does not own.
   *  Another suite (or a previous interrupted run) may already own the same global `code`; in that
   *  case `owned` is false and teardown must leave the row alone. */
  readonly owned: boolean;
}

/** receive-line.ts's own `getDocumentTemplateId` (modules/wms/infrastructure/receive-inbound/
 *  repository.ts:498) requires a `platform.document_templates` row for the GRN template code before
 *  it can post a receipt — same fixture step
 *  modules/wms/tests/receive-inbound/receive-inbound.test.ts:572-577 seeds for the real golden-slice
 *  test suite. Fix round finding 1: `on conflict do NOTHING` (never `do update`) — a returned row
 *  means THIS call inserted it (owns it); no returned row means it already existed (owned by
 *  someone else), so a plain `select` recovers its id without claiming ownership. */
export async function ensureDocumentTemplate(
  pool: Pool,
  params: { readonly code: string; readonly nameAr: string; readonly bodyHtml: string },
): Promise<EnsuredDocumentTemplate> {
  const insertResult: QueryResult<{ id: string }> = await pool.query(
    `insert into platform.document_templates (code, name_ar, entity_id, body_html)
     values ($1, $2, null, $3)
     on conflict (code) do nothing
     returning id`,
    [params.code, params.nameAr, params.bodyHtml],
  );
  const insertedRow = insertResult.rows[0];
  if (insertedRow) return { id: insertedRow.id, owned: true };

  const existingResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.document_templates where code = $1`,
    [params.code],
  );
  const existingRow = existingResult.rows[0];
  if (!existingRow) throw new Error(`platform.document_templates row not found for code ${params.code} after a no-op insert`);
  return { id: existingRow.id, owned: false };
}

/** Only deletes the template row when THIS run inserted it (D-183). */
export async function deleteDocumentTemplateIfOwned(pool: Pool, templateId: string, owned: boolean): Promise<void> {
  if (!owned) return;
  await pool.query(`delete from platform.document_templates where id = $1`, [templateId]);
}

/** ReceiveLine generates a `platform.documents` row (the GRN) against the template for every
 *  receipt, `source_id` = the order id — scoped to THIS run's own order ids (precedent
 *  modules/wms/tests/receive-inbound/receive-inbound.test.ts:597), never to the (possibly
 *  not-owned) template id. Must run before `deleteOrderAndLines` deletes the order row itself is
 *  NOT required (no FK from documents.source_id to the order table), but before
 *  `deleteDocumentTemplateIfOwned` (`documents_template_id_fkey`, RESTRICT). */
export async function deleteDocumentsForOrders(pool: Pool, orderIds: readonly string[]): Promise<void> {
  if (orderIds.length === 0) return;
  await pool.query(`delete from platform.documents where source_id = any($1::uuid[])`, [orderIds]);
}

// --- FK-safe teardown helpers --------------------------------------------------------------------

export async function deleteOrderAndLines(pool: Pool, orderTable: 'wms.inbound_orders' | 'wms.outbound_orders', orderId: string): Promise<void> {
  await pool.query(`delete from wms.order_lines where order_table = $1 and order_id = $2`, [orderTable, orderId]);
  await pool.query(`delete from ${orderTable} where id = $1`, [orderId]);
}

/** Deletes the ledger rows a golden-slice receive+putaway flow wrote for this SKU — never a direct
 *  INSERT (G1), but teardown of the tester's OWN fixture rows inside this package's own `afterAll`
 *  is exactly the D-183 carve-out. Must run BEFORE deleting the sku (FK restrict). */
export async function deleteStockForSku(pool: Pool, skuId: string): Promise<void> {
  await pool.query(`delete from wms.stock_movements where sku_id = $1`, [skuId]);
  await pool.query(`delete from wms.stock_balance where sku_id = $1`, [skuId]);
}

export async function deleteSku(pool: Pool, skuId: string): Promise<void> {
  await pool.query(`delete from wms.skus where id = $1`, [skuId]);
}

export async function deleteContract(pool: Pool, contractId: string): Promise<void> {
  await pool.query(`delete from sales.contracts where id = $1`, [contractId]);
}

/** `catalog.price_list_lines` cascades on `price_list_id` (ON DELETE CASCADE) — deleting the price
 *  list is enough. */
export async function deletePriceList(pool: Pool, priceListId: string): Promise<void> {
  await pool.query(`delete from catalog.price_lists where id = $1`, [priceListId]);
}

export async function deleteClient(pool: Pool, clientId: string): Promise<void> {
  await pool.query(`delete from sales.accounts where id = $1`, [clientId]);
}

/** Teardown deletes only rows THIS run owns: `platform.outbox` by its own correlation ids,
 *  `platform.documents` by its own order ids, the GRN-01 `platform.document_templates` row only if
 *  this run inserted it (D-183) — see `deleteDocumentsForOrders`/`deleteDocumentTemplateIfOwned`
 *  above and the correlation-tracker-driven `platform.outbox` delete in each spec file's `afterAll`.
 *  `platform.decisions` / `billing.billable_events` / `tms.delivery_tasks` have NO teardown step
 *  here because nothing writes them today (the features that would — WBS 2.16, 4.3, 3.4 — are NOT
 *  BUILT, per the scenarios' own RED assertions); once one of those lands, its FK-safe teardown must
 *  be added here, and the corresponding scenario assertion will start showing the real row.
 *  `platform.audit_log` is never deleted (CLAUDE.md). */
