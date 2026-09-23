// modules/wms/tests/integration/rebuild-balance-scope.test.ts — GM directive 2026-09-23 phase C
// (pg-tester), written RED-first against pg-reviewer gate finding 9.
//
// Defect: rebuildBalance(ctx, {clientId, skuId}, deps) (modules/wms/src/stock-ledger/
// rebuild-balance.ts) runs inside withContext, so under RLS a caller sees ALL wms.stock_balance
// rows (policy internal_only — 13B §RLS auto-policy loop, pattern ② internal_only) but only the
// wms.stock_movements rows of its own entities (entity_scope: `entity_id =
// any(platform.allowed_entities())`, allowed_entities() = the caller's identity.user_entities —
// 13B §RLS auto-policy loop, pattern ① entity_scope). It then overwrites balances from a partial fold ->
// corrupts them (doc 40 P4: balances are derived and rebuildable with ZERO diff).
//
// Fixed behaviour the Master will have pg-backend implement: before any write, rebuildBalance
// checks inside the same transaction that the caller sees the WHOLE ledger — the current role is
// superuser or BYPASSRLS, OR platform.allowed_entities() contains every platform.entities id —
// otherwise it throws a new typed `RebuildScopeError` (exported from modules/wms/index.ts) and
// writes nothing. See ./rebuild-balance-scope.feature.
//
// Mechanism (packages/db/src/client.ts): the shared pool reads PGUSER/PGPASSWORD from
// process.env the FIRST time it is imported; PGPASSWORD is never passed explicitly to `new
// Pool(...)`, so `pg`'s own ConnectionParameters falls back to reading it from process.env at
// construction time (node_modules/pg/lib/connection-parameters.js:15, `process.env['PG' +
// key.toUpperCase()]`). Vitest isolates modules per test file (a fresh module registry per file),
// so mutating process.env.PGUSER/PGPASSWORD in THIS file, then dynamically
// `await import('../../index.js')`, makes the '@pg-eos/db' pool inside that fresh registry connect
// as the restricted role created below — without touching any other test file's pool.
//
// Fixture setup/teardown uses a SEPARATE, ordinary `pg` Pool connected as the original superuser
// (captured into SUPERUSER_USER/SUPERUSER_PASSWORD *before* this file mutates process.env), so
// cleanup in afterAll is unaffected by the mutation the test body performs.
//
// Grant list (discovered empirically against the live schema — see the pg-tester report): usage
// on schema wms; usage on schema platform; select on wms.stock_movements; select, insert, update,
// delete on wms.stock_balance; select on platform.entities. `usage on schema identity` is NOT
// required — platform.allowed_entities() (01 §platform.allowed_entities) is `security definer`,
// so it reads identity.user_entities with the FUNCTION OWNER's privileges, not the caller's; the
// caller never references the identity schema directly in its own SQL.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import type { LedgerDeps } from '../../index.js';

// --- literals, each cited to their source -------------------------------------------------------

// GM directive: "sales.accounts `_c9_fixture_…`" — this suite's fixture code prefix.
const FIXTURE_CODE_PREFIX = '_c9_fixture_';
// GM directive: "a LOGIN role `pgeos_t_<hex>`".
const ROLE_PREFIX = 'pgeos_t_';

// GM directive: "two platform.entities rows already seeded — e.g. PST and PCC".
const ENTITY_CODE_SEEN = 'PST';
const ENTITY_CODE_UNSEEN = 'PCC';

// GM directive: "insert (as superuser) ledger rows for that client/sku at the location under BOTH
// entities (single-sided, qty > 0)".
const QTY_SEEN_ENTITY = '10.000';
const QTY_UNSEEN_ENTITY = '5.000';
const EXPECTED_TOTAL_QTY = '15.000';
const MOVEMENT_TYPE_RECEIPT = 'receipt';
const UOM_EA = 'EA';
const BATCH_NO_DEFAULT = '';

// 01 wms.stock_movements.performed_by — "not null" with no FK on that column; a fixed constant
// named in the test (same convention as modules/wms/tests/integration/stock-ledger.test.ts's
// PERFORMED_BY_FIXTURE_UUID), distinct from every other suite's value since this file never shares
// fixtures with them.
const PERFORMED_BY_FIXTURE_UUID = '00000000-0000-4000-8000-0000000209c9';

// GRANT/REVOKE on a shared object (wms.stock_movements, wms.stock_balance, platform.entities, the
// wms/platform schemas) updates that object's own catalog row (e.g. pg_class.relacl) — running
// this file and rebuild-balance-scope-full.test.ts's GRANT/REVOKE sequences at the same time (the
// default: vitest runs test FILES in parallel) races two concurrent UPDATEs of that same row and
// intermittently fails with Postgres error "tuple concurrently updated" (observed empirically).
// A session-level advisory lock (same key in both files, held on ONE dedicated connection for the
// duration of the grant/revoke block, never through the shared `pool` which round-robins
// connections per query) serialises the two files' GRANT/REVOKE/DROP ROLE sections against each
// other without touching vitest.config.ts (out of pg-tester's write scope).
const GRANT_LOCK_KEY = 2_026_09_23_01;

const SUPERUSER_USER = process.env['PGUSER'] ?? 'postgres';
const SUPERUSER_PASSWORD = process.env['PGPASSWORD'];
// pg-reviewer slice-close round 2 finding 7: the RAW (possibly undefined) values, captured before
// this file's `it`s mutate process.env.PGUSER/PGPASSWORD to point the dynamically-imported
// '@pg-eos/db' pool at the restricted role — restored verbatim in afterAll (SUPERUSER_USER above
// is a defaulted value for the fixture Pool, not suitable for restoring an originally-unset var).
const ORIGINAL_PGUSER = process.env['PGUSER'];
const ORIGINAL_PGPASSWORD = process.env['PGPASSWORD'];
const PG_HOST = process.env['PGHOST'] ?? 'localhost';
const PG_PORT = Number(process.env['PGPORT'] ?? '5432');
const PG_DATABASE = process.env['PGDATABASE'] ?? 'pgeos';

// Superuser pool for fixture setup/teardown — built with EXPLICIT credentials captured above so
// mutating process.env later (to point the dynamically-imported '@pg-eos/db' pool at the
// restricted role) never affects this pool.
const pool = new Pool({
  host: PG_HOST,
  port: PG_PORT,
  user: SUPERUSER_USER,
  password: SUPERUSER_PASSWORD,
  database: PG_DATABASE,
  max: 5,
});

let entityPstId: string;
let entityPccId: string;
let locationL1: string;
let fixtureClientId: string;
let fixtureSkuId: string;
let writerUserId: string;
const roleName = `${ROLE_PREFIX}rbscope_${randomUUID().replace(/-/g, '')}`;
const rolePassword = randomUUID();

const deps: LedgerDeps = {
  clock: new FixedClock(new Date('2026-09-23T00:00:00.000Z')),
  ids: new SequentialIdGenerator(2009),
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

async function balanceQtyOnHand(): Promise<string | undefined> {
  const result: QueryResult<{ qty_on_hand: string }> = await pool.query(
    `select qty_on_hand::text as qty_on_hand from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = $4`,
    [fixtureClientId, fixtureSkuId, locationL1, BATCH_NO_DEFAULT],
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

beforeAll(async () => {
  const entitiesResult: QueryResult<{ id: string; code: string }> = await pool.query(
    `select id, code from platform.entities where code = any($1)`,
    [[ENTITY_CODE_SEEN, ENTITY_CODE_UNSEEN]],
  );
  const seenRow = entitiesResult.rows.find((r) => r.code === ENTITY_CODE_SEEN);
  const unseenRow = entitiesResult.rows.find((r) => r.code === ENTITY_CODE_UNSEEN);
  if (!seenRow || !unseenRow) {
    throw new Error(
      `fixture entities ${ENTITY_CODE_SEEN} and ${ENTITY_CODE_UNSEEN} must both exist in platform.entities`,
    );
  }
  entityPstId = seenRow.id;
  entityPccId = unseenRow.id;

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
    [accountCode, 'عميل اختبار نطاق إعادة بناء الرصيد'],
  );
  const clientRow = clientResult.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  fixtureClientId = clientRow.id;

  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar) values ($1, $2, $3) returning id`,
    [fixtureClientId, `RBSCOPE-SKU-${randomUUID()}`, 'صنف اختبار نطاق إعادة بناء الرصيد'],
  );
  const skuRow = skuResult.rows[0];
  if (!skuRow) throw new Error('fixture wms.skus insert returned no row');
  fixtureSkuId = skuRow.id;

  const writerResult: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type)
     values ($1, $2, 'internal') returning id`,
    [`${FIXTURE_CODE_PREFIX}${randomUUID()}@test.invalid`, 'كاتب اختبار نطاق إعادة بناء الرصيد'],
  );
  const writerRow = writerResult.rows[0];
  if (!writerRow) throw new Error('fixture identity.users insert returned no row');
  writerUserId = writerRow.id;

  // The defect: the writer is scoped to ONLY the entity that will NOT be the sole poster.
  await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
    writerUserId,
    entityPstId,
  ]);

  await withGrantLock(async () => {
    await pool.query(
      `create role ${roleName} login password '${rolePassword}' nosuperuser nobypassrls`,
    );
    // Minimal grant list rebuildBalance needs — see header comment for what was tried and dropped.
    await pool.query(`grant usage on schema wms to ${roleName}`);
    await pool.query(`grant usage on schema platform to ${roleName}`);
    await pool.query(`grant select on wms.stock_movements to ${roleName}`);
    await pool.query(`grant select, insert, update, delete on wms.stock_balance to ${roleName}`);
    await pool.query(`grant select on platform.entities to ${roleName}`);
  });

  // GM directive: "insert (as superuser) ledger rows for that client/sku at the location under
  // BOTH entities (single-sided, qty > 0)".
  await pool.query(
    `insert into wms.stock_movements
       (entity_id, movement_type, client_id, sku_id, to_location_id, qty, uom, batch_no, performed_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9)`,
    [
      entityPstId,
      MOVEMENT_TYPE_RECEIPT,
      fixtureClientId,
      fixtureSkuId,
      locationL1,
      QTY_SEEN_ENTITY,
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
      entityPccId,
      MOVEMENT_TYPE_RECEIPT,
      fixtureClientId,
      fixtureSkuId,
      locationL1,
      QTY_UNSEEN_ENTITY,
      UOM_EA,
      BATCH_NO_DEFAULT,
      PERFORMED_BY_FIXTURE_UUID,
    ],
  );
  // "the matching balance rows so verify_balance_integrity() is clean".
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

describe('Scenario: rebuildBalance refuses to run for a caller who cannot see the whole ledger', () => {
  // Deliberately three SEPARATE `it`s (not one), so each right-reason-for-RED the GM directive
  // names is its own named test, independent of the others:
  //   1. the export itself is missing (today's actual state) — never calls rebuildBalance.
  //   2. even if the export existed, today's rebuildBalance has no scope check at all, so it
  //      RESOLVES instead of rejecting — this `it` genuinely calls rebuildBalance regardless of
  //      whether test 1 passed, so it independently proves "rebuild proceeds" against the live
  //      database rather than being short-circuited by test 1's assertion.
  //   3. the real-world consequence: because test 2's call actually ran and actually wrote, the
  //      balance is corrupted and G1 (wms.verify_balance_integrity) goes non-zero for the client.
  let capturedResult: { rowsWritten: number } | undefined;
  let capturedError: unknown;

  it('RebuildScopeError is exported from modules/wms/index.ts', async () => {
    process.env['PGUSER'] = roleName;
    process.env['PGPASSWORD'] = rolePassword;

    const mod = await import('../../index.js');
    expect(
      mod.RebuildScopeError,
      'RebuildScopeError must be exported from modules/wms/index.ts (pg-reviewer gate finding 9)',
    ).toBeTypeOf('function');
  });

  it('rebuildBalance does not silently resolve for a caller scoped to only one of the two posting entities', async () => {
    process.env['PGUSER'] = roleName;
    process.env['PGPASSWORD'] = rolePassword;

    const mod = await import('../../index.js');
    const ctx = { userId: writerUserId, clientId: null, isInternal: true };

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
      'rebuildBalance must reject, not resolve, when the caller cannot see the whole ledger',
    ).toBeUndefined();
    expect(capturedError, 'rebuildBalance must throw RebuildScopeError, not swallow the scope violation').toBeDefined();
    expect((capturedError as { name?: string } | undefined)?.name).toBe('RebuildScopeError');
  });

  it('the wms.stock_balance row is unchanged and wms.verify_balance_integrity() stays clean for that client, checked as superuser', async () => {
    const qtyOnHand = await balanceQtyOnHand();
    expect(qtyOnHand, `expected the balance to be unchanged at ${EXPECTED_TOTAL_QTY}`).toBe(
      EXPECTED_TOTAL_QTY,
    );

    const guardRows = await guardRowCountFor(fixtureClientId);
    expect(guardRows, 'wms.verify_balance_integrity() must report zero rows for this client (G1)').toBe(0);
  });
});
