// modules/wms/tests/integration/expiry-balance.property.test.ts — WBS 2.9 part 2 (fix), written
// RED-first by pg-tester against docs/notes/slice-briefs/_slice-2.9-p2.brief.md's property test:
// "for any generated sequence of receipts/transfers of ONE batch, stock_balance.expiry_date equals
// the batch's single expiry after incremental posting and after rebuild-balance."
//
// Same subject as ../receive-inbound/expiry-balance.test.ts: `PostMovementInput.expiryDate?: string
// | null` (decision 3) is the top-level optional field `postReceipt` below passes alongside `entry`.
//
// This property deliberately includes TRANSFERS, not just receipts: decision 4 requires
// `postTransferInTx`, after both balance locks, to read `expiry_date` off the SOURCE balance row
// and write it on both movement rows and both balance legs — so a transfer must also carry the
// batch's expiry to a brand-new destination balance row, not only a receipt.
//
// Harness: same shape as modules/wms/tests/integration/stock-ledger.test.ts (superuser `pg` Pool,
// fixture entity/client/locations, `withContext`-backed `postMovementInTx`/`postTransferInTx`
// calls, fixed Clock + SequentialIdGenerator). A fresh fixture SKU is created per fast-check run so
// runs never share a wms.stock_balance row; the balance/movement rows for the whole fixture client
// are deleted in `afterAll`.

import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withContext } from '@pg-eos/db';
import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';

import {
  postMovementInTx,
  postTransferInTx,
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

// --- literals ------------------------------------------------------------------------------------

const FIXTURE_CODE_PREFIX = '_expiry_bal_prop_fixture_';
const ENTITY_CODE = 'PST';
const MOVEMENT_TYPE_RECEIPT = 'receipt';
const UOM_EA = 'EA';
const BATCH_NO = 'EXP-BAL-PROP';
const FIXTURE_SKU_GROSS_WEIGHT_KG = '0.100';
const FIXTURE_SKU_VOLUME_CBM = '0.0001';
const PERFORMED_BY_FIXTURE_UUID = '00000000-0000-4000-8000-0000000209eb';

// decision 2 / the property's own wording: "a single expiry" — the ONE expiry every receipt in a
// generated sequence carries.
const THE_BATCH_EXPIRY = '2027-04-01';

// At least 2 locations so a transfer step is meaningful; 3 lets a run chain more than one hop.
const PROPERTY_LOCATION_COUNT = 3;
// Each run makes several real DB round trips (postReceipt/postTransfer/rebuildBalance) — kept low
// enough that the suite finishes inside PROPERTY_TEST_TIMEOUT_MS below.
const PROPERTY_NUM_RUNS = 8;
const PROPERTY_MAX_STEPS = 4;
const PROPERTY_SEED = 2_009_2002;
const PROPERTY_TEST_TIMEOUT_MS = 30_000;

// The very first step of every run: a guaranteed receipt at location 0, so every run's ledger for
// that batch is non-empty and every subsequent transfer step has a real balance to draw a fraction
// of.
const BASELINE_RECEIPT_QTY = '20.000';

// Bounds for arbitrary receipt quantities — test-data range, not a business number.
const RECEIPT_QTY_INTEGER_MAX = 15;
const RECEIPT_QTY_FRACTION_MIN = 1;
const RECEIPT_QTY_FRACTION_MAX = 999;
const RECEIPT_QTY_FRACTION_PAD_WIDTH = 3;
const QUANTITY_DECIMALS = 3;

// Bounds for the arbitrary transfer fraction (of the source location's current balance moved) —
// test-data range, not a business number.
const TRANSFER_FRACTION_MIN = 0.1;
const TRANSFER_FRACTION_MAX = 1;

const clock = new FixedClock(new Date('2026-09-28T00:00:00.000Z'));
const ids = new SequentialIdGenerator(20_093);
const deps: LedgerDeps = { clock, ids };

let entityId: string;
let fixtureClientId: string;
let locationIds: string[] = [];
const fixtureClientCode = `${FIXTURE_CODE_PREFIX}${randomUUID()}`;
const fixtureSkuIds: string[] = [];

const ctx = { userId: PERFORMED_BY_FIXTURE_UUID, clientId: null, isInternal: true };

function nextCorrelationId(): string {
  return randomUUID();
}

async function createFixtureSku(): Promise<string> {
  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [
      fixtureClientId,
      `EXP-BAL-PROP-SKU-${randomUUID()}`,
      'صنف اختبار خاصية رصيد انتهاء الصلاحية',
      FIXTURE_SKU_GROSS_WEIGHT_KG,
      FIXTURE_SKU_VOLUME_CBM,
    ],
  );
  const skuRow = skuResult.rows[0];
  if (!skuRow) throw new Error('fixture wms.skus insert returned no row');
  fixtureSkuIds.push(skuRow.id);
  return skuRow.id;
}

async function postReceipt(params: {
  readonly skuId: string;
  readonly locationId: string;
  readonly qty: string;
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
          batchNo: BATCH_NO,
          movementType: MOVEMENT_TYPE_RECEIPT,
          uom: UOM_EA,
        },
        correlationId: nextCorrelationId(),
        performedBy: PERFORMED_BY_FIXTURE_UUID,
        // decision 3: optional top-level sibling of `entry` on `PostMovementInput`.
        expiryDate: THE_BATCH_EXPIRY,
      },
      ctx.userId,
      deps,
    ),
  );
}

async function postTransfer(params: {
  readonly skuId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly qty: string;
}): Promise<void> {
  await withContext(ctx, (tx) =>
    postTransferInTx(
      tx,
      {
        entityId,
        base: {
          clientId: fixtureClientId,
          skuId: params.skuId,
          qty: Quantity.of(params.qty),
          batchNo: BATCH_NO,
          uom: UOM_EA,
        },
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        correlationId: nextCorrelationId(),
        performedBy: PERFORMED_BY_FIXTURE_UUID,
      },
      ctx.userId,
      deps,
    ),
  );
}

interface StoredBalanceRow {
  readonly locationId: string;
  readonly expiryDate: string | null;
}

async function balanceRowsFor(skuId: string): Promise<readonly StoredBalanceRow[]> {
  const result: QueryResult<{ location_id: string; expiry_date: string | null }> = await pool.query(
    `select location_id, expiry_date::text as expiry_date from wms.stock_balance
      where client_id = $1 and sku_id = $2 and batch_no = $3`,
    [fixtureClientId, skuId, BATCH_NO],
  );
  return result.rows.map((row) => ({ locationId: row.location_id, expiryDate: row.expiry_date }));
}

interface ReceiptStep {
  readonly kind: 'receipt';
  readonly locationIndex: number;
  readonly qty: string;
}
interface TransferStep {
  readonly kind: 'transfer';
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fraction: number;
}
type Step = ReceiptStep | TransferStep;

const qtyArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.nat({ max: RECEIPT_QTY_INTEGER_MAX }),
    fc.integer({ min: RECEIPT_QTY_FRACTION_MIN, max: RECEIPT_QTY_FRACTION_MAX }),
  )
  .map(([intPart, fracPart]) => `${intPart}.${String(fracPart).padStart(RECEIPT_QTY_FRACTION_PAD_WIDTH, '0')}`);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('receipt' as const),
    locationIndex: fc.nat({ max: PROPERTY_LOCATION_COUNT - 1 }),
    qty: qtyArb,
  }),
  fc.record({
    kind: fc.constant('transfer' as const),
    fromIndex: fc.nat({ max: PROPERTY_LOCATION_COUNT - 1 }),
    toIndex: fc.nat({ max: PROPERTY_LOCATION_COUNT - 1 }),
    fraction: fc.double({ min: TRANSFER_FRACTION_MIN, max: TRANSFER_FRACTION_MAX, noNaN: true }),
  }),
);

const sequenceArb: fc.Arbitrary<readonly Step[]> = fc.array(stepArb, {
  minLength: 1,
  maxLength: PROPERTY_MAX_STEPS,
});

function roundQty(value: number): number {
  const factor = 10 ** QUANTITY_DECIMALS;
  return Math.round(value * factor) / factor;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    [ENTITY_CODE],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`fixture entity ${ENTITY_CODE} not found in platform.entities`);
  entityId = entityRow.id;

  // D-183: no DELETE on the shared identity.users/user_entities tables outside this suite's own
  // afterAll — idempotent insert instead. PERFORMED_BY_FIXTURE_UUID is this fixture's own fixed id;
  // a leftover row from a prior interrupted run is reused as-is (its email is never re-asserted).
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type)
     values ($1, $2, $3, 'internal')
     on conflict (id) do nothing`,
    [PERFORMED_BY_FIXTURE_UUID, `${FIXTURE_CODE_PREFIX}actor_${randomUUID()}@test.invalid`, 'ممثل اختبار خاصية رصيد انتهاء الصلاحية'],
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
    [fixtureClientCode, 'عميل اختبار خاصية رصيد انتهاء الصلاحية'],
  );
  const clientRow = clientResult.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  fixtureClientId = clientRow.id;

  const locationsResult: QueryResult<{ id: string }> = await pool.query(
    `select l.id
       from wms.locations l
       join wms.zones z on z.id = l.zone_id
       join wms.warehouses w on w.id = l.warehouse_id
      where w.code = 'WH1' and z.zone_type = 'storage' and l.is_blocked = false
      order by l.code
      limit $1`,
    [PROPERTY_LOCATION_COUNT],
  );
  if (locationsResult.rows.length < PROPERTY_LOCATION_COUNT) {
    throw new Error(
      `expected at least ${PROPERTY_LOCATION_COUNT} unblocked WH1 storage locations (doc 19 §4), found ${locationsResult.rows.length}`,
    );
  }
  locationIds = locationsResult.rows.map((row) => row.id);
});

afterAll(async () => {
  if (fixtureClientId) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
  }
  if (fixtureSkuIds.length > 0) {
    await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  }
  await pool.query(`delete from identity.user_entities where user_id = $1`, [PERFORMED_BY_FIXTURE_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [PERFORMED_BY_FIXTURE_UUID]);
  await pool.end();
});

describe('Property: a batch posted/transferred any way ends with ONE expiry_date everywhere it landed', () => {
  it(
    `wms.stock_balance.expiry_date equals THE_BATCH_EXPIRY after incremental posting and after rebuildBalance (fast-check seed ${PROPERTY_SEED}, ${PROPERTY_NUM_RUNS} runs)`,
    async () => {
      await fc.assert(
        fc.asyncProperty(sequenceArb, async (steps) => {
          const skuId = await createFixtureSku();
          const runningBalances = new Array<number>(PROPERTY_LOCATION_COUNT).fill(0);
          // Every location index this run actually posted a receipt to or transferred INTO — the
          // set balance rows must equal (F13 row-count guard).
          const touchedLocationIndices = new Set<number>([0]);

          // Guaranteed baseline receipt (see BASELINE_RECEIPT_QTY's comment) — establishes the
          // batch's single expiry at location 0 before any arbitrary-drawn step runs.
          await postReceipt({ skuId, locationId: locationIds[0] as string, qty: BASELINE_RECEIPT_QTY });
          runningBalances[0] = Number(BASELINE_RECEIPT_QTY);

          for (const step of steps) {
            if (step.kind === 'receipt') {
              await postReceipt({
                skuId,
                locationId: locationIds[step.locationIndex] as string,
                qty: step.qty,
              });
              runningBalances[step.locationIndex] =
                (runningBalances[step.locationIndex] ?? 0) + Number(step.qty);
              touchedLocationIndices.add(step.locationIndex);
              continue;
            }

            if (step.fromIndex === step.toIndex) continue;
            const available = runningBalances[step.fromIndex] ?? 0;
            const qty = roundQty(available * step.fraction);
            if (qty <= 0) continue;

            await postTransfer({
              skuId,
              fromLocationId: locationIds[step.fromIndex] as string,
              toLocationId: locationIds[step.toIndex] as string,
              qty: qty.toFixed(QUANTITY_DECIMALS),
            });
            runningBalances[step.fromIndex] = available - qty;
            runningBalances[step.toIndex] = (runningBalances[step.toIndex] ?? 0) + qty;
            touchedLocationIndices.add(step.toIndex);
          }

          const expectedTouchedLocationIds = [...touchedLocationIndices]
            .map((index) => locationIds[index] as string)
            .sort();

          const incrementalRows = await balanceRowsFor(skuId);
          expect(incrementalRows.length, 'expected at least one wms.stock_balance row for this batch').toBeGreaterThan(0);
          expect(
            [...new Set(incrementalRows.map((row) => row.locationId))].sort(),
            'expected a wms.stock_balance row at exactly every location this run touched',
          ).toEqual(expectedTouchedLocationIds);
          for (const row of incrementalRows) {
            expect(
              row.expiryDate,
              `incremental path: expected every wms.stock_balance row of this batch to carry ${THE_BATCH_EXPIRY}, found ${JSON.stringify(incrementalRows)}`,
            ).toBe(THE_BATCH_EXPIRY);
          }

          // F6: null this suite's own fixture rows first (UPDATE, not DELETE — D-183), so that a
          // rebuild-balance upsert that leaves expiry_date untouched cannot pass the assertion
          // below by accident — only decision 6's "upsert sets expiry_date = excluded.expiry_date"
          // restores it.
          await pool.query(`update wms.stock_balance set expiry_date = null where client_id = $1 and sku_id = $2`, [
            fixtureClientId,
            skuId,
          ]);
          const nulledRows = await balanceRowsFor(skuId);
          expect(nulledRows.length, 'expected the pre-rebuild UPDATE to leave every row in place').toBeGreaterThan(0);
          for (const row of nulledRows) {
            expect(row.expiryDate, 'expected the pre-rebuild UPDATE to null every row of this batch').toBeNull();
          }

          await rebuildBalance(ctx, { clientId: fixtureClientId, skuId }, deps);

          const rebuiltRows = await balanceRowsFor(skuId);
          expect(
            rebuiltRows.length,
            'expected rebuildBalance to reproduce a row at every location this run touched',
          ).toBeGreaterThan(0);
          expect(
            [...new Set(rebuiltRows.map((row) => row.locationId))].sort(),
            'expected rebuildBalance to reproduce a wms.stock_balance row at exactly every location this run touched',
          ).toEqual(expectedTouchedLocationIds);
          for (const row of rebuiltRows) {
            expect(
              row.expiryDate,
              `rebuild-balance path: expected every wms.stock_balance row of this batch to carry ${THE_BATCH_EXPIRY}, found ${JSON.stringify(rebuiltRows)}`,
            ).toBe(THE_BATCH_EXPIRY);
          }
        }),
        { numRuns: PROPERTY_NUM_RUNS, seed: PROPERTY_SEED },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
