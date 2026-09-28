// modules/wms/tests/receive-inbound/expiry-balance.test.ts — WBS 2.9 part 2 (fix), written
// RED-first by pg-tester (BOOTSTRAP-v5 §5) against
// docs/notes/slice-briefs/_slice-2.9-p2.brief.md, ahead of the fix to
// modules/wms/src/stock-ledger/post-movement.ts and rebuild-balance.ts. Follows
// ./expiry-balance.feature scenario-by-scenario.
//
// Facts (brief): wms.stock_movements and wms.stock_balance already carry an `expiry_date` column
// (01-Data-Model.sql:695-730) — no schema change. Decision 3: `PostMovementInput.expiryDate?:
// string | null` (modules/wms/src/stock-ledger/post-movement.ts) is an OPTIONAL top-level sibling of
// `entry`, so this suite calls `postMovementInTx` with a plain object literal carrying a top-level
// `expiryDate: string | null` alongside `entry`. `PostTransferInput` takes no `expiryDate` (decision
// 3): a transfer reads its expiry off the source balance row (decision 4). This suite was written
// RED-first; the field is implemented now and every scenario below runs green against it.
//
// Harness: same shape as modules/wms/tests/integration/stock-ledger.test.ts (superuser `pg` Pool,
// PG* env, fixture entity/client/SKU/location, `withContext`-backed `postMovementInTx` calls, a
// FixedClock + SequentialIdGenerator `LedgerDeps`). Each scenario uses its OWN batch_no so the
// seven `describe` blocks never share a wms.stock_balance row.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withContext } from '@pg-eos/db';
import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';

import {
  postMovementInTx,
  postTransfer,
  rebuildBalance,
  type LedgerDeps,
} from '../../index.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the scenario/decision it comes from -------------------------------

const FIXTURE_CODE_PREFIX = '_expiry_bal_fixture_';
const ENTITY_CODE = 'PST';
const MOVEMENT_TYPE_RECEIPT = 'receipt';
const UOM_EA = 'EA';

// WBS 2.4 D1/D3: every fixture SKU needs a location-limit-safe gross_weight_kg / volume_cbm, same
// values modules/wms/tests/integration/stock-ledger.test.ts's fixture SKUs use.
const FIXTURE_SKU_GROSS_WEIGHT_KG = '0.100';
const FIXTURE_SKU_VOLUME_CBM = '0.0001';

// decision 10-style fixed actor uuid (no FK on wms.stock_movements.performed_by), distinct from
// every other suite's constant (stock-ledger.test.ts uses ...208a1, rebuild-balance-scope.test.ts
// uses ...209c9).
const PERFORMED_BY_FIXTURE_UUID = '00000000-0000-4000-8000-0000000209ea';

const BATCH_NO_SCENARIO_1 = 'EXP-BAL-S1';
const BATCH_NO_SCENARIO_2 = 'EXP-BAL-S2';
const BATCH_NO_SCENARIO_3 = 'EXP-BAL-S3';
const BATCH_NO_SCENARIO_4 = 'EXP-BAL-S4';
const BATCH_NO_SCENARIO_5 = 'EXP-BAL-S5';
const BATCH_NO_SCENARIO_6 = 'EXP-BAL-S6';
const BATCH_NO_SCENARIO_7 = 'EXP-BAL-S7';

const RECEIPT_QTY_1 = '10.000';
const RECEIPT_QTY_2 = '5.000';
// Less than RECEIPT_QTY_1 so the transfer is never refused for insufficient stock instead of expiry.
const TRANSFER_QTY = '3.000';

const EXPIRY_DATE_A = '2027-03-15';
const EXPIRY_DATE_B = '2027-06-01';
const EXPIRY_DATE_CONFLICT = '2027-09-01';

const clock = new FixedClock(new Date('2026-09-28T00:00:00.000Z'));
const ids = new SequentialIdGenerator(20_092);
const deps: LedgerDeps = { clock, ids };

let entityId: string;
let fixtureClientId: string;
let fixtureSkuId: string;
let locationId: string;
let secondLocationId: string;
// SKUs created by scenarios 6 and 7 (each on its own SKU so its deliberately conflicting ledger
// never poisons the shared fixture SKU's rebuildBalance in scenario 5).
const extraSkuIds: string[] = [];
const fixtureClientCode = `${FIXTURE_CODE_PREFIX}${randomUUID()}`;

const ctx = { userId: PERFORMED_BY_FIXTURE_UUID, clientId: null, isInternal: true };

function nextCorrelationId(): string {
  return randomUUID();
}

interface BalanceRow {
  readonly qtyOnHand: string;
  readonly expiryDate: string | null;
}

async function balanceRow(batchNo: string): Promise<BalanceRow | undefined> {
  const result: QueryResult<{ qty_on_hand: string; expiry_date: string | null }> = await pool.query(
    `select qty_on_hand::text as qty_on_hand, expiry_date::text as expiry_date
       from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = $4`,
    [fixtureClientId, fixtureSkuId, locationId, batchNo],
  );
  const row = result.rows[0];
  return row ? { qtyOnHand: row.qty_on_hand, expiryDate: row.expiry_date } : undefined;
}

async function countMovements(batchNo: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.stock_movements
      where client_id = $1 and sku_id = $2 and batch_no = $3`,
    [fixtureClientId, fixtureSkuId, batchNo],
  );
  return Number(result.rows[0]?.n ?? '0');
}

// Posts one receipt through `postMovementInTx`, carrying `expiryDate` as the top-level optional
// field `PostMovementInput` accepts (decision 3, see header comment).
async function postReceipt(params: {
  readonly batchNo: string;
  readonly qty: string;
  readonly expiryDate: string | null;
}): Promise<void> {
  await withContext(ctx, (tx) =>
    postMovementInTx(
      tx,
      {
        entityId,
        entry: {
          clientId: fixtureClientId,
          skuId: fixtureSkuId,
          fromLocationId: null,
          toLocationId: locationId,
          qty: Quantity.of(params.qty),
          batchNo: params.batchNo,
          movementType: MOVEMENT_TYPE_RECEIPT,
          uom: UOM_EA,
        },
        correlationId: nextCorrelationId(),
        performedBy: PERFORMED_BY_FIXTURE_UUID,
        expiryDate: params.expiryDate,
      },
      ctx.userId,
      deps,
    ),
  );
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    [ENTITY_CODE],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`fixture entity ${ENTITY_CODE} not found in platform.entities`);
  entityId = entityRow.id;

  // WBS 0.6a part 2 (D-133): postMovementInTx/rebuildBalance run through withContext as the
  // non-superuser pgeos_app role — the fixture actor needs identity.user_entities for every
  // platform.entities row so rebuildBalance's own scope guard (assertSeesWholeLedger) and
  // wms.stock_movements' entity_scope RLS policy both allow this fixture through, same pattern as
  // modules/wms/tests/integration/stock-ledger.test.ts.
  // D-183: no DELETE on the shared identity.users/user_entities tables outside this suite's own
  // afterAll — idempotent insert instead. PERFORMED_BY_FIXTURE_UUID is this fixture's own fixed id;
  // a leftover row from a prior interrupted run is reused as-is (its email is never re-asserted).
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type)
     values ($1, $2, $3, 'internal')
     on conflict (id) do nothing`,
    [PERFORMED_BY_FIXTURE_UUID, `${FIXTURE_CODE_PREFIX}actor_${randomUUID()}@test.invalid`, 'ممثل اختبار رصيد انتهاء الصلاحية'],
  );
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  if (allEntitiesResult.rows.length === 0) throw new Error('expected at least one row in platform.entities');
  for (const row of allEntitiesResult.rows) {
    // identity.user_entities' primary key is (user_id, entity_id) (01-Data-Model.sql:274) — a real
    // unique key, so `on conflict` targets it directly.
    await pool.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
       on conflict (user_id, entity_id) do nothing`,
      [PERFORMED_BY_FIXTURE_UUID, row.id],
    );
  }

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [fixtureClientCode, 'عميل اختبار رصيد انتهاء الصلاحية'],
  );
  const clientRow = clientResult.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  fixtureClientId = clientRow.id;

  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [fixtureClientId, `EXP-BAL-SKU-${randomUUID()}`, 'صنف اختبار رصيد انتهاء الصلاحية', FIXTURE_SKU_GROSS_WEIGHT_KG, FIXTURE_SKU_VOLUME_CBM],
  );
  const skuRow = skuResult.rows[0];
  if (!skuRow) throw new Error('fixture wms.skus insert returned no row');
  fixtureSkuId = skuRow.id;

  const locationResult: QueryResult<{ id: string }> = await pool.query(
    `select l.id
       from wms.locations l
       join wms.zones z on z.id = l.zone_id
       join wms.warehouses w on w.id = l.warehouse_id
      where w.code = 'WH1' and z.zone_type = 'storage' and l.is_blocked = false
      order by l.code
      limit 1`,
  );
  const locationRow = locationResult.rows[0];
  if (!locationRow) throw new Error('expected at least one unblocked WH1 storage location (doc 19 §4)');
  locationId = locationRow.id;

  const secondLocationResult: QueryResult<{ id: string }> = await pool.query(
    `select l.id
       from wms.locations l
       join wms.zones z on z.id = l.zone_id
       join wms.warehouses w on w.id = l.warehouse_id
      where w.code = 'WH1' and z.zone_type = 'storage' and l.is_blocked = false and l.id <> $1
      order by l.code
      limit 1`,
    [locationId],
  );
  const secondLocationRow = secondLocationResult.rows[0];
  if (!secondLocationRow) throw new Error('expected a second unblocked WH1 storage location (doc 19 §4)');
  secondLocationId = secondLocationRow.id;
});

afterAll(async () => {
  if (fixtureClientId) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
  }
  for (const extraSkuId of extraSkuIds) {
    await pool.query(`delete from wms.skus where id = $1`, [extraSkuId]);
  }
  if (fixtureSkuId) {
    await pool.query(`delete from wms.skus where id = $1`, [fixtureSkuId]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  }
  await pool.query(`delete from identity.user_entities where user_id = $1`, [PERFORMED_BY_FIXTURE_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [PERFORMED_BY_FIXTURE_UUID]);
  await pool.end();
});

// --- Scenario 1 ----------------------------------------------------------------------------------

describe('Scenario: A received batch line with an expiry writes that expiry on its stock_balance row', () => {
  it('wms.stock_balance has expiry_date EXPIRY_DATE_A and qty_on_hand RECEIPT_QTY_1', async () => {
    await postReceipt({ batchNo: BATCH_NO_SCENARIO_1, qty: RECEIPT_QTY_1, expiryDate: EXPIRY_DATE_A });

    const balance = await balanceRow(BATCH_NO_SCENARIO_1);
    expect(balance, 'expected a wms.stock_balance row for the posted batch').toBeDefined();
    expect(balance?.expiryDate, `expected expiry_date ${EXPIRY_DATE_A}, got ${balance?.expiryDate}`).toBe(
      EXPIRY_DATE_A,
    );
    expect(Quantity.of(balance?.qtyOnHand as string).equals(Quantity.of(RECEIPT_QTY_1))).toBe(true);
  });
});

// --- Scenario 2 ----------------------------------------------------------------------------------

describe('Scenario: A second receipt of the same batch keeps the recorded expiry and adds quantity', () => {
  it('wms.stock_balance keeps expiry_date EXPIRY_DATE_A and sums qty_on_hand', async () => {
    await postReceipt({ batchNo: BATCH_NO_SCENARIO_2, qty: RECEIPT_QTY_1, expiryDate: EXPIRY_DATE_A });
    await postReceipt({ batchNo: BATCH_NO_SCENARIO_2, qty: RECEIPT_QTY_2, expiryDate: EXPIRY_DATE_A });

    const balance = await balanceRow(BATCH_NO_SCENARIO_2);
    expect(balance, 'expected a wms.stock_balance row for the posted batch').toBeDefined();
    expect(balance?.expiryDate).toBe(EXPIRY_DATE_A);
    const expectedQty = Quantity.of(RECEIPT_QTY_1).add(Quantity.of(RECEIPT_QTY_2));
    expect(Quantity.of(balance?.qtyOnHand as string).equals(expectedQty)).toBe(true);
  });
});

// --- Scenario 3 ----------------------------------------------------------------------------------

describe('Scenario: A receipt without expiry leaves expiry_date null; a later one with expiry fills it', () => {
  it('expiry_date is null after the first receipt, then EXPIRY_DATE_B after the second', async () => {
    await postReceipt({ batchNo: BATCH_NO_SCENARIO_3, qty: RECEIPT_QTY_1, expiryDate: null });

    const afterFirst = await balanceRow(BATCH_NO_SCENARIO_3);
    expect(afterFirst, 'expected a wms.stock_balance row for the posted batch').toBeDefined();
    expect(afterFirst?.expiryDate, 'expected expiry_date null after a receipt with no expiry').toBeNull();

    await postReceipt({ batchNo: BATCH_NO_SCENARIO_3, qty: RECEIPT_QTY_2, expiryDate: EXPIRY_DATE_B });

    const afterSecond = await balanceRow(BATCH_NO_SCENARIO_3);
    expect(afterSecond, 'expected a wms.stock_balance row for the posted batch').toBeDefined();
    expect(afterSecond?.expiryDate).toBe(EXPIRY_DATE_B);
    const expectedQty = Quantity.of(RECEIPT_QTY_1).add(Quantity.of(RECEIPT_QTY_2));
    expect(Quantity.of(afterSecond?.qtyOnHand as string).equals(expectedQty)).toBe(true);
  });
});

// --- Scenario 4 ----------------------------------------------------------------------------------

describe('Scenario: A conflicting expiry for the same batch is refused, never overwritten silently', () => {
  it('the second receipt (different non-null expiry) is refused; the stored expiry and qty are unchanged', async () => {
    await postReceipt({ batchNo: BATCH_NO_SCENARIO_4, qty: RECEIPT_QTY_1, expiryDate: EXPIRY_DATE_A });
    const beforeCount = await countMovements(BATCH_NO_SCENARIO_4);

    // Decision 8: `ConflictingExpiryError` (name = 'ConflictingExpiryError'), message names the
    // batch key, recorded and offered expiry, then "Allowed: the batch's recorded expiry <A>, or
    // no expiry."
    await expect(
      postReceipt({ batchNo: BATCH_NO_SCENARIO_4, qty: RECEIPT_QTY_2, expiryDate: EXPIRY_DATE_CONFLICT }),
    ).rejects.toMatchObject({ name: 'ConflictingExpiryError', message: expect.stringContaining('Allowed:') });

    const balance = await balanceRow(BATCH_NO_SCENARIO_4);
    expect(balance, 'expected a wms.stock_balance row for the posted batch').toBeDefined();
    expect(balance?.expiryDate, 'a conflicting expiry must never overwrite the stored one').toBe(EXPIRY_DATE_A);
    expect(
      Quantity.of(balance?.qtyOnHand as string).equals(Quantity.of(RECEIPT_QTY_1)),
      'the refused receipt must not have added its quantity',
    ).toBe(true);

    const afterCount = await countMovements(BATCH_NO_SCENARIO_4);
    expect(afterCount, 'the refused receipt must not have written a wms.stock_movements row either').toBe(
      beforeCount,
    );
  });
});

// --- Scenario 5 ----------------------------------------------------------------------------------

describe('Scenario: rebuild-balance reproduces the same expiry_date as the incremental path', () => {
  it("rebuildBalance's resulting expiry_date matches the incremental path's, restored from a nulled column", async () => {
    await postReceipt({ batchNo: BATCH_NO_SCENARIO_5, qty: RECEIPT_QTY_1, expiryDate: null });
    await postReceipt({ batchNo: BATCH_NO_SCENARIO_5, qty: RECEIPT_QTY_2, expiryDate: EXPIRY_DATE_A });

    const incremental = await balanceRow(BATCH_NO_SCENARIO_5);
    expect(incremental, 'expected a wms.stock_balance row for the posted batch').toBeDefined();
    expect(incremental?.expiryDate, 'unreachable unless scenario 3 also fails').toBe(EXPIRY_DATE_A);

    // F6: null this suite's own fixture rows first (UPDATE, not DELETE — D-183), so that a
    // rebuild-balance upsert that leaves expiry_date untouched (a plain `do update set` without an
    // `expiry_date` clause) cannot pass the assertion below by accident — only decision 6's
    // "upsert sets expiry_date = excluded.expiry_date" restores it.
    await pool.query(`update wms.stock_balance set expiry_date = null where client_id = $1 and sku_id = $2`, [
      fixtureClientId,
      fixtureSkuId,
    ]);
    const nulledBeforeRebuild = await balanceRow(BATCH_NO_SCENARIO_5);
    expect(nulledBeforeRebuild, 'expected the pre-rebuild UPDATE to leave the row in place').toBeDefined();
    expect(nulledBeforeRebuild?.expiryDate, 'expected the pre-rebuild UPDATE to null this row').toBeNull();

    const result = await rebuildBalance(ctx, { clientId: fixtureClientId, skuId: fixtureSkuId }, deps);
    expect(result.rowsWritten).toBeGreaterThan(0);

    const rebuilt = await balanceRow(BATCH_NO_SCENARIO_5);
    expect(rebuilt, 'expected rebuildBalance to reproduce the row').toBeDefined();
    expect(
      rebuilt?.expiryDate,
      `rebuildBalance must restore the incremental path's expiry_date ${incremental?.expiryDate}, got ${rebuilt?.expiryDate}`,
    ).toBe(incremental?.expiryDate);
  });
});

// --- Scenarios 6 and 7 helpers -------------------------------------------------------------------

async function insertExtraSku(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [fixtureClientId, `EXP-BAL-SKU-${randomUUID()}`, 'صنف اختبار رفض انتهاء الصلاحية', FIXTURE_SKU_GROSS_WEIGHT_KG, FIXTURE_SKU_VOLUME_CBM],
  );
  const row = result.rows[0];
  if (!row) throw new Error('extra wms.skus insert returned no row');
  extraSkuIds.push(row.id);
  return row.id;
}

async function postReceiptFor(params: {
  readonly skuId: string;
  readonly locationId: string;
  readonly batchNo: string;
  readonly qty: string;
  readonly expiryDate: string | null;
}): Promise<void> {
  await withContext(ctx, (tx) =>
    postMovementInTx(
      tx,
      {
        entityId,
        entry: {
          clientId: fixtureClientId,
          skuId: params.skuId,
          fromLocationId: null,
          toLocationId: params.locationId,
          qty: Quantity.of(params.qty),
          batchNo: params.batchNo,
          movementType: MOVEMENT_TYPE_RECEIPT,
          uom: UOM_EA,
        },
        correlationId: nextCorrelationId(),
        performedBy: PERFORMED_BY_FIXTURE_UUID,
        expiryDate: params.expiryDate,
      },
      ctx.userId,
      deps,
    ),
  );
}

async function balanceRowAt(skuId: string, atLocationId: string, batchNo: string): Promise<BalanceRow | undefined> {
  const result: QueryResult<{ qty_on_hand: string; expiry_date: string | null }> = await pool.query(
    `select qty_on_hand::text as qty_on_hand, expiry_date::text as expiry_date
       from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = $4`,
    [fixtureClientId, skuId, atLocationId, batchNo],
  );
  const row = result.rows[0];
  return row ? { qtyOnHand: row.qty_on_hand, expiryDate: row.expiry_date } : undefined;
}

async function countMovementsFor(skuId: string, batchNo: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.stock_movements
      where client_id = $1 and sku_id = $2 and batch_no = $3`,
    [fixtureClientId, skuId, batchNo],
  );
  return Number(result.rows[0]?.n ?? '0');
}

// --- Scenario 6 ----------------------------------------------------------------------------------

describe('Scenario: rebuild-balance refuses a key whose ledger holds two different expiries, before deleting anything', () => {
  it('rebuildBalance rejects with ConflictingExpiryError and the stock_balance row keeps its qty and expiry', async () => {
    const skuId = await insertExtraSku();
    // Both receipts are accepted by the incremental path (the second offers no expiry, so the
    // coalesce keeps A); the ledger is then made ambiguous by UPDATE-ing this suite's OWN second
    // movement row (identified by its distinct qty) to a different expiry — D-183: an UPDATE on the
    // suite's own fixture rows, never a DELETE.
    await postReceiptFor({ skuId, locationId, batchNo: BATCH_NO_SCENARIO_6, qty: RECEIPT_QTY_1, expiryDate: EXPIRY_DATE_A });
    await postReceiptFor({ skuId, locationId, batchNo: BATCH_NO_SCENARIO_6, qty: RECEIPT_QTY_2, expiryDate: null });
    const updated = await pool.query(
      `update wms.stock_movements set expiry_date = $1::date
        where client_id = $2 and sku_id = $3 and batch_no = $4 and qty = $5::numeric`,
      [EXPIRY_DATE_B, fixtureClientId, skuId, BATCH_NO_SCENARIO_6, RECEIPT_QTY_2],
    );
    expect(updated.rowCount, 'expected the UPDATE to hit exactly the second movement row').toBe(1);

    const before = await balanceRowAt(skuId, locationId, BATCH_NO_SCENARIO_6);
    expect(before, 'expected a wms.stock_balance row before the rebuild').toBeDefined();
    expect(before?.expiryDate).toBe(EXPIRY_DATE_A);
    const expectedQty = Quantity.of(RECEIPT_QTY_1).add(Quantity.of(RECEIPT_QTY_2));
    expect(Quantity.of(before?.qtyOnHand as string).equals(expectedQty)).toBe(true);

    await expect(rebuildBalance(ctx, { clientId: fixtureClientId, skuId }, deps)).rejects.toMatchObject({
      name: 'ConflictingExpiryError',
    });

    // The refusal happens before the delete/upsert: the row is still there, unchanged.
    const after = await balanceRowAt(skuId, locationId, BATCH_NO_SCENARIO_6);
    expect(after, 'the refused rebuild must not have deleted the stock_balance row').toBeDefined();
    expect(after?.expiryDate, 'the refused rebuild must not have changed expiry_date').toBe(EXPIRY_DATE_A);
    expect(
      Quantity.of(after?.qtyOnHand as string).equals(expectedQty),
      'the refused rebuild must not have changed qty_on_hand',
    ).toBe(true);
  });
});

// --- Scenario 7 ----------------------------------------------------------------------------------

describe('Scenario: A transfer onto a destination row holding a different expiry is refused', () => {
  it('postTransfer rejects with ConflictingExpiryError; both rows keep qty and expiry and no movement row is added', async () => {
    const skuId = await insertExtraSku();
    await postReceiptFor({ skuId, locationId, batchNo: BATCH_NO_SCENARIO_7, qty: RECEIPT_QTY_1, expiryDate: EXPIRY_DATE_A });
    await postReceiptFor({
      skuId,
      locationId: secondLocationId,
      batchNo: BATCH_NO_SCENARIO_7,
      qty: RECEIPT_QTY_2,
      expiryDate: EXPIRY_DATE_B,
    });

    const sourceBefore = await balanceRowAt(skuId, locationId, BATCH_NO_SCENARIO_7);
    const destinationBefore = await balanceRowAt(skuId, secondLocationId, BATCH_NO_SCENARIO_7);
    expect(sourceBefore?.expiryDate).toBe(EXPIRY_DATE_A);
    expect(destinationBefore?.expiryDate).toBe(EXPIRY_DATE_B);
    const movementsBefore = await countMovementsFor(skuId, BATCH_NO_SCENARIO_7);

    await expect(
      postTransfer(
        ctx,
        {
          entityId,
          base: {
            clientId: fixtureClientId,
            skuId,
            qty: Quantity.of(TRANSFER_QTY),
            batchNo: BATCH_NO_SCENARIO_7,
            uom: UOM_EA,
          },
          fromLocationId: locationId,
          toLocationId: secondLocationId,
          correlationId: nextCorrelationId(),
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toMatchObject({ name: 'ConflictingExpiryError' });

    const sourceAfter = await balanceRowAt(skuId, locationId, BATCH_NO_SCENARIO_7);
    const destinationAfter = await balanceRowAt(skuId, secondLocationId, BATCH_NO_SCENARIO_7);
    expect(sourceAfter, 'source row must survive the refused transfer').toBeDefined();
    expect(destinationAfter, 'destination row must survive the refused transfer').toBeDefined();
    expect(sourceAfter?.expiryDate).toBe(EXPIRY_DATE_A);
    expect(destinationAfter?.expiryDate).toBe(EXPIRY_DATE_B);
    expect(Quantity.of(sourceAfter?.qtyOnHand as string).equals(Quantity.of(RECEIPT_QTY_1))).toBe(true);
    expect(Quantity.of(destinationAfter?.qtyOnHand as string).equals(Quantity.of(RECEIPT_QTY_2))).toBe(true);
    expect(
      await countMovementsFor(skuId, BATCH_NO_SCENARIO_7),
      'the refused transfer must not have written any wms.stock_movements row (both legs roll back)',
    ).toBe(movementsBefore);
  });
});
