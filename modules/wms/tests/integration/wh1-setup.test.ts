// WBS 2.1 (pg-tester). `wms.warehouses`, `wms.zones`, `wms.space_blocks` and `wms.locations` for
// WH1 are ALREADY DELIVERED by database/schema/019-Warehouse-WH1-Setup.sql (frozen file; see
// docs/notes/slice-briefs/_slice-2.1.brief.md and .claude/briefs/wms.brief.md — "the file generates
// exactly what 19 §4 describes; nothing is entered by hand"). There is no domain/application code
// to build for this task: this file is the permanent, re-runnable proof that doc 38 row 2.1's
// acceptance numbers hold against a live Postgres instance. Read-only — no INSERT/UPDATE/DELETE.
//
// Numbers are doc literals, not display formats (review round 1, finding 2): doc 19 says `288`
// and `3,153`, never a decimal-padded display string like 288 with three trailing zeros. Numeric
// comparisons are done IN SQL (`column = $n::numeric`), binding the doc literal as a parameter
// and returning a boolean match flag plus the actual column text (for the failure message only —
// never asserted against a fabricated padded string). m3 per block and the m3 sigma are also
// compared numerically for consistency with capacity_pallets (either text or numeric equality is
// valid per the slice brief; numeric was chosen here).
//
// Citation discipline (review round 1, finding 3): `positions` and `m3` come from doc 19 §3-2
// (lines 127-135, type column A/A1/B/C, no zone column). `zone` letter and `block_type`
// (pallet_rack/shelf) come from doc 19 lines 256-263 (the 019 space-blocks insert tuples).
// Zone location counts for P/G/M/T/X come from doc 19 §3-1 (lines 111-119, 120); zone location
// counts for the six operational zones come from doc 19 §2-4 (lines 93-102); `zone_type` for
// every zone comes from doc 19 lines 224-240 (the 019 zones insert tuples) — name_ar is NOT
// asserted, it is not in the acceptance. Doc 40 line 239 corroborates 30 operational + 147
// structural.
//
// Connects to the already-running dev database exactly like
// modules/platform/tests/integration/schema-invariants.test.ts (pg Pool, PG* env, same defaults).

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// doc 19 §3-2 (lines 127-135) — positions and m3, THE source, copied verbatim, never derived from
// a query. doc 19 lines 256-263 (the 019 space-blocks insert tuples) — zone and block_type.
const DOC_19_SPACE_BLOCKS = [
  { block: 'P-A', type: 'pallet_rack', zone: 'P', positions: 288, m3: '507.384' },
  { block: 'P-A1', type: 'pallet_rack', zone: 'P', positions: 12, m3: '21.141' },
  { block: 'G-B', type: 'shelf', zone: 'G', positions: 906, m3: '880.632' },
  { block: 'G-C', type: 'shelf', zone: 'G', positions: 45, m3: '43.740' },
  { block: 'M-B', type: 'shelf', zone: 'M', positions: 906, m3: '880.632' },
  { block: 'M-C', type: 'shelf', zone: 'M', positions: 45, m3: '43.740' },
  { block: 'T-B', type: 'shelf', zone: 'T', positions: 906, m3: '880.632' },
  { block: 'T-C', type: 'shelf', zone: 'T', positions: 45, m3: '43.740' },
] as const;

// doc 19 §3-2 (line 135) — the governing sigma row: 3,153 positions · 3,301.641 m3.
const DOC_19_TOTAL_POSITIONS = 3153;
const DOC_19_TOTAL_CBM = '3301.641';

// doc 19 §3-1 (lines 111-119: P/G/M/T location counts; line 120: X = 147 structural) · doc 19
// §2-4 (lines 93-102: the six operational zones) · doc 19 lines 224-240 (the 019 zones insert
// tuples: code · name_ar · zone_type — name_ar is not asserted, it is not in the acceptance).
const DOC_19_ZONES = [
  { code: 'P', type: 'storage', locations: 300 },
  { code: 'G', type: 'storage', locations: 951 },
  { code: 'M', type: 'storage', locations: 951 },
  { code: 'T', type: 'storage', locations: 951 },
  { code: 'RCV', type: 'receiving', locations: 6 },
  { code: 'STG', type: 'staging', locations: 8 },
  { code: 'SHP', type: 'shipping', locations: 6 },
  { code: 'QRT', type: 'quarantine', locations: 4 },
  { code: 'RTN', type: 'returns', locations: 4 },
  { code: 'DMG', type: 'damaged', locations: 2 },
  { code: 'X', type: 'structural', locations: 147 },
] as const;

// The six operational zones (doc 19 §2-4, lines 93-102), derived from DOC_19_ZONES rather than
// re-typed, so the list can never drift from the table above.
const OPERATIONAL_ZONE_CODES = DOC_19_ZONES.filter(
  (zone) => zone.type !== 'storage' && zone.type !== 'structural',
).map((zone) => zone.code);

// doc 40 line 239 — "30 operational ... and 147 structural".
const DOC_40_OPERATIONAL_TOTAL = 30;
const DOC_40_STRUCTURAL_TOTAL = 147;

// doc 19 §3-4 / database/schema/019-Warehouse-WH1-Setup.sql §13 (wms.verify_wh1, lines 396-482):
// twenty-one named checks, all of which must pass.
const DOC_19_VERIFY_WH1_ROW_COUNT = 21;

let wh1Id: string;

beforeAll(async () => {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id from wms.warehouses where code = $1`,
    ['WH1'],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      "WH1 not found in wms.warehouses — is database/schema/019-Warehouse-WH1-Setup.sql applied to this database?",
    );
  }
  wh1Id = row.id;
});

afterAll(async () => {
  await pool.end();
});

describe('wms.warehouses — WH1 exists once and belongs to PST (WBS 2.1)', () => {
  it('has exactly one row with code WH1, and its entity is PST', async () => {
    const result: QueryResult<{ code: string; entity_code: string }> = await pool.query(
      `select w.code, e.code as entity_code
         from wms.warehouses w
         join platform.entities e on e.id = w.entity_id
        where w.code = $1`,
      ['WH1'],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.code).toBe('WH1');
    expect(result.rows[0]?.entity_code).toBe('PST');
  });
});

describe('wms.space_blocks — each of the eight blocks matches doc 19 §3-2 (lines 127-135) / lines 256-263', () => {
  it.each(DOC_19_SPACE_BLOCKS)(
    '$block: zone $zone, block_type $type, capacity_pallets $positions, capacity_cbm $m3, status active, ' +
      'and exactly $positions wms.locations rows reference it via space_block_id',
    async ({ block, type, zone, positions, m3 }) => {
      const blockResult: QueryResult<{
        id: string;
        block_type: string;
        status: string;
        zone_code: string;
        pallets_match: boolean;
        capacity_pallets_actual: string;
        cbm_match: boolean;
        capacity_cbm_actual: string;
      }> = await pool.query(
        `select sb.id, sb.block_type, sb.status, z.code as zone_code,
                (sb.capacity_pallets = $3::numeric) as pallets_match,
                sb.capacity_pallets::text as capacity_pallets_actual,
                (sb.capacity_cbm = $4::numeric) as cbm_match,
                sb.capacity_cbm::text as capacity_cbm_actual
           from wms.space_blocks sb
           join wms.zones z on z.id = sb.zone_id
          where sb.warehouse_id = $1 and sb.code = $2`,
        [wh1Id, block, positions, m3],
      );

      expect(blockResult.rows).toHaveLength(1);
      const row = blockResult.rows[0];
      if (!row) throw new Error(`unreachable: length checked above for ${block}`);

      expect(row.zone_code).toBe(zone);
      expect(row.block_type).toBe(type);
      expect(row.status).toBe('active');
      expect(
        row.pallets_match,
        `capacity_pallets: expected ${positions} (doc 19 §3-2 line 127-135), got ${row.capacity_pallets_actual}`,
      ).toBe(true);
      expect(
        row.cbm_match,
        `capacity_cbm: expected ${m3} (doc 19 §3-2 line 127-135), got ${row.capacity_cbm_actual}`,
      ).toBe(true);

      const locationsResult: QueryResult<{ count: string }> = await pool.query(
        `select count(*)::text as count from wms.locations where space_block_id = $1`,
        [row.id],
      );
      expect(locationsResult.rows[0]?.count).toBe(String(positions));
    },
  );
});

describe('wms.space_blocks — the eight blocks are exactly the eight doc-19 codes and no other (WBS 2.1)', () => {
  it('sorted codes of wms.space_blocks for WH1 equal the doc 19 §3-2 codes, no other', async () => {
    const expectedSortedBlockCodes = DOC_19_SPACE_BLOCKS.map((b) => b.block)
      .slice()
      .sort();

    const result: QueryResult<{ codes: string[] | null }> = await pool.query(
      `select array_agg(code order by code) as codes from wms.space_blocks where warehouse_id = $1`,
      [wh1Id],
    );
    expect(result.rows[0]?.codes).toEqual(expectedSortedBlockCodes);
  });
});

describe('wms.space_blocks — totals (WBS 2.1, numeric equality, not float)', () => {
  it('sum(capacity_pallets) = 3153 and sum(capacity_cbm) = 3301.641 (doc 19 §3-2 line 135)', async () => {
    const result: QueryResult<{
      pallets_match: boolean;
      total_pallets_actual: string;
      cbm_match: boolean;
      total_cbm_actual: string;
    }> = await pool.query(
      `select (sum(capacity_pallets) = $2::numeric) as pallets_match,
              sum(capacity_pallets)::text as total_pallets_actual,
              (sum(capacity_cbm) = $3::numeric) as cbm_match,
              sum(capacity_cbm)::text as total_cbm_actual
         from wms.space_blocks
        where warehouse_id = $1`,
      [wh1Id, DOC_19_TOTAL_POSITIONS, DOC_19_TOTAL_CBM],
    );
    const row = result.rows[0];

    expect(
      row?.pallets_match,
      `sum(capacity_pallets): expected ${DOC_19_TOTAL_POSITIONS} (doc 19 §3-2 line 135), got ${row?.total_pallets_actual}`,
    ).toBe(true);
    expect(
      row?.cbm_match,
      `sum(capacity_cbm): expected ${DOC_19_TOTAL_CBM} (doc 19 §3-2 line 135), got ${row?.total_cbm_actual}`,
    ).toBe(true);
  });
});

describe('wms.zones — each of the eleven zones matches doc 19 §3-1 / §2-4 / lines 224-240 (WBS 2.1)', () => {
  it.each(DOC_19_ZONES)(
    '$code: zone_type $type, exactly $locations wms.locations rows belong to it via zone_id',
    async ({ code, type, locations }) => {
      const zoneResult: QueryResult<{ id: string; zone_type: string }> = await pool.query(
        `select id, zone_type from wms.zones where warehouse_id = $1 and code = $2`,
        [wh1Id, code],
      );

      expect(zoneResult.rows).toHaveLength(1);
      const zoneRow = zoneResult.rows[0];
      if (!zoneRow) throw new Error(`unreachable: length checked above for ${code}`);

      expect(zoneRow.zone_type).toBe(type);

      const locationsResult: QueryResult<{ count: string }> = await pool.query(
        `select count(*)::text as count from wms.locations where warehouse_id = $1 and zone_id = $2`,
        [wh1Id, zoneRow.id],
      );
      expect(locationsResult.rows[0]?.count).toBe(String(locations));
    },
  );
});

describe('wms.zones — the zones are exactly the eleven doc-19 codes and no other (WBS 2.1)', () => {
  it('sorted codes of wms.zones for WH1 equal the doc 19 zone codes, no other', async () => {
    const expectedSortedZoneCodes = DOC_19_ZONES.map((z) => z.code)
      .slice()
      .sort();

    const result: QueryResult<{ codes: string[] | null }> = await pool.query(
      `select array_agg(code order by code) as codes from wms.zones where warehouse_id = $1`,
      [wh1Id],
    );
    expect(result.rows[0]?.codes).toEqual(expectedSortedZoneCodes);
  });
});

describe('wms.locations — operational and structural totals (doc 40 line 239, WBS 2.1)', () => {
  it('sum of wms.locations across the six operational zones equals 30', async () => {
    const result: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count
         from wms.locations l
         join wms.zones z on z.id = l.zone_id
        where l.warehouse_id = $1 and z.code = any($2::text[])`,
      [wh1Id, OPERATIONAL_ZONE_CODES],
    );
    expect(result.rows[0]?.count).toBe(String(DOC_40_OPERATIONAL_TOTAL));
  });

  it('count of wms.locations in zone X equals 147', async () => {
    const result: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count
         from wms.locations l
         join wms.zones z on z.id = l.zone_id
        where l.warehouse_id = $1 and z.code = $2`,
      [wh1Id, 'X'],
    );
    expect(result.rows[0]?.count).toBe(String(DOC_40_STRUCTURAL_TOTAL));
  });
});

describe('wms.verify_wh1() — the schema\'s own verification agrees (WBS 2.1)', () => {
  it('returns 21 rows, all passed = true (prints the failing check_name on failure)', async () => {
    const result: QueryResult<{
      check_name: string;
      expected: string;
      actual: string;
      passed: boolean;
    }> = await pool.query('select * from wms.verify_wh1()');

    expect(result.rows).toHaveLength(DOC_19_VERIFY_WH1_ROW_COUNT);

    const failing = result.rows.filter((row) => !row.passed);
    expect(
      failing.map((row) => `${row.check_name} (expected ${row.expected}, got ${row.actual})`),
    ).toEqual([]);
    expect(result.rows.every((row) => row.passed === true)).toBe(true);
  });
});

describe('nothing was entered by hand — every row in the whole database belongs to WH1 (WBS 2.1)', () => {
  // Master decision (review round 1, finding 5): whole-table check, not scoped to WH1-coded zones
  // or WH1 space_blocks — nothing else may exist yet. It will legitimately go red the day a
  // second warehouse is registered; that slice narrows this check to "for WH1" as part of its own
  // acceptance criterion.
  it('no wms.zones row in the whole table has a warehouse_id other than WH1\'s id', async () => {
    const result: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count from wms.zones where warehouse_id is distinct from $1`,
      [wh1Id],
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('no wms.space_blocks row in the whole table has a warehouse_id other than WH1\'s id', async () => {
    const result: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count from wms.space_blocks where warehouse_id is distinct from $1`,
      [wh1Id],
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('no wms.locations row in the whole table has a warehouse_id other than WH1\'s id', async () => {
    const result: QueryResult<{ count: string }> = await pool.query(
      `select count(*)::text as count from wms.locations where warehouse_id is distinct from $1`,
      [wh1Id],
    );
    expect(result.rows[0]?.count).toBe('0');
  });
});
