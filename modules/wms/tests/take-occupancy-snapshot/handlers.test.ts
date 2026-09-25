// modules/wms/tests/take-occupancy-snapshot/handlers.test.ts — WBS 2.14 (lane 2).
//
// The api layer's contract (modules/wms/api/take-occupancy-snapshot/handlers.ts), one test per
// mapping (brief: "API-layer tests: Problem envelope mapping, Idempotency-Key required 400,
// role-gate 422, contract validation 400"):
//   - a missing Idempotency-Key -> 400 Problem;
//   - an invalid body (missing warehouseId) -> 400 Problem;
//   - a role-gate rejection (caller without WH_MGR) -> 422 Problem, title = 'RoleRequiredError';
//   - the Problem envelope itself: an error response body carries { title, status, detail } (doc
//     40's own Problem shape, same convention as every prior slice's handlers.test.ts);
//   - a successful call returns 200 with the minimal summary body
//     { warehouseId, snapshotDate, clientsSnapshotted, clientsInOverflow } — no version column
//     exists on this aggregate (D1), so unlike count-inventory/receive-inbound there is no
//     StaleVersionError/expectedVersion mapping to test here.
//
// Fixture/RLS pattern: same admin-pool style as ./take-occupancy-snapshot.test.ts, deliberately
// minimal (one warehouse/zone/pallet location/client/stock row) since this file only exercises the
// API-mapping LAYER, not every business scenario (already covered by take-occupancy-snapshot.test.ts).
// platform.audit_log is never deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createTakeOccupancySnapshotDeps } from '../../api/take-occupancy-snapshot/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — TakeOccupancySnapshotDeps carries `logger: Logger`
// (../../application/take-occupancy-snapshot/ports.js), and
// createTakeOccupancySnapshotDeps({ clock, ids, logger }) accepts an injected one instead of always
// defaulting to a real pino-backed logger — same convention as count-inventory's own handlers.test.ts.
import type { Logger } from '../../application/take-occupancy-snapshot/ports.js';
// pg-reviewer finding 8 discipline (2.13): stock is seeded through a REAL 'receipt' movement via
// the module's own public postMovement (never a direct wms.stock_balance INSERT).
import { postMovement, type LedgerDeps } from '../../index.js';

// The module under test — does not exist yet with this error-mapping behaviour (RED).
import { handleTakeOccupancySnapshot, type ApiRequest } from '../../api/take-occupancy-snapshot/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000214c1';
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000214c2';
const WH_MGR_ROLE_CODE = 'WH_MGR';
const RECEIPT_MOVEMENT_TYPE = 'receipt';
const DEFAULT_SEED_UOM = 'EA';
const DEFAULT_SEED_QTY = '1.000';
const SNAPSHOT_DATE = '2026-09-25';

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(2141);
const deps = createTakeOccupancySnapshotDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let fixtureClientId: string;
let fixtureWarehouseId: string;
let fixtureZoneId: string;
let fixtureBlockId: string;
let fixtureLocationId: string;
let fixtureSkuId: string;
const seedCorrelationIds: string[] = [];
// round-1 review finding 9: every correlationId a SUCCESSFUL TakeOccupancySnapshot call generates
// its own wms.occupancy.snapshot outbox row for — these are never the seed correlation ids above,
// and were previously never cleaned up (the same orphan-fixture pattern that broke
// wh1-setup.test.ts earlier in this slice's build). Every test below that expects a 200 pushes its
// own body.correlationId here; afterAll deletes platform.outbox rows for all of them.
const commandCorrelationIds: string[] = [];
// finding 6/9: additional fixture rows (a second location + sku) created ONLY by the
// idempotent-replay test below, to prove replay short-circuits rather than recomputes — tracked
// here so afterAll's warehouse-scoped location delete still needs no change, but the extra sku
// does (locations are deleted by warehouse_id already; skus are not).
const extraSkuIds: string[] = [];
const ledgerDeps: LedgerDeps = { clock, ids: new SequentialIdGenerator(21410) };

function requestWithKey<TBody>(body: TBody, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

function requestWithoutKey<TBody>(body: TBody): ApiRequest<TBody> {
  return { headers: {}, body, ctx };
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

/** pg-reviewer finding 8 discipline (2.13): seeds stock through a REAL 'receipt' movement via the
 *  module's own public `postMovement` (../../index.js), never a direct wms.stock_balance INSERT. */
async function seedStockViaReceipt(skuId: string, locationId: string): Promise<void> {
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
        qty: Quantity.of(DEFAULT_SEED_QTY),
        batchNo: '',
        movementType: RECEIPT_MOVEMENT_TYPE,
        uom: DEFAULT_SEED_UOM,
      },
      correlationId,
      performedBy: FIXTURE_ACTOR_UUID,
    },
    ledgerDeps,
  );
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_occsnap_handlers_${randomUUID()}`, 'عميل اختبار معالجات لقطة الإشغال'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;

  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, '1.000', '0.00100') returning id`,
    [fixtureClientId, `OCCSNAP-HANDLERS-${randomUUID()}`, 'صنف اختبار معالجات لقطة الإشغال'],
  );
  fixtureSkuId = (skuResult.rows[0] as { id: string }).id;

  const whResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [entityId, `_OCCSNAP_HDL_${randomUUID()}`, 'مستودع اختبار معالجات لقطة الإشغال'],
  );
  fixtureWarehouseId = (whResult.rows[0] as { id: string }).id;
  const zoneResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, 'A', $2, 'storage') returning id`,
    [fixtureWarehouseId, 'منطقة اختبار'],
  );
  fixtureZoneId = (zoneResult.rows[0] as { id: string }).id;
  // CORRECTION (brief Facts, 13B occupancy_snapshots_grain_uq): a location only counts toward a
  // snapshot when it carries a real space_block_id — set one here so this fixture's stock is
  // actually snapshot-eligible under the corrected (client, space_block) grain.
  const blockResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_blocks (entity_id, warehouse_id, zone_id, code, block_type)
     values ($1, $2, $3, $4, 'pallet_rack') returning id`,
    [entityId, fixtureWarehouseId, fixtureZoneId, `_OCCSNAP_HDL_BLK_${randomUUID()}`],
  );
  fixtureBlockId = (blockResult.rows[0] as { id: string }).id;
  const locationResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.locations (warehouse_id, zone_id, code, location_type, space_block_id) values ($1, $2, 'P1-00-1', 'pallet', $3) returning id`,
    [fixtureWarehouseId, fixtureZoneId, fixtureBlockId],
  );
  fixtureLocationId = (locationResult.rows[0] as { id: string }).id;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_occsnap_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات لقطة الإشغال'],
  );
  await pool.query(`delete from identity.users where id = $1`, [NO_ROLE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [NO_ROLE_ACTOR_UUID, `_occsnap_handlers_norole_${randomUUID()}@test.invalid`, 'ممثل اختبار بلا صلاحية'],
  );
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const userId of [FIXTURE_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    for (const row of allEntitiesResult.rows) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, row.id]);
    }
  }
  // WH_MGR alone (brief D7: TakeOccupancySnapshot is WH_MGR-only).
  const roleResult: QueryResult<{ id: string }> = await pool.query(
    `select id from identity.roles where code = $1`,
    [WH_MGR_ROLE_CODE],
  );
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);

  await seedStockViaReceipt(fixtureSkuId, fixtureLocationId);
});

afterAll(async () => {
  const allOutboxCorrelationIds = [...seedCorrelationIds, ...commandCorrelationIds];
  if (allOutboxCorrelationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [allOutboxCorrelationIds]);
  }
  if (fixtureClientId) {
    await pool.query(`delete from billing.billable_events where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.occupancy_snapshots where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_movements where client_id = $1`, [fixtureClientId]);
    await pool.query(`delete from wms.stock_balance where client_id = $1`, [fixtureClientId]);
  }
  if (fixtureWarehouseId) {
    await pool.query(`delete from wms.locations where warehouse_id = $1`, [fixtureWarehouseId]);
    if (fixtureBlockId) await pool.query(`delete from wms.space_blocks where id = $1`, [fixtureBlockId]);
    await pool.query(`delete from wms.zones where warehouse_id = $1`, [fixtureWarehouseId]);
    await pool.query(`delete from wms.warehouses where id = $1`, [fixtureWarehouseId]);
  }
  if (fixtureSkuId) await pool.query(`delete from wms.skus where id = $1`, [fixtureSkuId]);
  if (extraSkuIds.length > 0) await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [extraSkuIds]);
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
  it('handleTakeOccupancySnapshot: no Idempotency-Key header -> 400, Problem envelope carries a title', async () => {
    const result = await handleTakeOccupancySnapshot(
      requestWithoutKey({ warehouseId: fixtureWarehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleTakeOccupancySnapshot: a body missing warehouseId -> 400, not a thrown exception', async () => {
    const result = await handleTakeOccupancySnapshot(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });
});

describe('a role-gate rejection maps to 422, title = "RoleRequiredError"', () => {
  it('handleTakeOccupancySnapshot: caller with no WH_MGR role -> 422', async () => {
    const result = await handleTakeOccupancySnapshot(
      {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: { warehouseId: fixtureWarehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: randomUUID() },
        ctx: noRoleCtx,
      },
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });
  });
});

describe('the Problem envelope carries { title, status, detail } on every non-2xx response', () => {
  it('handleTakeOccupancySnapshot: the 400 response body (missing Idempotency-Key) has title/status/detail keys', async () => {
    const result = await handleTakeOccupancySnapshot(
      requestWithoutKey({ warehouseId: fixtureWarehouseId, snapshotDate: SNAPSHOT_DATE, correlationId: randomUUID() }),
      deps,
    );
    expect(result.status).toBe(400);
    const body = result.body as Record<string, unknown>;
    expect(typeof body['title']).toBe('string');
    expect('status' in body).toBe(true);
    expect('detail' in body).toBe(true);
  });
});

describe('a successful call returns 200 with the minimal summary body', () => {
  it('handleTakeOccupancySnapshot: { warehouseId, snapshotDate, clientsSnapshotted, clientsInOverflow } — no other keys', async () => {
    const correlationId = randomUUID();
    commandCorrelationIds.push(correlationId); // finding 9: this 200 call writes its own outbox row.
    const result = await handleTakeOccupancySnapshot(
      requestWithKey({ warehouseId: fixtureWarehouseId, snapshotDate: SNAPSHOT_DATE, correlationId }),
      deps,
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return; // unreachable, narrows for TS below.
    const body = result.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['clientsInOverflow', 'clientsSnapshotted', 'snapshotDate', 'warehouseId'].sort());
    expect(body['warehouseId']).toBe(fixtureWarehouseId);
    expect(body['snapshotDate']).toBe(SNAPSHOT_DATE);
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first', () => {
  // round-2 review finding 5: the previous version of this test only added stock for the SAME
  // fixture client between the two calls — since the response body carries only counts
  // (clientsSnapshotted/clientsInOverflow, never pallets_occupied), that change could never move
  // those counts even if the second call genuinely recomputed, so the test proved nothing. Fixed to
  // follow the same approach as ./take-occupancy-snapshot.test.ts's own idempotent-replay
  // integration test: a NEW client starts occupying the warehouse between the two calls — a
  // genuinely-short-circuited replay must still return the FIRST result (clientsSnapshotted
  // unchanged), while a body that actually re-executed would see clientsSnapshotted grow.
  let extraClientId: string | undefined;

  it('handleTakeOccupancySnapshot: identical key + body, with a NEW client gaining stock in between -> identical response (replayed, not recomputed)', async () => {
    const idempotencyKey = randomUUID();
    const correlationId = randomUUID();
    commandCorrelationIds.push(correlationId); // finding 9: the first (executing) call writes an outbox row.
    const body = { warehouseId: fixtureWarehouseId, snapshotDate: SNAPSHOT_DATE, correlationId };

    const first = await handleTakeOccupancySnapshot(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    if (first.status !== 200) return; // unreachable, narrows for TS below.
    const firstBody = first.body as Record<string, unknown>;
    expect(firstBody['clientsSnapshotted']).toBe(1);

    // a NEW client starts occupying the SAME warehouse/block between the two calls — if the second
    // call actually recomputed, clientsSnapshotted would become 2.
    const extraClientResult: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
      [`_occsnap_handlers_replay_${randomUUID()}`, 'عميل إضافي اختبار إعادة تشغيل معالجات لقطة الإشغال'],
    );
    extraClientId = (extraClientResult.rows[0] as { id: string }).id;
    const extraSkuResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
       values ($1, $2, $3, '1.000', '0.00100') returning id`,
      [extraClientId, `OCCSNAP-HANDLERS-REPLAY-${randomUUID()}`, 'صنف اختبار إعادة تشغيل معالجات لقطة الإشغال'],
    );
    const extraSkuId = (extraSkuResult.rows[0] as { id: string }).id;
    extraSkuIds.push(extraSkuId);
    const extraLocationResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.locations (warehouse_id, zone_id, code, location_type, space_block_id) values ($1, $2, 'P1-00-2', 'pallet', $3) returning id`,
      [fixtureWarehouseId, fixtureZoneId, fixtureBlockId],
    );
    const extraLocationId = (extraLocationResult.rows[0] as { id: string }).id;
    const extraCorrelationId = randomUUID();
    seedCorrelationIds.push(extraCorrelationId);
    await postMovement(
      ctx,
      {
        entityId,
        entry: {
          clientId: extraClientId,
          skuId: extraSkuId,
          fromLocationId: null,
          toLocationId: extraLocationId,
          qty: Quantity.of(DEFAULT_SEED_QTY),
          batchNo: '',
          movementType: RECEIPT_MOVEMENT_TYPE,
          uom: DEFAULT_SEED_UOM,
        },
        correlationId: extraCorrelationId,
        performedBy: FIXTURE_ACTOR_UUID,
      },
      ledgerDeps,
    );

    const second = await handleTakeOccupancySnapshot(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);
    if (second.status !== 200) return; // unreachable, narrows for TS below.
    const secondBody = second.body as Record<string, unknown>;
    expect(secondBody['clientsSnapshotted']).toBe(1); // replayed, not recomputed against the new client.
    const newClientSnapshots: QueryResult<{ id: string }> = await pool.query(
      `select id from wms.occupancy_snapshots where client_id = $1 and warehouse_id = $2`,
      [extraClientId, fixtureWarehouseId],
    );
    expect(newClientSnapshots.rows).toHaveLength(0); // the new client's occupancy was never snapshotted.
  });

  afterAll(async () => {
    if (extraClientId) {
      await pool.query(`delete from billing.billable_events where client_id = $1`, [extraClientId]);
      await pool.query(`delete from wms.occupancy_snapshots where client_id = $1`, [extraClientId]);
      await pool.query(`delete from wms.stock_movements where client_id = $1`, [extraClientId]);
      await pool.query(`delete from wms.stock_balance where client_id = $1`, [extraClientId]);
      await pool.query(`delete from wms.skus where client_id = $1`, [extraClientId]);
      await pool.query(`delete from sales.accounts where id = $1`, [extraClientId]);
    }
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleTakeOccupancySnapshot: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const depsWithSpyLogger = createTakeOccupancySnapshotDeps({ clock, ids, logger });
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

    const result = await handleTakeOccupancySnapshot(
      requestWithKey({ warehouseId: fixtureWarehouseId, snapshotDate: SNAPSHOT_DATE, correlationId }),
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

// --- createTakeOccupancySnapshotDeps({ clock, ids, logger }) --------------------------------------

describe('createTakeOccupancySnapshotDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createTakeOccupancySnapshotDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createTakeOccupancySnapshotDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
