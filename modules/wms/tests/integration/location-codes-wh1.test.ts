// WBS 2.3 (pg-tester). The 3,330 WH1 location codes, their seven-character format, the X- prefix
// on structural (blocked) codes, and sellable capacity are ALREADY DELIVERED by
// database/schema/019-Warehouse-WH1-Setup.sql (frozen file) — wms.verify_wh1() already proves 21
// of the doc 19 §3-4 checks (see wh1-setup.test.ts, WBS 2.1). There is no domain/application code
// to build for this task: this file adds the one number doc 38 row 2.3 names that
// wms.verify_wh1() does not itself assert — sellable capacity (3,153 storage locations minus the
// 7% operational buffer = 2,932) — plus the block_reason assertion for structural locations that
// the doc 38 row 2.3 acceptance line calls out ("structural, blocked, with reason"). Read-only —
// no INSERT/UPDATE/DELETE.
//
// Connects to the already-running dev database exactly like wh1-setup.test.ts (pg Pool, PG* env,
// same defaults, shared module-level pool — no per-test connect/catch, no silent skip: if the
// database is unreachable or WH1 is missing, beforeAll throws and the run fails loudly).

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

// database/schema/019-Warehouse-WH1-Setup.sql header comment ("الأرقام المحقَّقة — لا يتغيّر
// منها رقم", 19 §3-4) and wms.verify_wh1()'s own check rows.
const STORAGE_LOCATIONS = 3153; // 300 pallet (288 P-A + 12 P-A1) + 2,853 shelf
const PALLET_LOCATIONS = 300;
const SHELF_LOCATIONS = 2853;
const OPERATIONAL_LOCATIONS = 30;
const STRUCTURAL_LOCATIONS = 147;
const TOTAL_LOCATIONS = 3330;
const DOC_19_VERIFY_WH1_ROW_COUNT = 21; // wms.verify_wh1()'s own fixed number of check rows

// doc 19 §2-0 — the fixed seven-character storage-code format.
const STORAGE_CODE_FORMAT = '^[PGMT][1-9]-[0-9]{2}-[1-9]$';
const STORAGE_CODE_LENGTH = 7;

// The buffer percentage is NOT hard-coded here — it is read at test time from
// platform.thresholds key 'space.buffer_pct' (database/schema/13B-Schema-Reference-
// Consolidation.sql line 2807: 7.000, unit 'pct', "العازل التشغيلي من طاقة الكتلة — EXEC §1.1 ·
// 17 §5-1"), the same threshold 019 §9 applies when it inserts each
// wms.space_blocks_out_of_service row (`qty_pallets = round(capacity_pallets * 0.07, 3)`,
// 019 lines ~305-307 — 0.07 there IS this threshold, expressed as a literal at seed time).
//
// Rounding rule for the 2,932 sellable-capacity figure (doc 38 row 2.3): this test does not
// invent a new rounding rule. It reproduces 019 §9's own already-applied formula — each
// wms.space_blocks_out_of_service.qty_pallets row was computed by the migration itself as
// round(block.capacity_pallets * buffer_pct / 100, 3), one row per active WH1 space block. This
// test only sums those eight already-computed, already-stored values and rounds the TOTAL to a
// whole number, because a location code is an indivisible unit (unlike the fractional-pallet
// per-block buffer amount, which is a valid intermediate quantity but not itself a count of
// locations). round(sum) = round(220.710) = 221, and 3,153 - 221 = 2,932.
const EXPECTED_BUFFER_ROUNDED = 221;
const EXPECTED_SELLABLE = 2932;
const DOC_38_BUFFER_PCT = 7; // doc 38 row 2.3: "the 7% operational buffer"

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

describe('wms.locations — WH1 location-code inventory matches doc 19 §3-4 (WBS 2.3)', () => {
  it('counts 3,153 storage (300 pallet + 2,853 shelf) / 30 operational / 147 structural / 3,330 total', async () => {
    const byType: QueryResult<{ location_type: string; n: string }> = await pool.query(
      `select location_type, count(*)::text as n
         from wms.locations
        where warehouse_id = $1
        group by location_type`,
      [wh1Id],
    );
    const counts = Object.fromEntries(byType.rows.map((r) => [r.location_type, Number(r.n)]));

    expect(counts['pallet']).toBe(PALLET_LOCATIONS);
    expect(counts['shelf']).toBe(SHELF_LOCATIONS);
    expect((counts['pallet'] ?? 0) + (counts['shelf'] ?? 0)).toBe(STORAGE_LOCATIONS);
    expect(counts['operational']).toBe(OPERATIONAL_LOCATIONS);
    expect(counts['structural']).toBe(STRUCTURAL_LOCATIONS);

    const total: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.locations where warehouse_id = $1`,
      [wh1Id],
    );
    expect(total.rows[0]?.n).toBe(String(TOTAL_LOCATIONS));
  });

  it('formats every storage code as the fixed 7-character section-aisle-position-level pattern', async () => {
    const result: QueryResult<{ code_match: boolean; length_match: boolean; n: string }> =
      await pool.query(
        `select
            bool_and(code ~ $2) as code_match,
            bool_and(length(code) = $3) as length_match,
            count(*)::text as n
           from wms.locations
          where warehouse_id = $1 and location_type in ('pallet','shelf')`,
        [wh1Id, STORAGE_CODE_FORMAT, STORAGE_CODE_LENGTH],
      );
    const row = result.rows[0];
    expect(row?.n).toBe(String(STORAGE_LOCATIONS));
    expect(row?.code_match).toBe(true);
    expect(row?.length_match).toBe(true);
  });

  it('prefixes every structural (blocked) code with X-, marks is_blocked, and records a block_reason', async () => {
    const result: QueryResult<{
      prefix_match: boolean;
      all_blocked: boolean;
      all_reasoned: boolean;
      n: string;
    }> = await pool.query(
      `select
          bool_and(code like 'X-%') as prefix_match,
          bool_and(is_blocked) as all_blocked,
          bool_and(block_reason is not null and length(trim(block_reason)) > 0) as all_reasoned,
          count(*)::text as n
         from wms.locations
        where warehouse_id = $1 and location_type = 'structural'`,
      [wh1Id],
    );
    const row = result.rows[0];
    expect(row?.n).toBe(String(STRUCTURAL_LOCATIONS));
    expect(row?.prefix_match).toBe(true);
    expect(row?.all_blocked).toBe(true);
    expect(row?.all_reasoned).toBe(true);
  });

  it('wms.verify_wh1() returns exactly 21 rows, all passed = true', async () => {
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

describe('Sellable capacity = 3,153 storage locations minus the operational buffer (doc 38 row 2.3)', () => {
  it('sums operational_buffer qty_pallets across active WH1 space blocks and derives 2,932 sellable', async () => {
    // platform.thresholds is the governing source for the buffer percentage (CLAUDE.md: no magic
    // numbers) — read live, never hard-coded, and cited to 13B line 2807.
    const threshold: QueryResult<{ value: string; unit: string }> = await pool.query(
      `select value::text as value, unit from platform.thresholds where key = $1`,
      ['space.buffer_pct'],
    );
    const thresholdRow = threshold.rows[0];
    if (!thresholdRow) {
      throw new Error(
        "platform.thresholds row 'space.buffer_pct' not found — is 13B-Schema-Reference-Consolidation.sql applied?",
      );
    }
    expect(thresholdRow.unit).toBe('pct');
    expect(Number(thresholdRow.value)).toBe(DOC_38_BUFFER_PCT);

    const storageCount: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n
         from wms.locations
        where warehouse_id = $1 and location_type in ('pallet','shelf')`,
      [wh1Id],
    );
    expect(storageCount.rows[0]?.n).toBe(String(STORAGE_LOCATIONS));

    const buffer: QueryResult<{ sum_qty_pallets: string | null }> = await pool.query(
      `select sum(x.qty_pallets)::text as sum_qty_pallets
         from wms.space_blocks_out_of_service x
         join wms.space_blocks b on b.id = x.block_id
        where b.warehouse_id = $1 and x.reason = 'operational_buffer'`,
      [wh1Id],
    );
    const rawSum = Number(buffer.rows[0]?.sum_qty_pallets ?? '0');
    const bufferPct = Number(thresholdRow.value);
    expect(rawSum).toBeCloseTo(STORAGE_LOCATIONS * (bufferPct / 100), 2);

    const rounded = Math.round(rawSum);
    expect(rounded).toBe(EXPECTED_BUFFER_ROUNDED);

    const sellable = STORAGE_LOCATIONS - rounded;
    expect(sellable).toBe(EXPECTED_SELLABLE);
  });
});
