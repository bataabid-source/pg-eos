// modules/wms/tests/integration/rebuild-balance-lock.test.ts — pg-tester, written RED-first
// against pg-reviewer slice-close round 2 finding 1 (see ./rebuild-balance-lock.feature for the
// full defect writeup).
//
// Fixed behaviour pg-backend implemented (interface given verbatim in the close-out brief):
//   - a new export `balanceRebuildLockKey(clientId, skuId): string`, from modules/wms/index.ts,
//     returning exactly `'wms.stock_balance.rebuild|' + clientId + '|' + skuId`.
//   - every posting (postMovement, postTransfer, reverseMovement) takes
//     `pg_advisory_xact_lock_shared(hashtextextended(<that text>, 0))` for each (client, sku) it
//     touches BEFORE its existing per-balance-key locks.
//   - rebuildBalance takes `pg_advisory_xact_lock(hashtextextended(<that text>, 0))` (exclusive)
//     BEFORE folding the ledger.
//
// Written RED first on 2026-09-23: the import of `balanceRebuildLockKey` below failed outright (no
// such export existed yet) — every `it` in this file failed at collection/import time for that
// reason alone. Once the export existed, scenarios (a) and (b) below were independently RED for a
// second, distinct reason: postMovement/rebuildBalance took no lock keyed on
// balanceRebuildLockKey, so a separate session holding that key's lock did not block them at all —
// they settled immediately instead of waiting. Scenario (c) held trivially before the fix (no lock
// taken => nothing to block on) and continues to hold once the fix landed (shared locks never
// block other shared holders) — its only RED-before-the-fix reason was the same import failure as
// every other `it` here. Scenario (d) is a timing-dependent stress check; in one RED run before the
// fix it produced 1 non-zero verify_balance_integrity() row, but it can pass by chance either way —
// the deterministic regression guards are (a) and (b).
//
// Same connection/fixture conventions as modules/wms/tests/integration/stock-ledger.test.ts:
// `pool` (PG* env, superuser) for fixture setup/teardown and direct assertions; `ctx` exactly the
// brief's Public surface block: `{ userId: <fixture uuid>, clientId: null, isInternal: true }`.
// A separate, dedicated `pg` client (checked out of its own small pool) plays the "separate
// database session" the Gherkin describes — advisory locks are session/transaction scoped on the
// backend that took them, so a dedicated, un-shared connection is required to hold one across an
// intentional pause while the module-under-test's own (distinct) connection attempts to post/
// rebuild concurrently.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The module under test, per the brief's Public surface block plus the close-out brief's new
// export.
import {
  balanceRebuildLockKey,
  postMovement,
  rebuildBalance,
  type LedgerDeps,
  type LedgerEntry,
} from '../../index.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals, each cited to the scenario/reason they come from --------------------------------

// Gherkin "an initial receipt has already been posted, so a wms.stock_balance row exists at L1".
const INITIAL_RECEIPT_QTY = '10.000';
// Gherkin "postMovement posts a receipt of 1.000 at L1" (scenarios a, c).
const LOCK_TEST_RECEIPT_QTY = '1.000';
// pg-reviewer slice-close round 2 finding 1: 750ms is comfortably longer than a normal, unblocked
// postMovement/rebuildBalance round trip against a local database (single-digit milliseconds
// observed elsewhere in this suite) but short enough to keep this file fast — the "still blocked"
// sampling delay used by every lock-contention scenario below.
const WAIT_MS = 750;
// Gherkin "20 postMovement receipts and 3 rebuildBalance calls interleaved".
const STRESS_POST_COUNT = 20;
const STRESS_REBUILD_COUNT = 3;
const STRESS_RECEIPT_QTY = '1.000';

// WBS 2.4 fix round 1: every fixture SKU now needs a location-limit-safe gross_weight_kg /
// volume_cbm — WBS 2.4 D3 rejects a null-weight (or null-volume) SKU moving into ANY WH1 storage
// location, since 019-Warehouse-WH1-Setup.sql sets max_weight_kg/max_volume_cbm on all 3,153 of
// them (019:236-245). Worst-case load this file ever posts at locationL1: fixtureSkuId receives
// INITIAL_RECEIPT_QTY (10.000) plus two LOCK_TEST_RECEIPT_QTY (1.000 each, one per lock-contention
// scenario) = 12.000 units; fixtureSkuIdStress receives INITIAL_RECEIPT_QTY (10.000) plus
// STRESS_POST_COUNT (20) x STRESS_RECEIPT_QTY (1.000) = 30.000 units — 42.000 combined at
// locationL1 in the worst case. At FIXTURE_SKU_GROSS_WEIGHT_KG kg/unit that is 42 * 0.100 =
// 4.2 kg, and at FIXTURE_SKU_VOLUME_CBM cbm/unit (the smallest nonzero value
// wms.skus.volume_cbm's numeric(10,4) column can hold) 42 * 0.0001 = 0.0042 cbm — both trivially
// under the smaller of the two 019 hard barriers (750 kg / 0.97200 cbm on a shelf location,
// 019:239-245; 1,000 kg / 1.76175 cbm on a pallet location, 019:236-237).
const FIXTURE_SKU_GROSS_WEIGHT_KG = '0.100';
const FIXTURE_SKU_VOLUME_CBM = '0.0001';

// 01 wms.stock_movements.performed_by — "not null" with no FK on that column; a fixed constant
// named in the test (same convention as stock-ledger.test.ts's PERFORMED_BY_FIXTURE_UUID),
// distinct from every other suite's value since this file never shares fixtures with them.
const PERFORMED_BY_FIXTURE_UUID = '00000000-0000-4000-8000-000000020801';

// Test ctx — brief Public surface block, verbatim: "{ userId: <fixture uuid>, clientId: null,
// isInternal: true }".
const ctx = { userId: PERFORMED_BY_FIXTURE_UUID, clientId: null, isInternal: true };

const clock = new FixedClock(new Date('2026-09-23T00:00:00.000Z'));
const ids = new SequentialIdGenerator(2801);
const deps: LedgerDeps = { clock, ids };

let entityId: string;
let fixtureClientId: string;
let fixtureSkuId: string;
let fixtureSkuIdStress: string;
let locationL1: string;
const fixtureClientCode = `_lock_fixture_${randomUUID()}`;
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

async function stockBalanceQtyOnHand(skuId: string): Promise<string | undefined> {
  const result: QueryResult<{ qty_on_hand: string }> = await pool.query(
    `select qty_on_hand::text as qty_on_hand from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = ''`,
    [fixtureClientId, skuId, locationL1],
  );
  return result.rows[0]?.qty_on_hand;
}

async function guardRowCountFor(clientId: string): Promise<number> {
  const result: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n from wms.verify_balance_integrity() where client_id = $1`,
    [clientId],
  );
  return result.rows[0]?.n ?? 0;
}

function receiptEntry(skuId: string, qtyStr: string): LedgerEntry {
  return {
    clientId: fixtureClientId,
    skuId,
    fromLocationId: null,
    toLocationId: locationL1,
    qty: Quantity.of(qtyStr),
    batchNo: '',
    movementType: 'receipt',
    uom: 'EA',
  };
}

async function postReceipt(skuId: string, qtyStr: string): Promise<unknown> {
  return postMovement(
    ctx,
    {
      entityId,
      entry: receiptEntry(skuId, qtyStr),
      correlationId: nextCorrelationId(),
      performedBy: PERFORMED_BY_FIXTURE_UUID,
    },
    deps,
  );
}

/** Races `promise` against a WAIT_MS-ish timer; resolves 'settled' or 'pending' — never rejects
 *  (a rejection of `promise` counts as "settled", exactly like a resolution). */
const PENDING = Symbol('pending');
async function isSettledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const outcome = await Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<typeof PENDING>((resolve) => {
      setTimeout(() => resolve(PENDING), ms);
    }),
  ]);
  return outcome !== PENDING;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    throw new Error('fixture entity PST not found in platform.entities');
  }
  entityId = entityRow.id;

  // WBS 0.6a part 2 (D-133): postMovement/rebuildBalance now run through withContext as the
  // non-superuser pgeos_app role, so wms.stock_movements' entity_scope policy (13B RLS
  // auto-policy loop) and rebuildBalance's own "sees the whole ledger" scope guard
  // (src/stock-ledger/rebuild-balance.ts `assertSeesWholeLedger`, pg-reviewer gate finding 9)
  // actually apply — same fixture pattern as
  // modules/wms/tests/integration/stock-ledger.test.ts / rebuild-balance-scope-full.test.ts:
  // ctx.userId needs a real identity.users row with identity.user_entities covering EVERY
  // platform.entities row. Idempotent against a leftover row from a previously interrupted run
  // reusing this file's fixed PERFORMED_BY_FIXTURE_UUID.
  await pool.query(`delete from identity.user_entities where user_id = $1`, [
    PERFORMED_BY_FIXTURE_UUID,
  ]);
  await pool.query(`delete from identity.users where id = $1`, [PERFORMED_BY_FIXTURE_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type)
     values ($1, $2, $3, 'internal')`,
    [
      PERFORMED_BY_FIXTURE_UUID,
      `_lock_fixture_actor_${randomUUID()}@test.invalid`,
      'ممثل اختبار قفل إعادة بناء الرصيد — WBS 0.6a',
    ],
  );
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities`,
  );
  if (allEntitiesResult.rows.length === 0) {
    throw new Error('expected at least one row in platform.entities');
  }
  for (const row of allEntitiesResult.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
      PERFORMED_BY_FIXTURE_UUID,
      row.id,
    ]);
  }

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type)
     values ($1, $2, 'client') returning id`,
    [fixtureClientCode, 'عميل اختبار قفل إعادة بناء الرصيد — WBS 2.8'],
  );
  const clientRow = clientResult.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  fixtureClientId = clientRow.id;

  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [
      fixtureClientId,
      `LOCK-SKU-${randomUUID()}`,
      'صنف اختبار قفل إعادة بناء الرصيد',
      FIXTURE_SKU_GROSS_WEIGHT_KG,
      FIXTURE_SKU_VOLUME_CBM,
    ],
  );
  const skuRow = skuResult.rows[0];
  if (!skuRow) throw new Error('fixture wms.skus insert returned no row');
  fixtureSkuId = skuRow.id;

  const skuStressResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [
      fixtureClientId,
      `LOCK-SKU-STRESS-${randomUUID()}`,
      'صنف اختبار ضغط قفل إعادة بناء الرصيد',
      FIXTURE_SKU_GROSS_WEIGHT_KG,
      FIXTURE_SKU_VOLUME_CBM,
    ],
  );
  const skuStressRow = skuStressResult.rows[0];
  if (!skuStressRow) throw new Error('fixture wms.skus insert returned no row (stress sku)');
  fixtureSkuIdStress = skuStressRow.id;

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
  locationL1 = locationRow.id;

  // Gherkin: "an initial receipt has already been posted, so a wms.stock_balance row exists at
  // L1" — for BOTH skus (the lock-contention sku and the stress sku each need their own starting
  // balance).
  await postReceipt(fixtureSkuId, INITIAL_RECEIPT_QTY);
  await postReceipt(fixtureSkuIdStress, INITIAL_RECEIPT_QTY);
});

afterAll(async () => {
  if (fixtureClientId) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
  }
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [
      [...usedCorrelationIds],
    ]);
  }
  const skuIds = [fixtureSkuId, fixtureSkuIdStress].filter(Boolean);
  if (skuIds.length > 0) {
    await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [skuIds]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  }
  // WBS 0.6a part 2 (D-133) fixture teardown, FK order: user_entities before users.
  await pool.query(`delete from identity.user_entities where user_id = $1`, [
    PERFORMED_BY_FIXTURE_UUID,
  ]);
  await pool.query(`delete from identity.users where id = $1`, [PERFORMED_BY_FIXTURE_UUID]);
  await pool.end();
});

// --- balanceRebuildLockKey itself ---------------------------------------------------------------

describe('balanceRebuildLockKey', () => {
  it("returns 'wms.stock_balance.rebuild|<clientId>|<skuId>' verbatim", () => {
    const clientId = randomUUID();
    const skuId = randomUUID();
    expect(balanceRebuildLockKey(clientId, skuId)).toBe(
      `wms.stock_balance.rebuild|${clientId}|${skuId}`,
    );
  });
});

// --- Scenario: a posting waits while a rebuild holds the (client, sku) lock --------------------

describe('Scenario: a posting waits while a rebuild holds the (client, sku) lock', () => {
  it('postMovement does not settle until the exclusive rebuild-key holder commits, then the balance has increased by 1.000', async () => {
    const before = await stockBalanceQtyOnHand(fixtureSkuId);
    expect(before).toBeDefined();

    const holder = await pool.connect();
    // Tracks whether `holder`'s own transaction is still open — so the finally below can always
    // release the (client, sku) lock (rollback) even if something throws BEFORE this test's own
    // `commit` runs (e.g. balanceRebuildLockKey missing/throwing while still RED), instead of
    // leaking an "idle in transaction" connection back into the pool for the rest of the suite.
    let holderTxnOpen = false;
    try {
      await holder.query('begin');
      holderTxnOpen = true;
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        balanceRebuildLockKey(fixtureClientId, fixtureSkuId),
      ]);

      const postPromise = postReceipt(fixtureSkuId, LOCK_TEST_RECEIPT_QTY);

      const settledEarly = await isSettledWithin(postPromise, WAIT_MS);
      expect(
        settledEarly,
        'postMovement must still be blocked on the shared rebuild-key lock while the exclusive holder has not committed',
      ).toBe(false);

      await holder.query('commit');
      holderTxnOpen = false;

      await postPromise;

      const after = await stockBalanceQtyOnHand(fixtureSkuId);
      expect(after).toBeDefined();
      const delta = Quantity.of(after as string).add(Quantity.of(before as string).negate());
      expect(delta.equals(Quantity.of(LOCK_TEST_RECEIPT_QTY))).toBe(true);
    } finally {
      if (holderTxnOpen) {
        await holder.query('rollback').catch(() => {});
      }
      holder.release();
    }
  });
});

// --- Scenario: a rebuild waits while a posting holds the shared lock ---------------------------

describe('Scenario: a rebuild waits while a posting holds the shared lock', () => {
  it('rebuildBalance does not settle until the shared rebuild-key holder commits, then verify_balance_integrity() = 0', async () => {
    const holder = await pool.connect();
    let holderTxnOpen = false;
    try {
      await holder.query('begin');
      holderTxnOpen = true;
      await holder.query('select pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
        balanceRebuildLockKey(fixtureClientId, fixtureSkuId),
      ]);

      const rebuildPromise = rebuildBalance(
        ctx,
        { clientId: fixtureClientId, skuId: fixtureSkuId },
        deps,
      );

      const settledEarly = await isSettledWithin(rebuildPromise, WAIT_MS);
      expect(
        settledEarly,
        'rebuildBalance must still be blocked on the exclusive rebuild-key lock while the shared holder has not committed',
      ).toBe(false);

      await holder.query('commit');
      holderTxnOpen = false;

      const result = await rebuildPromise;
      expect(result.rowsWritten).toBeGreaterThan(0);

      const guardRows = await guardRowCountFor(fixtureClientId);
      expect(guardRows).toBe(0);
    } finally {
      if (holderTxnOpen) {
        await holder.query('rollback').catch(() => {});
      }
      holder.release();
    }
  });
});

// --- Scenario: postings on the same (client, sku) do not block each other on the shared lock ----

describe('Scenario: postings on the same (client, sku) do not block each other on the shared lock', () => {
  it('postMovement settles within the wait window while a separate session holds the shared rebuild-key lock', async () => {
    const holder = await pool.connect();
    let holderTxnOpen = false;
    try {
      await holder.query('begin');
      holderTxnOpen = true;
      await holder.query('select pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
        balanceRebuildLockKey(fixtureClientId, fixtureSkuId),
      ]);

      const postPromise = postReceipt(fixtureSkuId, LOCK_TEST_RECEIPT_QTY);

      const settled = await isSettledWithin(postPromise, WAIT_MS);
      expect(
        settled,
        'a shared rebuild-key holder must not block another shared-lock posting',
      ).toBe(true);

      await postPromise;
    } finally {
      if (holderTxnOpen) {
        await holder.query('commit').catch(() => {});
      }
      holder.release();
    }
  });
});

// --- Scenario: 20 postings and 3 rebuilds interleaved all settle with a clean guard -------------

describe('Scenario: 20 postings and 3 rebuilds interleaved all settle with a clean guard', () => {
  it(
    `${STRESS_POST_COUNT} postMovement receipts and ${STRESS_REBUILD_COUNT} rebuildBalance calls via Promise.all all settle, then verify_balance_integrity() = 0`,
    async () => {
      const postPromises = Array.from({ length: STRESS_POST_COUNT }, () =>
        postReceipt(fixtureSkuIdStress, STRESS_RECEIPT_QTY),
      );
      const rebuildPromises = Array.from({ length: STRESS_REBUILD_COUNT }, () =>
        rebuildBalance(ctx, { clientId: fixtureClientId, skuId: fixtureSkuIdStress }, deps),
      );

      await expect(Promise.all([...postPromises, ...rebuildPromises])).resolves.toBeDefined();

      const guardRows = await guardRowCountFor(fixtureClientId);
      expect(guardRows).toBe(0);
    },
  );
});
