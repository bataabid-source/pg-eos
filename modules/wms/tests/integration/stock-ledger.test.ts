// modules/wms/tests/integration/stock-ledger.test.ts — WBS 2.8 (pg-tester), written RED-first on
// 2026-09-23 against .claude/briefs/_slice-2.8.brief.md's "Public surface" block, ahead of
// `modules/wms/src/stock-ledger/{domain,errors,post-movement,rebuild-balance,index}.ts` and the
// re-export from `modules/wms/index.ts` — same RED-first precedent as
// modules/wms/tests/integration/wh1-setup.test.ts (WBS 2.1) and
// packages/identity/tests/rbac-sod.test.ts (WBS 0.17). It is now the permanent DB-backed proof
// suite for that surface.
//
// This file is the permanent DB-backed proof suite for doc 38 row 2.8's acceptance ("Zero rows
// after 1,000 random movements; property test green") plus the GM directive 2026-09-23 phase C
// RED coverage: (a) append-only ledger, (b) derived balance = sum of movements, (c)
// verify_balance_integrity() detects deviation, (d) edge cases (zero quantity, reversal,
// concurrency). It follows the Gherkin in ./stock-ledger.feature scenario-by-scenario, in file
// order, because later scenarios build on the ledger state earlier scenarios leave behind (same
// "sequential fixture" style as this file's own precedent, modules/wms/tests/integration/
// wh1-setup.test.ts, and packages/identity/tests/rbac-sod.test.ts).
//
// Connects like wh1-setup.test.ts (pg Pool, PG* env, same defaults). Test ctx is exactly what the
// brief's Public surface block specifies: `{ userId: <fixture uuid>, clientId: null, isInternal:
// true }`.
//
// pg-reviewer migration-gate finding, SCR-WMS-01 (2026-09-23): `wms.verify_balance_integrity()`
// (01 §wms.verify_balance_integrity (v1.1)) is keyed on (client_id, sku_id, location_id,
// batch_no) — the SAME key `balanceKey`/`deriveBalances` (brief Public surface) use —
// `${clientId}|${skuId}|${locationId}|${batchNo}` — and folds ledger batch_no as
// `coalesce(stock_movements.batch_no, '')`, comparing in both directions (a stock_balance row with
// no ledger rows is reported too). Decision 11's 1,000-movement property test below therefore
// draws its batch_no from `LEDGER_BATCH_NOS` — '' plus two named batches — instead of only '', so
// it actually exercises the batch_no key: it was RED (false deviations) on the v1.0 function; it
// is GREEN on v1.1 (SCR-WMS-01, migration 0005). `LedgerEntry.batchNo` is a `string`, not
// `string | null` (domain.ts) — null is not reachable through `postMovement`/`postTransfer`, so no
// null-batch case is drawn here.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import fc from 'fast-check';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The module under test, per the brief's Public surface block.
import {
  InvalidQuantityError,
  MOVEMENT_TYPES,
  MovementNotFoundError,
  NegativeStockError,
  balanceKey,
  deriveBalances,
  postMovement,
  postTransfer,
  rebuildBalance,
  reverseMovement,
  type LedgerDeps,
  type LedgerEntry,
  type MovementType,
} from '../../index.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// --- literals, each cited to the decision/scenario they come from -----------------------------

// Gherkin scenario "a receipt is written to the ledger" (stock-ledger.feature).
const RECEIPT_QTY = '12.500';
// Gherkin scenario "a movement that would make stock negative is rejected atomically".
const OVER_PICK_QTY = '20.000';
// Gherkin scenario "a transfer moves stock between locations as two single-sided rows".
const TRANSFER_QTY = '5.000';
// Gherkin scenario "the guard detects any deviation": "tampered (+1.000)" / "diff -1.000".
const TAMPER_DELTA = '1.000';
const EXPECTED_DIFF_AFTER_TAMPER = '-1.000';
// doc 38 row 2.8 acceptance, verbatim: "Zero rows after 1,000 random movements".
const CONCURRENCY_MOVEMENT_COUNT = 1000;
// decision 11: "executed with real concurrency (>= 20 in flight via Promise.all batches)".
const CONCURRENCY_BATCH_SIZE = 25;
// decision 11: "against >= 3 SKUs x >= 5 locations".
const FIXTURE_SKU_COUNT = 3;
const FIXTURE_LOCATION_COUNT = 5;
// decision 11: "an explicit, printed seed ... so a failure is reproducible". Printed via the test
// name below (no console.log — CLAUDE.md · AGENT CONSTRAINTS).
const CONCURRENCY_SEED = 2_008_1000;
// pg-reviewer finding, SCR-WMS-01 (2026-09-23): 1,000 movements in batches of
// CONCURRENCY_BATCH_SIZE against a real database run ~10-12 s observed, well past vitest's 5 s
// default `testTimeout` — an unbounded run risks the test being cut off mid-`Promise.allSettled`,
// leaving in-flight inserts that race the suite's own `afterAll` cleanup. An explicit, generous
// per-test timeout removes that race without touching vitest.config.ts (out of pg-tester's write
// scope — CLAUDE.md WRITE SCOPE).
const CONCURRENCY_TEST_TIMEOUT_MS = 60_000;
// pg-reviewer finding, SCR-WMS-01 (2026-09-23): batch_no values the 1,000-movement property test
// draws from, so it exercises wms.verify_balance_integrity()'s (client_id, sku_id, location_id,
// batch_no) key instead of only the '' batch. See the header comment above.
const LEDGER_BATCH_NOS = ['', 'LEDGER-BATCH-A', 'LEDGER-BATCH-B'] as const;

// decision 10: "performed_by = a fixed uuid constant named in the test (no FK on that column,
// 01 wms.stock_movements.performed_by)". Also used as ctx.userId per the brief's Public surface
// block's test-ctx line.
const PERFORMED_BY_FIXTURE_UUID = '00000000-0000-4000-8000-0000000208a1';

// Test ctx — brief Public surface block, verbatim: "{ userId: <fixture uuid>, clientId: null,
// isInternal: true }".
const ctx = { userId: PERFORMED_BY_FIXTURE_UUID, clientId: null, isInternal: true };

// decision 2: "last_movement_at from the injected Clock" — deterministic, never new Date()
// (CLAUDE.md · AGENT CONSTRAINTS, mirrored onto this fixture harness for a checkable timestamp).
const clock = new FixedClock(new Date('2026-09-23T00:00:00.000Z'));
const ids = new SequentialIdGenerator(2008);
const deps: LedgerDeps = { clock, ids };

interface StockMovementRow {
  id: string;
  movement_type: string;
  client_id: string;
  sku_id: string;
  from_location_id: string | null;
  to_location_id: string | null;
  qty: string;
  uom: string;
  batch_no: string | null;
  ref_table: string | null;
  ref_id: string | null;
  reason_code: string | null;
}

// --- fixture state (decision 10) ---------------------------------------------------------------

let entityId: string;
let fixtureClientId: string;
const fixtureSkuIds: string[] = [];
const fixtureLocationIds: string[] = [];
let locationL1: string;
let locationL2: string;
const fixtureClientCode = `_ledger_fixture_${randomUUID()}`;
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

async function stockBalanceQtyOnHand(
  clientId: string,
  skuId: string,
  locationId: string,
): Promise<{ qty: string; lastMovementAt: Date | null } | undefined> {
  const result: QueryResult<{ qty_on_hand: string; last_movement_at: Date | null }> =
    await pool.query(
      `select qty_on_hand, last_movement_at from wms.stock_balance
        where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = ''`,
      [clientId, skuId, locationId],
    );
  const row = result.rows[0];
  return row ? { qty: row.qty_on_hand, lastMovementAt: row.last_movement_at } : undefined;
}

async function countStockMovements(clientId: string, skuId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.stock_movements where client_id = $1 and sku_id = $2`,
    [clientId, skuId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function ledgerRowsFor(clientId: string, skuIds: readonly string[]): Promise<LedgerEntry[]> {
  const result: QueryResult<StockMovementRow> = await pool.query(
    `select id, movement_type, client_id, sku_id, from_location_id, to_location_id,
            qty::text as qty, uom, batch_no, ref_table, ref_id, reason_code
       from wms.stock_movements
      where client_id = $1 and sku_id = any($2::uuid[])`,
    [clientId, skuIds],
  );
  return result.rows.map((row) => ({
    clientId: row.client_id,
    skuId: row.sku_id,
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    qty: Quantity.of(row.qty),
    batchNo: row.batch_no ?? '',
    movementType: row.movement_type as MovementType,
    uom: row.uom,
  }));
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    throw new Error("fixture entity PST not found in platform.entities (brief decision 10)");
  }
  entityId = entityRow.id;

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type)
     values ($1, $2, 'client') returning id`,
    [fixtureClientCode, 'عميل اختبار دفتر المخزون — WBS 2.8'],
  );
  const clientRow = clientResult.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  fixtureClientId = clientRow.id;

  for (let i = 0; i < FIXTURE_SKU_COUNT; i += 1) {
    const skuResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.skus (client_id, code, name_ar)
       values ($1, $2, $3) returning id`,
      [fixtureClientId, `LEDGER-SKU-${i}-${randomUUID()}`, `صنف اختبار دفتر المخزون ${i}`],
    );
    const skuRow = skuResult.rows[0];
    if (!skuRow) throw new Error('fixture wms.skus insert returned no row');
    fixtureSkuIds.push(skuRow.id);
  }

  const locationsResult: QueryResult<{ id: string }> = await pool.query(
    `select l.id
       from wms.locations l
       join wms.zones z on z.id = l.zone_id
       join wms.warehouses w on w.id = l.warehouse_id
      where w.code = 'WH1' and z.zone_type = 'storage' and l.is_blocked = false
      order by l.code
      limit $1`,
    [FIXTURE_LOCATION_COUNT],
  );
  if (locationsResult.rows.length < FIXTURE_LOCATION_COUNT) {
    throw new Error(
      `expected at least ${FIXTURE_LOCATION_COUNT} unblocked WH1 storage locations (doc 19 §4 / brief decision 10, decision 11), found ${locationsResult.rows.length}`,
    );
  }
  for (const row of locationsResult.rows) {
    fixtureLocationIds.push(row.id);
  }
  const [l1, l2] = fixtureLocationIds;
  if (!l1 || !l2) throw new Error('unreachable: length checked above');
  locationL1 = l1;
  locationL2 = l2;
});

afterAll(async () => {
  // decision 10: fixture stock_balance / stock_movements rows are deleted (the test pool is
  // superuser); fixture outbox rows are deleted by correlation_id; audit rows stay (hash chain,
  // the 0.18 tail-only rule) — they reference fixture ids only.
  if (fixtureClientId) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
  }
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [
      [...usedCorrelationIds],
    ]);
  }
  if (fixtureSkuIds.length > 0) {
    await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  }
  await pool.end();
});

// --- Scenario: a receipt is written to the ledger and raises the balance at its location -------

describe('Scenario: a receipt is written to the ledger and raises the balance at its location', () => {
  let receiptMovementId: string;
  let receiptCorrelationId: string;

  it('postMovement posts a receipt of 12.500 to location L1', async () => {
    receiptCorrelationId = nextCorrelationId();
    clock.advance(1);

    const entry: LedgerEntry = {
      clientId: fixtureClientId,
      skuId: fixtureSkuIds[0] as string,
      fromLocationId: null,
      toLocationId: locationL1,
      qty: Quantity.of(RECEIPT_QTY),
      batchNo: '',
      movementType: 'receipt',
      uom: 'EA',
    };

    const posted = await postMovement(
      ctx,
      { entityId, entry, correlationId: receiptCorrelationId, performedBy: PERFORMED_BY_FIXTURE_UUID },
      deps,
    );

    expect(posted.movementIds).toHaveLength(1);
    expect(posted.correlationId).toBe(receiptCorrelationId);
    receiptMovementId = posted.movementIds[0] as string;
  });

  it('wms.stock_movements has one new row with to_location_id L1, from_location_id null, qty 12.500', async () => {
    const result: QueryResult<StockMovementRow & { qty_match: boolean }> = await pool.query(
      `select *, (qty = $2::numeric) as qty_match from wms.stock_movements where id = $1`,
      [receiptMovementId, RECEIPT_QTY],
    );
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row?.to_location_id).toBe(locationL1);
    expect(row?.from_location_id).toBeNull();
    expect(row?.qty_match).toBe(true);
    expect(row?.movement_type).toBe('receipt');
  });

  it("wms.stock_balance (client, sku, L1, '') has qty_on_hand 12.500 and last_movement_at set", async () => {
    const balance = await stockBalanceQtyOnHand(fixtureClientId, fixtureSkuIds[0] as string, locationL1);
    expect(balance).toBeDefined();
    expect(Quantity.of(balance?.qty as string).equals(Quantity.of(RECEIPT_QTY))).toBe(true);
    expect(balance?.lastMovementAt).not.toBeNull();
    expect(balance?.lastMovementAt?.toISOString()).toBe(clock.now().toISOString());
  });

  it('platform.outbox has one row wms.stock.moved for that movement with the given correlation_id', async () => {
    const result: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox
        where correlation_id = $1 and event_type = 'wms.stock.moved' and aggregate_id = $2`,
      [receiptCorrelationId, receiptMovementId],
    );
    expect(result.rows[0]?.n).toBe('1');
  });

  it('platform.audit_log has one row (wms, stock_movements, that record_id, insert) with the same correlation_id', async () => {
    const result: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.audit_log
        where correlation_id = $1 and schema_name = 'wms' and table_name = 'stock_movements'
          and record_id = $2 and operation = 'insert'`,
      [receiptCorrelationId, receiptMovementId],
    );
    expect(result.rows[0]?.n).toBe('1');
  });

  it('wms.verify_balance_integrity() returns zero rows for (client, sku, L1)', async () => {
    const result: QueryResult<Record<string, unknown>> = await pool.query(
      `select * from wms.verify_balance_integrity()
        where client_id = $1 and sku_id = $2 and location_id = $3`,
      [fixtureClientId, fixtureSkuIds[0], locationL1],
    );
    expect(result.rows).toEqual([]);
  });
});

// --- Scenario: the ledger cannot be edited (append-only) — decision 6 --------------------------

describe('Scenario: the ledger cannot be edited (append-only) — decision 6', () => {
  // pg-reviewer finding, SCR-WMS-01 (2026-09-23): PostgreSQL reserves the `pg_` role-name prefix
  // ("role name ... is reserved"); `create role pg_eos_2_8_proof_...` fails outright. `pgeos_t_`
  // does not start with the literal `pg_` and is this suite's own test-fixture-role prefix.
  const roleName = `pgeos_t_2_8_proof_${randomUUID().replace(/-/g, '')}`;
  const rolePassword = randomUUID();
  let rolePool: Pool;
  let receiptMovementId: string;
  let originalQty: string;

  beforeAll(async () => {
    const result: QueryResult<{ id: string; qty: string }> = await pool.query(
      `select id, qty::text as qty from wms.stock_movements
        where client_id = $1 and sku_id = $2 and to_location_id = $3 and movement_type = 'receipt'
        order by occurred_at desc limit 1`,
      [fixtureClientId, fixtureSkuIds[0], locationL1],
    );
    const row = result.rows[0];
    if (!row) throw new Error('receipt row from the previous scenario is required for this proof');
    receiptMovementId = row.id;
    originalQty = row.qty;

    await pool.query(
      `create role ${roleName} login password '${rolePassword}' nosuperuser nobypassrls`,
    );
    await pool.query(`grant usage on schema wms to ${roleName}`);
    await pool.query(`grant select, insert on wms.stock_movements to ${roleName}`);

    rolePool = new Pool({
      host: process.env['PGHOST'] ?? 'localhost',
      port: Number(process.env['PGPORT'] ?? '5432'),
      user: roleName,
      password: rolePassword,
      database: process.env['PGDATABASE'] ?? 'pgeos',
      max: 2,
    });
  });

  afterAll(async () => {
    await rolePool.end();
    await pool.query(`revoke select, insert on wms.stock_movements from ${roleName}`);
    await pool.query(`revoke usage on schema wms from ${roleName}`);
    await pool.query(`drop role ${roleName}`);
  });

  it('a non-superuser, NOBYPASSRLS role updating the receipt row fails with SQLSTATE 42501', async () => {
    await expect(
      rolePool.query(`update wms.stock_movements set qty = qty + 1 where id = $1`, [
        receiptMovementId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a non-superuser, NOBYPASSRLS role deleting the receipt row fails with SQLSTATE 42501', async () => {
    await expect(
      rolePool.query(`delete from wms.stock_movements where id = $1`, [receiptMovementId]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the row is unchanged after both attempts', async () => {
    const result: QueryResult<{ qty: string }> = await pool.query(
      `select qty::text as qty from wms.stock_movements where id = $1`,
      [receiptMovementId],
    );
    expect(result.rows[0]?.qty).toBe(originalQty);
  });
});

// --- Scenario: a zero quantity is rejected before the database — decision 4 --------------------

describe('Scenario: a zero quantity is rejected before the database — decision 4', () => {
  it.each([
    ['zero', '0.000'],
    ['negative', '-5.000'],
  ])('postMovement rejects qty %s with InvalidQuantityError, no rows written', async (_label, qtyStr) => {
    const correlationId = nextCorrelationId();
    const beforeCount = await countStockMovements(fixtureClientId, fixtureSkuIds[1] as string);

    const entry: LedgerEntry = {
      clientId: fixtureClientId,
      skuId: fixtureSkuIds[1] as string,
      fromLocationId: null,
      toLocationId: locationL1,
      qty: Quantity.of(qtyStr),
      batchNo: '',
      movementType: 'receipt',
      uom: 'EA',
    };

    await expect(
      postMovement(
        ctx,
        { entityId, entry, correlationId, performedBy: PERFORMED_BY_FIXTURE_UUID },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidQuantityError);

    const afterCount = await countStockMovements(fixtureClientId, fixtureSkuIds[1] as string);
    expect(afterCount).toBe(beforeCount);

    const outboxCount: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox where correlation_id = $1`,
      [correlationId],
    );
    expect(outboxCount.rows[0]?.n).toBe('0');

    const auditCount: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
      [correlationId],
    );
    expect(auditCount.rows[0]?.n).toBe('0');
  });
});

// --- Scenario: a movement that would make stock negative is rejected atomically — decision 3 ----

describe('Scenario: a movement that would make stock negative is rejected atomically — decision 3', () => {
  it('postMovement posts a pick of 20.000 from L1 and it throws NegativeStockError, on-hand stays 12.500', async () => {
    const balanceBefore = await stockBalanceQtyOnHand(
      fixtureClientId,
      fixtureSkuIds[0] as string,
      locationL1,
    );
    expect(Quantity.of(balanceBefore?.qty as string).equals(Quantity.of(RECEIPT_QTY))).toBe(true);

    const correlationId = nextCorrelationId();
    const beforeCount = await countStockMovements(fixtureClientId, fixtureSkuIds[0] as string);

    const entry: LedgerEntry = {
      clientId: fixtureClientId,
      skuId: fixtureSkuIds[0] as string,
      fromLocationId: locationL1,
      toLocationId: null,
      qty: Quantity.of(OVER_PICK_QTY),
      batchNo: '',
      movementType: 'pick',
      uom: 'EA',
    };

    await expect(
      postMovement(
        ctx,
        { entityId, entry, correlationId, performedBy: PERFORMED_BY_FIXTURE_UUID },
        deps,
      ),
    ).rejects.toBeInstanceOf(NegativeStockError);

    const balanceAfter = await stockBalanceQtyOnHand(
      fixtureClientId,
      fixtureSkuIds[0] as string,
      locationL1,
    );
    expect(Quantity.of(balanceAfter?.qty as string).equals(Quantity.of(RECEIPT_QTY))).toBe(true);

    const afterCount = await countStockMovements(fixtureClientId, fixtureSkuIds[0] as string);
    expect(afterCount).toBe(beforeCount);

    const outboxCount: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.outbox where correlation_id = $1`,
      [correlationId],
    );
    expect(outboxCount.rows[0]?.n).toBe('0');

    const auditCount: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
      [correlationId],
    );
    expect(auditCount.rows[0]?.n).toBe('0');
  });
});

// --- Scenario: a transfer moves stock between locations as two single-sided rows — decision 1 ---

describe('Scenario: a transfer moves stock between locations as two single-sided rows — decision 1', () => {
  let transferCorrelationId: string;
  let outRowId: string;
  let inRowId: string;

  it('postTransfer moves 5.000 from L1 to L2', async () => {
    transferCorrelationId = nextCorrelationId();
    clock.advance(1);

    const posted = await postTransfer(
      ctx,
      {
        entityId,
        correlationId: transferCorrelationId,
        performedBy: PERFORMED_BY_FIXTURE_UUID,
        base: {
          clientId: fixtureClientId,
          skuId: fixtureSkuIds[0] as string,
          qty: Quantity.of(TRANSFER_QTY),
          batchNo: '',
          uom: 'EA',
        },
        fromLocationId: locationL1,
        toLocationId: locationL2,
      },
      deps,
    );

    expect(posted.movementIds).toHaveLength(2);
    expect(posted.correlationId).toBe(transferCorrelationId);
    // decision 1: "an out-row at from and an in-row at to" — that order.
    [outRowId, inRowId] = posted.movementIds as [string, string];
  });

  it('two ledger rows exist, one out at L1 and one in at L2, both transfer, same correlation_id', async () => {
    const outRow: QueryResult<StockMovementRow> = await pool.query(
      `select * from wms.stock_movements where id = $1`,
      [outRowId],
    );
    const inRow: QueryResult<StockMovementRow> = await pool.query(
      `select * from wms.stock_movements where id = $1`,
      [inRowId],
    );

    expect(outRow.rows[0]?.from_location_id).toBe(locationL1);
    expect(outRow.rows[0]?.to_location_id).toBeNull();
    expect(outRow.rows[0]?.movement_type).toBe('transfer');
    expect(outRow.rows[0]?.ref_table).toBe(inRow.rows[0]?.ref_table);
    expect(outRow.rows[0]?.ref_id).toBe(inRow.rows[0]?.ref_id);

    expect(inRow.rows[0]?.to_location_id).toBe(locationL2);
    expect(inRow.rows[0]?.from_location_id).toBeNull();
    expect(inRow.rows[0]?.movement_type).toBe('transfer');
  });

  it('on-hand is 7.500 at L1 and 5.000 at L2, and verify_balance_integrity() returns zero rows', async () => {
    const balanceL1 = await stockBalanceQtyOnHand(fixtureClientId, fixtureSkuIds[0] as string, locationL1);
    const balanceL2 = await stockBalanceQtyOnHand(fixtureClientId, fixtureSkuIds[0] as string, locationL2);

    expect(Quantity.of(balanceL1?.qty as string).equals(Quantity.of('7.500'))).toBe(true);
    expect(Quantity.of(balanceL2?.qty as string).equals(Quantity.of('5.000'))).toBe(true);

    const guardResult: QueryResult<Record<string, unknown>> = await pool.query(
      `select * from wms.verify_balance_integrity()
        where client_id = $1 and sku_id = $2 and location_id = any($3::uuid[])`,
      [fixtureClientId, fixtureSkuIds[0], [locationL1, locationL2]],
    );
    expect(guardResult.rows).toEqual([]);
  });
});

// --- Scenario: a reversal is a counter-entry, never an edit — decision 5 -----------------------

describe('Scenario: a reversal is a counter-entry, never an edit — decision 5', () => {
  let inRowId: string;
  let reversalCorrelationId: string;
  let reversalRowId: string;
  let originalRowSnapshotBefore: StockMovementRow;

  beforeAll(async () => {
    const result: QueryResult<StockMovementRow> = await pool.query(
      `select * from wms.stock_movements
        where client_id = $1 and sku_id = $2 and to_location_id = $3 and movement_type = 'transfer'
        order by occurred_at desc limit 1`,
      [fixtureClientId, fixtureSkuIds[0], locationL2],
    );
    const row = result.rows[0];
    if (!row) throw new Error("transfer in-row at L2 from the previous scenario is required");
    inRowId = row.id;
    originalRowSnapshotBefore = row;
  });

  it("reverseMovement is called for the transfer's in-row at L2", async () => {
    reversalCorrelationId = nextCorrelationId();
    clock.advance(1);

    const posted = await reverseMovement(
      ctx,
      { movementId: inRowId, correlationId: reversalCorrelationId, performedBy: PERFORMED_BY_FIXTURE_UUID },
      deps,
    );

    expect(posted.movementIds).toHaveLength(1);
    reversalRowId = posted.movementIds[0] as string;
  });

  it('one adjust row exists with from_location_id L2, qty 5.000, ref_table/ref_id to the original, reason_code reversal', async () => {
    const result: QueryResult<StockMovementRow & { qty_match: boolean }> = await pool.query(
      `select *, (qty = $2::numeric) as qty_match from wms.stock_movements where id = $1`,
      [reversalRowId, TRANSFER_QTY],
    );
    const row = result.rows[0];
    expect(row?.movement_type).toBe('adjust');
    expect(row?.from_location_id).toBe(locationL2);
    expect(row?.to_location_id).toBeNull();
    expect(row?.qty_match).toBe(true);
    expect(row?.ref_table).toBe('wms.stock_movements');
    expect(row?.ref_id).toBe(inRowId);
    expect(row?.reason_code).toBe('reversal');
  });

  it('the original row is unchanged', async () => {
    const result: QueryResult<StockMovementRow> = await pool.query(
      `select * from wms.stock_movements where id = $1`,
      [inRowId],
    );
    expect(result.rows[0]).toEqual(originalRowSnapshotBefore);
  });

  it('on-hand at L2 is 0.000', async () => {
    const balanceL2 = await stockBalanceQtyOnHand(fixtureClientId, fixtureSkuIds[0] as string, locationL2);
    expect(Quantity.of(balanceL2?.qty as string).equals(Quantity.of('0.000'))).toBe(true);
  });

  it('reverseMovement for a random unknown id throws MovementNotFoundError', async () => {
    await expect(
      reverseMovement(
        ctx,
        { movementId: randomUUID(), correlationId: nextCorrelationId(), performedBy: PERFORMED_BY_FIXTURE_UUID },
        deps,
      ),
    ).rejects.toBeInstanceOf(MovementNotFoundError);
  });
});

// --- Scenario: the guard detects any deviation and the balance is rebuildable — decision 8 ------

describe('Scenario: the guard detects any deviation and the balance is rebuildable — decision 8', () => {
  it('the balance row at L1 is tampered by +1.000 directly, then verify_balance_integrity() flags it', async () => {
    await pool.query(
      `update wms.stock_balance set qty_on_hand = qty_on_hand + $4::numeric
        where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = ''`,
      [fixtureClientId, fixtureSkuIds[0], locationL1, TAMPER_DELTA],
    );

    const result: QueryResult<{ diff_match: boolean; diff_actual: string }> = await pool.query(
      `select (diff = $4::numeric) as diff_match, diff::text as diff_actual
         from wms.verify_balance_integrity()
        where client_id = $1 and sku_id = $2 and location_id = $3`,
      [fixtureClientId, fixtureSkuIds[0], locationL1, EXPECTED_DIFF_AFTER_TAMPER],
    );

    expect(result.rows).toHaveLength(1);
    expect(
      result.rows[0]?.diff_match,
      `expected diff ${EXPECTED_DIFF_AFTER_TAMPER}, got ${result.rows[0]?.diff_actual}`,
    ).toBe(true);
  });

  it('rebuildBalance runs for (client, sku) and verify_balance_integrity() returns zero rows again', async () => {
    const result = await rebuildBalance(
      ctx,
      { clientId: fixtureClientId, skuId: fixtureSkuIds[0] as string },
      deps,
    );
    expect(result.rowsWritten).toBeGreaterThan(0);

    const guardResult: QueryResult<Record<string, unknown>> = await pool.query(
      `select * from wms.verify_balance_integrity() where client_id = $1 and sku_id = $2`,
      [fixtureClientId, fixtureSkuIds[0]],
    );
    expect(guardResult.rows).toEqual([]);

    const ledgerEntries = await ledgerRowsFor(fixtureClientId, [fixtureSkuIds[0] as string]);
    const expectedBalances = deriveBalances(ledgerEntries);
    const expectedL1 = expectedBalances.get(
      balanceKey(fixtureClientId, fixtureSkuIds[0] as string, locationL1, ''),
    );
    const balanceL1 = await stockBalanceQtyOnHand(fixtureClientId, fixtureSkuIds[0] as string, locationL1);

    expect(expectedL1).toBeDefined();
    expect(Quantity.of(balanceL1?.qty as string).equals(expectedL1 as Quantity)).toBe(true);
  });
});

// --- Scenario: 1,000 random movements under concurrency leave zero rows — decision 11 -----------

describe('Scenario: 1,000 random movements under concurrency leave zero rows — decision 11', () => {
  interface MovementDescriptor {
    readonly skuIndex: number;
    readonly locationIndexA: number;
    readonly locationIndexB: number;
    readonly movementType: MovementType;
    readonly qtyStr: string;
    readonly batchNo: (typeof LEDGER_BATCH_NOS)[number];
    readonly isTransfer: boolean;
    readonly isInbound: boolean;
  }

  const movementDescriptorArb = (): fc.Arbitrary<MovementDescriptor> =>
    fc.record({
      skuIndex: fc.nat({ max: FIXTURE_SKU_COUNT - 1 }),
      locationIndexA: fc.nat({ max: FIXTURE_LOCATION_COUNT - 1 }),
      locationIndexB: fc.nat({ max: FIXTURE_LOCATION_COUNT - 1 }),
      movementType: fc.constantFrom(...MOVEMENT_TYPES),
      qtyStr: fc
        .tuple(fc.nat({ max: 50 }), fc.integer({ min: 1, max: 999 }))
        .map(([intPart, fracPart]) => `${intPart}.${String(fracPart).padStart(3, '0')}`),
      // pg-reviewer finding, SCR-WMS-01: several batches per location, including '' — see
      // LEDGER_BATCH_NOS above and the header comment.
      batchNo: fc.constantFrom(...LEDGER_BATCH_NOS),
      isTransfer: fc.boolean(),
      isInbound: fc.boolean(),
    });

  async function postOneDescriptor(descriptor: MovementDescriptor): Promise<unknown> {
    const skuId = fixtureSkuIds[descriptor.skuIndex] as string;
    const locA = fixtureLocationIds[descriptor.locationIndexA] as string;
    const locB = fixtureLocationIds[descriptor.locationIndexB] as string;
    const correlationId = nextCorrelationId();
    const qty = Quantity.of(descriptor.qtyStr);

    if (descriptor.isTransfer && locA !== locB) {
      return postTransfer(
        ctx,
        {
          entityId,
          correlationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
          base: { clientId: fixtureClientId, skuId, qty, batchNo: descriptor.batchNo, uom: 'EA' },
          fromLocationId: locA,
          toLocationId: locB,
        },
        deps,
      );
    }

    const entry: LedgerEntry = {
      clientId: fixtureClientId,
      skuId,
      fromLocationId: descriptor.isInbound ? null : locA,
      toLocationId: descriptor.isInbound ? locA : null,
      qty,
      batchNo: descriptor.batchNo,
      movementType: descriptor.movementType,
      uom: 'EA',
    };
    return postMovement(
      ctx,
      { entityId, entry, correlationId, performedBy: PERFORMED_BY_FIXTURE_UUID },
      deps,
    );
  }

  it(
    `1,000 random movements (fast-check seed ${CONCURRENCY_SEED}) with >= 20 in flight leave zero guard rows`,
    async () => {
      const descriptors = fc.sample(movementDescriptorArb(), {
        numRuns: CONCURRENCY_MOVEMENT_COUNT,
        seed: CONCURRENCY_SEED,
      });
      expect(descriptors).toHaveLength(CONCURRENCY_MOVEMENT_COUNT);

      let rejectedAsNegativeStock = 0;
      const unexpectedErrors: unknown[] = [];

      for (let start = 0; start < descriptors.length; start += CONCURRENCY_BATCH_SIZE) {
        const batch = descriptors.slice(start, start + CONCURRENCY_BATCH_SIZE);
        expect(batch.length).toBeGreaterThanOrEqual(1);

        const results = await Promise.allSettled(batch.map((d) => postOneDescriptor(d)));
        for (const result of results) {
          if (result.status === 'rejected') {
            if (result.reason instanceof NegativeStockError) {
              rejectedAsNegativeStock += 1;
            } else {
              unexpectedErrors.push(result.reason);
            }
          }
        }
      }

      expect(unexpectedErrors).toEqual([]);
      expect(rejectedAsNegativeStock).toBeGreaterThanOrEqual(0);

      const guardResult: QueryResult<Record<string, unknown>> = await pool.query(
        `select * from wms.verify_balance_integrity() where client_id = $1 and sku_id = any($2::uuid[])`,
        [fixtureClientId, fixtureSkuIds],
      );
      expect(guardResult.rows).toEqual([]);

      const ledgerEntries = await ledgerRowsFor(fixtureClientId, fixtureSkuIds);
      const expectedBalances = deriveBalances(ledgerEntries);

      const actualBalances: QueryResult<{
        sku_id: string;
        location_id: string;
        batch_no: string;
        qty_on_hand: string;
      }> = await pool.query(
        `select sku_id, location_id, batch_no, qty_on_hand::text as qty_on_hand
           from wms.stock_balance where client_id = $1 and sku_id = any($2::uuid[])`,
        [fixtureClientId, fixtureSkuIds],
      );

      for (const row of actualBalances.rows) {
        const key = balanceKey(fixtureClientId, row.sku_id, row.location_id, row.batch_no);
        const expected = expectedBalances.get(key) ?? Quantity.zero();
        expect(
          Quantity.of(row.qty_on_hand).equals(expected),
          `balance mismatch at ${key}: db=${row.qty_on_hand} ledger-fold=${expected.toString()}`,
        ).toBe(true);
      }
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );
});

// --- Scenario: G1 stays green after the whole suite ---------------------------------------------

describe('Scenario: G1 stays green after the whole suite (doc 40 Part F, guards.sql:31-32)', () => {
  it('select count(*) from wms.verify_balance_integrity() = 0 (whole table)', async () => {
    const result: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.verify_balance_integrity()`,
    );
    expect(result.rows[0]?.n).toBe('0');
  });
});
