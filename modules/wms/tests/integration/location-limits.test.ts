// modules/wms/tests/integration/location-limits.test.ts — WBS 2.4 (pg-tester), written RED-first
// on 2026-09-24 against the slice brief's Master design defaults D1-D5, then fixed twice against
// pg-reviewer findings (fix round 1: fixture SKUs across the module needed a location-limit-safe
// gross_weight_kg/volume_cbm; fix round 2, THIS revision: F1/F3/F4/F5/F6/F7 plus the scope
// decision below), ahead of modules/wms/src/stock-ledger/{errors,domain,post-movement}.ts gaining
// location-limit enforcement. Follows the Gherkin in ./location-limits.feature scenario-by-
// scenario. Fixture/RLS pattern copied from modules/wms/tests/integration/stock-ledger.test.ts
// (identity.users + identity.user_entities via the admin pool, pgeos_app under RLS, superuser-only
// cleanup of the append-only wms.stock_movements table, platform.audit_log rows are never
// deleted).
//
// Database facts this suite exercises, all already in 019-Warehouse-WH1-Setup.sql (no migration
// here — D5): wms.locations.max_weight_kg / max_volume_cbm are set on all 3,153 storage locations
// (1,000 kg + 1.76175 cbm on every 'pallet' location, 750 kg + 0.97200 cbm on every 'shelf'
// location — 019:236-245); wms.check_location_limits(p_location, p_weight, p_volume)
// (019:343-365) raises when the location is blocked, or p_weight/p_volume exceeds the location's
// max — a hard barrier, no warning (19 §3-3).
//
// Master decision, fix round 2 finding 9 (SCOPE): weight and volume limits (D1/D3) apply ONLY to
// storage locations (location_type 'pallet' and 'shelf'), per 19 §3-3. Operational locations
// (location_type 'operational', e.g. RCV-1) are NOT weight/volume-checked, even though 019 also
// happens to set max_weight_kg = 1000 on them (019:281-295) — that column is simply unused for
// enforcement on that type. The blocked check applies to every location type.
//
// Expected new surface (this suite is RED until it exists), named here so the build brief can
// quote it verbatim:
//   - `LocationLimitExceededError` / `LocationBlockedError` (modules/wms/src/stock-ledger/
//     errors.ts) — same contract as fix round 1.
//   - `evaluateLocationLimits` (modules/wms/src/stock-ledger/domain.ts) — the PURE decision
//     function fix round 2 finding 7 requires; see modules/wms/tests/unit/
//     location-limits.domain.test.ts for its full contract and property tests. postMovement/
//     postTransfer call it (via a DB read of the location + current load), in the SAME
//     transaction, before the ledger insert, for every entry that ADDS stock to a location
//     (toLocationId not null — D1), restricted to 'pallet'/'shelf' for the weight/volume branch,
//     every type for the blocked branch. On rejection: no ledger row, no balance change, no
//     outbox row, no audit row (D2) — and for postTransfer, NEITHER side is written (atomic).
//   - concurrency (D4): the builder serialises per location (e.g. a transaction advisory lock
//     keyed on the location id) so two concurrent put-aways into the same location that together
//     exceed the limit never both pass.

import { randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The module under test. `LocationLimitExceededError`/`LocationBlockedError` do not exist yet —
// this import itself is expected to fail to resolve those two names until the builder adds them
// to modules/wms/src/stock-ledger/errors.ts and re-exports them from index.ts (same barrel
// stock-ledger.test.ts imports NegativeStockError/MovementNotFoundError from).
import {
  LocationBlockedError,
  LocationLimitExceededError,
  postMovement,
  postTransfer,
  reverseMovement,
  type LedgerDeps,
  type LedgerEntry,
} from '../../index.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// --- literals, each cited to the schema fact or decision they come from ------------------------

// 019-Warehouse-WH1-Setup.sql:236 ("قسم P — المنصات · 6 مستويات · 1,000 كجم · 1.76175 م³") and
// platform.settings 'pallet_max_weight_kg' (019:328).
const PALLET_MAX_WEIGHT_KG = 1000;
const PALLET_MAX_VOLUME_CBM = 1.76175;
// 019-Warehouse-WH1-Setup.sql:239-245 ("أقسام G · M · T — الرفوف · 3 مستويات · 750 كجم ·
// 0.97200 م³") and platform.settings 'shelf_max_weight_kg' (019:334).
const SHELF_MAX_WEIGHT_KG = 750;
const SHELF_MAX_VOLUME_CBM = 0.972;
// 019-Warehouse-WH1-Setup.sql:283-287: every WH1 operational location also happens to carry
// max_weight_kg = 1000, but the scope decision above means it must never be enforced there.
const OPERATIONAL_STORED_MAX_WEIGHT_KG = 1000;

// Test-data weights/volumes, named so no bare literal below reads as a schema/business number —
// chosen so the arithmetic against the two constants above is obvious.
const LIGHT_WEIGHT_KG = '10.000'; // trivially under either limit, for the "accepted" scenario.
const OVER_PALLET_WEIGHT_KG = '1500.000'; // alone exceeds PALLET_MAX_WEIGHT_KG.
const OVER_SHELF_WEIGHT_KG = '900.000'; // under pallet's 1,000 but over shelf's 750.
const BULKY_VOLUME_CBM = '2.00000'; // exceeds PALLET_MAX_VOLUME_CBM, weight kept light.
const BULKY_ITEM_WEIGHT_KG = '5.000';
const RESULTING_LOAD_HEADROOM_FRACTION_A = 0.7; // first receipt: 70% of remaining headroom.
const RESULTING_LOAD_HEADROOM_FRACTION_B = 0.5; // second: alone fits (<100% of headroom)...
// ...but A (70%) + B (50%) = 120% of headroom, so combined they exceed the limit (D2).
const CONCURRENT_EACH_FRACTION = 0.6; // each of two concurrent put-aways: 60% of headroom alone
// fits, but 2 x 60% = 120% together exceeds the limit (D4).

// F3 (transfer atomicity): the destination is preloaded to within DEST_PRELOAD_BUFFER_KG of its
// max — a buffer strictly smaller than LIGHT_WEIGHT_KG (10 kg, the moved SKU's weight) — so the
// transfer's incoming leg alone pushes it over, while the SAME quantity would trivially fit an
// empty location (proving the rejection is about the destination's actual headroom, not the SKU).
const DEST_PRELOAD_BUFFER_KG = 5;
const TRANSFER_QTY = '1.000';
const SOURCE_STOCK_QTY = '5.000'; // 5 * LIGHT_WEIGHT_KG = 50 kg — trivial for a shelf source.

// F5 (cross-client resulting load): client X fills a location to within CROSS_CLIENT_BUFFER_KG of
// its max; client Y's own SKU (CROSS_CLIENT_Y_SKU_WEIGHT_KG) is heavier than that buffer, so ITS
// put-away alone (a different client, a different SKU) is what is rejected — proving D2's "all
// clients and SKUs" resulting-load rule.
const CROSS_CLIENT_BUFFER_KG = 5;
const CROSS_CLIENT_Y_SKU_WEIGHT_KG = '10.000';

// F1 (reversing a pick that no longer fits): fractions of the location's remaining headroom, kept
// distinct from the other fraction constants above so this scenario's arithmetic is self-
// contained and traceable.
const REVERSAL_INITIAL_RECEIPT_FRACTION = 0.5; // first receipt: half of headroom.
const REVERSAL_PICK_FRACTION = 0.4; // picked back out: 40% of the initial receipt.

const PERFORMED_BY_FIXTURE_UUID = '00000000-0000-4000-8000-0000000204a1';
const ctx = { userId: PERFORMED_BY_FIXTURE_UUID, clientId: null, isInternal: true };

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(204);
const deps: LedgerDeps = { clock, ids };

interface LocationRow {
  id: string;
  code: string;
  location_type: string;
  max_weight_kg: string;
  max_volume_cbm: string | null;
  is_blocked: boolean;
}

let entityId: string;
let fixtureClientId: string;
let fixtureClientIdY: string; // F5: a SECOND fixture client, to prove the resulting load is
// summed across clients, not scoped to one.
const fixtureSkuIds: string[] = [];
const fixtureSkuIdsY: string[] = [];
let skuLight: string; // gross_weight_kg = LIGHT_WEIGHT_KG-scale, small volume
let skuNoWeight: string; // gross_weight_kg IS NULL (D3)
let skuBulkyVolume: string; // small weight, large volume_cbm (BULKY_VOLUME_CBM)
let skuOverPallet: string; // gross_weight_kg = OVER_PALLET_WEIGHT_KG
let skuOverShelf: string; // gross_weight_kg = OVER_SHELF_WEIGHT_KG
let skuUnitWeight: string; // gross_weight_kg = 1.000 — used with a computed qty for headroom tests
let skuWeightNoVolume: string; // F6: gross_weight_kg set, volume_cbm IS NULL
let skuClientY: string; // F5: fixtureClientIdY's own SKU, weight CROSS_CLIENT_Y_SKU_WEIGHT_KG

const fixtureClientCode = `_loclimit_fixture_${randomUUID()}`;
const fixtureClientCodeY = `_loclimit_fixture_y_${randomUUID()}`;
const usedCorrelationIds = new Set<string>();
let warehouseId: string;
// Every scenario picks its OWN, freshly-created WH1 zone/location (tracked here for afterAll
// cleanup, locations before zones for the FK) so that one scenario's incorrectly-accepted
// over-limit write, or a leaked row from ANY other test file/run, can never pollute another
// scenario's "current load" reading — each test is self-contained regardless of enforcement
// being present.
const fixtureZoneIds: string[] = [];
const fixtureLocationIds: string[] = [];

async function pickFreshWh1Location(
  locationType: 'pallet' | 'shelf' | 'operational',
): Promise<LocationRow> {
  return pickWh1Location(locationType);
}

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

async function insertSku(
  clientId: string,
  code: string,
  grossWeightKg: string | null,
  volumeCbm: string | null,
): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [clientId, code, `صنف اختبار حدود الموقع ${code}`, grossWeightKg, volumeCbm],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.skus insert returned no row');
  return row.id;
}

/**
 * D2: "the RESULTING total at the location: Sum over wms.stock_balance rows at that location (all
 * clients and SKUs)". Computed independently of the mechanism under test, directly from the DB,
 * so a test never has to assume a location starts at zero (real WH1 locations "may already hold
 * stock from other tests" — brief).
 */
async function currentLocationLoad(
  locationId: string,
): Promise<{ weightKg: number; volumeCbm: number }> {
  const result: QueryResult<{ weight_kg: string | null; volume_cbm: string | null }> =
    await pool.query(
      `select sum(sb.qty_on_hand * coalesce(s.gross_weight_kg, 0))::text as weight_kg,
              sum(sb.qty_on_hand * coalesce(s.volume_cbm, 0))::text as volume_cbm
         from wms.stock_balance sb
         join wms.skus s on s.id = sb.sku_id
        where sb.location_id = $1`,
      [locationId],
    );
  const row = result.rows[0];
  return {
    weightKg: Number(row?.weight_kg ?? '0'),
    volumeCbm: Number(row?.volume_cbm ?? '0'),
  };
}

// Same bug class as WBS 2.10's own finding 1 (handlers.test.ts/process-outbound.test.ts) and
// receive-inbound.test.ts's insertLocationInZone/pickFreshWh1Location fix: `select ... from
// wms.locations ... order by code desc limit 1` over the SHARED table can pick a real WH1
// production location OR another test file's leftover fixture row, and `order by code desc`
// means an orphaned high-sorting code is picked FIRST — a leaked no-weight-limit location
// sorting first defeats this suite's over-weight assertions. Fix (mirrors
// receive-inbound.test.ts's insertLocationInZone/randomM9FixtureLocationCode): this function
// creates its OWN dedicated zone + location under the 'M9-' code block
// (019-Warehouse-WH1-Setup.sql:59 chk_locations_code_format `^[PGMT][1-9]-[0-9]{2}-[1-9]$`,
// required only for location_type in ('pallet','shelf') — WH1's real layout uses
// P1-P3/G1-G5/M1-M5/T1-T5, 'M9-' is reserved for this file's own fixtures), claimed with
// `on conflict (warehouse_id, code) do nothing` so the table's own unique constraint — not
// generator ordering — arbitrates between concurrent/leaked rows, and set with the SAME
// max_weight_kg/max_volume_cbm the real WH1 seed carries for that location_type (the constants
// above), so every downstream assertion against PALLET_MAX_WEIGHT_KG/SHELF_MAX_WEIGHT_KG/
// OPERATIONAL_STORED_MAX_WEIGHT_KG still holds. Never selects an existing shared row.
const M9_FIXTURE_LOCATION_PREFIX = 'M9';
const M9_FIXTURE_LOCATION_SEQ_COUNT = 100; // the regex's `[0-9]{2}` segment: 00..99.
const M9_FIXTURE_LOCATION_LEVEL_COUNT = 9; // the regex's trailing `[1-9]` segment: 1..9.
const M9_FIXTURE_LOCATION_MAX_ATTEMPTS = 200;

function randomM9FixtureLocationCode(): string {
  const [seqByte = 0, levelByte = 0] = randomBytes(2);
  const seq = String(seqByte % M9_FIXTURE_LOCATION_SEQ_COUNT).padStart(2, '0');
  const level = (levelByte % M9_FIXTURE_LOCATION_LEVEL_COUNT) + 1;
  return `${M9_FIXTURE_LOCATION_PREFIX}-${seq}-${level}`;
}

async function insertM9FixtureZone(): Promise<string> {
  const code = `_loclimit_M9_zone_${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, $2, $3, 'storage') returning id`,
    [warehouseId, code, `منطقة اختبار حدود الموقع ${code}`],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.zones insert returned no row');
  fixtureZoneIds.push(row.id);
  return row.id;
}

async function pickWh1Location(
  locationType: 'pallet' | 'shelf' | 'operational',
): Promise<LocationRow> {
  const zoneId = await insertM9FixtureZone();
  const maxWeightKg =
    locationType === 'pallet'
      ? String(PALLET_MAX_WEIGHT_KG)
      : locationType === 'shelf'
        ? String(SHELF_MAX_WEIGHT_KG)
        : String(OPERATIONAL_STORED_MAX_WEIGHT_KG);
  const maxVolumeCbm =
    locationType === 'pallet' ? String(PALLET_MAX_VOLUME_CBM) : locationType === 'shelf' ? String(SHELF_MAX_VOLUME_CBM) : null;
  for (let attempt = 0; attempt < M9_FIXTURE_LOCATION_MAX_ATTEMPTS; attempt += 1) {
    const code = randomM9FixtureLocationCode();
    const result: QueryResult<LocationRow> = await pool.query(
      `insert into wms.locations (warehouse_id, zone_id, code, location_type, max_weight_kg, max_volume_cbm, is_blocked)
       values ($1, $2, $3, $4, $5::numeric, $6::numeric, false)
       on conflict (warehouse_id, code) do nothing
       returning id, code, location_type, max_weight_kg::text as max_weight_kg,
                 max_volume_cbm::text as max_volume_cbm, is_blocked`,
      [warehouseId, zoneId, code, locationType, maxWeightKg, maxVolumeCbm],
    );
    const row = result.rows[0];
    if (row) {
      fixtureLocationIds.push(row.id);
      return row;
    }
  }
  throw new Error(
    `no free ${M9_FIXTURE_LOCATION_PREFIX}-xx-x fixture location code after ${M9_FIXTURE_LOCATION_MAX_ATTEMPTS} attempts`,
  );
}

async function pickBlockedStructuralLocation(): Promise<LocationRow> {
  const result: QueryResult<LocationRow> = await pool.query(
    `select l.id, l.code, l.location_type, l.max_weight_kg::text as max_weight_kg,
            l.max_volume_cbm::text as max_volume_cbm, l.is_blocked
       from wms.locations l
       join wms.warehouses w on w.id = l.warehouse_id
      where w.code = 'WH1' and l.location_type = 'structural' and l.is_blocked = true
      limit 1`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('expected a blocked WH1 structural location (019 §7)');
  return row;
}

async function countStockMovements(clientId: string, skuId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.stock_movements where client_id = $1 and sku_id = $2`,
    [clientId, skuId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** F3: scoped to ONE location, so "no new row at either the source or the destination" can be
 *  checked independently for each side of a transfer. */
async function countStockMovementsAtLocation(
  clientId: string,
  skuId: string,
  locationId: string,
): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.stock_movements
      where client_id = $1 and sku_id = $2
        and (from_location_id = $3 or to_location_id = $3)`,
    [clientId, skuId, locationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function balanceQtyOnHand(clientId: string, skuId: string, locationId: string): Promise<number> {
  const result: QueryResult<{ qty_on_hand: string }> = await pool.query(
    `select qty_on_hand::text as qty_on_hand from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = ''`,
    [clientId, skuId, locationId],
  );
  return Number(result.rows[0]?.qty_on_hand ?? '0');
}

async function outboxCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.outbox where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** F4: every rejection scenario must assert no audit row was written either — same
 *  correlation_id convention stock-ledger.test.ts uses for its own audit assertions. */
async function auditCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** F4: the common shape every rejection scenario below asserts — nothing reached the outbox or
 *  the audit chain for the rejected attempt's correlation_id. */
async function expectNothingWrittenFor(correlationId: string): Promise<void> {
  expect(await outboxCountForCorrelation(correlationId)).toBe(0);
  expect(await auditCountForCorrelation(correlationId)).toBe(0);
}

function receiptEntry(
  clientId: string,
  skuId: string,
  toLocationId: string,
  qty: string,
): LedgerEntry {
  return {
    clientId,
    skuId,
    fromLocationId: null,
    toLocationId,
    qty: Quantity.of(qty),
    batchNo: '',
    movementType: 'receipt',
    uom: 'EA',
  };
}

async function postReceipt(
  clientId: string,
  skuId: string,
  toLocationId: string,
  qty: string,
): Promise<{ movementIds: readonly string[]; correlationId: string }> {
  const correlationId = nextCorrelationId();
  return postMovement(
    ctx,
    {
      entityId,
      entry: receiptEntry(clientId, skuId, toLocationId, qty),
      correlationId,
      performedBy: PERFORMED_BY_FIXTURE_UUID,
    },
    deps,
  );
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error('fixture entity PST not found in platform.entities');
  entityId = entityRow.id;

  const warehouseResult: QueryResult<{ id: string }> = await pool.query(
    `select id from wms.warehouses where code = 'WH1'`,
  );
  const warehouseRow = warehouseResult.rows[0];
  if (!warehouseRow) throw new Error('fixture warehouse WH1 not found in wms.warehouses');
  warehouseId = warehouseRow.id;

  // WBS 0.6a part 2 (D-133): postMovement/postTransfer run through withContext as pgeos_app, so
  // wms.stock_movements' entity_scope RLS policy applies — same fixture pattern as
  // stock-ledger.test.ts's beforeAll.
  await pool.query(`delete from identity.user_entities where user_id = $1`, [
    PERFORMED_BY_FIXTURE_UUID,
  ]);
  await pool.query(`delete from identity.users where id = $1`, [PERFORMED_BY_FIXTURE_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type)
     values ($1, $2, $3, 'internal')`,
    [
      PERFORMED_BY_FIXTURE_UUID,
      `_loclimit_fixture_actor_${randomUUID()}@test.invalid`,
      'ممثل اختبار حدود الموقع — WBS 2.4',
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
    [fixtureClientCode, 'عميل اختبار حدود الموقع — WBS 2.4'],
  );
  const clientRow = clientResult.rows[0];
  if (!clientRow) throw new Error('fixture sales.accounts insert returned no row');
  fixtureClientId = clientRow.id;

  // F5: a second fixture client, entirely separate from fixtureClientId.
  const clientResultY: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type)
     values ($1, $2, 'client') returning id`,
    [fixtureClientCodeY, 'عميل ثانٍ اختبار حدود الموقع — WBS 2.4'],
  );
  const clientRowY = clientResultY.rows[0];
  if (!clientRowY) throw new Error('fixture sales.accounts insert returned no row (client Y)');
  fixtureClientIdY = clientRowY.id;

  skuLight = await insertSku(fixtureClientId, `LOCLIM-LIGHT-${randomUUID()}`, LIGHT_WEIGHT_KG, '0.01000');
  skuNoWeight = await insertSku(fixtureClientId, `LOCLIM-NOWEIGHT-${randomUUID()}`, null, null);
  skuBulkyVolume = await insertSku(
    fixtureClientId,
    `LOCLIM-BULKY-${randomUUID()}`,
    BULKY_ITEM_WEIGHT_KG,
    BULKY_VOLUME_CBM,
  );
  skuOverPallet = await insertSku(
    fixtureClientId,
    `LOCLIM-OVERPALLET-${randomUUID()}`,
    OVER_PALLET_WEIGHT_KG,
    '0.01000',
  );
  skuOverShelf = await insertSku(
    fixtureClientId,
    `LOCLIM-OVERSHELF-${randomUUID()}`,
    OVER_SHELF_WEIGHT_KG,
    '0.01000',
  );
  skuUnitWeight = await insertSku(fixtureClientId, `LOCLIM-UNIT-${randomUUID()}`, '1.000', '0.00100');
  // F6: gross_weight_kg set, volume_cbm null — the "missing_volume" branch.
  skuWeightNoVolume = await insertSku(
    fixtureClientId,
    `LOCLIM-NOVOLUME-${randomUUID()}`,
    '1.000',
    null,
  );
  fixtureSkuIds.push(
    skuLight,
    skuNoWeight,
    skuBulkyVolume,
    skuOverPallet,
    skuOverShelf,
    skuUnitWeight,
    skuWeightNoVolume,
  );

  // F5: client Y's own SKU.
  skuClientY = await insertSku(
    fixtureClientIdY,
    `LOCLIM-CLIENTY-${randomUUID()}`,
    CROSS_CLIENT_Y_SKU_WEIGHT_KG,
    '0.01000',
  );
  fixtureSkuIdsY.push(skuClientY);
});

afterAll(async () => {
  if (fixtureClientId) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
  }
  if (fixtureClientIdY) {
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientIdY]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientIdY]);
  }
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [
      [...usedCorrelationIds],
    ]);
  }
  if (fixtureSkuIds.length > 0) {
    await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  }
  if (fixtureSkuIdsY.length > 0) {
    await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIdsY]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  }
  if (fixtureClientIdY) {
    await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientIdY]);
  }
  if (fixtureLocationIds.length > 0) {
    await pool.query(`delete from wms.locations where id = any($1::uuid[])`, [fixtureLocationIds]);
  }
  if (fixtureZoneIds.length > 0) {
    await pool.query(`delete from wms.zones where id = any($1::uuid[])`, [fixtureZoneIds]);
  }
  await pool.query(`delete from identity.user_entities where user_id = $1`, [
    PERFORMED_BY_FIXTURE_UUID,
  ]);
  await pool.query(`delete from identity.users where id = $1`, [PERFORMED_BY_FIXTURE_UUID]);
  await pool.end();
});

// --- Scenario: a put-away within the pallet limit is accepted -----------------------------------

describe('Scenario: a put-away within the pallet limit (1,000 kg) is accepted and the balance rises', () => {
  it('a put-away within the pallet limit (1,000 kg) is accepted and the balance rises', async () => {
    const location = await pickFreshWh1Location('pallet');
    const before = await balanceQtyOnHand(fixtureClientId, skuLight, location.id);

    const posted = await postReceipt(fixtureClientId, skuLight, location.id, '1.000');

    expect(posted.movementIds).toHaveLength(1);
    const after = await balanceQtyOnHand(fixtureClientId, skuLight, location.id);
    expect(after - before).toBeCloseTo(1, 3);
  });
});

// --- Scenario: an over-weight put-away onto a pallet location is rejected -----------------------

describe('Scenario: an over-weight put-away onto a pallet location is rejected', () => {
  it('an over-weight put-away onto a pallet location is rejected with LocationLimitExceededError and nothing is written', async () => {
    const location = await pickFreshWh1Location('pallet');
    const beforeCount = await countStockMovements(fixtureClientId, skuOverPallet);
    const beforeBalance = await balanceQtyOnHand(fixtureClientId, skuOverPallet, location.id);
    const correlationId = nextCorrelationId();

    await expect(
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuOverPallet, location.id, '1.000'),
          correlationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    const afterCount = await countStockMovements(fixtureClientId, skuOverPallet);
    expect(afterCount).toBe(beforeCount);
    const afterBalance = await balanceQtyOnHand(fixtureClientId, skuOverPallet, location.id);
    expect(afterBalance).toBe(beforeBalance);
    await expectNothingWrittenFor(correlationId);
  });
});

// --- Scenario: an over-weight put-away onto a shelf location (750 kg) is rejected ----------------

describe('Scenario: an over-weight put-away onto a shelf location (750 kg) is rejected', () => {
  it('an over-weight put-away onto a shelf location (750 kg) is rejected', async () => {
    const location = await pickFreshWh1Location('shelf');
    const correlationId = nextCorrelationId();

    await expect(
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuOverShelf, location.id, '1.000'),
          correlationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    await expectNothingWrittenFor(correlationId);
  });
});

// --- Scenario: the check uses the RESULTING load, not the incoming quantity alone ----------------

describe('Scenario: the check uses the RESULTING load: existing plus incoming exceeding the limit', () => {
  it('the check uses the RESULTING load: existing stock plus incoming exceeding the limit is rejected even though the incoming alone fits', async () => {
    const location = await pickFreshWh1Location('pallet');
    const current = await currentLocationLoad(location.id);
    const remaining = PALLET_MAX_WEIGHT_KG - current.weightKg;
    expect(remaining).toBeGreaterThan(0);

    const qtyA = (remaining * RESULTING_LOAD_HEADROOM_FRACTION_A).toFixed(3);
    const qtyB = (remaining * RESULTING_LOAD_HEADROOM_FRACTION_B).toFixed(3);

    // First receipt: current + A stays under the limit — accepted (skuUnitWeight is 1 kg/unit, so
    // qty in units equals kg).
    await postReceipt(fixtureClientId, skuUnitWeight, location.id, qtyA);

    // B alone (< remaining) would fit if the location were empty, but current + A + B exceeds
    // PALLET_MAX_WEIGHT_KG (D2: the resulting total, not the incoming amount alone).
    expect(Number(qtyB)).toBeLessThan(PALLET_MAX_WEIGHT_KG);

    const secondCorrelationId = nextCorrelationId();
    await expect(
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuUnitWeight, location.id, qtyB),
          correlationId: secondCorrelationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    await expectNothingWrittenFor(secondCorrelationId);
  });
});

// --- Scenario: an over-volume put-away is rejected ------------------------------------------------

describe('Scenario: an over-volume put-away is rejected', () => {
  it('an over-volume put-away is rejected', async () => {
    const location = await pickFreshWh1Location('pallet');
    expect(Number(BULKY_VOLUME_CBM)).toBeGreaterThan(PALLET_MAX_VOLUME_CBM);
    const correlationId = nextCorrelationId();

    await expect(
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuBulkyVolume, location.id, '1.000'),
          correlationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    await expectNothingWrittenFor(correlationId);
  });
});

// --- Scenario: a SKU with no gross_weight_kg cannot be put away into a weight-limited location ---

describe('Scenario: a put-away of a SKU with no gross_weight_kg into a weight-limited location', () => {
  it('a put-away of a SKU with no gross_weight_kg into a weight-limited location is rejected', async () => {
    const location = await pickFreshWh1Location('pallet');
    const correlationId = nextCorrelationId();

    await expect(
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuNoWeight, location.id, '1.000'),
          correlationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    await expectNothingWrittenFor(correlationId);
  });
});

// --- Scenario (F6): a SKU with a gross weight but no volume_cbm is rejected in a volume-limited
//     location -------------------------------------------------------------------------------------

describe('Scenario: a SKU with gross weight but no volume_cbm is rejected in a volume-limited location', () => {
  it('a SKU with gross weight but no volume_cbm is rejected in a volume-limited location (the missing_volume branch)', async () => {
    const location = await pickFreshWh1Location('pallet');
    const correlationId = nextCorrelationId();

    await expect(
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuWeightNoVolume, location.id, '1.000'),
          correlationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    await expectNothingWrittenFor(correlationId);
  });
});

// --- Scenario: a put-away into a blocked (structural) location is rejected -----------------------

describe('Scenario: a put-away into a blocked (structural) location is rejected', () => {
  it('a put-away into a blocked (structural) location is rejected', async () => {
    const location = await pickBlockedStructuralLocation();
    expect(location.is_blocked).toBe(true);
    const correlationId = nextCorrelationId();

    await expect(
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuLight, location.id, '1.000'),
          correlationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationBlockedError);

    await expectNothingWrittenFor(correlationId);
  });
});

// --- Scenario (scope): an operational location is not weight-checked -----------------------------

describe('Scenario: an operational location is not weight-checked', () => {
  it('an operational location (e.g. RCV-1) is not weight-checked: a receipt over 1,000 kg is accepted', async () => {
    const location = await pickFreshWh1Location('operational');
    expect(location.location_type).toBe('operational');
    // 019:283-287 — the stored value is still 1,000, but the scope decision means it must not be
    // enforced on this type.
    expect(Number(location.max_weight_kg)).toBe(OPERATIONAL_STORED_MAX_WEIGHT_KG);

    const before = await balanceQtyOnHand(fixtureClientId, skuOverPallet, location.id);
    // skuOverPallet's gross_weight_kg (OVER_PALLET_WEIGHT_KG = 1,500) alone already exceeds
    // OPERATIONAL_STORED_MAX_WEIGHT_KG — proving the acceptance is the scope decision at work, not
    // an accidentally-light fixture.
    expect(Number(OVER_PALLET_WEIGHT_KG)).toBeGreaterThan(OPERATIONAL_STORED_MAX_WEIGHT_KG);

    const posted = await postReceipt(fixtureClientId, skuOverPallet, location.id, '1.000');
    expect(posted.movementIds).toHaveLength(1);

    const after = await balanceQtyOnHand(fixtureClientId, skuOverPallet, location.id);
    expect(after - before).toBeCloseTo(1, 3);
  });

  it('a weightless SKU (gross_weight_kg null) is also accepted into an operational location', async () => {
    const location = await pickFreshWh1Location('operational');
    const before = await balanceQtyOnHand(fixtureClientId, skuNoWeight, location.id);

    const posted = await postReceipt(fixtureClientId, skuNoWeight, location.id, '1.000');
    expect(posted.movementIds).toHaveLength(1);

    const after = await balanceQtyOnHand(fixtureClientId, skuNoWeight, location.id);
    expect(after - before).toBeCloseTo(1, 3);
  });
});

// --- Scenario (F5): the resulting load counts other clients' stock -------------------------------

describe("Scenario: the resulting load counts other clients' stock", () => {
  it("the resulting load counts other clients' stock: client X fills the location and client Y's put-away is rejected", async () => {
    const location = await pickFreshWh1Location('pallet');
    const current = await currentLocationLoad(location.id);
    const remaining = PALLET_MAX_WEIGHT_KG - current.weightKg;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeGreaterThan(CROSS_CLIENT_BUFFER_KG);

    // Client X (fixtureClientId) fills the location to within CROSS_CLIENT_BUFFER_KG of its max
    // — skuUnitWeight is 1 kg/unit, so qty in units equals kg.
    const fillQty = (remaining - CROSS_CLIENT_BUFFER_KG).toFixed(3);
    await postReceipt(fixtureClientId, skuUnitWeight, location.id, fillQty);

    // Client Y's own SKU is heavier than the buffer left — its put-away alone would fit an empty
    // location (CROSS_CLIENT_Y_SKU_WEIGHT_KG=10 < PALLET_MAX_WEIGHT_KG=1,000) but not the buffer
    // client X left (CROSS_CLIENT_BUFFER_KG=5).
    expect(Number(CROSS_CLIENT_Y_SKU_WEIGHT_KG)).toBeGreaterThan(CROSS_CLIENT_BUFFER_KG);
    expect(Number(CROSS_CLIENT_Y_SKU_WEIGHT_KG)).toBeLessThan(PALLET_MAX_WEIGHT_KG);

    const correlationId = nextCorrelationId();
    const balanceYBefore = await balanceQtyOnHand(fixtureClientIdY, skuClientY, location.id);

    await expect(
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientIdY, skuClientY, location.id, '1.000'),
          correlationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    const balanceYAfter = await balanceQtyOnHand(fixtureClientIdY, skuClientY, location.id);
    expect(balanceYAfter).toBe(balanceYBefore);
    await expectNothingWrittenFor(correlationId);
  });
});

// --- Scenario (F3): a transfer whose destination would exceed the limit is rejected atomically ---

describe('Scenario: a transfer whose destination would exceed the limit is rejected atomically', () => {
  it('a transfer whose destination would exceed the limit is rejected and the source row is not written either (atomic)', async () => {
    const source = await pickFreshWh1Location('shelf');
    const destination = await pickFreshWh1Location('pallet');

    // The source holds the SKU being moved (skuLight) — enough to transfer TRANSFER_QTY out of.
    await postReceipt(fixtureClientId, skuLight, source.id, SOURCE_STOCK_QTY);

    // Preload the destination to within DEST_PRELOAD_BUFFER_KG of its max, using a DIFFERENT SKU
    // (skuUnitWeight, 1 kg/unit) — so ONLY the transfer's in-leg is what fails, not some unrelated
    // rejection of the preload itself.
    const destCurrent = await currentLocationLoad(destination.id);
    const destRemaining = PALLET_MAX_WEIGHT_KG - destCurrent.weightKg;
    expect(destRemaining).toBeGreaterThan(DEST_PRELOAD_BUFFER_KG);
    const preloadQty = (destRemaining - DEST_PRELOAD_BUFFER_KG).toFixed(3);
    await postReceipt(fixtureClientId, skuUnitWeight, destination.id, preloadQty);

    // The buffer left (DEST_PRELOAD_BUFFER_KG=5) is smaller than the transfer's own weight
    // (TRANSFER_QTY=1 * LIGHT_WEIGHT_KG=10 = 10 kg) — so the in-leg is rejected, even though that
    // same 10 kg would trivially fit an EMPTY pallet location (max 1,000 kg).
    expect(DEST_PRELOAD_BUFFER_KG).toBeLessThan(Number(LIGHT_WEIGHT_KG) * Number(TRANSFER_QTY));

    const sourceBalanceBefore = await balanceQtyOnHand(fixtureClientId, skuLight, source.id);
    const destBalanceBefore = await balanceQtyOnHand(fixtureClientId, skuLight, destination.id);
    const sourceMovementCountBefore = await countStockMovementsAtLocation(
      fixtureClientId,
      skuLight,
      source.id,
    );
    const destMovementCountBefore = await countStockMovementsAtLocation(
      fixtureClientId,
      skuLight,
      destination.id,
    );

    const transferCorrelationId = nextCorrelationId();
    await expect(
      postTransfer(
        ctx,
        {
          entityId,
          correlationId: transferCorrelationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
          base: {
            clientId: fixtureClientId,
            skuId: skuLight,
            qty: Quantity.of(TRANSFER_QTY),
            batchNo: '',
            uom: 'EA',
          },
          fromLocationId: source.id,
          toLocationId: destination.id,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    // No new stock_movements row for skuLight at EITHER location.
    expect(await countStockMovementsAtLocation(fixtureClientId, skuLight, source.id)).toBe(
      sourceMovementCountBefore,
    );
    expect(await countStockMovementsAtLocation(fixtureClientId, skuLight, destination.id)).toBe(
      destMovementCountBefore,
    );
    // Both balances (source and destination, for the moved SKU) are unchanged.
    expect(await balanceQtyOnHand(fixtureClientId, skuLight, source.id)).toBe(sourceBalanceBefore);
    expect(await balanceQtyOnHand(fixtureClientId, skuLight, destination.id)).toBe(destBalanceBefore);
    await expectNothingWrittenFor(transferCorrelationId);
  });
});

// --- Scenario (F1): reversing a pick whose stock no longer fits the location ----------------------

describe('Scenario: reversing a pick whose stock no longer fits the location', () => {
  it('reversing a pick whose stock no longer fits the location is rejected', async () => {
    const location = await pickFreshWh1Location('pallet');
    const baseline = await currentLocationLoad(location.id);
    const remaining0 = PALLET_MAX_WEIGHT_KG - baseline.weightKg;
    expect(remaining0).toBeGreaterThan(0);

    // Step 1: an initial receipt of skuUnitWeight (1 kg/unit), well under the limit.
    const initQty = remaining0 * REVERSAL_INITIAL_RECEIPT_FRACTION;
    await postReceipt(fixtureClientId, skuUnitWeight, location.id, initQty.toFixed(3));

    // Step 2: pick part of it back out — a decrease, never limit-checked (D1: only entries that
    // ADD stock are checked).
    const pickQty = initQty * REVERSAL_PICK_FRACTION;
    const pickEntry: LedgerEntry = {
      clientId: fixtureClientId,
      skuId: skuUnitWeight,
      fromLocationId: location.id,
      toLocationId: null,
      qty: Quantity.of(pickQty.toFixed(3)),
      batchNo: '',
      movementType: 'pick',
      uom: 'EA',
    };
    const pickCorrelationId = nextCorrelationId();
    const pickPosted = await postMovement(
      ctx,
      { entityId, entry: pickEntry, correlationId: pickCorrelationId, performedBy: PERFORMED_BY_FIXTURE_UUID },
      deps,
    );
    const pickMovementId = pickPosted.movementIds[0] as string;

    // Step 3: fill the location EXACTLY to its max (a different SKU) — the boundary itself is
    // still `ok` ("equal to the max is ok").
    const afterPickLoad = await currentLocationLoad(location.id);
    const remaining1 = PALLET_MAX_WEIGHT_KG - afterPickLoad.weightKg;
    expect(remaining1).toBeGreaterThan(0);

    const fillerSkuWeight = '1.000';
    const fillerSku = await insertSku(fixtureClientId, `LOCLIM-REVFILL-${randomUUID()}`, fillerSkuWeight, '0.00100');
    fixtureSkuIds.push(fillerSku);
    await postReceipt(fixtureClientId, fillerSku, location.id, remaining1.toFixed(3));

    const fullLoad = await currentLocationLoad(location.id);
    expect(fullLoad.weightKg).toBeCloseTo(PALLET_MAX_WEIGHT_KG, 2);

    // Step 4: reversing the pick would add pickQty back — pushing the (now exactly-full) location
    // over its max.
    const balanceBefore = await balanceQtyOnHand(fixtureClientId, skuUnitWeight, location.id);
    const movementCountBefore = await countStockMovementsAtLocation(
      fixtureClientId,
      skuUnitWeight,
      location.id,
    );
    const reversalCorrelationId = nextCorrelationId();

    await expect(
      reverseMovement(
        ctx,
        {
          movementId: pickMovementId,
          correlationId: reversalCorrelationId,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    expect(
      await countStockMovementsAtLocation(fixtureClientId, skuUnitWeight, location.id),
    ).toBe(movementCountBefore);
    expect(await balanceQtyOnHand(fixtureClientId, skuUnitWeight, location.id)).toBe(balanceBefore);
    await expectNothingWrittenFor(reversalCorrelationId);
  });
});

// --- Scenario: two concurrent put-aways that together exceed the limit ---------------------------

describe('Scenario: two concurrent put-aways that together exceed the limit', () => {
  it('two concurrent put-aways that together exceed the limit: exactly one succeeds', async () => {
    const location = await pickFreshWh1Location('pallet');
    const current = await currentLocationLoad(location.id);
    const remaining = PALLET_MAX_WEIGHT_KG - current.weightKg;
    expect(remaining).toBeGreaterThan(0);

    const qtyEach = (remaining * CONCURRENT_EACH_FRACTION).toFixed(3);
    expect(Number(qtyEach)).toBeLessThan(remaining); // alone, each fits.
    expect(Number(qtyEach) * 2).toBeGreaterThan(remaining); // together, they exceed it.

    const correlationA = nextCorrelationId();
    const correlationB = nextCorrelationId();

    const [resultA, resultB] = await Promise.allSettled([
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuUnitWeight, location.id, qtyEach),
          correlationId: correlationA,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
      postMovement(
        ctx,
        {
          entityId,
          entry: receiptEntry(fixtureClientId, skuUnitWeight, location.id, qtyEach),
          correlationId: correlationB,
          performedBy: PERFORMED_BY_FIXTURE_UUID,
        },
        deps,
      ),
    ]);

    const outcomes = [
      { correlationId: correlationA, result: resultA },
      { correlationId: correlationB, result: resultB },
    ];
    const fulfilled = outcomes.filter((o) => o.result.status === 'fulfilled');
    const rejected = outcomes.filter(
      (o): o is { correlationId: string; result: PromiseRejectedResult } =>
        o.result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.result.reason).toBeInstanceOf(LocationLimitExceededError);
    await expectNothingWrittenFor(rejected[0]?.correlationId as string);
  });
});

// --- Scenario: the limits in wms.locations match 019 ----------------------------------------------

describe('Scenario: the limits in wms.locations match 019', () => {
  it('the limits in wms.locations match 019: 1,000 kg on every pallet location, 750 kg on every shelf location', async () => {
    // 019-Warehouse-WH1-Setup.sql:236-237 (pallet, P section, 1,000 kg) and :239-245 (shelf,
    // G/M/T sections, 750 kg).
    const pallet: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.locations l
         join wms.warehouses w on w.id = l.warehouse_id
        where w.code = 'WH1' and l.location_type = 'pallet'
          and l.max_weight_kg <> $1`,
      [PALLET_MAX_WEIGHT_KG],
    );
    expect(pallet.rows[0]?.n).toBe('0');

    const shelf: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.locations l
         join wms.warehouses w on w.id = l.warehouse_id
        where w.code = 'WH1' and l.location_type = 'shelf'
          and l.max_weight_kg <> $1`,
      [SHELF_MAX_WEIGHT_KG],
    );
    expect(shelf.rows[0]?.n).toBe('0');

    // Same fact, max_volume_cbm: 019-Warehouse-WH1-Setup.sql:236 (pallet, 1.76175 cbm) and :239-245
    // (shelf, 0.97200 cbm).
    const palletVolume: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.locations l
         join wms.warehouses w on w.id = l.warehouse_id
        where w.code = 'WH1' and l.location_type = 'pallet'
          and l.max_volume_cbm <> $1`,
      [PALLET_MAX_VOLUME_CBM],
    );
    expect(palletVolume.rows[0]?.n).toBe('0');

    const shelfVolume: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.locations l
         join wms.warehouses w on w.id = l.warehouse_id
        where w.code = 'WH1' and l.location_type = 'shelf'
          and l.max_volume_cbm <> $1`,
      [SHELF_MAX_VOLUME_CBM],
    );
    expect(shelfVolume.rows[0]?.n).toBe('0');
  });
});
