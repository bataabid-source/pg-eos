// tests/scenarios/fixtures/lookups.ts — enablement item 3a (Master decision 7: entity PST,
// warehouse WH1; storage locations chosen from the seeded WH1 storage zones, unblocked).

import type { Pool, QueryResult } from 'pg';

export const SCENARIO_ENTITY_CODE = 'PST';
export const SCENARIO_WAREHOUSE_CODE = 'WH1';
export const PDL_ENTITY_CODE = 'PDL';

const STORAGE_ZONE_TYPE = 'storage';

export async function getEntityIdByCode(pool: Pool, code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, [
    code,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`platform.entities row not found for code ${code}`);
  return row.id;
}

export async function getWarehouseIdByCode(pool: Pool, code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(`select id from wms.warehouses where code = $1`, [
    code,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`wms.warehouses row not found for code ${code}`);
  return row.id;
}

/** Picks `count` DISTINCT unblocked locations from WH1's already-seeded storage zones
 *  (019-Warehouse-WH1-Setup.sql) — never a direct `wms.locations` INSERT of scenario-owned rows;
 *  ordered by code so repeated runs (twice in a row, guard runs) pick the SAME rows, never
 *  colliding with each other since this is a read-only SELECT of pre-existing reference data. */
export async function pickStorageLocationIds(pool: Pool, warehouseId: string, count: number): Promise<string[]> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select l.id
       from wms.locations l
       join wms.zones z on z.id = l.zone_id
      where l.warehouse_id = $1 and z.zone_type = $2 and l.is_blocked = false
      order by l.code
      limit $3`,
    [warehouseId, STORAGE_ZONE_TYPE, count],
  );
  if (result.rows.length < count) {
    throw new Error(
      `expected ${count} unblocked storage locations in warehouse ${warehouseId}, found ${result.rows.length}`,
    );
  }
  return result.rows.map((row) => row.id);
}

export async function getServiceIdByCode(pool: Pool, code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [
    code,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`catalog.services row not found for code ${code}`);
  return row.id;
}
