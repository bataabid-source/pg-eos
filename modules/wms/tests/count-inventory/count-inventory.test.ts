// modules/wms/tests/count-inventory/count-inventory.test.ts — WBS 2.13 (lane 2).
//
// Integration tests, one per scenario in ./count-inventory.feature, against the real database as
// pgeos_app. Sources: docs/notes/slice-briefs/_slice-2.13.brief.md (Facts/D1-D8, verbatim),
// doc 40 INV-C3-7, .claude/briefs/wms.brief.md.
//
// Binding behaviour this suite asserts (RED until pg-backend builds
// modules/wms/{domain,application,infrastructure,api}/count-inventory/**):
//   - StartCount(ctx, { warehouseId, countType, locationIds?, skuIds?, clientId?, correlationId },
//     deps) inserts ONE wms.inventory_counts row (status 'in_progress', version 1 — no separate
//     "create" command exists, so StartCount both creates the row and starts it in one call — brief
//     D1/D6) plus one wms.inventory_count_lines row per (location, sku, batch_no) combination
//     currently holding non-zero wms.stock_balance in the target warehouse, each with qty_system
//     FROZEN from stock_balance and qty_counted null (D6). No expectedVersion on the input — there
//     is no prior row to have read a version from (Contract section, brief).
//   - CountLocation(ctx, { lineId, qtyCounted, correlationId }, deps) and
//     Recount(ctx, { lineId, recountQty, correlationId }, deps) each return ONLY
//     { lineId, recorded: true } — NEVER qtySystem/variance/recountQty/the original qtyCounted (D2,
//     the blind-count contract). Neither takes expectedVersion (D3) — guarded instead by the
//     line's own state (AlreadyCountedError / NotFlaggedForRecountError) under a lock on the
//     PARENT count row.
//   - in_progress -> review fires automatically the moment every line of the count has
//     qty_counted set (D1); review -> recount fires automatically the first time Recount is called
//     on a variant line; recount -> review fires automatically once every variant line has
//     recount_qty set (D1).
//   - AdjustCount(ctx, { countId, expectedVersion, correlationId }, deps) — WH_MGR ONLY (D4) —
//     iterates every line where the FINAL quantity (recount_qty ?? qty_counted) differs from
//     qty_system, posts ONE 'adjust' stock_movements row per such line via postMovementInTx
//     (ref_table 'wms.inventory_count_lines', ref_id = line.id — D5), sets
//     line.adjusted_movement_id, and moves the count to 'adjusted'. A line with zero final
//     variance is skipped — no movement posted for it (D5).
//   - No new outbox event for the count's own status transitions — only 'wms.stock.moved',
//     already catalogued, fires per AdjustCount-posted movement (D8); every count-level state
//     change still gets an audit_log row (G9).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as
// modules/wms/tests/receive-inbound/receive-inbound.test.ts (the golden slice) and
// modules/hr/tests/maintain-shift/maintain-shift.test.ts. PG_APP_USER=pgeos_app is REQUIRED to run
// this suite (every command call goes through withContext(ctx, fn) as pgeos_app, genuinely subject
// to RLS). platform.audit_log rows are NEVER deleted.
//
// wms.inventory_count_lines carries NO entity_id column (brief Facts — RLS internal_only, the same
// known gap wms.order_lines has, accepted at 2.9); every access to a line goes through the
// application layer's own join to its parent count row — this file's admin-pool queries are
// read-only fixture assertions, never a substitute for that RLS.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test — do not exist yet (RED).
import { adjustCount, countLocation, recount, startCount } from '../../application/count-inventory/index.js';
import { createCountInventoryDeps } from '../../api/count-inventory/composition.js';
import {
  AlreadyCountedError,
  CountNotFoundError,
  IllegalTransitionError,
  LineNotFoundError,
  NotFlaggedForRecountError,
  RecountRequiredError,
  RoleRequiredError,
  StaleVersionError,
  WarehouseNotFoundError,
} from '../../domain/count-inventory/errors.js';
// pg-reviewer finding 8 (slice-close round 1): stock is seeded through a REAL 'receipt' movement
// via the module's own public postMovement (never wms.stock_balance inserted directly) — same
// pattern modules/wms/tests/integration/stock-ledger.test.ts uses for its own fixtures. This is
// the ONLY way this suite is allowed to put stock on the ledger; a direct wms.stock_balance
// INSERT leaves a ledgerless balance row and fails guard G1 (wms.verify_balance_integrity()).
import { postMovement, type LedgerDeps } from '../../index.js';
// the package subpath export (@pg-eos/contracts/wms/count-inventory), not a deep relative path —
// packages/contracts/package.json's own `exports` map already carries this entry.
import { CountLocationInputSchema, StartCountInputSchema } from '@pg-eos/contracts/wms/count-inventory';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// pgeos_app-role pool, present for parity with the golden slice's own fixture pattern even though
// no scenario in this suite exercises cross-entity RLS visibility directly (unlike 2.9's OUTSIDER
// scenario) — kept so a later slice-close round adding one does not need to introduce the pool.
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// --- literals --------------------------------------------------------------------------------

const WH_MGR_ROLE_CODE = 'WH_MGR';
const WH_SUP_ROLE_CODE = 'WH_SUP';
const WH_OP_ROLE_CODE = 'WH_OP';
const STOCK_MOVED_EVENT_TYPE = 'wms.stock.moved';
const ADJUST_MOVEMENT_TYPE = 'adjust';
const REF_TABLE_COUNT_LINES = 'wms.inventory_count_lines';
const COUNT_TYPE_FULL = 'full';
const DEFAULT_QTY_ON_HAND = '10.000';
const RECEIPT_MOVEMENT_TYPE = 'receipt';
const DEFAULT_SEED_UOM = 'EA';
// finding 9 coverage: a NON-default uom, so a fixture seeded with it proves AdjustCount's posted
// movement copies the SOURCE stock_movements row's uom rather than a hardcoded value.
const NON_DEFAULT_SEED_UOM = 'CTN';

// WH_MGR alone (D4: StartCount -> WH_MGR|WH_SUP, CountLocation/Recount -> any of the three,
// AdjustCount -> WH_MGR only — so WH_MGR alone covers every command this ctx drives). WH_MGR is
// not SoD-paired with anything (identity.sod_rules, 13B:617-655); WH_OP/WH_SUP IS a paired pair
// ("الملتقط لا يدقّق التقاطه", 13B:634) and must never be granted to the same identity.users row.
const ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000213a1'; // WH_MGR only.
const WH_SUP_ONLY_ACTOR_UUID = '00000000-0000-4000-8000-0000000213a2';
const WH_OP_ONLY_ACTOR_UUID = '00000000-0000-4000-8000-0000000213a3';
// finding 6: an OUTSIDER whose ONLY entity differs from this suite's fixture entity (PST) — never
// granted access to `entityId` at all. Also granted WH_MGR (covers every command's role gate) so
// every rejection this actor triggers below is genuinely about entity scoping, not role.
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000213a4';
// finding 7a: a caller holding NO warehouse role at all (identity.user_roles row-less).
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000213a5';

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(213);
const deps = createCountInventoryDeps({ clock, ids });
// A separate SequentialIdGenerator seed (finding 8's fixture-seeding deps) — distinct from `ids`
// above (213) so the two never draw the same id from the same counter.
const ledgerDeps: LedgerDeps = { clock, ids: new SequentialIdGenerator(21300) };

const roleCtx = { userId: ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const whSupOnlyCtx = { userId: WH_SUP_ONLY_ACTOR_UUID, clientId: null, isInternal: true };
const whOpOnlyCtx = { userId: WH_OP_ONLY_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
// finding 6: any entity OTHER than `entityId` (this suite's own PST fixture entity), for the
// OUTSIDER cross-entity isolation scenarios.
let outsiderEntityId: string;
let fixtureClientId: string;
const fixtureClientCode = `_cntinv_fixture_${randomUUID()}`;
const fixtureWarehouseIds: string[] = [];
const fixtureZoneIds: string[] = [];
const fixtureLocationIds: string[] = [];
const fixtureSkuIds: string[] = [];
const fixtureCountIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `wms.count-inventory.${endpoint}`,
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
    [userId, `_cntinv_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار جرد المخزون — WBS 2.13'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

/** A dedicated warehouse + zone, so "full" count snapshots are deterministic — never WH1, which
 *  other suites (receive-inbound) also write stock to. */
async function createFixtureWarehouse(): Promise<{ warehouseId: string; zoneId: string }> {
  const whResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [entityId, `_CNTINV_WH_${randomUUID()}`, 'مستودع اختبار جرد المخزون'],
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
// location_type in ('pallet','shelf')). 9 aisles * 100 positions * 9 levels = 8,100 unique codes,
// far more than any fixture in this suite needs.
let locationCodeCounter = 0;
function nextLocationCode(): string {
  const n = locationCodeCounter;
  locationCodeCounter += 1;
  const level = (n % 9) + 1;
  const position = Math.floor(n / 9) % 100;
  const aisle = (Math.floor(n / 900) % 9) + 1;
  return `P${aisle}-${String(position).padStart(2, '0')}-${level}`;
}

async function insertLocation(warehouseId: string, zoneId: string, code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.locations (warehouse_id, zone_id, code, location_type) values ($1, $2, $3, 'shelf') returning id`,
    [warehouseId, zoneId, code],
  );
  const id = (result.rows[0] as { id: string }).id;
  fixtureLocationIds.push(id);
  return id;
}

async function insertSku(code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, '1.000', '0.00100') returning id`,
    [fixtureClientId, code, `صنف اختبار جرد المخزون ${code}`],
  );
  fixtureSkuIds.push((result.rows[0] as { id: string }).id);
  return (result.rows[0] as { id: string }).id;
}

/** pg-reviewer finding 8: seeds stock through a REAL 'receipt' movement via the module's own
 *  public `postMovement` (../../index.js) — never a direct wms.stock_balance INSERT, which leaves
 *  a ledgerless balance row and fails guard G1. Same call shape as
 *  modules/wms/tests/integration/stock-ledger.test.ts's own fixture seeding. `roleCtx`/
 *  `ROLE_ACTOR_UUID` already carry a real identity.users/user_entities row for `entityId`
 *  (createFixtureActor in beforeAll), which is what `postMovement`'s own `withContext` needs. */
async function seedStockViaReceipt(
  skuId: string,
  locationId: string,
  qtyOnHand: string = DEFAULT_QTY_ON_HAND,
  uom: string = DEFAULT_SEED_UOM,
): Promise<void> {
  await postMovement(
    roleCtx,
    {
      entityId,
      entry: {
        clientId: fixtureClientId,
        skuId,
        fromLocationId: null,
        toLocationId: locationId,
        qty: Quantity.of(qtyOnHand),
        batchNo: '',
        movementType: RECEIPT_MOVEMENT_TYPE,
        uom,
      },
      correlationId: nextCorrelationId(),
      performedBy: ROLE_ACTOR_UUID,
    },
    ledgerDeps,
  );
}

/** N locations, each with its own SKU and a REAL 'receipt' movement of `qtyOnHand` posted to it
 *  (finding 8) — so a "full" count of this warehouse produces exactly N lines, in
 *  `locationIds[i]`/`skuIds[i]` order. */
async function buildCountFixture(
  n: number,
  qtyOnHand: string = DEFAULT_QTY_ON_HAND,
): Promise<{ warehouseId: string; locationIds: string[]; skuIds: string[] }> {
  const { warehouseId, zoneId } = await createFixtureWarehouse();
  const locationIds: string[] = [];
  const skuIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const tag = randomUUID();
    const locationId = await insertLocation(warehouseId, zoneId, nextLocationCode());
    const skuId = await insertSku(`CNTINV-${i}-${tag}`);
    await seedStockViaReceipt(skuId, locationId, qtyOnHand);
    locationIds.push(locationId);
    skuIds.push(skuId);
  }
  return { warehouseId, locationIds, skuIds };
}

async function getCount(countId: string): Promise<{ status: string; version: number }> {
  const result: QueryResult<{ status: string; version: number }> = await pool.query(
    `select status, version from wms.inventory_counts where id = $1`,
    [countId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.inventory_counts row for id ${countId}`);
  return row;
}

// round-3 finding 1: a plain correlation-id count (this file's earlier, now-removed helper) also
// matches the LINE-level audit row
// recount() always writes for the same correlationId (repository.ts's writeAuditRow with target
// 'line'), so it stays > 0 even when the COUNT-level row is the one missing — the exact round-2
// defect this test exists to catch. This narrows to the count's own row specifically:
// schema_name/table_name = wms.inventory_counts, record_id = the count's own id.
async function countLevelAuditCountForCorrelation(correlationId: string, countId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log
      where correlation_id = $1 and schema_name = 'wms' and table_name = 'inventory_counts' and record_id = $2`,
    [correlationId, countId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

interface CountLineRow {
  readonly id: string;
  readonly location_id: string;
  readonly sku_id: string;
  readonly qty_system: string;
  readonly qty_counted: string | null;
  readonly recount_qty: string | null;
  readonly variance_reason: string | null;
  readonly adjusted_movement_id: string | null;
}

/** ordered by the FIXTURE-created location code, so lines line up with buildCountFixture's own
 *  locationIds[]/skuIds[] arrays. */
async function getLinesForCount(countId: string): Promise<CountLineRow[]> {
  const result: QueryResult<CountLineRow> = await pool.query(
    `select cl.id, cl.location_id, cl.sku_id, cl.qty_system::text as qty_system,
            cl.qty_counted::text as qty_counted, cl.recount_qty::text as recount_qty,
            cl.variance_reason, cl.adjusted_movement_id::text as adjusted_movement_id
       from wms.inventory_count_lines cl
       join wms.locations l on l.id = cl.location_id
      where cl.count_id = $1
      order by l.code`,
    [countId],
  );
  return result.rows;
}

async function countRowsForWarehouse(warehouseId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.inventory_counts where warehouse_id = $1`,
    [warehouseId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function movementsForLine(lineId: string): Promise<
  Array<{ movement_type: string; qty: string; from_location_id: string | null; to_location_id: string | null }>
> {
  const result: QueryResult<{
    movement_type: string;
    qty: string;
    from_location_id: string | null;
    to_location_id: string | null;
  }> = await pool.query(
    `select movement_type, qty::text as qty, from_location_id::text as from_location_id, to_location_id::text as to_location_id
       from wms.stock_movements where ref_table = $1 and ref_id = $2`,
    [REF_TABLE_COUNT_LINES, lineId],
  );
  return result.rows;
}

async function getStockOnHand(skuId: string, locationId: string): Promise<string> {
  const result: QueryResult<{ qty_on_hand: string }> = await pool.query(
    `select qty_on_hand::text as qty_on_hand from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = ''`,
    [fixtureClientId, skuId, locationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.stock_balance row for sku ${skuId} / location ${locationId}`);
  return row.qty_on_hand;
}

async function outboxRowsForCorrelationAndType(correlationId: string, eventType: string): Promise<Array<{ id: string }>> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id::text as id from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

/** Drives StartCount for a fresh N-location fixture warehouse via the command under test (never a
 *  fixture shortcut). Returns the count id/version plus its lines in fixture order. */
async function startFixtureCount(
  n: number,
  qtyOnHand: string = DEFAULT_QTY_ON_HAND,
): Promise<{ countId: string; version: number; warehouseId: string; lines: CountLineRow[] }> {
  const fixture = await buildCountFixture(n, qtyOnHand);
  const result = await startCount(
    roleCtx,
    { warehouseId: fixture.warehouseId, countType: COUNT_TYPE_FULL, correlationId: nextCorrelationId() },
    deps,
  );
  fixtureCountIds.push(result.id);
  const lines = await getLinesForCount(result.id);
  return { countId: result.id, version: result.version, warehouseId: fixture.warehouseId, lines };
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  // finding 6: an entity OTHER than `entityId`, for the OUTSIDER isolation scenarios.
  const outsiderEntityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where id <> $1 limit 1`,
    [entityId],
  );
  const outsiderEntityRow = outsiderEntityResult.rows[0];
  if (!outsiderEntityRow) throw new Error('expected at least 2 rows in platform.entities (finding 6 fixture)');
  outsiderEntityId = outsiderEntityRow.id;

  await createFixtureActor(ROLE_ACTOR_UUID, [entityId]);
  await createFixtureActor(WH_SUP_ONLY_ACTOR_UUID, [entityId]);
  await createFixtureActor(WH_OP_ONLY_ACTOR_UUID, [entityId]);
  await createFixtureActor(OUTSIDER_ACTOR_UUID, [outsiderEntityId]); // NEVER granted `entityId`.
  await createFixtureActor(NO_ROLE_ACTOR_UUID, [entityId]);
  await grantRole(ROLE_ACTOR_UUID, WH_MGR_ROLE_CODE);
  await grantRole(WH_SUP_ONLY_ACTOR_UUID, WH_SUP_ROLE_CODE);
  await grantRole(WH_OP_ONLY_ACTOR_UUID, WH_OP_ROLE_CODE);
  // finding 6: WH_MGR covers every command's own role gate, so every rejection OUTSIDER triggers
  // below is genuinely about entity scoping (RLS), never about a missing role.
  await grantRole(OUTSIDER_ACTOR_UUID, WH_MGR_ROLE_CODE);
  // NO_ROLE_ACTOR_UUID (finding 7a) deliberately gets no identity.user_roles row at all.

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [fixtureClientCode, 'عميل اختبار جرد المخزون'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  // inventory_count_lines.adjusted_movement_id FKs to stock_movements — lines (and their parent
  // counts) must go BEFORE stock_movements/stock_balance are deleted, not after.
  if (fixtureCountIds.length > 0) {
    await pool.query(`delete from wms.inventory_count_lines where count_id = any($1::uuid[])`, [fixtureCountIds]);
    await pool.query(`delete from wms.inventory_counts where id = any($1::uuid[])`, [fixtureCountIds]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
  }
  if (fixtureSkuIds.length > 0) await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  if (fixtureLocationIds.length > 0) {
    await pool.query(`delete from wms.locations where id = any($1::uuid[])`, [fixtureLocationIds]);
  }
  if (fixtureZoneIds.length > 0) await pool.query(`delete from wms.zones where id = any($1::uuid[])`, [fixtureZoneIds]);
  if (fixtureWarehouseIds.length > 0) {
    await pool.query(`delete from wms.warehouses where id = any($1::uuid[])`, [fixtureWarehouseIds]);
  }
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  for (const userId of [
    ROLE_ACTOR_UUID,
    WH_SUP_ONLY_ACTOR_UUID,
    WH_OP_ONLY_ACTOR_UUID,
    OUTSIDER_ACTOR_UUID,
    NO_ROLE_ACTOR_UUID,
  ]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
  await appPool.end();
});

// --- contract stub (package subpath import) ----------------------------------------------------

describe('@pg-eos/contracts/wms/count-inventory — StartCountInputSchema has no expectedVersion/performedBy', () => {
  it('StartCountInputSchema accepts { warehouseId, countType, correlationId } with no performedBy/expectedVersion field', () => {
    const parsed = StartCountInputSchema.parse({
      warehouseId: randomUUID(),
      countType: COUNT_TYPE_FULL,
      correlationId: randomUUID(),
    });
    expect(parsed.countType).toBe(COUNT_TYPE_FULL);
    expect('performedBy' in parsed).toBe(false);
    expect('expectedVersion' in parsed).toBe(false);
  });

  it('CountLocationInputSchema accepts { lineId, qtyCounted, correlationId } with no expectedVersion field (D3)', () => {
    const parsed = CountLocationInputSchema.parse({
      lineId: randomUUID(),
      qtyCounted: '7.000',
      correlationId: randomUUID(),
    });
    expect(parsed.qtyCounted).toBe('7.000');
    expect('expectedVersion' in parsed).toBe(false);
  });
});

// --- Scenario: Start a full count ----------------------------------------------------------------

describe('Scenario: Start a full count', () => {
  it('one wms.inventory_counts row exists with status "in_progress", version 1, and one line per (location, sku) holding non-zero stock, qty_system frozen and qty_counted null', async () => {
    const fixture = await buildCountFixture(3);
    const result = await startCount(
      roleCtx,
      { warehouseId: fixture.warehouseId, countType: COUNT_TYPE_FULL, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCountIds.push(result.id);
    expect(result.version).toBe(1);

    const row = await getCount(result.id);
    expect(row.status).toBe('in_progress');
    expect(row.version).toBe(1);

    const lines = await getLinesForCount(result.id);
    expect(lines).toHaveLength(3);
    for (const [index, line] of lines.entries()) {
      expect(line.location_id).toBe(fixture.locationIds[index]);
      expect(line.sku_id).toBe(fixture.skuIds[index]);
      expect(line.qty_system).toBe(DEFAULT_QTY_ON_HAND);
      expect(line.qty_counted).toBeNull();
    }
  });
});

// --- Scenario: A counter records a count without seeing the system quantity ----------------------

describe('Scenario: A counter records a count without seeing the system quantity', () => {
  it('the response carries ONLY { lineId, recorded: true } — no qtySystem/variance/recountQty field — and qty_counted is set', async () => {
    const { lines } = await startFixtureCount(2); // 2 lines -> stays "in_progress" after counting one.
    const targetLine = lines[0] as CountLineRow;

    const result = await countLocation(
      roleCtx,
      { lineId: targetLine.id, qtyCounted: '7.000', correlationId: nextCorrelationId() },
      deps,
    );

    expect(result).toEqual({ lineId: targetLine.id, recorded: true });
    expect('qtySystem' in result).toBe(false);
    expect('variance' in result).toBe(false);
    expect('recountQty' in result).toBe(false);

    const lineRow: QueryResult<{ qty_counted: string | null }> = await pool.query(
      `select qty_counted::text as qty_counted from wms.inventory_count_lines where id = $1`,
      [targetLine.id],
    );
    expect(lineRow.rows[0]?.qty_counted).toBe('7.000');
  });
});

// --- Scenario: Counting the same location twice is rejected --------------------------------------

describe('Scenario: Counting the same location twice is rejected', () => {
  it('AlreadyCountedError (422), the line stays unchanged', async () => {
    const { lines } = await startFixtureCount(2);
    const targetLine = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: targetLine.id, qtyCounted: '10.000', correlationId: nextCorrelationId() }, deps);

    await expect(
      countLocation(roleCtx, { lineId: targetLine.id, qtyCounted: '5.000', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(AlreadyCountedError);

    const lineRow: QueryResult<{ qty_counted: string | null }> = await pool.query(
      `select qty_counted::text as qty_counted from wms.inventory_count_lines where id = $1`,
      [targetLine.id],
    );
    expect(lineRow.rows[0]?.qty_counted).toBe('10.000'); // unchanged by the rejected second call.
  });
});

// --- Scenario: Completing every line moves the count to review -----------------------------------

describe('Scenario: Completing every line moves the count to review', () => {
  it('counting the LAST open line moves the count to "review" and bumps its version', async () => {
    const { countId, version, lines } = await startFixtureCount(2);
    const [lineA, lineB] = lines as [CountLineRow, CountLineRow];
    await countLocation(roleCtx, { lineId: lineA.id, qtyCounted: '10.000', correlationId: nextCorrelationId() }, deps);
    expect((await getCount(countId)).status).toBe('in_progress'); // one line still open.

    await countLocation(roleCtx, { lineId: lineB.id, qtyCounted: '10.000', correlationId: nextCorrelationId() }, deps);

    const after = await getCount(countId);
    expect(after.status).toBe('review');
    expect(after.version).toBeGreaterThan(version);
  });
});

// --- Scenario: A variant line requires a mandatory recount ----------------------------------------

describe('Scenario: A variant line requires a mandatory recount', () => {
  it('Recount on a variant line, with ANOTHER variant line still awaiting, moves the count to "recount"; the response carries no qtySystem/variance/original qtyCounted', async () => {
    const { countId, lines } = await startFixtureCount(2);
    const [lineA, lineB] = lines as [CountLineRow, CountLineRow];
    // TWO variant lines (8 != system 10, 9 != system 10) — completing both moves the count to
    // "review" (D1: in_progress -> review fires once every line is counted, regardless of
    // variance). Recounting only ONE of the two leaves the count on "recount" (finding 2: the
    // count returns to "review" only once EVERY variant line has been recounted — a count with a
    // SINGLE variant line would instead land back on "review" in this same call; see the
    // dedicated "Finding 2" describe block below for that case).
    await countLocation(roleCtx, { lineId: lineA.id, qtyCounted: '8.000', correlationId: nextCorrelationId() }, deps);
    await countLocation(roleCtx, { lineId: lineB.id, qtyCounted: '9.000', correlationId: nextCorrelationId() }, deps);
    expect((await getCount(countId)).status).toBe('review');

    const result = await recount(
      roleCtx,
      { lineId: lineA.id, recountQty: '8.000', correlationId: nextCorrelationId() },
      deps,
    );

    expect(result).toEqual({ lineId: lineA.id, recorded: true });
    expect('qtySystem' in result).toBe(false);
    expect('variance' in result).toBe(false);
    expect('qtyCounted' in result).toBe(false);

    expect((await getCount(countId)).status).toBe('recount'); // lineB is still awaiting its own recount.
  });
});

// --- Scenario: Recounting a line with no variance is rejected -------------------------------------

describe('Scenario: Recounting a line with no variance is rejected', () => {
  it('NotFlaggedForRecountError (422) for a line whose qty_counted equals qty_system', async () => {
    const { lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: DEFAULT_QTY_ON_HAND, correlationId: nextCorrelationId() }, deps);

    await expect(
      recount(roleCtx, { lineId: line.id, recountQty: DEFAULT_QTY_ON_HAND, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(NotFlaggedForRecountError);
  });
});

// --- Scenario: All variant lines recounted returns the count to review -----------------------------

describe('Scenario: All variant lines recounted returns the count to review', () => {
  it('recounting the LAST awaiting variant line moves the count back to "review"', async () => {
    const { countId, lines } = await startFixtureCount(2);
    const [lineA, lineB] = lines as [CountLineRow, CountLineRow];
    // Both lines variant (8/9 != system 10) so both need recounting.
    await countLocation(roleCtx, { lineId: lineA.id, qtyCounted: '8.000', correlationId: nextCorrelationId() }, deps);
    await countLocation(roleCtx, { lineId: lineB.id, qtyCounted: '9.000', correlationId: nextCorrelationId() }, deps);
    expect((await getCount(countId)).status).toBe('review');

    await recount(roleCtx, { lineId: lineA.id, recountQty: '8.000', correlationId: nextCorrelationId() }, deps);
    expect((await getCount(countId)).status).toBe('recount'); // one variant line still awaiting.

    await recount(roleCtx, { lineId: lineB.id, recountQty: '9.000', correlationId: nextCorrelationId() }, deps);
    expect((await getCount(countId)).status).toBe('review'); // both variant lines now recounted.
  });
});

// --- Scenario: Adjustment posts a stock movement and closes the gap --------------------------------

describe('Scenario: Adjustment posts a stock movement and closes the gap', () => {
  it('AdjustCount posts one "adjust" outflow movement for a shortfall line, updates stock_balance, sets adjusted_movement_id, and moves the count to "adjusted" — AFTER the mandatory recount (finding 1)', async () => {
    const { countId, version, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    // qty_counted 7 != qty_system 10 -> a variant line -> INV-C3-7's mandatory recount (finding 1)
    // must happen before AdjustCount will accept the count; the recount CONFIRMS the shortfall
    // (recount_qty 7, same as qty_counted), so the final quantity is still 7 < qty_system 10.
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '7.000', correlationId: nextCorrelationId() }, deps);
    expect((await getCount(countId)).status).toBe('review');
    await recount(roleCtx, { lineId: line.id, recountQty: '7.000', correlationId: nextCorrelationId() }, deps);
    const afterCount = await getCount(countId);
    // a single variant line: the one Recount call above lands the count straight back on
    // "review" in the same transaction (finding 2) — never observably stuck on "recount".
    expect(afterCount.status).toBe('review');

    const result = await adjustCount(
      roleCtx,
      { countId, expectedVersion: afterCount.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('adjusted');
    expect(result.version).toBeGreaterThan(afterCount.version);
    expect(result.version).toBeGreaterThan(version);

    const movements = await movementsForLine(line.id);
    expect(movements).toHaveLength(1);
    const movement = movements[0]!;
    expect(movement.movement_type).toBe(ADJUST_MOVEMENT_TYPE);
    expect(movement.qty).toBe('3.000'); // abs(7 - 10).
    expect(movement.from_location_id).toBe(line.location_id); // shortfall -> outflow (D5).
    expect(movement.to_location_id).toBeNull();

    expect(await getStockOnHand(line.sku_id, line.location_id)).toBe('7.000'); // 10 - 3.

    const refreshedLine: QueryResult<{ adjusted_movement_id: string | null }> = await pool.query(
      `select adjusted_movement_id::text as adjusted_movement_id from wms.inventory_count_lines where id = $1`,
      [line.id],
    );
    expect(refreshedLine.rows[0]?.adjusted_movement_id).not.toBeNull();
  });
});

// --- Scenario: A line with zero final variance is not adjusted --------------------------------------

describe('Scenario: A line with zero final variance is not adjusted', () => {
  it('AdjustCount moves the count to "adjusted" but posts no wms.stock_movements row when every final quantity equals qty_system', async () => {
    const { countId, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: DEFAULT_QTY_ON_HAND, correlationId: nextCorrelationId() }, deps);
    const afterCount = await getCount(countId);
    expect(afterCount.status).toBe('review');

    const result = await adjustCount(
      roleCtx,
      { countId, expectedVersion: afterCount.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('adjusted');
    expect(await movementsForLine(line.id)).toHaveLength(0);
  });
});

// --- Scenario: AdjustCount by a non-WH_MGR is rejected ------------------------------------------------

describe('Scenario: AdjustCount by a non-WH_MGR is rejected', () => {
  it('RoleRequiredError (422) for a caller holding only WH_SUP; nothing is written', async () => {
    const { countId, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '7.000', correlationId: nextCorrelationId() }, deps);
    const before = await getCount(countId);
    expect(before.status).toBe('review');

    await expect(
      adjustCount(whSupOnlyCtx, { countId, expectedVersion: before.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    const after = await getCount(countId);
    expect(after.status).toBe('review'); // unchanged.
    expect(after.version).toBe(before.version);
  });
});

// --- Scenario: AdjustCount before review is rejected --------------------------------------------------

describe('Scenario: AdjustCount before review is rejected', () => {
  it('IllegalTransitionError (422) while the count is still "in_progress"', async () => {
    const { countId, version } = await startFixtureCount(2); // 2 open lines -> stays "in_progress".

    await expect(
      adjustCount(roleCtx, { countId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    expect((await getCount(countId)).status).toBe('in_progress');
  });
});

// --- Scenario: A stale expectedVersion on AdjustCount is rejected --------------------------------------

describe('Scenario: A stale expectedVersion on AdjustCount is rejected', () => {
  it('StaleVersionError (409), no column written', async () => {
    const { countId, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '7.000', correlationId: nextCorrelationId() }, deps);
    const before = await getCount(countId);
    expect(before.status).toBe('review');

    await expect(
      adjustCount(roleCtx, { countId, expectedVersion: before.version + 999, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(StaleVersionError);

    const after = await getCount(countId);
    expect(after.status).toBe('review');
    expect(after.version).toBe(before.version);
    expect(await movementsForLine(line.id)).toHaveLength(0);
  });
});

// --- Scenario: Role gates on StartCount ---------------------------------------------------------------

describe('Scenario: Role gates on StartCount', () => {
  it('RoleRequiredError (422) for a caller holding only WH_OP; nothing is written', async () => {
    const fixture = await buildCountFixture(1);

    await expect(
      startCount(
        whOpOnlyCtx,
        { warehouseId: fixture.warehouseId, countType: COUNT_TYPE_FULL, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    expect(await countRowsForWarehouse(fixture.warehouseId)).toBe(0);
  });
});

// --- Scenario: Idempotent replay ------------------------------------------------------------------------

describe('Scenario: Idempotent replay', () => {
  it('StartCount twice with the same Idempotency-Key and body: one count exists, the second call returns the first result', async () => {
    const fixture = await buildCountFixture(1);
    const idempotencyKey = randomUUID();
    const body = { warehouseId: fixture.warehouseId, countType: COUNT_TYPE_FULL, correlationId: nextCorrelationId() };
    const idem = idemFor('start-count', idempotencyKey, body);

    const first = await startCount(roleCtx, { ...body, idem }, deps);
    fixtureCountIds.push(first.id);
    const second = await startCount(roleCtx, { ...body, idem }, deps);

    expect(second).toEqual(first);
    expect(await countRowsForWarehouse(fixture.warehouseId)).toBe(1);
  });

  it('the same Idempotency-Key with a DIFFERENT body -> IdempotencyConflictError', async () => {
    const fixture = await buildCountFixture(1);
    const idempotencyKey = randomUUID();
    const body = { warehouseId: fixture.warehouseId, countType: COUNT_TYPE_FULL, correlationId: nextCorrelationId() };
    const idem = idemFor('start-count', idempotencyKey, body);
    const first = await startCount(roleCtx, { ...body, idem }, deps);
    fixtureCountIds.push(first.id);

    const differentBody = { ...body, correlationId: nextCorrelationId() };
    const differentIdem = idemFor('start-count', idempotencyKey, differentBody);
    await expect(
      startCount(roleCtx, { ...differentBody, idem: differentIdem }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- D8: no outbox event of the count's own; 'wms.stock.moved' still fires per adjustment ------------

describe('D8: the count transitions write no event of their own — only wms.stock.moved, per adjustment', () => {
  it('AdjustCount writes exactly one wms.stock.moved outbox row for the one variant line', async () => {
    const { countId, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '7.000', correlationId: nextCorrelationId() }, deps);
    // finding 1: the variant line must be recounted before AdjustCount accepts the count.
    await recount(roleCtx, { lineId: line.id, recountQty: '7.000', correlationId: nextCorrelationId() }, deps);
    const before = await getCount(countId);

    const adjustCorrelationId = nextCorrelationId();
    await adjustCount(roleCtx, { countId, expectedVersion: before.version, correlationId: adjustCorrelationId }, deps);

    const movedRows = await outboxRowsForCorrelationAndType(adjustCorrelationId, STOCK_MOVED_EVENT_TYPE);
    expect(movedRows).toHaveLength(1);
  });
});

// --- Finding 6: cross-entity isolation — an OUTSIDER scoped to a DIFFERENT entity -----------------

describe('Finding 6: cross-entity isolation — an OUTSIDER whose only entity differs from the fixture entity', () => {
  it('CountLocation on the main entity\'s line from the outsider -> LineNotFoundError, the line stays unchanged', async () => {
    const { lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;

    await expect(
      countLocation(outsiderCtx, { lineId: line.id, qtyCounted: '5.000', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(LineNotFoundError);

    const row: QueryResult<{ qty_counted: string | null }> = await pool.query(
      `select qty_counted::text as qty_counted from wms.inventory_count_lines where id = $1`,
      [line.id],
    );
    expect(row.rows[0]?.qty_counted).toBeNull();
  });

  it('AdjustCount on the main entity\'s count from the outsider -> CountNotFoundError', async () => {
    const { countId, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '7.000', correlationId: nextCorrelationId() }, deps);
    const before = await getCount(countId);

    await expect(
      adjustCount(outsiderCtx, { countId, expectedVersion: before.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(CountNotFoundError);

    const after = await getCount(countId);
    expect(after.status).toBe('review'); // unchanged by the rejected outsider call.
  });

  it('StartCount targeting the main entity\'s warehouse from the outsider -> WarehouseNotFoundError (422) once finding 11 lands — nothing is written', async () => {
    const fixture = await buildCountFixture(1);

    // brief coordination note (finding 6/11): wms.warehouses is `reference_read` (cross-entity
    // readable by RLS itself), so the entity-scoping barrier for StartCount is an APPLICATION
    // check on the resolved entity_id against platform.allowed_entities() — finding 11's fix.
    // Until that fix lands this assertion is RED (see the fix-round report for which error the
    // command currently throws instead).
    await expect(
      startCount(
        outsiderCtx,
        { warehouseId: fixture.warehouseId, countType: COUNT_TYPE_FULL, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(WarehouseNotFoundError);

    expect(await countRowsForWarehouse(fixture.warehouseId)).toBe(0);
  });
});

// --- Finding 7a: WH_OP alone counts; a caller with no warehouse role at all is rejected -----------

describe('Finding 7a: WH_OP alone can run CountLocation/Recount; a caller with NO warehouse role is rejected', () => {
  it('WH_OP alone can call CountLocation successfully', async () => {
    const { lines } = await startFixtureCount(2);
    const line = lines[0] as CountLineRow;

    const result = await countLocation(
      whOpOnlyCtx,
      { lineId: line.id, qtyCounted: '5.000', correlationId: nextCorrelationId() },
      deps,
    );

    expect(result).toEqual({ lineId: line.id, recorded: true });
  });

  it('WH_OP alone can call Recount on a variant line', async () => {
    const { lines } = await startFixtureCount(2);
    const [lineA, lineB] = lines as [CountLineRow, CountLineRow];
    await countLocation(roleCtx, { lineId: lineA.id, qtyCounted: '8.000', correlationId: nextCorrelationId() }, deps);
    await countLocation(roleCtx, { lineId: lineB.id, qtyCounted: '10.000', correlationId: nextCorrelationId() }, deps);

    const result = await recount(
      whOpOnlyCtx,
      { lineId: lineA.id, recountQty: '8.000', correlationId: nextCorrelationId() },
      deps,
    );

    expect(result).toEqual({ lineId: lineA.id, recorded: true });
  });

  it('a caller with NO warehouse role at all is rejected with RoleRequiredError on CountLocation; the line stays unchanged', async () => {
    const { lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;

    await expect(
      countLocation(noRoleCtx, { lineId: line.id, qtyCounted: '5.000', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    const row: QueryResult<{ qty_counted: string | null }> = await pool.query(
      `select qty_counted::text as qty_counted from wms.inventory_count_lines where id = $1`,
      [line.id],
    );
    expect(row.rows[0]?.qty_counted).toBeNull();
  });

  it('a caller with NO warehouse role at all is rejected with RoleRequiredError on Recount', async () => {
    const { lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '7.000', correlationId: nextCorrelationId() }, deps);

    await expect(
      recount(noRoleCtx, { lineId: line.id, recountQty: '7.000', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);
  });
});

// --- Finding 1/2: mandatory recount before adjustment; single-variant-line recount -----------------

describe('Finding 1: AdjustCount with an un-recounted variant line is rejected (INV-C3-7 mandatory recount)', () => {
  it('RecountRequiredError (422) when a variant line was counted but never recounted; nothing is written', async () => {
    const { countId, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '8.000', correlationId: nextCorrelationId() }, deps); // variant, never recounted.
    const before = await getCount(countId);
    expect(before.status).toBe('review');

    await expect(
      adjustCount(roleCtx, { countId, expectedVersion: before.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RecountRequiredError);

    const after = await getCount(countId);
    expect(after.status).toBe('review'); // unchanged.
    expect(after.version).toBe(before.version);
    expect(await movementsForLine(line.id)).toHaveLength(0);
  });
});

describe('Finding 2: a single-variant-line recount returns the count directly to "review", never stuck on "recount"', () => {
  it('a count with exactly one variant line: the one Recount call lands the count back on "review" in the same transaction', async () => {
    const { countId, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '8.000', correlationId: nextCorrelationId() }, deps); // variant: 8 != 10.
    const before = await getCount(countId);
    expect(before.status).toBe('review');

    const recountCorrelationId = nextCorrelationId();
    await recount(roleCtx, { lineId: line.id, recountQty: '8.000', correlationId: recountCorrelationId }, deps);

    const after = await getCount(countId);
    expect(after.status).toBe('review'); // review -> recount -> review, in one call.
  });

  // round-2 finding 1: round-1's test above only asserted the STATUS nets to the same value —
  // that let a missing audit_log row slip through, since status(before) === status(after) does not
  // by itself prove a write ever happened. G9's general rule ("every count-level state change gets
  // an audit_log row", brief D8) applies EVEN WHEN the status ends where it started: review ->
  // recount -> review is still two edges fired (FLAG_RECOUNT then RECOUNT_COMPLETE) inside the one
  // Recount call, and each edge is a state change that must be audited.
  it('recounting the LAST variant line writes a platform.audit_log row for the count, even though status(before) === status(after) === "review"', async () => {
    const { countId, lines } = await startFixtureCount(1);
    const line = lines[0] as CountLineRow;
    await countLocation(roleCtx, { lineId: line.id, qtyCounted: '8.000', correlationId: nextCorrelationId() }, deps); // variant: 8 != 10.
    const before = await getCount(countId);
    expect(before.status).toBe('review');

    const recountCorrelationId = nextCorrelationId();
    await recount(roleCtx, { lineId: line.id, recountQty: '8.000', correlationId: recountCorrelationId }, deps);

    const after = await getCount(countId);
    expect(after.status).toBe('review'); // nets to the same value as `before` ...
    expect(after.version).toBe(before.version + 1); // ... but the row genuinely changed (version bumped) ...
    // ... and the COUNT's own row was audited — not just the line's (round-3 finding 1: a plain
    // correlation-id count would also pass via the line-level audit row alone, hiding a missing
    // count-level row).
    expect(await countLevelAuditCountForCorrelation(recountCorrelationId, countId)).toBe(1);
  });
});

// --- Finding 12: StartCount on a warehouse with zero matching stock -------------------------------

describe('Finding 12: StartCount on a warehouse with zero matching stock lands directly in "review" with zero lines', () => {
  it('an empty warehouse (no stock_balance rows) starts already in "review", zero lines', async () => {
    const { warehouseId } = await createFixtureWarehouse(); // no locations/stock seeded at all.

    const result = await startCount(
      roleCtx,
      { warehouseId, countType: COUNT_TYPE_FULL, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCountIds.push(result.id);

    expect(result.status).toBe('review');
    const row = await getCount(result.id);
    expect(row.status).toBe('review');
    expect(await getLinesForCount(result.id)).toHaveLength(0);
  });
});

// --- Finding 10: StartCount with a clientId filter only snapshots that client's SKUs --------------

describe('Finding 10: StartCount with a clientId filter only snapshots that client\'s SKUs, not other clients\' (same warehouse)', () => {
  it('two clients share a warehouse; StartCount scoped to clientId A snapshots only A\'s line', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const locationA = await insertLocation(warehouseId, zoneId, nextLocationCode());
    const locationB = await insertLocation(warehouseId, zoneId, nextLocationCode());
    const skuA = await insertSku(`CNTINV-CLIENTA-${randomUUID()}`); // client = fixtureClientId.
    await seedStockViaReceipt(skuA, locationA, DEFAULT_QTY_ON_HAND);

    // A second, distinct client + sku in the SAME warehouse.
    const otherClientResult: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
      [`_cntinv_fixture_other_${randomUUID()}`, 'عميل آخر اختبار جرد المخزون'],
    );
    const otherClientId = (otherClientResult.rows[0] as { id: string }).id;
    const otherSkuResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
       values ($1, $2, $3, '1.000', '0.00100') returning id`,
      [otherClientId, `CNTINV-CLIENTB-${randomUUID()}`, 'صنف عميل آخر اختبار جرد المخزون'],
    );
    const otherSkuId = (otherSkuResult.rows[0] as { id: string }).id;
    // round-2 finding 5: this test's own extra client/sku are outside fixtureClientId's afterAll
    // cleanup scope, so its cleanup must run even if an assertion below throws — try/finally,
    // never an inline cleanup after the assertions (which never runs on failure and leaves
    // orphaned rows, the same class of problem round-1 finding 8 required manual cleanup for).
    try {
      await postMovement(
        roleCtx,
        {
          entityId,
          entry: {
            clientId: otherClientId,
            skuId: otherSkuId,
            fromLocationId: null,
            toLocationId: locationB,
            qty: Quantity.of(DEFAULT_QTY_ON_HAND),
            batchNo: '',
            movementType: RECEIPT_MOVEMENT_TYPE,
            uom: DEFAULT_SEED_UOM,
          },
          correlationId: nextCorrelationId(),
          performedBy: ROLE_ACTOR_UUID,
        },
        ledgerDeps,
      );

      const result = await startCount(
        roleCtx,
        { warehouseId, countType: COUNT_TYPE_FULL, clientId: fixtureClientId, correlationId: nextCorrelationId() },
        deps,
      );
      fixtureCountIds.push(result.id);

      const lines = await getLinesForCount(result.id);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.sku_id).toBe(skuA);
    } finally {
      await pool.query(`delete from wms.stock_movements where client_id = $1`, [otherClientId]);
      await pool.query(`delete from wms.stock_balance where client_id = $1`, [otherClientId]);
      await pool.query(`delete from wms.skus where id = $1`, [otherSkuId]);
      await pool.query(`delete from sales.accounts where id = $1`, [otherClientId]);
    }
  });
});

// --- Finding 9: AdjustCount's movement uom matches the SOURCE stock_movements row's uom -----------

describe('Finding 9: AdjustCount posts its movement with the uom of the SOURCE stock_movements row, never a hardcoded default', () => {
  it('a receipt seeded with uom "CTN" produces an "adjust" movement also uom "CTN"', async () => {
    const { warehouseId, zoneId } = await createFixtureWarehouse();
    const locationId = await insertLocation(warehouseId, zoneId, nextLocationCode());
    const skuId = await insertSku(`CNTINV-UOM-${randomUUID()}`);
    await seedStockViaReceipt(skuId, locationId, DEFAULT_QTY_ON_HAND, NON_DEFAULT_SEED_UOM);

    const started = await startCount(
      roleCtx,
      { warehouseId, countType: COUNT_TYPE_FULL, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCountIds.push(started.id);
    const [line] = await getLinesForCount(started.id);
    const targetLine = line as CountLineRow;

    await countLocation(roleCtx, { lineId: targetLine.id, qtyCounted: '7.000', correlationId: nextCorrelationId() }, deps);
    await recount(roleCtx, { lineId: targetLine.id, recountQty: '7.000', correlationId: nextCorrelationId() }, deps);
    const afterCount = await getCount(started.id);

    await adjustCount(
      roleCtx,
      { countId: started.id, expectedVersion: afterCount.version, correlationId: nextCorrelationId() },
      deps,
    );

    const movementResult: QueryResult<{ uom: string }> = await pool.query(
      `select uom from wms.stock_movements where ref_table = $1 and ref_id = $2`,
      [REF_TABLE_COUNT_LINES, targetLine.id],
    );
    expect(movementResult.rows[0]?.uom).toBe(NON_DEFAULT_SEED_UOM);
  });
});
