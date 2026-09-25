// modules/wms/tests/manage-space/handlers.test.ts — WBS 2.15 (lane 2).
//
// The api/ layer's contract (modules/wms/api/manage-space/handlers.ts), one test per mapping
// (brief: "API-layer tests: Problem envelope mapping, Idempotency-Key required 400, role-gate 422,
// contract validation 400"):
//   - a missing Idempotency-Key -> 400 Problem, for both handleAllocateSpace/handleReserveSpace;
//   - an invalid body (missing blockId, or qty 0 for AllocateSpace) -> 400 Problem, not a thrown
//     exception (Gherkin: "Allocating with a non-positive qty is rejected at the contract... the
//     handler returns a 400 Problem and nothing is written");
//   - a role-gate rejection (caller without SALES_MGR, D5) -> 422 Problem, title =
//     'RoleRequiredError';
//   - the Problem envelope itself: an error response body carries { title, status, detail } (doc
//     40's own Problem shape, same convention as every prior slice's handlers.test.ts);
//   - a successful AllocateSpace call returns 200 and writes one wms.space_allocations row.
//
// Fixture/RLS pattern: same admin-pool style as ./manage-space.test.ts, deliberately minimal (one
// warehouse/zone/block/client/contract) since this file only exercises the API-mapping LAYER, not
// every business scenario (already covered by manage-space.test.ts). platform.audit_log is never
// deleted.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createManageSpaceDeps } from '../../api/manage-space/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — ManageSpaceDeps carries `logger: Logger`
// (../../application/manage-space/ports.js), and createManageSpaceDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger — same
// convention as take-occupancy-snapshot's own handlers.test.ts.
import type { Logger } from '../../application/manage-space/ports.js';

// The module under test — does not exist yet with this error-mapping behaviour (RED).
import { handleAllocateSpace, handleReserveSpace, type ApiRequest } from '../../api/manage-space/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000000215c1'; // SALES_MGR.
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000215c2';
const SALES_MGR_ROLE_CODE = 'SALES_MGR';
const PALLET_UOM = 'pallet';
const RESV_REASON_QUOTE_PENDING = 'quote_pending';
const BLOCK_TYPE_PALLET_RACK = 'pallet_rack';
const TODAY = '2026-09-25';

function daysFrom(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(2151);
const deps = createManageSpaceDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let fixtureClientId: string;
let fixtureContractId: string;
let fixtureWarehouseId: string;
let fixtureZoneId: string;
let fixtureBlockId: string;
const commandCorrelationIds: string[] = [];
// Finding 4: extra block rows created per-test (insertFreshBlock, below) so each error-mapping
// scenario gets a clean sellable figure — tracked here for afterAll cleanup.
const extraBlockIds: string[] = [];

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

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`_mgspace_handlers_${randomUUID()}`, 'عميل اختبار معالجات إدارة المساحة'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;

  const contractResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, start_date)
     values ($1, $2, $3, $4, $5::date) returning id`,
    [entityId, `_MGSPACE-HDL-CT-${randomUUID()}`, fixtureClientId, 'عقد اختبار معالجات إدارة المساحة', TODAY],
  );
  fixtureContractId = (contractResult.rows[0] as { id: string }).id;

  const whResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [entityId, `_MGSPACE_HDL_${randomUUID()}`, 'مستودع اختبار معالجات إدارة المساحة'],
  );
  fixtureWarehouseId = (whResult.rows[0] as { id: string }).id;
  const zoneResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, 'A', $2, 'storage') returning id`,
    [fixtureWarehouseId, 'منطقة اختبار'],
  );
  fixtureZoneId = (zoneResult.rows[0] as { id: string }).id;
  const blockResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_blocks (entity_id, warehouse_id, zone_id, code, block_type, capacity_pallets)
     values ($1, $2, $3, $4, $5, 100) returning id`,
    [entityId, fixtureWarehouseId, fixtureZoneId, `_MGSPACE_HDL_BLK_${randomUUID()}`, BLOCK_TYPE_PALLET_RACK],
  );
  fixtureBlockId = (blockResult.rows[0] as { id: string }).id;

  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_mgspace_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات إدارة المساحة'],
  );
  await pool.query(`delete from identity.users where id = $1`, [NO_ROLE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [NO_ROLE_ACTOR_UUID, `_mgspace_handlers_norole_${randomUUID()}@test.invalid`, 'ممثل اختبار بلا صلاحية'],
  );
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const userId of [FIXTURE_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    for (const row of allEntitiesResult.rows) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, row.id]);
    }
  }
  // SALES_MGR alone (brief D5: AllocateSpace/ReserveSpace are SALES_MGR-only). NO_ROLE_ACTOR_UUID
  // deliberately gets no identity.user_roles row at all.
  const roleResult: QueryResult<{ id: string }> = await pool.query(
    `select id from identity.roles where code = $1`,
    [SALES_MGR_ROLE_CODE],
  );
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [
    FIXTURE_ACTOR_UUID,
    (roleResult.rows[0] as { id: string }).id,
  ]);
});

afterAll(async () => {
  if (commandCorrelationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [commandCorrelationIds]);
  }
  if (fixtureBlockId) {
    await pool.query(`delete from wms.space_reservations where block_id = $1`, [fixtureBlockId]);
    await pool.query(`delete from wms.space_allocations where block_id = $1`, [fixtureBlockId]);
    await pool.query(`delete from wms.space_blocks where id = $1`, [fixtureBlockId]);
  }
  if (extraBlockIds.length > 0) {
    await pool.query(`delete from wms.space_reservations where block_id = any($1::uuid[])`, [extraBlockIds]);
    await pool.query(`delete from wms.space_allocations where block_id = any($1::uuid[])`, [extraBlockIds]);
    await pool.query(`delete from wms.space_blocks where id = any($1::uuid[])`, [extraBlockIds]);
  }
  if (fixtureWarehouseId) {
    await pool.query(`delete from wms.zones where warehouse_id = $1`, [fixtureWarehouseId]);
    await pool.query(`delete from wms.warehouses where id = $1`, [fixtureWarehouseId]);
  }
  if (fixtureContractId) await pool.query(`delete from sales.contracts where id = $1`, [fixtureContractId]);
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
  it('handleAllocateSpace: no Idempotency-Key header -> 400, Problem envelope carries a title', async () => {
    const result = await handleAllocateSpace(
      requestWithoutKey({
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId: fixtureBlockId,
        qty: 10,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });

  it('handleReserveSpace: no Idempotency-Key header -> 400', async () => {
    const result = await handleReserveSpace(
      requestWithoutKey({
        blockId: fixtureBlockId,
        clientId: fixtureClientId,
        qty: 10,
        uom: PALLET_UOM,
        reservedFrom: TODAY,
        expiresAt: daysFrom(TODAY, 10),
        reason: RESV_REASON_QUOTE_PENDING,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('an invalid body is rejected with a 400 Problem, not a thrown exception', () => {
  it('handleAllocateSpace: a body missing blockId -> 400', async () => {
    const result = await handleAllocateSpace(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleAllocateSpace: qty 0 (Gherkin — "rejected at the contract") -> 400, nothing written', async () => {
    const result = await handleAllocateSpace(
      requestWithKey({
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId: fixtureBlockId,
        qty: 0,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);

    const rows: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.space_allocations where block_id = $1 and qty = 0`,
      [fixtureBlockId],
    );
    expect(Number(rows.rows[0]?.n ?? '0')).toBe(0);
  });

  it('handleReserveSpace: a body missing blockId -> 400', async () => {
    const result = await handleReserveSpace(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });
});

describe('a role-gate rejection maps to 422, title = "RoleRequiredError"', () => {
  it('handleAllocateSpace: caller with no SALES_MGR role -> 422', async () => {
    const result = await handleAllocateSpace(
      {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: {
          contractId: fixtureContractId,
          clientId: fixtureClientId,
          blockId: fixtureBlockId,
          qty: 10,
          uom: PALLET_UOM,
          validFrom: TODAY,
          correlationId: randomUUID(),
        },
        ctx: noRoleCtx,
      },
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });
  });

  it('handleReserveSpace: caller with no SALES_MGR role -> 422', async () => {
    const result = await handleReserveSpace(
      {
        headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() },
        body: {
          blockId: fixtureBlockId,
          clientId: fixtureClientId,
          qty: 10,
          uom: PALLET_UOM,
          reservedFrom: TODAY,
          expiresAt: daysFrom(TODAY, 10),
          reason: RESV_REASON_QUOTE_PENDING,
          correlationId: randomUUID(),
        },
        ctx: noRoleCtx,
      },
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'RoleRequiredError' });
  });
});

describe('the Problem envelope carries { title, status, detail } on every non-2xx response', () => {
  it('handleAllocateSpace: the 400 response body (missing Idempotency-Key) has title/status/detail keys', async () => {
    const result = await handleAllocateSpace(
      requestWithoutKey({
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId: fixtureBlockId,
        qty: 10,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(400);
    const body = result.body as Record<string, unknown>;
    expect(typeof body['title']).toBe('string');
    expect('status' in body).toBe(true);
    expect('detail' in body).toBe(true);
  });
});

// --- Finding 4: 422 + correct Problem `title` for SpaceNotAvailableError, ReservationTooLongError,
//     ReservationDateRangeInvalidError -----------------------------------------------------------
//
// round-1 review finding 4: strengthen the domain-level SpaceNotAvailableError assertion in
// ./manage-space.test.ts AND assert, at the api/ layer, that every one of the three business-rule
// errors this use case can throw maps to 422 with `title` === the error's own `.name` (never
// InternalServerError / 500 — these are typed, expected rejections, not unknown failures).

async function insertFreshBlock(capacityPallets = 100): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.space_blocks (entity_id, warehouse_id, zone_id, code, block_type, capacity_pallets)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [entityId, fixtureWarehouseId, fixtureZoneId, `_MGSPACE_HDL_F4_${randomUUID()}`, BLOCK_TYPE_PALLET_RACK, capacityPallets],
  );
  const id = (result.rows[0] as { id: string }).id;
  extraBlockIds.push(id);
  return id;
}

describe('Finding 4: SpaceNotAvailableError/ReservationTooLongError/ReservationDateRangeInvalidError all map to 422 with the correct Problem title', () => {
  it('handleAllocateSpace: over-capacity -> 422, title "SpaceNotAvailableError"', async () => {
    const blockId = await insertFreshBlock(100);
    const firstCorrelationId = randomUUID();
    commandCorrelationIds.push(firstCorrelationId);
    const first = await handleAllocateSpace(
      requestWithKey({
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        qty: 70,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId: firstCorrelationId,
      }),
      deps,
    );
    expect(first.status).toBe(200);

    const secondCorrelationId = randomUUID();
    const second = await handleAllocateSpace(
      requestWithKey({
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId,
        qty: 40, // 70 + 40 = 110 > 100.
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId: secondCorrelationId,
      }),
      deps,
    );
    expect(second.status).toBe(422);
    expect(second.body).toMatchObject({ title: 'SpaceNotAvailableError', status: 422 });
  });

  it('handleReserveSpace: a 45-day reservation (threshold 30 days) -> 422, title "ReservationTooLongError"', async () => {
    const blockId = await insertFreshBlock(100);
    const result = await handleReserveSpace(
      requestWithKey({
        blockId,
        clientId: fixtureClientId,
        qty: 10,
        uom: PALLET_UOM,
        reservedFrom: TODAY,
        expiresAt: daysFrom(TODAY, 45),
        reason: RESV_REASON_QUOTE_PENDING,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'ReservationTooLongError', status: 422 });
  });

  it('handleReserveSpace: expiresAt === reservedFrom (zero duration) -> 422, title "ReservationDateRangeInvalidError"', async () => {
    const blockId = await insertFreshBlock(100);
    const result = await handleReserveSpace(
      requestWithKey({
        blockId,
        clientId: fixtureClientId,
        qty: 10,
        uom: PALLET_UOM,
        reservedFrom: TODAY,
        expiresAt: TODAY, // zero duration — distinct from the 30-day threshold above.
        reason: RESV_REASON_QUOTE_PENDING,
        correlationId: randomUUID(),
      }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'ReservationDateRangeInvalidError', status: 422 });
  });
});

describe('a successful AllocateSpace call returns 200 and writes one row', () => {
  it('handleAllocateSpace: valid body, Idempotency-Key present -> 200, one wms.space_allocations row', async () => {
    const correlationId = randomUUID();
    commandCorrelationIds.push(correlationId);
    const result = await handleAllocateSpace(
      requestWithKey({
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId: fixtureBlockId,
        qty: 12,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId,
      }),
      deps,
    );
    expect(result.status).toBe(200);

    const rows: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.space_allocations where block_id = $1 and qty = 12`,
      [fixtureBlockId],
    );
    expect(Number(rows.rows[0]?.n ?? '0')).toBe(1);
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleAllocateSpace: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const logger = spyLogger();
    const depsWithSpyLogger = createManageSpaceDeps({ clock, ids, logger });
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

    const result = await handleAllocateSpace(
      requestWithKey({
        contractId: fixtureContractId,
        clientId: fixtureClientId,
        blockId: fixtureBlockId,
        qty: 5,
        uom: PALLET_UOM,
        validFrom: TODAY,
        correlationId,
      }),
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

// --- createManageSpaceDeps({ clock, ids, logger }) ------------------------------------------------

describe('createManageSpaceDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createManageSpaceDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createManageSpaceDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});
