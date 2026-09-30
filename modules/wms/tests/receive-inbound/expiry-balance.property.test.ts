// modules/wms/tests/receive-inbound/expiry-balance.property.test.ts — WBS 2.9 part 3 (pg-tester).
//
// Property (brief "Property test", verbatim): for any generated sequence of receipts of one batch
// across locations, every wms.stock_balance row of that batch carries one expiry, and a receipt with
// a different non-null expiry is refused and changes no row. Model: the batch's recorded expiry is
// the first non-null expiry received; a later receipt is refused iff it carries a non-null expiry
// different from the recorded one (D-204, across ALL locations). Rows with a null expiry are legitimate
// under brief decision 2(a) (a receipt without expiry leaves it null), so the balance assertion is "at
// most one distinct NON-NULL expiry across the batch's rows, equal to the recorded one". Refusal = InvalidLedgerEntryError
// (existing class, see expiry-balance.test.ts header). Real DB, each run uses a fresh batch.

import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withContext } from '@pg-eos/db';
import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';

import { inboundLedgerPort } from '../../infrastructure/receive-inbound/ledger.js';
import { InvalidLedgerEntryError, postMovement, type LedgerDeps } from '../../index.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// Fresh actor per run (D-183: no pre-clean DELETE); deleted only in afterAll.
const ACTOR_UUID = randomUUID();
const ctx = { userId: ACTOR_UUID, clientId: null, isInternal: true };
const deps: LedgerDeps = {
  clock: new FixedClock(new Date('2026-09-29T00:00:00.000Z')),
  ids: new SequentialIdGenerator(2094),
};

const UOM_EA = 'EA';
const RECEIPT_QTY = '1.000';
const SKU_GROSS_WEIGHT_KG = '0.100';
const SKU_VOLUME_CBM = '0.001';
const FIXTURE_LOCATION_COUNT = 3;
// Test-budget bounds (DB round-trips per run), not business numbers.
const NUM_RUNS = 25;
const MAX_RECEIPTS_PER_RUN = 8;
const EXPIRY_POOL = ['2027-03-01', '2027-04-01', '2027-05-01'] as const;

let entityId: string;
let clientId: string;
let skuId: string;
const locationIds: string[] = [];
const correlationIds: string[] = [];

type Step =
  | { readonly kind: 'receipt'; readonly locationIndex: number; readonly expiry: string | null }
  | { readonly kind: 'transfer'; readonly fromIndex: number; readonly toIndex: number };

const locationIndexArb = fc.integer({ min: 0, max: FIXTURE_LOCATION_COUNT - 1 });
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('receipt' as const),
    locationIndex: locationIndexArb,
    expiry: fc.option(fc.constantFrom(...EXPIRY_POOL), { nil: null }),
  }),
  fc.record({ kind: fc.constant('transfer' as const), fromIndex: locationIndexArb, toIndex: locationIndexArb }),
);

/** Model of one balance row: units on hand (every receipt and transfer moves 1 unit) and its expiry. */
interface ModelRow {
  units: number;
  expiry: string | null;
}

interface Snapshot {
  readonly balances: readonly string[];
  readonly movements: number;
}

async function snapshot(batchNo: string): Promise<Snapshot> {
  const b: QueryResult<{ s: string }> = await pool.query(
    `select location_id || '|' || coalesce(to_char(expiry_date, 'YYYY-MM-DD'), 'null') || '|' || qty_on_hand::text as s
       from wms.stock_balance where client_id = $1 and sku_id = $2 and batch_no = $3 order by location_id`,
    [clientId, skuId, batchNo],
  );
  const m: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n from wms.stock_movements where client_id = $1 and sku_id = $2 and batch_no = $3`,
    [clientId, skuId, batchNo],
  );
  return { balances: b.rows.map((r) => r.s), movements: m.rows[0]?.n ?? 0 };
}

async function outboxCountFor(id: string): Promise<number> {
  const r: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n from platform.outbox where correlation_id = $1`,
    [id],
  );
  return r.rows[0]?.n ?? 0;
}

async function distinctBalanceExpiries(batchNo: string): Promise<readonly (string | null)[]> {
  const r: QueryResult<{ e: string | null }> = await pool.query(
    `select distinct to_char(expiry_date, 'YYYY-MM-DD') as e from wms.stock_balance
      where client_id = $1 and sku_id = $2 and batch_no = $3 and expiry_date is not null`,
    [clientId, skuId, batchNo],
  );
  return r.rows.map((row) => row.e);
}

beforeAll(async () => {
  const entity: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = 'PST'`,
  );
  const entityRow = entity.rows[0];
  if (!entityRow) throw new Error('fixture entity PST not found in platform.entities');
  entityId = entityRow.id;

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [ACTOR_UUID, `_expiry_prop_actor_${randomUUID()}@test.invalid`, 'ممثل خاصية انتهاء الصلاحية — WBS 2.9'],
  );
  const entities: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const row of entities.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [ACTOR_UUID, row.id]);
  }

  const client: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_expiry_prop_${randomUUID()}`, 'عميل خاصية انتهاء الدفعة — WBS 2.9'],
  );
  const clientRow = client.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  clientId = clientRow.id;

  const sku: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [clientId, `EXPIRY-PROP-SKU-${randomUUID()}`, 'صنف خاصية انتهاء الدفعة', SKU_GROSS_WEIGHT_KG, SKU_VOLUME_CBM],
  );
  const skuRow = sku.rows[0];
  if (!skuRow) throw new Error('fixture wms.skus insert returned no row');
  skuId = skuRow.id;

  const locations: QueryResult<{ id: string }> = await pool.query(
    `select l.id from wms.locations l
       join wms.zones z on z.id = l.zone_id
       join wms.warehouses w on w.id = l.warehouse_id
      where w.code = 'WH1' and z.zone_type = 'storage' and l.is_blocked = false
      order by l.code limit $1`,
    [FIXTURE_LOCATION_COUNT],
  );
  if (locations.rows.length < FIXTURE_LOCATION_COUNT) {
    throw new Error(`expected ${FIXTURE_LOCATION_COUNT} unblocked WH1 storage locations`);
  }
  for (const row of locations.rows) locationIds.push(row.id);
});

afterAll(async () => {
  if (clientId) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [clientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [clientId]);
  }
  if (correlationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationIds]);
  }
  if (skuId) await pool.query(`delete from wms.skus where id = $1`, [skuId]);
  if (clientId) await pool.query(`delete from sales.accounts where id = $1`, [clientId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ACTOR_UUID]);
  await pool.end();
});

describe('one expiry per (client, SKU, batch) across all locations — property', () => {
  it('every balance row of the batch carries one expiry; a different non-null expiry is refused and changes no row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: MAX_RECEIPTS_PER_RUN }),
        async (steps) => {
          const batchNo = `EXP-PROP-${randomUUID()}`;
          let recorded: string | null = null;
          const model = new Map<number, ModelRow>();

          for (const step of steps) {
            const correlationId = randomUUID();
            correlationIds.push(correlationId);

            if (step.kind === 'transfer') {
              // A put-away transfer needs stock at the source and a distinct destination; otherwise
              // the generated step is not applicable and is skipped.
              const source = model.get(step.fromIndex);
              if (step.fromIndex === step.toIndex || source === undefined || source.units < 1) continue;
              await withContext(ctx, (tx) =>
                inboundLedgerPort.postPutawayTransfer(
                  tx,
                  {
                    entityId,
                    clientId,
                    skuId,
                    qty: RECEIPT_QTY,
                    batchNo,
                    uom: UOM_EA,
                    fromLocationId: locationIds[step.fromIndex] as string,
                    toLocationId: locationIds[step.toIndex] as string,
                    correlationId,
                    refId: randomUUID(),
                  },
                  ACTOR_UUID,
                  deps,
                ),
              );
              // Decision 2(d): the destination takes the SOURCE row's expiry (possibly null); an
              // existing non-null destination expiry is kept (2(a)).
              source.units -= 1;
              const destination = model.get(step.toIndex) ?? { units: 0, expiry: null };
              destination.units += 1;
              destination.expiry = destination.expiry ?? source.expiry;
              model.set(step.toIndex, destination);
            } else {
              const location = locationIds[step.locationIndex] as string;
              const post = () =>
                postMovement(
                  ctx,
                  {
                    entityId,
                    entry: {
                      clientId,
                      skuId,
                      fromLocationId: null,
                      toLocationId: location,
                      qty: Quantity.of(RECEIPT_QTY),
                      batchNo,
                      movementType: 'receipt',
                      uom: UOM_EA,
                    },
                    correlationId,
                    performedBy: ACTOR_UUID,
                    expiryDate: step.expiry,
                  },
                  deps,
                );

              const conflicts = step.expiry !== null && recorded !== null && step.expiry !== recorded;
              if (conflicts) {
                const before = await snapshot(batchNo);
                await expect(post()).rejects.toBeInstanceOf(InvalidLedgerEntryError);
                expect(await snapshot(batchNo)).toEqual(before);
                expect(await outboxCountFor(correlationId)).toBe(0);
                continue;
              }
              await post();
              recorded = recorded ?? step.expiry;
              const row = model.get(step.locationIndex) ?? { units: 0, expiry: null };
              row.units += 1;
              row.expiry = row.expiry ?? step.expiry;
              model.set(step.locationIndex, row);
            }

            // Invariant: at most one distinct non-null expiry across the batch's rows, equal to the
            // recorded one; every row's expiry equals the model's.
            const expiries = await distinctBalanceExpiries(batchNo);
            expect(expiries).toEqual(recorded === null ? [] : [recorded]);
            const actual = await snapshot(batchNo);
            const expected = [...model.entries()]
              .map(([index, row]) => ({ id: locationIds[index] as string, row }))
              .sort((x, y) => (x.id < y.id ? -1 : 1))
              .map(({ id, row }) => `${id}|${row.expiry ?? 'null'}|${row.units}.000`);
            expect(actual.balances).toEqual(expected);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
