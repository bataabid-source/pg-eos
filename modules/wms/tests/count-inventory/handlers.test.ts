// modules/wms/tests/count-inventory/handlers.test.ts — WBS 2.13 (lane 2).
//
// The api layer's contract (modules/wms/api/count-inventory/handlers.ts), one test per mapping:
//   - a missing Idempotency-Key -> 400 Problem;
//   - an invalid body -> 400 Problem;
//   - a role-gate rejection -> 422 Problem;
//   - StaleVersionError -> 409, IllegalTransitionError -> 422, title = error.name;
//   - an unknown error -> 500 Problem, logged via deps.logger.error, never leaking the raw message;
//   - CRITICAL (brief D2, the blind-count contract enforced at the response layer, not just
//     application discipline): handleCountLocation's and handleRecount's HTTP response BODY
//     carries ONLY { lineId, recorded: true } — genuinely no qtySystem/variance/recountQty key,
//     checked on the actual JSON the handler returns, not just the Zod result schema (which would
//     silently strip unknown keys on `.parse()` even if the domain layer leaked them).
//
// Fixture/RLS pattern: same admin-pool style as ./count-inventory.test.ts, deliberately minimal
// (one warehouse/zone/location/sku/stock_balance row, one count) since this file only exercises
// the API-mapping LAYER, not every business scenario (already covered by count-inventory.test.ts).
// platform.audit_log is never deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createCountInventoryDeps } from '../../api/count-inventory/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — CountInventoryDeps carries `logger: Logger`
// (../../application/count-inventory/ports.ts), and createCountInventoryDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger.
import type { Logger } from '../../application/count-inventory/ports.js';
import { countLocation, startCount } from '../../application/count-inventory/index.js';
// pg-reviewer finding 8: stock is seeded through a REAL 'receipt' movement via the module's own
// public postMovement (never a direct wms.stock_balance INSERT) — same discipline as
// ./count-inventory.test.ts's own seedStockViaReceipt.
import { postMovement, type LedgerDeps } from '../../index.js';

// The module under test — does not exist yet with this error-mapping behaviour (RED).
import {
  handleAdjustCount,
  handleCountLocation,
  handleRecount,
  handleStartCount,
  type ApiRequest,
} from '../../api/count-inventory/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000213c1';
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000213c2';
const WH_MGR_ROLE_CODE = 'WH_MGR';
const COUNT_TYPE_FULL = 'full';
const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(2131);
const deps = createCountInventoryDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let fixtureClientId: string;
let fixtureWarehouseId: string;
let fixtureZoneId: string;
let fixtureLocationId: string;
let fixtureSkuId: string;
let draftCountLineId: string;
const extraWarehouseIds: string[] = [];
const extraCountIds: string[] = [];
// finding 8: correlation ids of the fixture 'receipt' movements posted via seedStockViaReceipt
// (outbox rows those movements write are cleaned in afterAll, same discipline as
// ./count-inventory.test.ts's own usedCorrelationIds).
const seedCorrelationIds: string[] = [];
const ledgerDeps: LedgerDeps = { clock, ids: new SequentialIdGenerator(21310) };

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
}

// Monotonic generator for codes matching chk_locations_code_format
// (database/schema/019-Warehouse-WH1-Setup.sql:59-62 — `^[PGMT][1-9]-[0-9]{2}-[1-9]$`, required for
// location_type in ('pallet','shelf')). 9 aisles * 100 positions * 9 levels = 8,100 unique codes,
// far more than any fixture in this file needs.
let locationCodeCounter = 0;
function nextLocationCode(): string {
  const n = locationCodeCounter;
  locationCodeCounter += 1;
  const level = (n % 9) + 1;
  const position = Math.floor(n / 9) % 100;
  const aisle = (Math.floor(n / 900) % 9) + 1;
  return `P${aisle}-${String(position).padStart(2, '0')}-${level}`;
}

function spyLogger(): Logger & { readonly errorCalls: Array<[Record<string, unknown>, string]> } {
  const errorCalls: Array<[Record<string, unknown>, string]> = [];
  return {
    errorCalls,
    error: (obj, msg) => {
      errorCalls.push([obj, msg]);
    },
    info: () => {
      // not asserted here.
    },
  };
}

/** pg-reviewer finding 8: seeds stock through a REAL 'receipt' movement via the module's own
 *  public `postMovement` (../../index.js) — never a direct wms.stock_balance INSERT, which leaves
 *  a ledgerless balance row and fails guard G1. `ctx`/`FIXTURE_ACTOR_UUID` already carry a real
 *  identity.users/user_entities row for `entityId` (beforeAll), which `postMovement`'s own
 *  `withContext` needs. */
async function seedStockViaReceipt(skuId: string, locationId: string, qtyOnHand: string = '10.000'): Promise<void> {
  const correlationId = randomUUID();
  seedCorrelationIds.push(correlationId);
  await postMovement(
    ctx,
    {
      entityId,
      entry: {
        clientId: fixtureClientId,
        skuId,
        fromLocationId: null,
        toLocationId: locationId,
        qty: Quantity.of(qtyOnHand),
        batchNo: '',
        movementType: 'receipt',
        uom: 'EA',
      },
      correlationId,
      performedBy: FIXTURE_ACTOR_UUID,
    },
    ledgerDeps,
  );
}

/** builds a fresh warehouse+zone+location+sku+stock (finding 8: via a real receipt movement) and
 *  starts a full count on it via the application layer directly (not the handler under test —
 *  this is fixture setup). Returns the one line's id. */
async function insertFreshCountLine(): Promise<{ countId: string; lineId: string; version: number }> {
  const whResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [entityId, `_CNTINV_HDL_WH_${randomUUID()}`, 'مستودع اختبار معالجات الجرد'],
  );
  const warehouseId = (whResult.rows[0] as { id: string }).id;
  extraWarehouseIds.push(warehouseId);
  const zoneResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, 'A', $2, 'storage') returning id`,
    [warehouseId, 'منطقة اختبار'],
  );
  const zoneId = (zoneResult.rows[0] as { id: string }).id;
  const locationResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.locations (warehouse_id, zone_id, code, location_type) values ($1, $2, $3, 'shelf') returning id`,
    [warehouseId, zoneId, nextLocationCode()],
  );
  const locationId = (locationResult.rows[0] as { id: string }).id;
  await seedStockViaReceipt(fixtureSkuId, locationId);

  const result = await startCount(ctx, { warehouseId, countType: COUNT_TYPE_FULL, correlationId: randomUUID() }, deps);
  extraCountIds.push(result.id);
  const lineResult: QueryResult<{ id: string }> = await pool.query(
    `select id from wms.inventory_count_lines where count_id = $1`,
    [result.id],
  );
  return { countId: result.id, lineId: (lineResult.rows[0] as { id: string }).id, version: result.version };
}

/** finding 7b: a fresh line already counted with a VARIANT quantity (7 != system 10) — via the
 *  application layer directly (fixture setup, not the handler under test) — so it is genuinely
 *  flagged for Recount, exercising handleRecount as more than an untested import. */
async function insertFreshRecountableLine(): Promise<{ countId: string; lineId: string }> {
  const line = await insertFreshCountLine();
  await countLocation(ctx, { lineId: line.lineId, qtyCounted: '7.000', correlationId: randomUUID() }, deps);
  return { countId: line.countId, lineId: line.lineId };
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_cntinv_handlers_${randomUUID()}`, 'عميل اختبار معالجات الجرد'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;

  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, '1.000', '0.00100') returning id`,
    [fixtureClientId, `CNTINV-HANDLERS-${randomUUID()}`, 'صنف اختبار معالجات الجرد'],
  );
  fixtureSkuId = (skuResult.rows[0] as { id: string }).id;

  const whResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [entityId, `_CNTINV_HDL_${randomUUID()}`, 'مستودع اختبار معالجات الجرد'],
  );
  fixtureWarehouseId = (whResult.rows[0] as { id: string }).id;
  const zoneResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, 'A', $2, 'storage') returning id`,
    [fixtureWarehouseId, 'منطقة اختبار'],
  );
  fixtureZoneId = (zoneResult.rows[0] as { id: string }).id;
  const locationResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.locations (warehouse_id, zone_id, code, location_type) values ($1, $2, $3, 'shelf') returning id`,
    [fixtureWarehouseId, fixtureZoneId, nextLocationCode()],
  );
  fixtureLocationId = (locationResult.rows[0] as { id: string }).id;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_cntinv_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات الجرد'],
  );
  await pool.query(`delete from identity.users where id = $1`, [NO_ROLE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [NO_ROLE_ACTOR_UUID, `_cntinv_handlers_norole_${randomUUID()}@test.invalid`, 'ممثل اختبار بلا صلاحية'],
  );
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const userId of [FIXTURE_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    for (const row of allEntitiesResult.rows) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, row.id]);
    }
  }
  // WH_MGR alone: it covers every command this file exercises through FIXTURE_ACTOR_UUID
  // (handleStartCount, handleCountLocation, handleAdjustCount — D4). Granting WH_SUP or WH_OP on
  // top would violate the (WH_OP, WH_SUP) SoD pair (identity.sod_rules, 13B:617-655,634 —
  // "الملتقط لا يدقّق التقاطه"), enforced by trigger identity.check_sod().
  const roleResult: QueryResult<{ id: string }> = await pool.query(
    `select id from identity.roles where code = $1`,
    [WH_MGR_ROLE_CODE],
  );
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);

  // finding 8: seeded AFTER FIXTURE_ACTOR_UUID's identity/entity/role rows exist above —
  // seedStockViaReceipt's postMovement call runs as `ctx` (FIXTURE_ACTOR_UUID) through a real
  // withContext, which needs that identity to already be in place.
  await seedStockViaReceipt(fixtureSkuId, fixtureLocationId);

  const line = await insertFreshCountLine();
  draftCountLineId = line.lineId;
});

afterAll(async () => {
  if (seedCorrelationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [seedCorrelationIds]);
  }
  if (extraCountIds.length > 0) {
    await pool.query(`delete from wms.inventory_count_lines where count_id = any($1::uuid[])`, [extraCountIds]);
    await pool.query(`delete from wms.inventory_counts where id = any($1::uuid[])`, [extraCountIds]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
  }
  await pool.query(`delete from wms.locations where warehouse_id = any($1::uuid[])`, [
    [fixtureWarehouseId, ...extraWarehouseIds],
  ]);
  await pool.query(`delete from wms.zones where warehouse_id = any($1::uuid[])`, [
    [fixtureWarehouseId, ...extraWarehouseIds],
  ]);
  await pool.query(`delete from wms.warehouses where id = any($1::uuid[])`, [
    [fixtureWarehouseId, ...extraWarehouseIds],
  ]);
  if (fixtureSkuId) await pool.query(`delete from wms.skus where id = $1`, [fixtureSkuId]);
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  for (const userId of [FIXTURE_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleStartCount: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const result = await handleStartCount(
      requestWithoutKey({ warehouseId: fixtureWarehouseId, countType: COUNT_TYPE_FULL, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleStartCount: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleStartCount(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });
});

describe('a role-gate rejection maps to 422, title = "RoleRequiredError"', () => {
  it('handleStartCount: caller with no WH_MGR/WH_SUP role -> 422', async () => {
    const result = await handleStartCount(
      { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() }, body: { warehouseId: fixtureWarehouseId, countType: COUNT_TYPE_FULL, correlationId: randomUUID() }, ctx: noRoleCtx },
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });
  });
});

describe('IllegalTransitionError maps to 422, title = error.name', () => {
  it('handleAdjustCount on a still-in_progress count -> 422, title "IllegalTransitionError"', async () => {
    const line = await insertFreshCountLine();

    const result = await handleAdjustCount(
      requestWithKey({ countId: line.countId, expectedVersion: line.version, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });
});

// round-2 finding 6: no handler-level test previously confirmed RecountRequiredError and
// WarehouseNotFoundError (both new from round 1's fixes) map to 422 via
// errorToApiFailure/handleAdjustCount/handleStartCount — if either were accidentally dropped from
// the error-mapping switch, these tests must catch it as a 500 instead of the intended 422 (the
// same class of gap round-1 finding 13 exists to prevent).

describe('RecountRequiredError maps to 422, title = error.name', () => {
  it('handleAdjustCount on a "review" count with a variant line never recounted -> 422, title "RecountRequiredError"', async () => {
    const line = await insertFreshCountLine();
    // '7.000' != the fixture's seeded '10.000' -> a variant line, moving the (single-line) count
    // to "review" without ever being recounted (INV-C3-7's "recount mandatory").
    await countLocation(ctx, { lineId: line.lineId, qtyCounted: '7.000', correlationId: randomUUID() }, deps);

    const result = await handleAdjustCount(
      requestWithKey({ countId: line.countId, expectedVersion: line.version + 1, correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RecountRequiredError' });
  });
});

describe('WarehouseNotFoundError maps to 422, title = error.name', () => {
  it('handleStartCount with a warehouseId that does not exist -> 422, title "WarehouseNotFoundError"', async () => {
    const result = await handleStartCount(
      requestWithKey({ warehouseId: randomUUID(), countType: COUNT_TYPE_FULL, correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'WarehouseNotFoundError' });
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleAdjustCount: a mismatched expectedVersion (StaleVersionError fires on any mismatch, older or newer) -> 409, title "StaleVersionError"', async () => {
    const line = await insertFreshCountLine();
    const result = await handleAdjustCount(
      requestWithKey({ countId: line.countId, expectedVersion: line.version + 999, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

// --- D2: the blind-count contract, enforced on the HTTP response BODY itself -----------------------

describe('handleCountLocation response body carries NO qtySystem/variance/recountQty field (brief D2)', () => {
  it('the raw JSON body is exactly { lineId, recorded: true } — checked on actual keys, not a schema.parse() that would silently strip extras', async () => {
    const result = await handleCountLocation(
      requestWithKey({ lineId: draftCountLineId, qtyCounted: '7.000', correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return; // unreachable, narrows for TS below.
    const body = result.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['lineId', 'recorded'].sort());
    expect(body['recorded']).toBe(true);
    expect('qtySystem' in body).toBe(false);
    expect('variance' in body).toBe(false);
    expect('recountQty' in body).toBe(false);
  });
});

// --- finding 7b: handleRecount — the SAME Problem-envelope + blind-count coverage as handleCountLocation ---

describe('handleRecount response body carries NO qtySystem/variance/qtyCounted field (brief D2)', () => {
  it('the raw JSON body is exactly { lineId, recorded: true } — checked on actual keys, not a schema.parse() that would silently strip extras', async () => {
    const { lineId } = await insertFreshRecountableLine();

    const result = await handleRecount(requestWithKey({ lineId, recountQty: '7.000', correlationId: randomUUID() }), deps);

    expect(result.status).toBe(200);
    if (result.status !== 200) return; // unreachable, narrows for TS below.
    const body = result.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['lineId', 'recorded'].sort());
    expect(body['recorded']).toBe(true);
    expect('qtySystem' in body).toBe(false);
    expect('variance' in body).toBe(false);
    expect('qtyCounted' in body).toBe(false);
  });
});

describe('handleRecount: NotFlaggedForRecountError maps to 422, title = error.name', () => {
  it('a line counted with NO variance (qty_counted equals qty_system, count already in "review") is not flagged for recount -> 422', async () => {
    const line = await insertFreshCountLine();
    // insertFreshCountLine's own fixture seeds exactly '10.000' of stock (seedStockViaReceipt's
    // default) — counting the line with that SAME quantity produces a line with NO variance and
    // moves the (single-line) count straight to "review", legitimately eligible for Recount's own
    // status gate, yet NOT flagged (no variance) — genuinely exercising NotFlaggedForRecountError
    // rather than an earlier IllegalTransitionError from a still-in_progress count.
    await countLocation(ctx, { lineId: line.lineId, qtyCounted: '10.000', correlationId: randomUUID() }, deps);

    const result = await handleRecount(
      requestWithKey({ lineId: line.lineId, recountQty: '5.000', correlationId: randomUUID() }),
      deps,
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'NotFlaggedForRecountError' });
  });
});

describe('handleRecount: a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('no Idempotency-Key header -> 400', async () => {
    const { lineId } = await insertFreshRecountableLine();

    const result = await handleRecount(requestWithoutKey({ lineId, recountQty: '7.000', correlationId: randomUUID() }), deps);

    expect(result.status).toBe(400);
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first and the command ran once', () => {
  it('handleStartCount: identical key + body -> identical response, exactly one wms.inventory_counts row', async () => {
    const whResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
      [entityId, `_CNTINV_HDL_IDEM_${randomUUID()}`, 'مستودع اختبار تكرار المعالجات'],
    );
    const warehouseId = (whResult.rows[0] as { id: string }).id;
    extraWarehouseIds.push(warehouseId);
    const idempotencyKey = randomUUID();
    const body = { warehouseId, countType: COUNT_TYPE_FULL, correlationId: randomUUID() };

    const first = await handleStartCount(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status === 200) extraCountIds.push((first.body as { id: string }).id);

    const second = await handleStartCount(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.inventory_counts where warehouse_id = $1`,
      [warehouseId],
    );
    expect(countResult.rows[0]?.n).toBe('1');
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleStartCount: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const depsWithSpyLogger = createCountInventoryDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        hasAnyRole: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = randomUUID();

    const result = await handleStartCount(
      requestWithKey({ warehouseId: fixtureWarehouseId, countType: COUNT_TYPE_FULL, correlationId }),
      brokenDeps,
    );

    expect(result.status).toBe(500);
    expect('body' in result ? JSON.stringify(result.body) : '').not.toMatch(/unexpected repository failure/);

    expect(logger.errorCalls).toHaveLength(1);
    const [loggedObj] = logger.errorCalls[0] as [Record<string, unknown>, string];
    expect(loggedObj['correlationId']).toBe(correlationId);
    expect(loggedObj['err']).toBeInstanceOf(Error);
    expect(loggedObj['err']).toBe(thrown);
  });
});

// --- createCountInventoryDeps({ clock, ids, logger }) --------------------------------------------

describe('createCountInventoryDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createCountInventoryDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createCountInventoryDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
