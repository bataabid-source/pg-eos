// modules/wms/tests/integration/balance-integrity-batch.test.ts — GM directive 2026-09-23 phase H
// (SCR-WMS-01): regression tests for the wms.verify_balance_integrity() batch_no fix, pg-tester.
//
// Prior defect (fixed by 01 §wms.verify_balance_integrity (v1.1), migration
// database/migrations/0005_M_balance-integrity-batch.sql, guard G1): the ledger CTE folded by
// (client_id, sku_id, coalesce(to_location_id, from_location_id)) WITHOUT batch_no, then joined
// wms.stock_balance whose key is (client_id, sku_id, location_id, batch_no) (01 wms.stock_balance,
// 01 wms.stock_balance.batch_no default ''). Two batches of one SKU at one location -> each balance row
// was compared against the SUM of both -> false deviations. It also read only ledger -> balance,
// so a non-zero balance row with no ledger rows was never reported (doc 40 INV-C3-2,
// docs/package/40-Build-Specification-EN.md:245: "Rebuilt balance from ledger equals stored
// balance"). The tests below prove the fix and guard against a regression back to the old fold.
//
// Fixed interface implemented by 01 §wms.verify_balance_integrity (v1.1), tested against here:
// wms.verify_balance_integrity() returns
//   (client_id uuid, sku_id uuid, location_id uuid, batch_no text,
//    ledger_qty numeric, balance_qty numeric, diff numeric)
// with ledger batch key = coalesce(stock_movements.batch_no, ''), and a full comparison in both
// directions (a balance row with no ledger rows and qty_on_hand <> 0 is reported with
// ledger_qty 0).
//
// Connection style follows modules/wms/tests/integration/stock-ledger.test.ts (pg, PG* env, same
// defaults) and modules/wms/tests/integration/wh1-setup.test.ts (read-only fixture lookups). Per
// the GM directive, every scenario here runs inside ONE transaction on ONE client
// (BEGIN in beforeEach, ROLLBACK in afterEach's finally), with its own fixtures created inside
// that transaction: a sales.accounts row (code prefix `_h_fixture_`), a wms.skus row, one existing
// WH1 storage location (read-only, fetched once), entity = platform.entities code 'PST'
// (read-only, fetched once). Ledger and balance rows are inserted directly with SQL — this suite
// is about the guard function, not the posting mechanism (modules/wms/src/stock-ledger/* is not
// imported), so the audit trigger is not exercised and no audit rows are expected.
//
// pg-reviewer migration-gate finding (SCR-WMS-01, 2026-09-23): the OLD function's return row has
// no `batch_no` column at all, so a query that names `batch_no` (an `order by batch_no`, or a
// `select batch_no, ...`) fails on the OLD function with SQLSTATE 42703 — a schema error, not the
// behavioural deviation this suite exists to prove. Every RED-deciding assertion below therefore
// reads `count(*)` (and, where useful, `ledger_qty`/`balance_qty`/`diff`) keyed only by
// `client_id`, and never names `batch_no`. A second, detail-level query naming `batch_no` may
// follow in the SAME `it`, but only after the count assertion — `expect(...).toBe(...)` throws
// immediately on a mismatch, so on the OLD function (wrong count) that second query never runs;
// it is reached only once the count assertion already passes (i.e., only on the NEW function).
// `verifyBalanceIntegrityFor` below does not `order by batch_no` for exactly this reason.

// The exact expected counts on the OLD function, cited verbatim in each test's own `it` title, so
// a future reader can tell "wrong count" (behavioural deviation) from "column does not exist"
// (schema error) at a glance:
//   scenario 1 (two batches reconcile):        OLD reports 2 rows, want 0.
//   scenario 2 (one batch tampered):           OLD reports 2 rows, want 1.
//   scenario 4 (orphan balance row):           OLD reports 0 rows, want 1.
//   scenario (b) (batch mismatch, this file):  OLD reports 0 rows, want 2.

import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// --- literals, each cited to their source -------------------------------------------------------

// database/schema/01-Data-Model.sql:696: "performed_by uuid not null" with no FK on that column;
// fixed constant per the GM directive ("performed_by a fixed uuid constant"), distinct from the
// WBS 2.8 suite's own constant of the same name
// (modules/wms/tests/integration/stock-ledger.test.ts, PERFORMED_BY_FIXTURE_UUID) since this
// file never shares a transaction or fixture rows with that suite.
const PERFORMED_BY_FIXTURE_UUID = '00000000-0000-4000-8000-0000000005c1';

// GM directive scenario 1: "receipts batch 'H-A' qty 10.000 and batch 'H-B' qty 5.000 at L1".
const BATCH_H_A = 'H-A';
const BATCH_H_A_QTY = '10.000';
const BATCH_H_B = 'H-B';
const BATCH_H_B_QTY = '5.000';
// GM directive scenario 2: "update the 'H-B' balance to 6.000 ... diff -1.000".
const BATCH_H_B_TAMPERED_QTY = '6.000';
const EXPECTED_DIFF_SCENARIO_2 = '-1.000';
// GM directive scenario 3: "a null ledger batch_no ... qty 4.000".
const NULL_BATCH_QTY = '4.000';
// GM directive scenario 4: "balance row (…, 'H-ORPHAN', 3.000) with no movement".
const BATCH_H_ORPHAN = 'H-ORPHAN';
const BATCH_H_ORPHAN_QTY = '3.000';
const EXPECTED_DIFF_SCENARIO_4 = '-3.000';
const ZERO_QTY = '0.000';

// pg-reviewer finding 2(a): "a ledger key with NO balance row (receipt 7.000 batch 'H-NOBAL', no
// balance row) -> exactly 1 row, ledger_qty 7.000, balance_qty 0, diff 7.000 (old function also
// reports it — non-regression)". Only one batch exists for this client/sku/location, so the OLD
// function's location-only fold and the NEW function's (location, batch_no) fold compute the same
// number — this scenario must never name `batch_no` in its assertions, so it stays a true
// non-regression check runnable against either function.
const BATCH_H_NOBAL = 'H-NOBAL';
const BATCH_H_NOBAL_QTY = '7.000';

// pg-reviewer finding 2(b): "batch mismatch: ledger batch 'H-A' 10.000, balance only under 'H-X'
// 10.000 -> exactly 2 rows for the client (old: 0 rows -> RED)".
const BATCH_H_X = 'H-X';

// GM directive: "the column list is the documented one" — the fixed interface's field order.
const EXPECTED_COLUMN_NAMES = [
  'client_id',
  'sku_id',
  'location_id',
  'batch_no',
  'ledger_qty',
  'balance_qty',
  'diff',
];

// movement_type 'receipt' / uom 'EA' — same as modules/wms/tests/integration/stock-ledger.test.ts
// (WBS 2.8) single-sided receipt fixtures.
const MOVEMENT_TYPE_RECEIPT = 'receipt';
const UOM_EA = 'EA';

const client = new Client({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  password: process.env['PGPASSWORD'],
  database: process.env['PGDATABASE'] ?? 'pgeos',
});

let entityId: string;
let locationL1: string;

interface Fixture {
  readonly clientId: string;
  readonly skuId: string;
}

async function createFixture(): Promise<Fixture> {
  const code = `_h_fixture_${randomUUID()}`;
  const clientResult: QueryResult<{ id: string }> = await client.query(
    `insert into sales.accounts (code, name_ar, account_type, status)
     values ($1, $2, 'client', 'active') returning id`,
    [code, 'عميل اختبار سلامة الرصيد الدفعي — SCR-WMS-01'],
  );
  const clientRow = clientResult.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');

  const skuResult: QueryResult<{ id: string }> = await client.query(
    `insert into wms.skus (client_id, code, name_ar)
     values ($1, $2, $3) returning id`,
    [clientRow.id, `H-FIXTURE-SKU-${randomUUID()}`, 'صنف اختبار سلامة الرصيد الدفعي'],
  );
  const skuRow = skuResult.rows[0];
  if (!skuRow) throw new Error('fixture wms.skus insert returned no row');

  return { clientId: clientRow.id, skuId: skuRow.id };
}

async function insertMovement(
  fixture: Fixture,
  batchNo: string | null,
  qty: string,
): Promise<void> {
  await client.query(
    `insert into wms.stock_movements
       (entity_id, movement_type, client_id, sku_id, to_location_id, qty, uom, batch_no, performed_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
    [
      entityId,
      MOVEMENT_TYPE_RECEIPT,
      fixture.clientId,
      fixture.skuId,
      locationL1,
      qty,
      UOM_EA,
      batchNo,
      PERFORMED_BY_FIXTURE_UUID,
    ],
  );
}

async function insertBalance(fixture: Fixture, batchNo: string, qtyOnHand: string): Promise<void> {
  await client.query(
    `insert into wms.stock_balance (client_id, sku_id, location_id, batch_no, qty_on_hand)
     values ($1, $2, $3, $4, $5::numeric)`,
    [fixture.clientId, fixture.skuId, locationL1, batchNo, qtyOnHand],
  );
}

// No `order by batch_no` — the OLD function's row shape has no `batch_no` column, and naming it
// anywhere in the query (including an `order by`) fails with SQLSTATE 42703 on OLD regardless of
// row count. Callers that need a stable row order for a multi-row detail assertion add their own
// `order by` over columns present in BOTH shapes (e.g. `ledger_qty`), scoped to a query reached
// only after a count assertion already passed (see the header comment).
async function verifyBalanceIntegrityFor(clientId: string): Promise<QueryResult<Record<string, unknown>>> {
  return client.query(`select * from wms.verify_balance_integrity() where client_id = $1`, [clientId]);
}

// The RED-deciding shape for scenarios 1, 2, 4 and (b): `count(*)` keyed only by `client_id`,
// never naming `batch_no` — see the header comment.
async function countBalanceIntegrityRowsFor(clientId: string): Promise<number> {
  const result: QueryResult<{ n: number }> = await client.query(
    `select count(*)::int as n from wms.verify_balance_integrity() where client_id = $1`,
    [clientId],
  );
  return result.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  await client.connect();

  const entityResult: QueryResult<{ id: string }> = await client.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    throw new Error("fixture entity PST not found in platform.entities");
  }
  entityId = entityRow.id;

  // "one existing WH1 storage location (from 019, is_blocked = false)" — same lookup shape as
  // modules/wms/tests/integration/stock-ledger.test.ts's beforeAll, limited to one row.
  const locationResult: QueryResult<{ id: string }> = await client.query(
    `select l.id
       from wms.locations l
       join wms.zones z on z.id = l.zone_id
       join wms.warehouses w on w.id = l.warehouse_id
      where w.code = 'WH1' and z.zone_type = 'storage' and l.is_blocked = false
      order by l.code
      limit 1`,
  );
  const locationRow = locationResult.rows[0];
  if (!locationRow) {
    throw new Error('expected at least one unblocked WH1 storage location (doc 19 §4)');
  }
  locationL1 = locationRow.id;
});

afterAll(async () => {
  await client.end();

  // "Confirm nothing persists (fixture code prefix count = 0 after)" — every scenario below rolls
  // its own transaction back in afterEach; this is the independent, out-of-transaction proof.
  const verifyClient = new Client({
    host: process.env['PGHOST'] ?? 'localhost',
    port: Number(process.env['PGPORT'] ?? '5432'),
    user: process.env['PGUSER'] ?? 'postgres',
    password: process.env['PGPASSWORD'],
    database: process.env['PGDATABASE'] ?? 'pgeos',
  });
  await verifyClient.connect();
  try {
    const result: QueryResult<{ n: string }> = await verifyClient.query(
      `select count(*)::text as n from sales.accounts where code like '_h_fixture_%'`,
    );
    if (result.rows[0]?.n !== '0') {
      throw new Error(
        `fixture leakage: ${result.rows[0]?.n} sales.accounts rows with code prefix _h_fixture_ still present`,
      );
    }
  } finally {
    await verifyClient.end();
  }
});

beforeEach(async () => {
  await client.query('begin');
});

afterEach(async () => {
  try {
    // scenarios never commit; roll back so no fixture or ledger/balance row persists.
  } finally {
    await client.query('rollback');
  }
});

describe('Scenario: two batches of one SKU at one location reconcile', () => {
  it('wms.verify_balance_integrity() returns zero rows for that client, by count(*) (regression: SCR-WMS-01 — the old fold ignored batch_no and reported 2 rows here)', async () => {
    const fixture = await createFixture();
    await insertMovement(fixture, BATCH_H_A, BATCH_H_A_QTY);
    await insertBalance(fixture, BATCH_H_A, BATCH_H_A_QTY);
    await insertMovement(fixture, BATCH_H_B, BATCH_H_B_QTY);
    await insertBalance(fixture, BATCH_H_B, BATCH_H_B_QTY);

    const n = await countBalanceIntegrityRowsFor(fixture.clientId);

    expect(n, `expected 0 rows, got ${n} (client_id = ${fixture.clientId})`).toBe(0);
  });
});

describe('Scenario: a deviation in one batch is reported for that batch only', () => {
  it('reports exactly one row, by count(*) (regression: SCR-WMS-01 — the old un-keyed-by-batch join reported 2 rows here)', async () => {
    const fixture = await createFixture();
    await insertMovement(fixture, BATCH_H_A, BATCH_H_A_QTY);
    await insertBalance(fixture, BATCH_H_A, BATCH_H_A_QTY);
    await insertMovement(fixture, BATCH_H_B, BATCH_H_B_QTY);
    await insertBalance(fixture, BATCH_H_B, BATCH_H_B_QTY);

    await client.query(
      `update wms.stock_balance set qty_on_hand = $4::numeric
        where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = $5`,
      [fixture.clientId, fixture.skuId, locationL1, BATCH_H_B_TAMPERED_QTY, BATCH_H_B],
    );

    // RED-deciding assertion: count(*) only, no batch_no reference (header comment). This is the
    // assertion that must fail BY BEHAVIOUR (2 rows, not 1) on the OLD function.
    const n = await countBalanceIntegrityRowsFor(fixture.clientId);
    expect(n, `expected 1 row, got ${n} (client_id = ${fixture.clientId})`).toBe(1);

    // Reached only once the count assertion above already passed — i.e., only on the NEW
    // function. Detail check: the one row is batch_no H-B with ledger_qty 5.000, balance_qty
    // 6.000, diff -1.000.
    const result: QueryResult<{
      batch_no: string;
      ledger_qty_match: boolean;
      balance_qty_match: boolean;
      diff_match: boolean;
      ledger_qty_actual: string;
      balance_qty_actual: string;
      diff_actual: string;
    }> = await client.query(
      `select batch_no,
              (ledger_qty = $2::numeric) as ledger_qty_match, ledger_qty::text as ledger_qty_actual,
              (balance_qty = $3::numeric) as balance_qty_match, balance_qty::text as balance_qty_actual,
              (diff = $4::numeric) as diff_match, diff::text as diff_actual
         from wms.verify_balance_integrity()
        where client_id = $1
        order by batch_no`,
      [fixture.clientId, BATCH_H_B_QTY, BATCH_H_B_TAMPERED_QTY, EXPECTED_DIFF_SCENARIO_2],
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.batch_no).toBe(BATCH_H_B);
    expect(row?.ledger_qty_match, `ledger_qty: expected ${BATCH_H_B_QTY}, got ${row?.ledger_qty_actual}`).toBe(true);
    expect(row?.balance_qty_match, `balance_qty: expected ${BATCH_H_B_TAMPERED_QTY}, got ${row?.balance_qty_actual}`).toBe(true);
    expect(row?.diff_match, `diff: expected ${EXPECTED_DIFF_SCENARIO_2}, got ${row?.diff_actual}`).toBe(true);
  });
});

describe("Scenario: a null ledger batch_no matches the '' balance batch", () => {
  it("wms.verify_balance_integrity() returns zero rows (ledger batch key = coalesce(batch_no, '')) (non-regression — passes on the OLD function too, since the fold's numeric result is the same whether or not batch_no is part of the key here)", async () => {
    const fixture = await createFixture();
    await insertMovement(fixture, null, NULL_BATCH_QTY);
    await insertBalance(fixture, '', NULL_BATCH_QTY);

    const result = await verifyBalanceIntegrityFor(fixture.clientId);

    expect(result.rows).toEqual([]);
  });
});

describe('Scenario: a balance row with no ledger rows is reported', () => {
  it('reports exactly one row, by count(*) (regression: SCR-WMS-01 — the old function only walked ledger -> balance, so this orphan balance row was reported as 0 rows)', async () => {
    const fixture = await createFixture();
    await insertBalance(fixture, BATCH_H_ORPHAN, BATCH_H_ORPHAN_QTY);

    // RED-deciding assertion: count(*) only, no batch_no reference (header comment).
    const n = await countBalanceIntegrityRowsFor(fixture.clientId);
    expect(n, `expected 1 row, got ${n} (client_id = ${fixture.clientId})`).toBe(1);

    // Reached only once the count assertion above already passed — i.e., only on the NEW
    // function. Detail check: the one row is batch_no H-ORPHAN with ledger_qty 0, balance_qty
    // 3.000, diff -3.000.
    const result: QueryResult<{
      batch_no: string;
      ledger_qty_match: boolean;
      balance_qty_match: boolean;
      diff_match: boolean;
      ledger_qty_actual: string;
      balance_qty_actual: string;
      diff_actual: string;
    }> = await client.query(
      `select batch_no,
              (ledger_qty = 0::numeric) as ledger_qty_match, ledger_qty::text as ledger_qty_actual,
              (balance_qty = $2::numeric) as balance_qty_match, balance_qty::text as balance_qty_actual,
              (diff = $3::numeric) as diff_match, diff::text as diff_actual
         from wms.verify_balance_integrity()
        where client_id = $1
        order by batch_no`,
      [fixture.clientId, BATCH_H_ORPHAN_QTY, EXPECTED_DIFF_SCENARIO_4],
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.batch_no).toBe(BATCH_H_ORPHAN);
    expect(row?.ledger_qty_match, `ledger_qty: expected 0, got ${row?.ledger_qty_actual}`).toBe(true);
    expect(row?.balance_qty_match, `balance_qty: expected ${BATCH_H_ORPHAN_QTY}, got ${row?.balance_qty_actual}`).toBe(true);
    expect(row?.diff_match, `diff: expected ${EXPECTED_DIFF_SCENARIO_4}, got ${row?.diff_actual}`).toBe(true);
  });

  it('a balance row with qty_on_hand 0 and no ledger rows is NOT reported (non-regression — passes on the OLD function too)', async () => {
    const fixture = await createFixture();
    await insertBalance(fixture, 'H-ZERO', ZERO_QTY);

    const result = await verifyBalanceIntegrityFor(fixture.clientId);

    expect(result.rows).toEqual([]);
  });
});

describe('Scenario: a ledger key with no balance row is reported (non-regression)', () => {
  // pg-reviewer finding 2(a): only one batch exists for this client/sku/location, so the OLD
  // function (which folds by location only) and the NEW function (which folds by location +
  // batch_no) compute the identical single ledger row and the identical "no balance row" left/full
  // join outcome. This scenario must pass on BOTH functions — it never names `batch_no`.
  it('reports exactly one row with ledger_qty 7.000, balance_qty 0, diff 7.000 (old function also reports it — non-regression)', async () => {
    const fixture = await createFixture();
    await insertMovement(fixture, BATCH_H_NOBAL, BATCH_H_NOBAL_QTY);
    // deliberately no matching wms.stock_balance row.

    const result: QueryResult<{
      ledger_qty_match: boolean;
      balance_qty_match: boolean;
      diff_match: boolean;
      ledger_qty_actual: string;
      balance_qty_actual: string;
      diff_actual: string;
    }> = await client.query(
      `select (ledger_qty = $2::numeric) as ledger_qty_match, ledger_qty::text as ledger_qty_actual,
              (balance_qty = 0::numeric) as balance_qty_match, balance_qty::text as balance_qty_actual,
              (diff = $2::numeric) as diff_match, diff::text as diff_actual
         from wms.verify_balance_integrity()
        where client_id = $1`,
      [fixture.clientId, BATCH_H_NOBAL_QTY],
    );

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.ledger_qty_match, `ledger_qty: expected ${BATCH_H_NOBAL_QTY}, got ${row?.ledger_qty_actual}`).toBe(true);
    expect(row?.balance_qty_match, `balance_qty: expected 0, got ${row?.balance_qty_actual}`).toBe(true);
    expect(row?.diff_match, `diff: expected ${BATCH_H_NOBAL_QTY}, got ${row?.diff_actual}`).toBe(true);
  });
});

describe('Scenario: a batch_no mismatch between ledger and balance is reported as two rows', () => {
  // pg-reviewer finding 2(b): ledger batch 'H-A' 10.000, balance only under batch 'H-X' 10.000.
  // The OLD function's join ignores batch_no entirely, so its (client, sku, location) match makes
  // the two rows look reconciled (10.000 = 10.000, diff 0) -> 0 rows reported, hiding a real
  // batch-identity error. The NEW function's full join is keyed on batch_no too, so neither side
  // matches the other and BOTH are reported.
  it('reports exactly two rows, by count(*) (regression: SCR-WMS-01 — the old un-keyed-by-batch join hid this mismatch and reported 0 rows)', async () => {
    const fixture = await createFixture();
    await insertMovement(fixture, BATCH_H_A, BATCH_H_A_QTY);
    await insertBalance(fixture, BATCH_H_X, BATCH_H_A_QTY);

    // RED-deciding assertion: count(*) only, no batch_no reference (header comment).
    const n = await countBalanceIntegrityRowsFor(fixture.clientId);
    expect(n, `expected 2 rows, got ${n} (client_id = ${fixture.clientId})`).toBe(2);

    // Reached only once the count assertion above already passed — i.e., only on the NEW
    // function. Detail check: one row per batch, each carrying only its own side's quantity.
    // Numeric equality (`= $n::numeric`), not a text comparison — `coalesce(missing_side, 0)`
    // returns scale-0 "0", not "0.000", which is a display artefact of the fold, not a value
    // this suite asserts on (same convention as the H-B and H-ORPHAN scenarios above).
    const result: QueryResult<{
      batch_no: string;
      ledger_qty_match: boolean;
      balance_qty_match: boolean;
      diff_match: boolean;
      ledger_qty_actual: string;
      balance_qty_actual: string;
      diff_actual: string;
    }> = await client.query(
      `select batch_no,
              (ledger_qty = $2::numeric) as ledger_qty_match, ledger_qty::text as ledger_qty_actual,
              (balance_qty = $3::numeric) as balance_qty_match, balance_qty::text as balance_qty_actual,
              (diff = $4::numeric) as diff_match, diff::text as diff_actual
         from wms.verify_balance_integrity()
        where client_id = $1
        order by batch_no`,
      [fixture.clientId, BATCH_H_A_QTY, ZERO_QTY, BATCH_H_A_QTY],
    );

    expect(result.rows).toHaveLength(2);
    const [rowHA, rowHX] = result.rows;

    expect(rowHA?.batch_no).toBe(BATCH_H_A);
    expect(rowHA?.ledger_qty_match, `H-A ledger_qty: expected ${BATCH_H_A_QTY}, got ${rowHA?.ledger_qty_actual}`).toBe(true);
    expect(rowHA?.balance_qty_match, `H-A balance_qty: expected 0, got ${rowHA?.balance_qty_actual}`).toBe(true);
    expect(rowHA?.diff_match, `H-A diff: expected ${BATCH_H_A_QTY}, got ${rowHA?.diff_actual}`).toBe(true);

    expect(rowHX?.batch_no).toBe(BATCH_H_X);
    // H-X's side is swapped relative to H-A (ledger_qty 0, balance_qty BATCH_H_A_QTY, diff
    // -BATCH_H_A_QTY), so it needs its own params rather than reusing H-A's ($2/$3/$4 above).
    // Numeric equality in SQL, exactly like the H-A row above — not a text comparison.
    const resultHX: QueryResult<{
      ledger_qty_match: boolean;
      balance_qty_match: boolean;
      diff_match: boolean;
      ledger_qty_actual: string;
      balance_qty_actual: string;
      diff_actual: string;
    }> = await client.query(
      `select (ledger_qty = 0::numeric) as ledger_qty_match, ledger_qty::text as ledger_qty_actual,
              (balance_qty = $2::numeric) as balance_qty_match, balance_qty::text as balance_qty_actual,
              (diff = -$2::numeric) as diff_match, diff::text as diff_actual
         from wms.verify_balance_integrity()
        where client_id = $1 and batch_no = $3`,
      [fixture.clientId, BATCH_H_A_QTY, BATCH_H_X],
    );
    expect(resultHX.rows).toHaveLength(1);
    const rowHXDetail = resultHX.rows[0];
    expect(rowHXDetail?.ledger_qty_match, `H-X ledger_qty: expected 0, got ${rowHXDetail?.ledger_qty_actual}`).toBe(true);
    expect(rowHXDetail?.balance_qty_match, `H-X balance_qty: expected ${BATCH_H_A_QTY}, got ${rowHXDetail?.balance_qty_actual}`).toBe(true);
    expect(rowHXDetail?.diff_match, `H-X diff: expected -${BATCH_H_A_QTY}, got ${rowHXDetail?.diff_actual}`).toBe(true);
  });
});

describe('Scenario: the column list is the documented one', () => {
  it("select * from wms.verify_balance_integrity() limit 0 field names equal ['client_id','sku_id','location_id','batch_no','ledger_qty','balance_qty','diff'] (regression: SCR-WMS-01 — the old row shape had no batch_no field)", async () => {
    const result: QueryResult<Record<string, unknown>> = await client.query(
      `select * from wms.verify_balance_integrity() limit 0`,
    );

    expect(result.fields.map((f) => f.name)).toEqual(EXPECTED_COLUMN_NAMES);
  });
});
