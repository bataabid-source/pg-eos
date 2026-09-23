// modules/wms/tests/integration/rebuild-balance-scope-full.test.ts — GM directive 2026-09-23
// phase C (pg-tester), positive control for rebuild-balance-scope.test.ts (see that file's header
// for the full defect writeup — pg-reviewer gate finding 9).
//
// This file proves the OTHER half of the fixed guard condition: a caller whose
// identity.user_entities covers EVERY row of platform.entities (not merely the entities that
// happen to have posted movements for this client/sku) sees the whole ledger and must NOT be
// refused — rebuildBalance proceeds and wms.verify_balance_integrity() (G1) stays clean. See
// ./rebuild-balance-scope-full.feature.
//
// Same mechanism as rebuild-balance-scope.test.ts: a fresh, restricted, NOSUPERUSER NOBYPASSRLS
// role; process.env.PGUSER/PGPASSWORD mutated in THIS (vitest-isolated) file only, then
// `await import('../../index.js')` so the '@pg-eos/db' pool inside that fresh module registry
// connects as the restricted role. Fixture setup/teardown uses a separate superuser pool built
// with explicit credentials captured before the mutation.
//
// Per the GM directive, this file was RED-before-the-fix only because of the missing
// `RebuildScopeError` export (checked here for the same import-shape reason as the other file) or
// a grant gap — never because the caller was wrongly refused (the pre-fix code had no scope check
// at all, so it already let this caller through).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import type { LedgerDeps } from '../../index.js';

// --- literals, each cited to their source -------------------------------------------------------

const FIXTURE_CODE_PREFIX = '_c9_fixture_';
const ROLE_PREFIX = 'pgeos_t_';

// Same two posting entities as rebuild-balance-scope.test.ts, so the same corruption-shaped
// fixture proves the OPPOSITE outcome once the writer sees every entity.
const ENTITY_CODE_A = 'PST';
const ENTITY_CODE_B = 'PCC';

const QTY_ENTITY_A = '10.000';
const QTY_ENTITY_B = '5.000';
const EXPECTED_TOTAL_QTY = '15.000';
const MOVEMENT_TYPE_RECEIPT = 'receipt';
const UOM_EA = 'EA';
const BATCH_NO_DEFAULT = '';

// Distinct from rebuild-balance-scope.test.ts's PERFORMED_BY_FIXTURE_UUID — this file never
// shares fixtures with that one (each is its own isolated vitest module/process view).
const PERFORMED_BY_FIXTURE_UUID = '00000000-0000-4000-8000-0000000209fa';

// SAME key as rebuild-balance-scope.test.ts's GRANT_LOCK_KEY — see that file's comment. Both
// files GRANT/REVOKE on the same shared objects (wms.stock_movements, wms.stock_balance,
// platform.entities, the wms/platform schemas), which updates each object's own catalog row;
// running both files' grant/revoke sections at once (the default: vitest runs test FILES in
// parallel) intermittently fails with Postgres error "tuple concurrently updated" (observed
// empirically). This advisory lock serialises the two files' sections against each other.
const GRANT_LOCK_KEY = 2_026_09_23_01;

const SUPERUSER_USER = process.env['PGUSER'] ?? 'postgres';
const SUPERUSER_PASSWORD = process.env['PGPASSWORD'];
// pg-reviewer slice-close round 2 finding 7 (same as rebuild-balance-scope.test.ts): the RAW
// (possibly undefined) values, captured before this file's `it`s mutate
// process.env.PGUSER/PGPASSWORD to point the dynamically-imported '@pg-eos/db' pool at the
// restricted role — restored verbatim in afterAll.
const ORIGINAL_PGUSER = process.env['PGUSER'];
const ORIGINAL_PGPASSWORD = process.env['PGPASSWORD'];
const PG_HOST = process.env['PGHOST'] ?? 'localhost';
const PG_PORT = Number(process.env['PGPORT'] ?? '5432');
const PG_DATABASE = process.env['PGDATABASE'] ?? 'pgeos';

const pool = new Pool({
  host: PG_HOST,
  port: PG_PORT,
  user: SUPERUSER_USER,
  password: SUPERUSER_PASSWORD,
  database: PG_DATABASE,
  max: 5,
});

let entityAId: string;
let entityBId: string;
let locationL1: string;
let fixtureClientId: string;
let fixtureSkuId: string;
let writerUserId: string;
let allEntityIds: string[] = [];
const roleName = `${ROLE_PREFIX}rbscopefull_${randomUUID().replace(/-/g, '')}`;
const rolePassword = randomUUID();

const deps: LedgerDeps = {
  clock: new FixedClock(new Date('2026-09-23T00:00:00.000Z')),
  ids: new SequentialIdGenerator(2010),
};

// See GRANT_LOCK_KEY's comment above — one dedicated connection holds the session-level advisory
// lock for the whole grant/revoke block, then releases both the lock and the connection.
async function withGrantLock(fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [GRANT_LOCK_KEY]);
    await fn();
  } finally {
    await client.query('select pg_advisory_unlock($1)', [GRANT_LOCK_KEY]);
    client.release();
  }
}

async function guardRowCountFor(clientId: string): Promise<number> {
  const result: QueryResult<{ n: number }> = await pool.query(
    `select count(*)::int as n from wms.verify_balance_integrity() where client_id = $1`,
    [clientId],
  );
  return result.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  const allEntitiesResult: QueryResult<{ id: string; code: string }> = await pool.query(
    `select id, code from platform.entities`,
  );
  if (allEntitiesResult.rows.length === 0) {
    throw new Error('expected at least one row in platform.entities');
  }
  allEntityIds = allEntitiesResult.rows.map((r) => r.id);
  const entityA = allEntitiesResult.rows.find((r) => r.code === ENTITY_CODE_A);
  const entityB = allEntitiesResult.rows.find((r) => r.code === ENTITY_CODE_B);
  if (!entityA || !entityB) {
    throw new Error(`fixture entities ${ENTITY_CODE_A} and ${ENTITY_CODE_B} must both exist in platform.entities`);
  }
  entityAId = entityA.id;
  entityBId = entityB.id;

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

  const accountCode = `${FIXTURE_CODE_PREFIX}${randomUUID()}`;
  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, status)
     values ($1, $2, 'client', 'active') returning id`,
    [accountCode, 'عميل اختبار نطاق إعادة بناء الرصيد — الضابط الإيجابي'],
  );
  const clientRow = clientResult.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  fixtureClientId = clientRow.id;

  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar) values ($1, $2, $3) returning id`,
    [fixtureClientId, `RBSCOPEFULL-SKU-${randomUUID()}`, 'صنف اختبار الضابط الإيجابي'],
  );
  const skuRow = skuResult.rows[0];
  if (!skuRow) throw new Error('fixture wms.skus insert returned no row');
  fixtureSkuId = skuRow.id;

  const writerResult: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type)
     values ($1, $2, 'internal') returning id`,
    [`${FIXTURE_CODE_PREFIX}${randomUUID()}@test.invalid`, 'كاتب اختبار الضابط الإيجابي'],
  );
  const writerRow = writerResult.rows[0];
  if (!writerRow) throw new Error('fixture identity.users insert returned no row');
  writerUserId = writerRow.id;

  // The positive control: the writer is scoped to EVERY platform.entities row, not just the ones
  // that posted movements for this client/sku.
  for (const entityId of allEntityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
      writerUserId,
      entityId,
    ]);
  }

  await withGrantLock(async () => {
    await pool.query(
      `create role ${roleName} login password '${rolePassword}' nosuperuser nobypassrls`,
    );
    await pool.query(`grant usage on schema wms to ${roleName}`);
    await pool.query(`grant usage on schema platform to ${roleName}`);
    await pool.query(`grant select on wms.stock_movements to ${roleName}`);
    await pool.query(`grant select, insert, update, delete on wms.stock_balance to ${roleName}`);
    await pool.query(`grant select on platform.entities to ${roleName}`);
  });

  await pool.query(
    `insert into wms.stock_movements
       (entity_id, movement_type, client_id, sku_id, to_location_id, qty, uom, batch_no, performed_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
    [
      entityAId,
      MOVEMENT_TYPE_RECEIPT,
      fixtureClientId,
      fixtureSkuId,
      locationL1,
      QTY_ENTITY_A,
      UOM_EA,
      BATCH_NO_DEFAULT,
      PERFORMED_BY_FIXTURE_UUID,
    ],
  );
  await pool.query(
    `insert into wms.stock_movements
       (entity_id, movement_type, client_id, sku_id, to_location_id, qty, uom, batch_no, performed_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
    [
      entityBId,
      MOVEMENT_TYPE_RECEIPT,
      fixtureClientId,
      fixtureSkuId,
      locationL1,
      QTY_ENTITY_B,
      UOM_EA,
      BATCH_NO_DEFAULT,
      PERFORMED_BY_FIXTURE_UUID,
    ],
  );
  await pool.query(
    `insert into wms.stock_balance (client_id, sku_id, location_id, batch_no, qty_on_hand)
     values ($1, $2, $3, $4, $5::numeric)`,
    [fixtureClientId, fixtureSkuId, locationL1, BATCH_NO_DEFAULT, EXPECTED_TOTAL_QTY],
  );

  const cleanBefore = await guardRowCountFor(fixtureClientId);
  if (cleanBefore !== 0) {
    throw new Error(`fixture setup invariant violated: expected G1 = 0 before the call, got ${cleanBefore}`);
  }
});

afterAll(async () => {
  // FK order: balance, movements, skus, accounts, user_entities, users; drop role; audit rows are
  // never deleted (GM directive).
  if (fixtureClientId) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
  }
  if (fixtureSkuId) {
    await pool.query(`delete from wms.skus where id = $1`, [fixtureSkuId]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  }
  if (writerUserId) {
    await pool.query(`delete from identity.user_entities where user_id = $1`, [writerUserId]);
    await pool.query(`delete from identity.users where id = $1`, [writerUserId]);
  }
  await withGrantLock(async () => {
    await pool.query(`revoke all on wms.stock_movements from ${roleName}`);
    await pool.query(`revoke all on wms.stock_balance from ${roleName}`);
    await pool.query(`revoke all on platform.entities from ${roleName}`);
    await pool.query(`revoke usage on schema wms from ${roleName}`);
    await pool.query(`revoke usage on schema platform from ${roleName}`);
    await pool.query(`drop role ${roleName}`);
  });
  await pool.end();

  // finding 7: restore, never leave the restricted-role credentials mutated in process.env past
  // this file's own tests.
  if (ORIGINAL_PGUSER === undefined) {
    delete process.env['PGUSER'];
  } else {
    process.env['PGUSER'] = ORIGINAL_PGUSER;
  }
  if (ORIGINAL_PGPASSWORD === undefined) {
    delete process.env['PGPASSWORD'];
  } else {
    process.env['PGPASSWORD'] = ORIGINAL_PGPASSWORD;
  }
});

async function balanceQtyOnHand(): Promise<string | undefined> {
  const result: QueryResult<{ qty_on_hand: string }> = await pool.query(
    `select qty_on_hand::text as qty_on_hand from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = $4`,
    [fixtureClientId, fixtureSkuId, locationL1, BATCH_NO_DEFAULT],
  );
  return result.rows[0]?.qty_on_hand;
}

describe('Scenario: rebuildBalance proceeds for a caller scoped to every entity', () => {
  // Split from the "resolves" `it` below (unlike this file's sibling
  // rebuild-balance-scope.test.ts, splitting here is not needed to observe a real DB call — the
  // GM directive says this file "may be RED only because of the missing export or grants", so the
  // export-shape check is isolated to its own `it` and never blocks the "resolves" `it` from
  // genuinely exercising rebuildBalance against the live database.
  it('RebuildScopeError is exported from modules/wms/index.ts', async () => {
    process.env['PGUSER'] = roleName;
    process.env['PGPASSWORD'] = rolePassword;

    const mod = await import('../../index.js');
    expect(
      mod.RebuildScopeError,
      'RebuildScopeError must be exported from modules/wms/index.ts (pg-reviewer gate finding 9)',
    ).toBeTypeOf('function');
  });

  it('rebuildBalance resolves (does not throw RebuildScopeError) for a caller with identity.user_entities covering all of platform.entities', async () => {
    process.env['PGUSER'] = roleName;
    process.env['PGPASSWORD'] = rolePassword;

    const mod = await import('../../index.js');
    const ctx = { userId: writerUserId, clientId: null, isInternal: true };

    const result = await mod.rebuildBalance(
      ctx,
      { clientId: fixtureClientId, skuId: fixtureSkuId },
      deps,
    );
    expect(result.rowsWritten).toBeGreaterThan(0);
  });

  it('wms.verify_balance_integrity() stays clean for that client, checked as superuser (G1)', async () => {
    const guardRows = await guardRowCountFor(fixtureClientId);
    expect(guardRows, 'wms.verify_balance_integrity() must report zero rows for this client (G1)').toBe(0);
  });

  // pg-reviewer slice-close round 2 finding 2: the Master's tightened scope rule requires a
  // non-bypass caller to ALSO satisfy platform.is_internal() — a caller scoped, via
  // identity.user_entities, to every platform.entities row (proven above) must still be refused
  // when ctx.isInternal is false. Before the fix, assertSeesWholeLedger (rebuild-balance.ts) never
  // checked platform.is_internal() at all, so it let this caller past its own scope check and
  // proceeded to the fold/write. Confirmed RED reason (pg-tester, run against the live database):
  // the write itself then failed, but NOT with a typed RebuildScopeError thrown "before any read or
  // write" as the brief requires — instead a raw Postgres error surfaces mid-transaction, SQLSTATE 42501
  // ("new row violates row-level security policy for table \"stock_balance\""), because
  // wms.stock_balance's internal_only policy (13B §RLS auto-policy loop, pattern ②, `for all using
  // (platform.is_internal())` with no separate WITH CHECK — so the USING expression doubles as the
  // INSERT's WITH CHECK) rejects the fold's own upsert once app.is_internal is false. The fix must
  // catch this case with its OWN check (ctx.isInternal / platform.is_internal()) ahead of any read
  // or write, per the interface the Master specified, not rely on this incidental RLS failure.
  it('a caller with every entity but isInternal false is refused', async () => {
    process.env['PGUSER'] = roleName;
    process.env['PGPASSWORD'] = rolePassword;

    const mod = await import('../../index.js');
    const ctx = { userId: writerUserId, clientId: null, isInternal: false };

    let capturedResult: { rowsWritten: number } | undefined;
    let capturedError: unknown;
    try {
      capturedResult = await mod.rebuildBalance(
        ctx,
        { clientId: fixtureClientId, skuId: fixtureSkuId },
        deps,
      );
    } catch (error) {
      capturedError = error;
    }

    expect(
      capturedResult,
      'rebuildBalance must reject, not resolve, when ctx.isInternal is false (finding 2)',
    ).toBeUndefined();
    expect(capturedError, 'rebuildBalance must throw RebuildScopeError, not swallow isInternal=false').toBeDefined();
    expect((capturedError as { name?: string } | undefined)?.name).toBe('RebuildScopeError');

    const qtyOnHand = await balanceQtyOnHand();
    expect(qtyOnHand, `expected the balance to be unchanged at ${EXPECTED_TOTAL_QTY}`).toBe(
      EXPECTED_TOTAL_QTY,
    );
  });
});
