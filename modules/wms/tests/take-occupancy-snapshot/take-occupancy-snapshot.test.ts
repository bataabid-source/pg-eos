// modules/wms/tests/take-occupancy-snapshot/take-occupancy-snapshot.test.ts — WBS 2.14 (lane 2).
//
// Integration tests, one per scenario in ./take-occupancy-snapshot.feature, against the real
// database as pgeos_app. Sources: docs/notes/slice-briefs/_slice-2.14.brief.md (Facts/D1-D9,
// verbatim), doc 40 line 224/260/262/320, .claude/briefs/wms.brief.md.
//
// Binding behaviour this suite asserts (RED until pg-backend builds
// modules/wms/{domain,application,infrastructure,api}/take-occupancy-snapshot/**):
//   - TakeOccupancySnapshot(ctx, { warehouseId, snapshotDate?, correlationId }, deps) snapshots
//     EVERY client with a positive wms.stock_balance row in the target warehouse in ONE call (D6).
//   - pallets_occupied = count of DISTINCT pallet-type wms.locations the client occupies;
//     locations_used = the same count across EVERY location_type (D2). sqm_occupied/cbm_occupied
//     are left at their column default (0) this slice (D2) — never asserted non-zero here.
//   - contracted capacity = sum(wms.space_allocations.qty) where uom='pallet', status='active',
//     the snapshot date falls inside [valid_from, valid_to], scoped to the warehouse via block_id
//     (D3). A client with no active allocation has contracted = 0 (D3).
//   - billing: ALWAYS one billing.billable_events row for ST-01 with qty = pallets_occupied.
//     ADDITIONALLY, when pallets_occupied > contracted, one more row for ST-12 with qty = the
//     excess only (D4). Both rows: unit_price/price_source/price_ref_id/amount null, status
//     'pending', source_table = 'wms.occupancy_snapshots', source_id = the snapshot's own id (D4).
//   - re-running for an already-billed (source_table, source_id, service_id) is a no-op — the
//     table's own unique index, not a hand-rolled check (D5). The snapshot row itself is a pure
//     no-op on re-run for a day already taken: the FIRST snapshot of the day stands (same id, same
//     values); a later stock change is never reflected by re-running the same day (D1, corrected).
//   - a client with ZERO occupied locations in the warehouse gets NO wms.occupancy_snapshots row
//     at all (not a zero row).
//   - role: WH_MGR only (D7) -> RoleRequiredError (422), nothing written.
//   - entity_id always ctx.entityId-resolved (never caller-supplied); actor = ctx.userId.
//   - ONE platform.audit_log row per call, aggregate table 'occupancy_snapshots' (D8) — not one
//     per client snapshotted.
//   - Idempotency-Key required; a replay with the same key + body returns the first result without
//     recomputing (D9) — on top of D1/D5's own natural idempotency.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as
// modules/wms/tests/count-inventory/count-inventory.test.ts and
// modules/wms/tests/receive-inbound/receive-inbound.test.ts. PG_APP_USER=pgeos_app is REQUIRED to
// run this suite (every command call goes through withContext(ctx, fn) as pgeos_app, genuinely
// subject to RLS). platform.audit_log rows are NEVER deleted.
//
// pg-reviewer finding 8 (WBS 2.13, round 1) — never repeated here: stock is seeded through a REAL
// 'receipt' movement via the module's own public postMovement (never a direct wms.stock_balance
// INSERT), which is the ONLY way this suite is allowed to put stock on the ledger. A direct INSERT
// leaves a ledgerless balance row and fails guard G1 (wms.verify_balance_integrity()).

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The module under test — does not exist yet (RED).
import { takeOccupancySnapshot } from '../../application/take-occupancy-snapshot/index.js';
import { createTakeOccupancySnapshotDeps } from '../../api/take-occupancy-snapshot/composition.js';
import { RoleRequiredError } from '../../domain/take-occupancy-snapshot/errors.js';
// round-1 review finding 3: businessDateOf itself is only ever exercised through invariants.property.test.ts
// (pure unit) plus THIS file's own integration test below, which calls TakeOccupancySnapshot WITHOUT a
// snapshotDate and asserts the result against this same function applied to the FixedClock's own instant.
import { businessDateOf } from '../../domain/take-occupancy-snapshot/invariants.js';
// pg-reviewer finding 8 discipline (2.13) — never a direct wms.stock_balance INSERT.
import { postMovement, type LedgerDeps } from '../../index.js';
// the package subpath export (@pg-eos/contracts/wms/take-occupancy-snapshot), not a deep relative
// path — packages/contracts/package.json's own `exports` map already carries this entry.
import { TakeOccupancySnapshotInputSchema } from '@pg-eos/contracts/wms/take-occupancy-snapshot';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// pgeos_app-role pool, present for parity with the golden slice's own fixture pattern (kept so a
// later slice-close round adding a cross-entity RLS scenario does not need to introduce the pool).
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// --- literals ------------------------------------------------------------------------------------

const WH_MGR_ROLE_CODE = 'WH_MGR';
const WH_SUP_ROLE_CODE = 'WH_SUP';
const ST01_SERVICE_CODE = 'ST-01';
const ST12_SERVICE_CODE = 'ST-12';
const RECEIPT_MOVEMENT_TYPE = 'receipt';
const DEFAULT_SEED_UOM = 'EA';
const DEFAULT_SEED_QTY = '1.000';
const SOURCE_TABLE = 'wms.occupancy_snapshots';
const PALLET_UOM = 'pallet';
const ALLOC_STATUS_ACTIVE = 'active';
const ALLOC_TYPE_DEDICATED = 'dedicated';
const BLOCK_TYPE_PALLET_RACK = 'pallet_rack';

const ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000214a1'; // WH_MGR only.
const WH_SUP_ONLY_ACTOR_UUID = '00000000-0000-4000-8000-0000000214a2';

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(214);
const deps = createTakeOccupancySnapshotDeps({ clock, ids });
const ledgerDeps: LedgerDeps = { clock, ids: new SequentialIdGenerator(21400) };

const roleCtx = { userId: ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const whSupOnlyCtx = { userId: WH_SUP_ONLY_ACTOR_UUID, clientId: null, isInternal: true };

// Every fixture snapshot in this suite targets THIS date, chosen once so contracted-capacity
// windows (valid_from/valid_to) can be built deterministically around it, never derived from
// `new Date()` (CLAUDE.md forbids `new Date()` in domain/; this is a test literal, not domain code).
const SNAPSHOT_DATE = '2026-09-25';
const ALLOCATION_VALID_FROM = '2026-01-01'; // well before SNAPSHOT_DATE.

let entityId: string;
let st01ServiceId: string;
let st12ServiceId: string;
const fixtureClientIds: string[] = [];
const fixtureContractIds: string[] = [];
const fixtureBlockIds: string[] = [];
const fixtureWarehouseIds: string[] = [];
const fixtureZoneIds: string[] = [];
const fixtureLocationIds: string[] = [];
const fixtureSkuIds: string[] = [];
const fixtureAllocationIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `wms.take-occupancy-snapshot.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    roleCode,
  ]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleId]);
}

async function createFixtureActor(userId: string, entityIds: readonly string[]): Promise<void> {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_occsnap_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار لقطة الإشغال — WBS 2.14'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

/** A dedicated warehouse + zone per test, so occupancy snapshots are deterministic — never WH1,
 *  which other suites (receive-inbound, count-inventory) also write stock to. */
async function createFixtureWarehouse(): Promise<{ warehouseId: string; zoneId: string }> {
  const whResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [entityId, `_OCCSNAP_WH_${randomUUID()}`, 'مستودع اختبار لقطة الإشغال'],
  );
  const warehouseId = (whResult.rows[0] as { id: string }).id;
  fixtureWarehouseIds.push(warehouseId);

  const zoneResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, $2, $3, 'storage') returning id`,
    [warehouseId, 'A', 'منطقة اختبار'],
  );
  const zoneId = (zoneResult.rows[0] as { id: string }).id;
  fixtureZoneIds.push(zoneId);

  return { warehouseId, zoneId };
}

// Monotonic generator for codes matching chk_locations_code_format
// (database/schema/019-Warehouse-WH1-Setup.sql:59-62 — `^[PGMT][1-9]-[0-9]{2}-[1-9]$`, required for
// location_type in ('pallet','shelf')). Same pattern as
// modules/wms/tests/count-inventory/count-inventory.test.ts's own nextLocationCode().
let locationCodeCounter = 0;
function nextLocationCode(): string {
  const n = locationCodeCounter;
  locationCodeCounter += 1;
  const level = (n % 9) + 1;
  const position = Math.floor(n / 9) % 100;
  const aisle = (Math.floor(n / 900) % 9) + 1;
  return `P${aisle}-${String(position).padStart(2, '0')}-${level}`;
}

async function insertLocation(
  warehouseId: string,
  zoneId: string,
  code: string,
  locationType: 'pallet' | 'shelf' = 'pallet',
  blockId: string | null = null,
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.locations (warehouse_id, zone_id, code, location_type, space_block_id) values ($1, $2, $3, $4, $5) returning id`,
    [warehouseId, zoneId, code, locationType, blockId],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureLocationIds.push(id);
  return id;
}

async function insertClient(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_occsnap_fixture_${randomUUID()}`, 'عميل اختبار لقطة الإشغال'],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureClientIds.push(id);
  return id;
}

async function insertContract(clientId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date)
     values ($1, $2, $3, $4, $5::date) returning id`,
    [entityId, `_OCCSNAP-CT-${randomUUID()}`, clientId, 'عقد اختبار لقطة الإشغال', ALLOCATION_VALID_FROM],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureContractIds.push(id);
  return id;
}

async function insertSpaceBlock(warehouseId: string, zoneId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_blocks (entity_id, warehouse_id, zone_id, code, block_type)
     values ($1, $2, $3, $4, $5) returning id`,
    [entityId, warehouseId, zoneId, `_OCCSNAP-BLK-${randomUUID()}`, BLOCK_TYPE_PALLET_RACK],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureBlockIds.push(id);
  return id;
}

/** an ACTIVE pallet-uom space_allocations row, covering SNAPSHOT_DATE (valid_from well before it,
 *  valid_to null — open-ended), for `qtyPallets` pallets of contracted capacity. */
async function insertActiveAllocation(
  contractId: string,
  clientId: string,
  blockId: string,
  qtyPallets: string,
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_allocations
       (entity_id, contract_id, client_id, block_id, alloc_type, qty, uom, service_id, valid_from, valid_to, status, created_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::date, null, $10, $11)
     returning id`,
    [
      entityId,
      contractId,
      clientId,
      blockId,
      ALLOC_TYPE_DEDICATED,
      qtyPallets,
      PALLET_UOM,
      st01ServiceId,
      ALLOCATION_VALID_FROM,
      ALLOC_STATUS_ACTIVE,
      ROLE_ACTOR_UUID,
    ],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureAllocationIds.push(id);
  return id;
}

async function insertSku(clientId: string, code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, '1.000', '0.00100') returning id`,
    [clientId, code, `صنف اختبار لقطة الإشغال ${code}`],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureSkuIds.push(id);
  return id;
}

/** pg-reviewer finding 8 discipline (2.13) — seeds stock through a REAL 'receipt' movement via the
 *  module's own public `postMovement` (../../index.js), never a direct wms.stock_balance INSERT.
 *  A distinct SKU per location keeps each location's own stock_balance row independent.
 *  `blockId` is REQUIRED (CORRECTION, brief Facts) — the occupancy_snapshots grain is now
 *  per (client, space_block); a location with no space_block_id is excluded from any snapshot,
 *  so every fixture location that should count toward a snapshot must carry a real block. */
async function seedOccupiedLocation(
  clientId: string,
  warehouseId: string,
  zoneId: string,
  blockId: string,
  locationType: 'pallet' | 'shelf' = 'pallet',
): Promise<string> {
  const locationId = await insertLocation(warehouseId, zoneId, nextLocationCode(), locationType, blockId);
  const skuId = await insertSku(clientId, `OCCSNAP-${randomUUID()}`);
  await postMovement(
    roleCtx,
    {
      entityId,
      entry: {
        clientId,
        skuId,
        fromLocationId: null,
        toLocationId: locationId,
        qty: Quantity.of(DEFAULT_SEED_QTY),
        batchNo: '',
        movementType: RECEIPT_MOVEMENT_TYPE,
        uom: DEFAULT_SEED_UOM,
      },
      correlationId: nextCorrelationId(),
      performedBy: ROLE_ACTOR_UUID,
    },
    ledgerDeps,
  );
  return locationId;
}

interface SnapshotRow {
  readonly id: string;
  readonly pallets_occupied: string;
  readonly sqm_occupied: string;
  readonly cbm_occupied: string;
  readonly locations_used: number;
  readonly space_block_id: string | null;
}

const SNAPSHOT_SELECT = `select id, pallets_occupied::text as pallets_occupied, sqm_occupied::text as sqm_occupied,
            cbm_occupied::text as cbm_occupied, locations_used, space_block_id
       from wms.occupancy_snapshots`;

/** Per the corrected grain (occupancy_snapshots_grain_uq: snapshot_date, entity_id, client_id,
 *  warehouse_id, space_block_id) a (client, warehouse) pair can now have MULTIPLE rows, one per
 *  block. `blockId` narrows to the single row for that block — every scenario with exactly one
 *  block for the client passes its own fixture blockId here, never omits it. */
async function getSnapshot(
  clientId: string,
  warehouseId: string,
  blockId: string,
  snapshotDate: string = SNAPSHOT_DATE,
): Promise<SnapshotRow | null> {
  const result: QueryResult<SnapshotRow> = await pool.query(
    `${SNAPSHOT_SELECT}
      where client_id = $1 and warehouse_id = $2 and space_block_id = $3 and snapshot_date = $4::date`,
    [clientId, warehouseId, blockId, snapshotDate],
  );
  return result.rows[0] ?? null;
}

/** All occupancy_snapshots rows for a (client, warehouse), any block — used by the "zero occupied
 *  locations" scenario (nothing should exist at all) and the "two blocks -> two rows" scenario. */
async function getSnapshotsForClient(
  clientId: string,
  warehouseId: string,
  snapshotDate: string = SNAPSHOT_DATE,
): Promise<SnapshotRow[]> {
  const result: QueryResult<SnapshotRow> = await pool.query(
    `${SNAPSHOT_SELECT}
      where client_id = $1 and warehouse_id = $2 and snapshot_date = $3::date
      order by space_block_id`,
    [clientId, warehouseId, snapshotDate],
  );
  return result.rows;
}

interface BillableEventRow {
  readonly id: string;
  readonly qty: string;
  readonly unit_price: string | null;
  readonly price_source: string | null;
  readonly price_ref_id: string | null;
  readonly amount: string | null;
  readonly status: string;
  readonly source_table: string;
  readonly source_id: string;
}

async function getBillableEventsForSnapshot(snapshotId: string, serviceId: string): Promise<BillableEventRow[]> {
  const result: QueryResult<BillableEventRow> = await pool.query(
    `select id::text as id, qty::text as qty, unit_price::text as unit_price, price_source,
            price_ref_id::text as price_ref_id, amount::text as amount, status,
            source_table, source_id::text as source_id
       from billing.billable_events
      where source_table = $1 and source_id = $2 and service_id = $3`,
    [SOURCE_TABLE, snapshotId, serviceId],
  );
  return result.rows;
}

async function auditRowCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log
      where correlation_id = $1 and schema_name = 'wms' and table_name = 'occupancy_snapshots'`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  await createFixtureActor(ROLE_ACTOR_UUID, [entityId]);
  await createFixtureActor(WH_SUP_ONLY_ACTOR_UUID, [entityId]);
  await grantRole(ROLE_ACTOR_UUID, WH_MGR_ROLE_CODE);
  await grantRole(WH_SUP_ONLY_ACTOR_UUID, WH_SUP_ROLE_CODE);

  // brief Facts: ST-01/ST-12 are already seeded (13B:2539, 2550) — looked up, never inserted here.
  const st01Result: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [
    ST01_SERVICE_CODE,
  ]);
  const st01Row = st01Result.rows[0];
  if (!st01Row) throw new Error(`catalog.services row not found for code ${ST01_SERVICE_CODE} — expected seeded at 13B`);
  st01ServiceId = st01Row.id;

  const st12Result: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [
    ST12_SERVICE_CODE,
  ]);
  const st12Row = st12Result.rows[0];
  if (!st12Row) throw new Error(`catalog.services row not found for code ${ST12_SERVICE_CODE} — expected seeded at 13B`);
  st12ServiceId = st12Row.id;
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureClientIds.length > 0) {
    await pool.query(`delete from billing.billable_events where client_id = any($1::uuid[])`, [fixtureClientIds]);
    await pool.query(`delete from wms.occupancy_snapshots where client_id = any($1::uuid[])`, [fixtureClientIds]);
  }
  if (fixtureAllocationIds.length > 0) {
    await pool.query(`delete from wms.space_allocations where id = any($1::uuid[])`, [fixtureAllocationIds]);
  }
  if (fixtureContractIds.length > 0) {
    await pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [fixtureContractIds]);
  }
  for (const clientId of fixtureClientIds) {
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [clientId]);
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [clientId]);
  }
  if (fixtureSkuIds.length > 0) await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  // locations reference wms.space_blocks (space_block_id fkey) — MUST be deleted before the blocks.
  if (fixtureLocationIds.length > 0) {
    await pool.query(`delete from wms.locations where id = any($1::uuid[])`, [fixtureLocationIds]);
  }
  if (fixtureBlockIds.length > 0) {
    await pool.query(`delete from wms.space_blocks where id = any($1::uuid[])`, [fixtureBlockIds]);
  }
  if (fixtureZoneIds.length > 0) await pool.query(`delete from wms.zones where id = any($1::uuid[])`, [fixtureZoneIds]);
  if (fixtureWarehouseIds.length > 0) {
    await pool.query(`delete from wms.warehouses where id = any($1::uuid[])`, [fixtureWarehouseIds]);
  }
  if (fixtureClientIds.length > 0) {
    await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [fixtureClientIds]);
  }
  for (const userId of [ROLE_ACTOR_UUID, WH_SUP_ONLY_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
  await appPool.end();
});

// --- contract stub (package subpath import) ----------------------------------------------------

describe('@pg-eos/contracts/wms/take-occupancy-snapshot — TakeOccupancySnapshotInputSchema', () => {
  it('accepts { warehouseId, correlationId } with snapshotDate omitted (server-side default)', () => {
    const parsed = TakeOccupancySnapshotInputSchema.parse({
      warehouseId: randomUUID(),
      correlationId: randomUUID(),
    });
    expect('performedBy' in parsed).toBe(false);
  });

  it('accepts an explicit snapshotDate (z.iso.date())', () => {
    const parsed = TakeOccupancySnapshotInputSchema.parse({
      warehouseId: randomUUID(),
      snapshotDate: SNAPSHOT_DATE,
      correlationId: randomUUID(),
    });
    expect(parsed.snapshotDate).toBe(SNAPSHOT_DATE);
  });
});

// --- Scenario: within contracted capacity ---------------------------------------------------------

describe('Scenario: Snapshotting a warehouse within contracted capacity', () => {
  it('pallets_occupied 5, one ST-01 billable row qty 5, no ST-12 row', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const contractId = await insertContract(clientId);
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await insertActiveAllocation(contractId, clientId, blockId, '10.000');
    for (let i = 0; i < 5; i += 1) {
      await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);
    }

    const result = await takeOccupancySnapshot(
      roleCtx,
      { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.warehouseId).toBe(warehouseId);
    expect(result.clientsSnapshotted).toBeGreaterThanOrEqual(1);

    const snapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.pallets_occupied).toBe('5.000');
    // round-1 review finding 4(b): sqm_occupied/cbm_occupied are left at the column's own default
    // this slice (D2 — computing them needs per-SKU volume/area, out of scope) — selected by every
    // fixture query already (SNAPSHOT_SELECT) but never asserted until now.
    expect(snapshot?.sqm_occupied).toBe('0.000');
    expect(snapshot?.cbm_occupied).toBe('0.000');

    const st01Rows = await getBillableEventsForSnapshot((snapshot as { id: string }).id, st01ServiceId);
    expect(st01Rows).toHaveLength(1);
    expect(st01Rows[0]?.qty).toBe('5.000');
    expect(st01Rows[0]?.unit_price).toBeNull();
    expect(st01Rows[0]?.price_source).toBeNull();
    expect(st01Rows[0]?.amount).toBeNull();
    expect(st01Rows[0]?.status).toBe('pending');

    const st12Rows = await getBillableEventsForSnapshot((snapshot as { id: string }).id, st12ServiceId);
    expect(st12Rows).toHaveLength(0);
  });
});

// --- Scenario: over contracted capacity — overflow (ST-12) ----------------------------------------

describe('Scenario: Snapshotting a warehouse over contracted capacity generates the overflow event', () => {
  it('pallets_occupied 12, ST-01 qty 12, ST-12 qty 2 (the excess over 10)', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const contractId = await insertContract(clientId);
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await insertActiveAllocation(contractId, clientId, blockId, '10.000');
    for (let i = 0; i < 12; i += 1) {
      await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);
    }

    await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() }, deps);

    const snapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(snapshot?.pallets_occupied).toBe('12.000');

    const st01Rows = await getBillableEventsForSnapshot((snapshot as { id: string }).id, st01ServiceId);
    expect(st01Rows).toHaveLength(1);
    expect(st01Rows[0]?.qty).toBe('12.000');

    const st12Rows = await getBillableEventsForSnapshot((snapshot as { id: string }).id, st12ServiceId);
    expect(st12Rows).toHaveLength(1);
    expect(st12Rows[0]?.qty).toBe('2.000');
    expect(st12Rows[0]?.status).toBe('pending');
    expect(st12Rows[0]?.unit_price).toBeNull();
  });
});

// --- Scenario: no active allocation — fully in overflow --------------------------------------------

describe('Scenario: A client with no active allocation is fully in overflow', () => {
  it('ST-12 qty equals the whole occupied count (contracted = 0)', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    for (let i = 0; i < 3; i += 1) {
      await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);
    }
    // deliberately NO wms.space_allocations row for this client/block.

    await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() }, deps);

    const snapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(snapshot?.pallets_occupied).toBe('3.000');

    const st12Rows = await getBillableEventsForSnapshot((snapshot as { id: string }).id, st12ServiceId);
    expect(st12Rows).toHaveLength(1);
    expect(st12Rows[0]?.qty).toBe('3.000');
  });
});

// --- Scenario: zero occupied locations — skipped entirely -------------------------------------------

describe('Scenario: A client with zero occupied locations is skipped entirely', () => {
  it('no wms.occupancy_snapshots row is written for that client', async () => {
    const { warehouseId } = await createFixtureWarehouse();
    const clientId = await insertClient(); // no stock_balance rows at all in this warehouse.

    await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() }, deps);

    expect(await getSnapshotsForClient(clientId, warehouseId)).toHaveLength(0);
  });
});

// --- Scenario: an occupied location with NO space_block_id is excluded entirely (D2 CORRECTION) ---

describe('Scenario: a location with space_block_id explicitly null is excluded (D2 CORRECTION)', () => {
  it('no wms.occupancy_snapshots row and no billing.billable_events row is written for that occupancy', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    // deliberately NO space_block for this location — insertLocation's blockId defaults to null.
    const locationId = await insertLocation(warehouseId, zoneId, nextLocationCode());
    const skuId = await insertSku(clientId, `OCCSNAP-NOBLOCK-${randomUUID()}`);
    await postMovement(
      roleCtx,
      {
        entityId,
        entry: {
          clientId,
          skuId,
          fromLocationId: null,
          toLocationId: locationId,
          qty: Quantity.of(DEFAULT_SEED_QTY),
          batchNo: '',
          movementType: RECEIPT_MOVEMENT_TYPE,
          uom: DEFAULT_SEED_UOM,
        },
        correlationId: nextCorrelationId(),
        performedBy: ROLE_ACTOR_UUID,
      },
      ledgerDeps,
    );

    await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() }, deps);

    expect(await getSnapshotsForClient(clientId, warehouseId)).toHaveLength(0);
    const billableResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from billing.billable_events where client_id = $1`,
      [clientId],
    );
    expect(Number(billableResult.rows[0]?.n ?? '0')).toBe(0);
  });
});

// --- Scenario: TakeOccupancySnapshot defaults snapshotDate to the Clock's own Kuwait business date -

describe('Scenario: snapshotDate defaults to the injected Clock own Asia/Kuwait business date (D6, round-1 finding 3)', () => {
  it('when snapshotDate is omitted, result.snapshotDate equals businessDateOf(clock.now())', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);

    const result = await takeOccupancySnapshot(roleCtx, { warehouseId, correlationId: nextCorrelationId() }, deps);

    expect(result.snapshotDate).toBe(businessDateOf(clock.now()));

    const snapshot = await getSnapshot(clientId, warehouseId, blockId, businessDateOf(clock.now()));
    expect(snapshot).not.toBeNull();
  });
});

// --- Scenario: re-running an already-billed day does not duplicate billing rows --------------------

describe('Scenario: Re-running the snapshot for an already-taken day is a pure no-op, even if stock changed since (brief D1, round-1 finding 2/8 resolution)', () => {
  it('the snapshot row is UNCHANGED (same id, same pallets_occupied) and billing rows are unchanged, even though stock grew in between', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const contractId = await insertContract(clientId);
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await insertActiveAllocation(contractId, clientId, blockId, '10.000');
    for (let i = 0; i < 12; i += 1) {
      await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);
    }

    await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() }, deps);
    const firstSnapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(firstSnapshot?.pallets_occupied).toBe('12.000');
    const st01RowsFirst = await getBillableEventsForSnapshot((firstSnapshot as { id: string }).id, st01ServiceId);
    expect(st01RowsFirst).toHaveLength(1);
    const st12RowsFirst = await getBillableEventsForSnapshot((firstSnapshot as { id: string }).id, st12ServiceId);
    expect(st12RowsFirst).toHaveLength(1);
    expect(st12RowsFirst[0]?.qty).toBe('2.000');

    // stock for the SAME client changes after the first snapshot — a new receipt into the SAME
    // block, which would push pallets_occupied to 15 (excess 5) if it were reflected.
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);

    await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() }, deps);
    const secondSnapshot = await getSnapshot(clientId, warehouseId, blockId);

    // pure no-op (D1 corrected): same id, same pallets_occupied — the new stock is NOT reflected.
    expect(secondSnapshot?.id).toBe(firstSnapshot?.id);
    expect(secondSnapshot?.pallets_occupied).toBe('12.000');

    const st01RowsSecond = await getBillableEventsForSnapshot((firstSnapshot as { id: string }).id, st01ServiceId);
    expect(st01RowsSecond).toHaveLength(1);
    expect(st01RowsSecond[0]?.qty).toBe('12.000'); // unchanged, not 15.
    const st12RowsSecond = await getBillableEventsForSnapshot((firstSnapshot as { id: string }).id, st12ServiceId);
    expect(st12RowsSecond).toHaveLength(1);
    expect(st12RowsSecond[0]?.qty).toBe('2.000'); // unchanged, not 5.
  });
});

// --- Scenario: re-running after the contracted allocation itself shrank ----------------------------
//
// Round-3 review finding 1: the stock-change re-run test above cannot tell the round-2 fix apart
// from the pre-fix code — with only stock changed, `contracted` is read fresh but unchanged (10),
// so the frozen 12 vs 10 still yields the SAME overflow of 2, and the ST-12 row already written by
// the first run blocks a duplicate via billable_events' own unique index. This scenario changes the
// CONTRACTED ALLOCATION instead: the first run is within capacity (12 vs 15 -> NO ST-12 row exists),
// the allocation then shrinks to 10, and the re-run would see overflow(12, 10) = 2 with NO existing
// ST-12 row to block an insert. Only the round-2 fix ("a re-run writes no billing rows of any kind")
// keeps ST-12 at zero rows here. Round-3 finding 2: the re-run's own RESULT must agree with what
// was written — clientsInOverflow 0, not a freshly recomputed 1.

describe('Scenario: Re-running the snapshot for an already-taken day after the contracted allocation shrank writes no overflow row (round-3 finding 1/2)', () => {
  it('first run 12 occupied vs 15 contracted -> no ST-12; allocation cut to 10; re-run writes no ST-12, leaves ST-01 at 12, leaves the snapshot row unchanged, and reports clientsInOverflow 0', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const contractId = await insertContract(clientId);
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const allocationId = await insertActiveAllocation(contractId, clientId, blockId, '15.000');
    for (let i = 0; i < 12; i += 1) {
      await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);
    }

    // First run — within capacity (12 <= 15): ST-01 qty 12, NO ST-12 row.
    const first = await takeOccupancySnapshot(
      roleCtx,
      { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() },
      deps,
    );
    expect(first.clientsSnapshotted).toBe(1);
    expect(first.clientsInOverflow).toBe(0);

    const firstSnapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(firstSnapshot).not.toBeNull();
    expect(firstSnapshot?.pallets_occupied).toBe('12.000');
    const firstSnapshotId = (firstSnapshot as { id: string }).id;

    const st01RowsFirst = await getBillableEventsForSnapshot(firstSnapshotId, st01ServiceId);
    expect(st01RowsFirst).toHaveLength(1);
    expect(st01RowsFirst[0]?.qty).toBe('12.000');
    expect(await getBillableEventsForSnapshot(firstSnapshotId, st12ServiceId)).toHaveLength(0);

    // Between the runs: the client's contracted capacity for that block shrinks 15 -> 10 (still
    // active, still covering SNAPSHOT_DATE). A fresh read now gives overflow(12, 10) = 2.
    const shrink: QueryResult = await pool.query(
      `update wms.space_allocations set qty = $2::numeric where id = $1`,
      [allocationId, '10.000'],
    );
    expect(shrink.rowCount).toBe(1);

    // Second run — SAME warehouse and date, no Idempotency-Key (the natural-key no-op is under test).
    const second = await takeOccupancySnapshot(
      roleCtx,
      { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() },
      deps,
    );

    // The snapshot row is the first run's own row, untouched.
    const secondSnapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(secondSnapshot?.id).toBe(firstSnapshotId);
    expect(secondSnapshot?.pallets_occupied).toBe('12.000');
    expect(await getSnapshotsForClient(clientId, warehouseId)).toHaveLength(1);

    // Round-2 fix regression: still NO ST-12 row (pre-fix code wrote one with qty 2 here).
    expect(await getBillableEventsForSnapshot(firstSnapshotId, st12ServiceId)).toHaveLength(0);
    const st01RowsSecond = await getBillableEventsForSnapshot(firstSnapshotId, st01ServiceId);
    expect(st01RowsSecond).toHaveLength(1);
    expect(st01RowsSecond[0]?.id).toBe(st01RowsFirst[0]?.id);
    expect(st01RowsSecond[0]?.qty).toBe('12.000');
    const allBillable: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from billing.billable_events where client_id = $1`,
      [clientId],
    );
    expect(Number(allBillable.rows[0]?.n ?? '0')).toBe(1);

    // Round-3 finding 2: the re-run's result reflects what stands, not a fresh recomputation.
    expect(second.clientsSnapshotted).toBe(1);
    expect(second.clientsInOverflow).toBe(0);
  });
});

// round-4 finding 1: the shrink test above only exercises the "no ST-12 row exists" direction of
// hasBillableEvent's re-run branch. This mirrors it in the OPPOSITE direction — an ST-12 row DOES
// exist from the first run, and the allocation is later RAISED (no longer technically over) — to
// confirm the re-run still reports clientsInOverflow: 1, matching the ST-12 row that still stands
// (a re-run never retracts a charge any more than it adds one).
describe('Scenario: Re-running the snapshot for an already-taken day after the contracted allocation grew still reports the existing overflow row (round-4 finding 1)', () => {
  it('first run 12 occupied vs 10 contracted -> ST-12 qty 2, clientsInOverflow 1; allocation raised to 15; re-run leaves ST-12 at qty 2 and still reports clientsInOverflow 1', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const contractId = await insertContract(clientId);
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    const allocationId = await insertActiveAllocation(contractId, clientId, blockId, '10.000');
    for (let i = 0; i < 12; i += 1) {
      await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);
    }

    // First run — over capacity (12 > 10): ST-01 qty 12, ST-12 qty 2, clientsInOverflow 1.
    const first = await takeOccupancySnapshot(
      roleCtx,
      { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() },
      deps,
    );
    expect(first.clientsSnapshotted).toBe(1);
    expect(first.clientsInOverflow).toBe(1);

    const firstSnapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(firstSnapshot).not.toBeNull();
    const firstSnapshotId = (firstSnapshot as { id: string }).id;

    const st12RowsFirst = await getBillableEventsForSnapshot(firstSnapshotId, st12ServiceId);
    expect(st12RowsFirst).toHaveLength(1);
    expect(st12RowsFirst[0]?.qty).toBe('2.000');

    // Between the runs: the client's contracted capacity for that block GROWS 10 -> 15 (still
    // active, still covering SNAPSHOT_DATE). A fresh read now gives overflow(12, 15) = 0 — the
    // client is no longer technically over. The already-standing ST-12 row must NOT be retracted.
    const grow: QueryResult = await pool.query(
      `update wms.space_allocations set qty = $2::numeric where id = $1`,
      [allocationId, '15.000'],
    );
    expect(grow.rowCount).toBe(1);

    // Second run — SAME warehouse and date, no Idempotency-Key.
    const second = await takeOccupancySnapshot(
      roleCtx,
      { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() },
      deps,
    );

    // The snapshot row is the first run's own row, untouched.
    const secondSnapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(secondSnapshot?.id).toBe(firstSnapshotId);
    expect(await getSnapshotsForClient(clientId, warehouseId)).toHaveLength(1);

    // The existing ST-12 row is untouched — same row, same qty, not retracted.
    const st12RowsSecond = await getBillableEventsForSnapshot(firstSnapshotId, st12ServiceId);
    expect(st12RowsSecond).toHaveLength(1);
    expect(st12RowsSecond[0]?.id).toBe(st12RowsFirst[0]?.id);
    expect(st12RowsSecond[0]?.qty).toBe('2.000');
    const allBillable: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from billing.billable_events where client_id = $1`,
      [clientId],
    );
    expect(Number(allBillable.rows[0]?.n ?? '0')).toBe(2); // ST-01 + ST-12, both from the first run only.

    // Round-4 finding 1: the re-run's result still reflects the ST-12 row that stands, not the
    // now-passing fresh comparison.
    expect(second.clientsSnapshotted).toBe(1);
    expect(second.clientsInOverflow).toBe(1);
  });
});

// --- Scenario: locations_used counts every location type -------------------------------------------

describe('Scenario: locations_used counts every location type, not just pallet-type', () => {
  it('pallets_occupied 2, locations_used 3 (2 pallet + 1 shelf), all in the same block', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId, 'pallet');
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId, 'pallet');
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId, 'shelf');

    await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() }, deps);

    const snapshot = await getSnapshot(clientId, warehouseId, blockId);
    expect(snapshot?.pallets_occupied).toBe('2.000');
    expect(snapshot?.locations_used).toBe(3);
  });
});

// --- Scenario: a client occupying two different blocks gets two snapshot rows ----------------------

describe('Scenario: A client occupying two different blocks gets two snapshot rows', () => {
  it('two occupancy_snapshots rows exist, one per block, each with independently evaluated overflow', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const contractId = await insertContract(clientId);

    const blockA = await insertSpaceBlock(warehouseId, zoneId);
    const blockB = await insertSpaceBlock(warehouseId, zoneId);
    // block A: within capacity (5 occupied vs 10 contracted). block B: over capacity (8 occupied vs 3 contracted).
    await insertActiveAllocation(contractId, clientId, blockA, '10.000');
    await insertActiveAllocation(contractId, clientId, blockB, '3.000');
    for (let i = 0; i < 5; i += 1) {
      await seedOccupiedLocation(clientId, warehouseId, zoneId, blockA);
    }
    for (let i = 0; i < 8; i += 1) {
      await seedOccupiedLocation(clientId, warehouseId, zoneId, blockB);
    }

    const result = await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() }, deps);

    // round-1 finding 1 regression: ONE client occupying TWO blocks (hence two snapshot rows) must
    // be counted as ONE distinct client in the command's result, not once per row.
    expect(result.clientsSnapshotted).toBe(1);
    expect(result.clientsInOverflow).toBe(1); // the client is over capacity in block B only.

    const rows = await getSnapshotsForClient(clientId, warehouseId);
    expect(rows).toHaveLength(2);

    const snapshotA = await getSnapshot(clientId, warehouseId, blockA);
    const snapshotB = await getSnapshot(clientId, warehouseId, blockB);
    expect(snapshotA).not.toBeNull();
    expect(snapshotB).not.toBeNull();
    expect(snapshotA?.pallets_occupied).toBe('5.000');
    expect(snapshotB?.pallets_occupied).toBe('8.000');
    // round-1 review finding 5: the two snapshot rows are genuinely distinct rows, not the same
    // row read twice.
    expect((snapshotA as { id: string }).id).not.toBe((snapshotB as { id: string }).id);

    // round-1 review finding 5: an ST-01 row exists for EACH block, with that block's own qty, and
    // each row's own source_id traces back to that specific block's snapshot row (never shared) —
    // getBillableEventsForSnapshot itself filters by source_id, so a non-empty, correctly-qty'd
    // result for each block's OWN snapshot id is already proof the source_id is that block's own.
    const st01RowsA = await getBillableEventsForSnapshot((snapshotA as { id: string }).id, st01ServiceId);
    expect(st01RowsA).toHaveLength(1);
    expect(st01RowsA[0]?.qty).toBe('5.000');
    expect(st01RowsA[0]?.source_id).toBe((snapshotA as { id: string }).id);

    const st01RowsB = await getBillableEventsForSnapshot((snapshotB as { id: string }).id, st01ServiceId);
    expect(st01RowsB).toHaveLength(1);
    expect(st01RowsB[0]?.qty).toBe('8.000');
    expect(st01RowsB[0]?.source_id).toBe((snapshotB as { id: string }).id);

    const st12RowsA = await getBillableEventsForSnapshot((snapshotA as { id: string }).id, st12ServiceId);
    expect(st12RowsA).toHaveLength(0); // block A within its own 10-pallet capacity.

    const st12RowsB = await getBillableEventsForSnapshot((snapshotB as { id: string }).id, st12ServiceId);
    expect(st12RowsB).toHaveLength(1); // block B: 8 occupied - 3 contracted = 5 excess.
    expect(st12RowsB[0]?.qty).toBe('5.000');
    expect(st12RowsB[0]?.source_id).toBe((snapshotB as { id: string }).id);
  });
});

// --- Scenario: role gate --------------------------------------------------------------------------

describe('Scenario: Role gate', () => {
  it('RoleRequiredError (422) for a caller holding only WH_SUP; nothing is written', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);

    const correlationId = nextCorrelationId();
    await expect(
      takeOccupancySnapshot(whSupOnlyCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    expect(await getSnapshotsForClient(clientId, warehouseId)).toHaveLength(0);
    // round-1 review finding 7: "nothing is written" means nothing in EITHER table this command
    // touches, and no audit trail for the rejected call — not just the snapshot table.
    const billableResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from billing.billable_events where client_id = $1`,
      [clientId],
    );
    expect(Number(billableResult.rows[0]?.n ?? '0')).toBe(0);
    expect(await auditRowCountForCorrelation(correlationId)).toBe(0);
  });
});

// --- Scenario: an audit row is written once per call ------------------------------------------------

describe('Scenario: An audit row is written once per call', () => {
  it('exactly one platform.audit_log row for the correlation_id, aggregate wms.occupancy_snapshots — even with two clients', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientA = await insertClient();
    const clientB = await insertClient();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await seedOccupiedLocation(clientA, warehouseId, zoneId, blockId);
    await seedOccupiedLocation(clientB, warehouseId, zoneId, blockId);

    const correlationId = nextCorrelationId();
    await takeOccupancySnapshot(roleCtx, { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId }, deps);

    expect(await auditRowCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: idempotent replay ------------------------------------------------------------------

describe('Scenario: Idempotent replay', () => {
  // round-1 review finding 6: since the command is ALSO naturally idempotent via D1/D5 (a second
  // identical call recomputes the same result even without any Idempotency-Key mechanism at all
  // per this slice's now-corrected no-op semantics), the OLD version of this test could not tell
  // "replay short-circuited" apart from "recomputation happened to match". Fix: change the
  // underlying stock BETWEEN the two calls carrying the SAME Idempotency-Key — if the replay
  // genuinely short-circuits (never re-executes the body), the second call's result must still
  // equal the first, ignoring the stock that changed in between. A body that runs twice would
  // instead see clientsSnapshotted differ once a NEW client is added between the calls.
  it('TakeOccupancySnapshot twice with the same Idempotency-Key: stock changes (a NEW client with stock) between the two calls, yet the second call returns the exact first result, proving it replayed rather than recomputed', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);

    const idempotencyKey = randomUUID();
    const body = { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() };
    const idem = idemFor('take-occupancy-snapshot', idempotencyKey, body);

    const first = await takeOccupancySnapshot(roleCtx, { ...body, idem }, deps);
    expect(first.clientsSnapshotted).toBe(1);

    // stock changes between the two calls: a SECOND client starts occupying the same warehouse —
    // if the second call actually recomputed, clientsSnapshotted would become 2.
    const secondClientId = await insertClient();
    await seedOccupiedLocation(secondClientId, warehouseId, zoneId, blockId);

    const second = await takeOccupancySnapshot(roleCtx, { ...body, idem }, deps);

    expect(second).toEqual(first); // replayed, not recomputed against the new client's stock.
    expect(second.clientsSnapshotted).toBe(1);
    // the second client's occupancy was never actually snapshotted by the replayed call.
    expect(await getSnapshotsForClient(secondClientId, warehouseId)).toHaveLength(0);
  });

  it('the same Idempotency-Key with a DIFFERENT body -> IdempotencyConflictError', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const clientId = await insertClient();
    const blockId = await insertSpaceBlock(warehouseId, zoneId);
    await seedOccupiedLocation(clientId, warehouseId, zoneId, blockId);

    const idempotencyKey = randomUUID();
    const body = { warehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: nextCorrelationId() };
    const idem = idemFor('take-occupancy-snapshot', idempotencyKey, body);
    await takeOccupancySnapshot(roleCtx, { ...body, idem }, deps);

    const differentBody = { ...body, correlationId: nextCorrelationId() };
    const differentIdem = idemFor('take-occupancy-snapshot', idempotencyKey, differentBody);
    await expect(
      takeOccupancySnapshot(roleCtx, { ...differentBody, idem: differentIdem }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
