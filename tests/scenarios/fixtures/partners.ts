// tests/scenarios/fixtures/partners.ts — S18 (docs/notes/slice-briefs/_slice-X-s18.brief.md):
// partner / partner warehouse / storage zone / space block / partner contract + price line /
// partner invoice insert-delete helpers, same discipline as ./seed.ts (a fresh, un-owned
// `_s18_`-prefixed row per call; FK-safe, own-rows-only deletes; `platform.next_doc_no` for every
// doc-numbered table, exactly as seed.ts's own `insertContract` does for `sales.contracts`).
//
// Column defaults recorded in the brief's Schema facts (`col_description` on `partner_type` and
// `relation_type` is empty — checked by the lane session): `partner_type` DEFAULT 'warehouse',
// `relation_type` DEFAULT 'storage'. `wms.space_blocks.block_type` uses the literal
// modules/wms/tests/manage-space/manage-space.test.ts:100 (`BLOCK_TYPE_PALLET_RACK`) uses
// ('pallet_rack'). `partners.partner_invoices.variance_amount`/`variance_pct` are GENERATED
// columns (13B) — never inserted here.

import { randomUUID } from 'node:crypto';

import type { Pool, QueryResult } from 'pg';

import { SCENARIO_CLOCK_DATE } from './clock.js';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

const PARTNER_TYPE_DEFAULT = 'warehouse';
const PARTNER_STATUS_ACTIVE = 'active';
const PARTNER_CONTRACT_RELATION_TYPE_DEFAULT = 'storage';
const PARTNER_CONTRACT_STATUS_ACTIVE = 'active';
const PARTNER_CONTRACT_DOC_SERIES = 'PCT';
const PARTNER_INVOICE_DOC_SERIES = 'PINV';
const PARTNER_INVOICE_STATUS_RECEIVED = 'received';
const STORAGE_ZONE_TYPE = 'storage';
export const PARTNER_INVOICES_SOURCE_TABLE = 'partners.partner_invoices';
const SPACE_BLOCK_TYPE_PALLET_RACK = 'pallet_rack';
// >= 200 (Given "allocated 200 pallets") — a fresh block, so no space_blocks_out_of_service rows
// exist and sellable === capacity (brief HONEST STATE).
const SPACE_BLOCK_CAPACITY_PALLETS = '250.000';
// Master decision 7 (seed.ts's own pattern): `start_date` one year before the FIXED clock date,
// never `current_date`.
const START_DATE_OFFSET_INTERVAL_SQL = `interval '1 year'`;

// --- partners.partners -------------------------------------------------------------------------

export interface InsertPartnerParams {
  readonly codePrefix: string;
  readonly nameEn: string;
  readonly nameAr: string;
}

export async function insertPartner(pool: Pool, params: InsertPartnerParams): Promise<string> {
  const code = `${params.codePrefix}${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into partners.partners (code, name_ar, name_en, partner_type, status)
     values ($1, $2, $3, $4, $5) returning id`,
    [code, params.nameAr, params.nameEn, PARTNER_TYPE_DEFAULT, PARTNER_STATUS_ACTIVE],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture partners.partners insert returned no row');
  return row.id;
}

export async function deletePartner(pool: Pool, partnerId: string): Promise<void> {
  await pool.query(`delete from partners.partners where id = $1`, [partnerId]);
}

// --- wms.warehouses (is_partner) -----------------------------------------------------------------

export interface InsertPartnerWarehouseParams {
  readonly entityId: string;
  readonly partnerId: string;
  readonly codePrefix: string;
  readonly nameAr: string;
}

export async function insertPartnerWarehouse(pool: Pool, params: InsertPartnerWarehouseParams): Promise<string> {
  const code = `${params.codePrefix}${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar, is_partner, partner_id)
     values ($1, $2, $3, true, $4) returning id`,
    [params.entityId, code, params.nameAr, params.partnerId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.warehouses insert returned no row');
  return row.id;
}

export async function deletePartnerWarehouse(pool: Pool, warehouseId: string): Promise<void> {
  await pool.query(`delete from wms.warehouses where id = $1`, [warehouseId]);
}

// --- wms.zones (storage) -------------------------------------------------------------------------

export interface InsertStorageZoneParams {
  readonly warehouseId: string;
  readonly codePrefix: string;
  readonly nameAr: string;
}

export async function insertStorageZone(pool: Pool, params: InsertStorageZoneParams): Promise<string> {
  const code = `${params.codePrefix}${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, $2, $3, $4) returning id`,
    [params.warehouseId, code, params.nameAr, STORAGE_ZONE_TYPE],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.zones insert returned no row');
  return row.id;
}

export async function deleteZone(pool: Pool, zoneId: string): Promise<void> {
  await pool.query(`delete from wms.zones where id = $1`, [zoneId]);
}

// --- wms.space_blocks -----------------------------------------------------------------------------

export interface InsertPartnerSpaceBlockParams {
  readonly entityId: string;
  readonly warehouseId: string;
  readonly zoneId: string;
  readonly codePrefix: string;
}

export async function insertPartnerSpaceBlock(pool: Pool, params: InsertPartnerSpaceBlockParams): Promise<string> {
  const code = `${params.codePrefix}${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_blocks (entity_id, warehouse_id, zone_id, code, block_type, capacity_pallets)
     values ($1, $2, $3, $4, $5, $6::numeric) returning id`,
    [params.entityId, params.warehouseId, params.zoneId, code, SPACE_BLOCK_TYPE_PALLET_RACK, SPACE_BLOCK_CAPACITY_PALLETS],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.space_blocks insert returned no row');
  return row.id;
}

export async function deleteSpaceBlock(pool: Pool, blockId: string): Promise<void> {
  await pool.query(`delete from wms.space_blocks where id = $1`, [blockId]);
}

/** FK-safe pre-step for `deleteSpaceBlock`/`deleteContract`: `wms.space_allocations` has no cascade
 *  on `block_id` (RESTRICT) — deletes only the allocation rows this run's own AllocateSpace call
 *  (or a fixture) wrote against `blockId`. */
export async function deleteSpaceAllocationsForBlock(pool: Pool, blockId: string): Promise<void> {
  await pool.query(`delete from wms.space_allocations where block_id = $1`, [blockId]);
}

/** FK-safe pre-step for `deletePartnerWarehouse`: `wms.occupancy_snapshots.warehouse_id` has no
 *  cascade (RESTRICT). Scoped to `warehouseId` — the partner warehouse this run created — so it
 *  never touches another suite's rows. Idempotent: deletes 0 rows when the snapshot command wrote
 *  none (brief HONEST STATE: `clientsSnapshotted 0` for an unoccupied block). */
export async function deleteOccupancySnapshotsForWarehouse(pool: Pool, warehouseId: string): Promise<void> {
  await pool.query(`delete from wms.occupancy_snapshots where warehouse_id = $1`, [warehouseId]);
}

// --- partners.partner_contracts + partner_price_lines ----------------------------------------------

export interface InsertPartnerContractParams {
  readonly entityId: string;
  readonly partnerId: string;
  readonly title: string;
}

export interface InsertPartnerContractResult {
  readonly id: string;
  /** `partner_price_lines.valid_from` must equal this same `start_date` (brief HONEST STATE). */
  readonly startDate: string;
}

export async function insertPartnerContract(
  pool: Pool,
  params: InsertPartnerContractParams,
): Promise<InsertPartnerContractResult> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, $2) as doc_no`,
    [params.entityId, PARTNER_CONTRACT_DOC_SERIES],
  );
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for PCT');
  const result: QueryResult<{ id: string; start_date: string }> = await pool.query(
    `insert into partners.partner_contracts
       (entity_id, doc_no, partner_id, relation_type, title, status, start_date)
     values ($1, $2, $3, $4, $5, $6, $7::date - ${START_DATE_OFFSET_INTERVAL_SQL})
     returning id, start_date::text`,
    [
      params.entityId,
      docNo,
      params.partnerId,
      PARTNER_CONTRACT_RELATION_TYPE_DEFAULT,
      params.title,
      PARTNER_CONTRACT_STATUS_ACTIVE,
      SCENARIO_CLOCK_DATE,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture partners.partner_contracts insert returned no row');
  return { id: row.id, startDate: row.start_date };
}

/** Deletes only THIS run's own contract row. `partner_price_lines` cascades on `contract_id` (ON
 *  DELETE CASCADE) — but this suite still deletes its price line explicitly first (own-rows-only
 *  discipline, same as `deletePriceList`'s comment in seed.ts), so the order here never relies on
 *  the cascade alone. Caller must have already deleted any `partner_invoices` row referencing this
 *  contract (RESTRICT, no cascade). */
export async function deletePartnerContract(pool: Pool, contractId: string): Promise<void> {
  await pool.query(`delete from partners.partner_contracts where id = $1`, [contractId]);
}

export interface InsertPartnerPriceLineParams {
  readonly contractId: string;
  readonly serviceId: string;
  readonly costPrice: string;
  readonly uom: string;
  readonly validFrom: string;
}

export async function insertPartnerPriceLine(pool: Pool, params: InsertPartnerPriceLineParams): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into partners.partner_price_lines (contract_id, service_id, cost_price, uom, valid_from)
     values ($1, $2, $3::numeric, $4, $5::date) returning id`,
    [params.contractId, params.serviceId, params.costPrice, params.uom, params.validFrom],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture partners.partner_price_lines insert returned no row');
  return row.id;
}

export async function deletePartnerPriceLine(pool: Pool, lineId: string): Promise<void> {
  await pool.query(`delete from partners.partner_price_lines where id = $1`, [lineId]);
}

// --- partners.partner_invoices ---------------------------------------------------------------------

export interface InsertPartnerInvoiceParams {
  readonly entityId: string;
  readonly partnerId: string;
  readonly contractId: string;
  readonly partnerRefPrefix: string;
  readonly claimedAmount: string;
}

export async function insertPartnerInvoice(pool: Pool, params: InsertPartnerInvoiceParams): Promise<string> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, $2) as doc_no`,
    [params.entityId, PARTNER_INVOICE_DOC_SERIES],
  );
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for PINV');
  const partnerRef = `${params.partnerRefPrefix}${randomUUID()}`;
  // variance_amount/variance_pct are GENERATED columns (13B) — never in this INSERT's column list.
  // matched_amount/paid_amount are NOT NULL DEFAULT 0 — also left off, so the schema's own default
  // stands (brief HONEST STATE: "until matching exists the generated columns read 8400 / NULL").
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into partners.partner_invoices
       (entity_id, doc_no, partner_ref, partner_id, contract_id, invoice_date, claimed_amount, status)
     values ($1, $2, $3, $4, $5, $6::date, $7::numeric, $8) returning id`,
    [
      params.entityId,
      docNo,
      partnerRef,
      params.partnerId,
      params.contractId,
      SCENARIO_CLOCK_DATE,
      params.claimedAmount,
      PARTNER_INVOICE_STATUS_RECEIVED,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture partners.partner_invoices insert returned no row');
  return row.id;
}

export async function deletePartnerInvoice(pool: Pool, invoiceId: string): Promise<void> {
  await pool.query(`delete from partners.partner_invoices where id = $1`, [invoiceId]);
}

/** FK-safe pre-step for `deletePartnerInvoice`: `platform.decisions.source_id` has no FK/cascade at
 *  all (a plain uuid column, per the brief) — this only ever deletes rows this run's own invoice id
 *  produced, scoped by `source_table`/`source_id`, never a bare `platform.decisions` sweep. */
export async function deleteDecisionsForInvoice(pool: Pool, invoiceId: string): Promise<void> {
  await pool.query(`delete from platform.decisions where source_table = $1 and source_id = $2`, [
    PARTNER_INVOICES_SOURCE_TABLE,
    invoiceId,
  ]);
}
