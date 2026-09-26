// modules/wms/tests/process-outbound/handlers.test.ts — WBS 2.11 part 1.
//
// The api layer's contract (modules/wms/api/process-outbound/handlers.ts), one test per mapping
// (brief Master decision 8):
//   - a missing Idempotency-Key -> 400 Problem (CLAUDE.md ARCHITECTURE: "Every write endpoint
//     requires an Idempotency-Key");
//   - an invalid body (Zod) -> 400 Problem;
//   - StaleVersionError -> 409, IdempotencyConflictError -> 409;
//   - every other typed domain error (IllegalTransitionError, RoleRequiredError,
//     OrderNotFoundError, every one of the nine condition errors, ClientNotQualifiedError) -> 422;
//   - an unknown error -> 500, generic detail, logged via deps.logger.error, never a bare throw.
//   - title = error.name in every Problem body.
//
// Fixture/RLS pattern: same admin-pool style as ./process-outbound.test.ts, deliberately minimal
// (one client, one priced contract, one SKU, one order) since this file only exercises the
// API-mapping LAYER, not every business scenario (already covered by process-outbound.test.ts).
// platform.audit_log is never deleted.

import { randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { createProcessOutboundDeps } from '../../api/process-outbound/composition.js';
import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
// A Logger port-shaped spy — ProcessOutboundDeps carries `logger: Logger`
// (../../application/process-outbound/ports.ts), and createProcessOutboundDeps({ clock, ids, logger })
// accepts an injected one instead of always defaulting to a real pino-backed logger.
import type { IncrementLotAllocatedParams, Logger } from '../../application/process-outbound/ports.js';
// G1 fix (same as ./process-outbound.test.ts's own seedStockViaReceipt): stock is seeded through a
// REAL 'receipt' movement via the module's own public postMovement — never a direct
// wms.stock_balance INSERT, which leaves a ledgerless balance row and fails guard G1
// (wms.verify_balance_integrity()).
import { postMovement, type LedgerDeps } from '../../index.js';
import { StockBalanceRowMissingError } from '../../domain/process-outbound/errors.js';

// The module under test — does not exist yet with this error-mapping behaviour (RED).
// handleAllocate/handleGeneratePickList are WBS 2.11 part 2's own additions to this barrel
// (_slice-2.11.brief.md part 2, Master decisions 2/3/5) — RED until pg-backend adds them.
import {
  handleAllocate,
  handleApproveOutbound,
  handleCancelOutbound,
  handleCheckOrder,
  handleCreateOutbound,
  handleGeneratePickList,
  handleLoadOrder,
  handlePackOrder,
  handlePickLine,
  handleRunOutboundChecks,
  type ApiRequest,
} from '../../api/process-outbound/handlers.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// pg-reviewer round 2 finding 1 (parallel-safety): a per-RUN random actor id, never a fixed UUID —
// concurrent runs never share, delete or re-create each other's identity.users row.
const FIXTURE_ACTOR_UUID = randomUUID();
// WBS 2.12 part 4 fix round finding 3: PackOrder's own setup needs an order walked to 'checked' —
// CheckOrder's own self-check gate (2.12 part 2) refuses a checker who is also the order's
// `picked_by`, so a SECOND actor is needed to reach 'checked' at all in this file (every earlier
// handleCheckOrder test here either fails fast on a 400/409 before the gate runs, or deliberately
// reuses FIXTURE_ACTOR_UUID to exercise the gate itself — neither path reaches 'checked').
const CHECKER_ACTOR_UUID = randomUUID();
const WH_MGR_ROLE_CODE = 'WH_MGR';
const SERVICE_CODE = 'OF-01';
// pg-reviewer round 2 finding 8: fixture dates (price_lists.valid_from, contracts.start_date) are
// derived in SQL from this SAME fixed clock date, passed as a bound parameter — never current_date.
const CLOCK_DATE = '2026-09-25';
const clock = new FixedClock(new Date(`${CLOCK_DATE}T00:00:00.000Z`));
const ids = new SequentialIdGenerator(2111);
const deps = createProcessOutboundDeps({ clock, ids });
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };
const checkerCtx = { userId: CHECKER_ACTOR_UUID, clientId: null, isInternal: true };
const ledgerDeps: LedgerDeps = { clock, ids: new SequentialIdGenerator(21115) };
const RECEIPT_MOVEMENT_TYPE = 'receipt';
// afterAll unwinds every fixture row this run created (FK-safe order, many tables) — same
// headroom-over-the-default-10s-hook-timeout reasoning as stock-ledger.test.ts's own
// CONCURRENCY_TEST_TIMEOUT_MS (modules/wms/tests/integration/stock-ledger.test.ts).
const CLEANUP_HOOK_TIMEOUT_MS = 30000;

let entityId: string;
let warehouseId: string;
let serviceId: string;
let priceListId: string;
let fixtureClientId: string;
let fixtureContractId: string;
let fixtureSkuId: string;
let fixtureZoneId: string;
let fixtureLocationId: string;
let checksPendingOrderId: string;
let checksPendingOrderVersion: number;
const extraOrderIds: string[] = [];
const extraContractIds: string[] = [];
const extraPriceListIds: string[] = [];
const usedCorrelationIds = new Set<string>();

/** Every correlationId this run hands to a command or to postMovement — afterAll deletes exactly
 *  those platform.outbox rows (same discipline as ./process-outbound.test.ts). */
function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

// pg-reviewer round 2 finding 1: this file creates its OWN zone + location — never a
// `select ... from wms.locations ... limit 1` over shared rows (which picked up another test
// file's temporary location and caused FK collisions on cleanup). Location code: the 'M9-' block
// this slice owns (019-Warehouse-WH1-Setup.sql:59 chk_locations_code_format
// `^[PGMT][1-9]-[0-9]{2}-[1-9]$`; WH1's real layout uses P1-P3/G1-G5/M1-M5/T1-T5, 'T9-' is WBS
// 2.10's fixture block), picked at random and claimed with `on conflict (warehouse_id, code) do
// nothing` — the table's own unique constraint arbitrates between concurrent runs, same scheme as
// ./process-outbound.test.ts's insertLocation.
const FIXTURE_LOCATION_PREFIX = 'M9';
const FIXTURE_LOCATION_SEQ_COUNT = 100;
const FIXTURE_LOCATION_LEVEL_COUNT = 9;
const FIXTURE_LOCATION_MAX_ATTEMPTS = 200;

function randomFixtureLocationCode(): string {
  const [seqByte = 0, levelByte = 0] = randomBytes(2);
  const seq = String(seqByte % FIXTURE_LOCATION_SEQ_COUNT).padStart(2, '0');
  const level = (levelByte % FIXTURE_LOCATION_LEVEL_COUNT) + 1;
  return `${FIXTURE_LOCATION_PREFIX}-${seq}-${level}`;
}

async function insertOwnLocation(zoneId: string): Promise<string> {
  for (let attempt = 0; attempt < FIXTURE_LOCATION_MAX_ATTEMPTS; attempt += 1) {
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.locations (warehouse_id, zone_id, code, location_type)
       values ($1, $2, $3, 'pallet')
       on conflict (warehouse_id, code) do nothing
       returning id`,
      [warehouseId, zoneId, randomFixtureLocationCode()],
    );
    const row = result.rows[0];
    if (row) return row.id;
  }
  throw new Error(`no free ${FIXTURE_LOCATION_PREFIX}-xx-x fixture location code after ${FIXTURE_LOCATION_MAX_ATTEMPTS} attempts`);
}

/** Every cleanup statement runs even if an earlier one throws (finding 1) — failures are collected
 *  and re-thrown together, so a broken cleanup is loud but never leaves later tables uncleaned. */
async function runCleanupSteps(steps: ReadonlyArray<readonly [string, () => Promise<unknown>]>): Promise<void> {
  const failures: string[] = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (err: unknown) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(`fixture cleanup failed:\n${failures.join('\n')}`);
}

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

/** A fresh draft order (own client/contract/SKU/stock so its checks pass), independent of the
 *  shared `checksPendingOrderId` fixture — replay tests approve their own order so replaying never
 *  collides with another test's already-bumped version. */
async function insertFreshChecksPendingOrder(): Promise<{ id: string; version: number }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'OUT') as doc_no`, [entityId]);
  const orderResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.outbound_orders
       (entity_id, doc_no, client_id, contract_id, warehouse_id, order_type, status,
        credit_check_passed, credit_checked_at, ship_to_name, ship_to_phone, ship_to_address, ship_to_area)
     values ($1, $2, $3, $4, $5, 'standard', 'checks_pending', true, now(), 'x', 'x', 'x', 'x')
     returning id, version`,
    [entityId, docNoResult.rows[0]?.doc_no, fixtureClientId, fixtureContractId, warehouseId],
  );
  const row = orderResult.rows[0] as { id: string; version: number };
  extraOrderIds.push(row.id);
  return row;
}

/** WBS 2.11 part 2: a fresh order forced directly to 'approved' (bypassing RunOutboundChecks/
 *  ApproveOutbound — same shortcut insertFreshChecksPendingOrder already takes for 'checks_pending'),
 *  carrying ONE order_line for fixtureSkuId, with enough stock posted at fixtureLocationId (via the
 *  real ledger, G1) to allocate it in full. */
async function insertFreshApprovedOrderWithLine(qtyOrdered = '1.000'): Promise<{ id: string; version: number; lineId: string }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'OUT') as doc_no`, [entityId]);
  const orderResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.outbound_orders
       (entity_id, doc_no, client_id, contract_id, warehouse_id, order_type, status,
        credit_check_passed, credit_checked_at, ship_to_name, ship_to_phone, ship_to_address, ship_to_area)
     values ($1, $2, $3, $4, $5, 'standard', 'approved', true, now(), 'x', 'x', 'x', 'x')
     returning id, version`,
    [entityId, docNoResult.rows[0]?.doc_no, fixtureClientId, fixtureContractId, warehouseId],
  );
  const row = orderResult.rows[0] as { id: string; version: number };
  extraOrderIds.push(row.id);

  const lineResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
     values ('wms.outbound_orders', $1, 1, $2, $3::numeric, 'EA') returning id`,
    [row.id, fixtureSkuId, qtyOrdered],
  );
  const lineRow = lineResult.rows[0] as { id: string };

  await postMovement(
    ctx,
    {
      entityId,
      entry: {
        clientId: fixtureClientId,
        skuId: fixtureSkuId,
        fromLocationId: null,
        toLocationId: fixtureLocationId,
        qty: Quantity.of(qtyOrdered),
        batchNo: '',
        movementType: RECEIPT_MOVEMENT_TYPE,
        uom: 'EA',
      },
      correlationId: nextCorrelationId(),
      performedBy: FIXTURE_ACTOR_UUID,
    },
    ledgerDeps,
  );

  return { id: row.id, version: row.version, lineId: lineRow.id };
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PST']);
  entityId = (entityResult.rows[0] as { id: string }).id;

  const warehouseResult: QueryResult<{ id: string }> = await pool.query(`select id from wms.warehouses where code = 'WH1'`);
  warehouseId = (warehouseResult.rows[0] as { id: string }).id;

  const serviceResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [SERVICE_CODE]);
  serviceId = (serviceResult.rows[0] as { id: string }).id;

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, status) values ($1, $2, 'client', 'active') returning id`,
    [`_procout_handlers_${randomUUID()}`, 'عميل اختبار معالجات الصرف'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;

  const priceListResult: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_lists (entity_id, code, name_ar, valid_from, status)
     values ($1, $2, $3, $4::date - interval '1 year', 'active') returning id`,
    [entityId, `_procout_handlers_pl_${randomUUID()}`, 'قائمة تسعير اختبار معالجات الصرف', CLOCK_DATE],
  );
  priceListId = (priceListResult.rows[0] as { id: string }).id;
  await pool.query(`insert into catalog.price_list_lines (price_list_id, service_id, price) values ($1, $2, '25.000')`, [
    priceListId,
    serviceId,
  ]);

  const docNoCntResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'CNT') as doc_no`, [entityId]);
  const contractResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, status, start_date, price_list_id)
     values ($1, $2, $3, $4, 'active', $6::date - interval '1 year', $5) returning id`,
    [entityId, docNoCntResult.rows[0]?.doc_no, fixtureClientId, 'عقد اختبار معالجات الصرف', priceListId, CLOCK_DATE],
  );
  fixtureContractId = (contractResult.rows[0] as { id: string }).id;

  // gross_weight_kg is REQUIRED once stock is seeded through the real ledger (G1 fix): postMovement
  // refuses a receipt into any weight-limited location for a SKU with no gross_weight_kg set (D3,
  // src/stock-ledger/post-movement.ts's own checkLocationLimits).
  const skuResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm) values ($1, $2, $3, '1.000', '0.00100') returning id`,
    [fixtureClientId, `PROCOUT-HANDLERS-${randomUUID()}`, 'صنف اختبار معالجات الصرف'],
  );
  fixtureSkuId = (skuResult.rows[0] as { id: string }).id;

  const zoneResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, $2, $3, 'storage') returning id`,
    [warehouseId, `_procout_zone_handlers_${randomUUID().slice(0, 8)}`, 'منطقة اختبار معالجات الصرف'],
  );
  fixtureZoneId = (zoneResult.rows[0] as { id: string }).id;
  fixtureLocationId = await insertOwnLocation(fixtureZoneId);

  const order = await insertFreshChecksPendingOrder();
  checksPendingOrderId = order.id;
  checksPendingOrderVersion = order.version;

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_procout_handlers_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار معالجات الصرف'],
  );
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const row of allEntitiesResult.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [FIXTURE_ACTOR_UUID, row.id]);
  }
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [WH_MGR_ROLE_CODE]);
  const roleId = (roleResult.rows[0] as { id: string }).id;
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [FIXTURE_ACTOR_UUID, roleId]);

  // CHECKER_ACTOR_UUID: a second internal WH_MGR-capable actor, distinct from FIXTURE_ACTOR_UUID —
  // CheckOrder's own self-check gate (see the comment at CHECKER_ACTOR_UUID's declaration).
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [CHECKER_ACTOR_UUID, `_procout_handlers_checker_${randomUUID()}@test.invalid`, 'مدقق اختبار معالجات الصرف'],
  );
  for (const row of allEntitiesResult.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [CHECKER_ACTOR_UUID, row.id]);
  }
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [CHECKER_ACTOR_UUID, roleId]);
});

afterAll(async () => {
  const orderIds = [checksPendingOrderId, ...extraOrderIds].filter((id): id is string => Boolean(id));
  const contractIds = [fixtureContractId, ...extraContractIds].filter((id): id is string => Boolean(id));
  const priceListIds = [priceListId, ...extraPriceListIds].filter((id): id is string => Boolean(id));
  const clientIds = [fixtureClientId].filter((id): id is string => Boolean(id));
  try {
    // FK-safe order (finding 1): outbox → stock_movements → stock_balance → order_lines → outbound_orders →
    // locations → zones → skus → contracts (contracts.price_list_id FKs price_lists, so contracts
    // go first) → price_list_lines → price_lists → accounts → identity rows. Only ids this run
    // created — never a prefix-wide delete.
    await runCleanupSteps([
      ['platform.outbox', () => pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]])],
      ['wms.stock_movements', () => pool.query(`delete from wms.stock_movements where client_id = any($1::uuid[])`, [clientIds])],
      ['wms.stock_balance', () => pool.query(`delete from wms.stock_balance where client_id = any($1::uuid[])`, [clientIds])],
      ['wms.order_lines', () => pool.query(`delete from wms.order_lines where order_id = any($1::uuid[])`, [orderIds])],
      ['wms.outbound_orders', () => pool.query(`delete from wms.outbound_orders where id = any($1::uuid[])`, [orderIds])],
      ['wms.locations', () => pool.query(`delete from wms.locations where id = any($1::uuid[])`, [[fixtureLocationId].filter(Boolean)])],
      ['wms.zones', () => pool.query(`delete from wms.zones where id = any($1::uuid[])`, [[fixtureZoneId].filter(Boolean)])],
      ['wms.skus', () => pool.query(`delete from wms.skus where id = any($1::uuid[])`, [[fixtureSkuId].filter(Boolean)])],
      ['sales.contracts', () => pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [contractIds])],
      ['catalog.price_list_lines', () => pool.query(`delete from catalog.price_list_lines where price_list_id = any($1::uuid[])`, [priceListIds])],
      ['catalog.price_lists', () => pool.query(`delete from catalog.price_lists where id = any($1::uuid[])`, [priceListIds])],
      ['sales.accounts', () => pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [clientIds])],
      ['platform.idempotency_keys', () => pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [[FIXTURE_ACTOR_UUID, CHECKER_ACTOR_UUID]])],
      ['identity.user_roles', () => pool.query(`delete from identity.user_roles where user_id = any($1::uuid[])`, [[FIXTURE_ACTOR_UUID, CHECKER_ACTOR_UUID]])],
      ['identity.user_entities', () => pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [[FIXTURE_ACTOR_UUID, CHECKER_ACTOR_UUID]])],
      ['identity.users', () => pool.query(`delete from identity.users where id = any($1::uuid[])`, [[FIXTURE_ACTOR_UUID, CHECKER_ACTOR_UUID]])],
    ]);
  } finally {
    await pool.end();
  }
}, CLEANUP_HOOK_TIMEOUT_MS);

describe('a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('handleApproveOutbound: no Idempotency-Key header -> 400, title reflects the rejection', async () => {
    const result = await handleApproveOutbound(
      requestWithoutKey({ orderId: checksPendingOrderId, expectedVersion: checksPendingOrderVersion, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(400);
    expect('body' in result && 'title' in result.body).toBe(true);
  });
});

describe('an invalid body is rejected with a 400 Problem', () => {
  it('handleCreateOutbound: a body missing required fields -> 400, not a thrown exception', async () => {
    const result = await handleCreateOutbound(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });

  it('handleApproveOutbound: a body missing required fields -> 400', async () => {
    const result = await handleApproveOutbound(requestWithKey({}), deps);
    expect(result.status).toBe(400);
  });
});

describe('StaleVersionError maps to 409, title = error.name', () => {
  it('handleApproveOutbound: a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const result = await handleApproveOutbound(
      requestWithKey({ orderId: checksPendingOrderId, expectedVersion: checksPendingOrderVersion + 999, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('IllegalTransitionError maps to 422, title = error.name', () => {
  it('handleApproveOutbound on a still-draft order -> 422, title "IllegalTransitionError"', async () => {
    const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'OUT') as doc_no`, [entityId]);
    const draftResult: QueryResult<{ id: string; version: number }> = await pool.query(
      `insert into wms.outbound_orders (entity_id, doc_no, client_id, contract_id, warehouse_id, order_type, status)
       values ($1, $2, $3, $4, $5, 'standard', 'draft') returning id, version`,
      [entityId, docNoResult.rows[0]?.doc_no, fixtureClientId, fixtureContractId, warehouseId],
    );
    const draft = draftResult.rows[0] as { id: string; version: number };
    extraOrderIds.push(draft.id);

    const result = await handleApproveOutbound(
      requestWithKey({ orderId: draft.id, expectedVersion: draft.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });
});

describe('a missing (or RLS-hidden) order maps to a typed 422 Problem, never a 500', () => {
  it('handleApproveOutbound against a non-existent orderId -> 422 OrderNotFoundError', async () => {
    const result = await handleApproveOutbound(
      requestWithKey({ orderId: randomUUID(), expectedVersion: 1, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'OrderNotFoundError' });
  });
});

describe('a condition-check failure maps to 422 carrying the i18n key + params in the Problem body', () => {
  it('handleRunOutboundChecks: no price for OF-01 -> 422, title "NoServicePriceError", i18nKey in the body', async () => {
    const docNoPlResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'CNT') as doc_no`, [entityId]);
    const unpricedPriceListResult: QueryResult<{ id: string }> = await pool.query(
      `insert into catalog.price_lists (entity_id, code, name_ar, valid_from, status)
       values ($1, $2, $3, $4::date - interval '1 year', 'active') returning id`,
      [entityId, `_procout_handlers_unpriced_${randomUUID()}`, 'قائمة بدون سعر', CLOCK_DATE],
    );
    const unpricedPriceListId = (unpricedPriceListResult.rows[0] as { id: string }).id;
    extraPriceListIds.push(unpricedPriceListId);
    const unpricedContractResult: QueryResult<{ id: string }> = await pool.query(
      `insert into sales.contracts (entity_id, doc_no, account_id, title, status, start_date, price_list_id)
       values ($1, $2, $3, $4, 'active', $6::date - interval '1 year', $5) returning id`,
      [entityId, docNoPlResult.rows[0]?.doc_no, fixtureClientId, 'عقد بدون سعر', unpricedPriceListId, CLOCK_DATE],
    );
    const unpricedContractId = (unpricedContractResult.rows[0] as { id: string }).id;
    extraContractIds.push(unpricedContractId);
    const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, 'OUT') as doc_no`, [entityId]);
    const draftResult: QueryResult<{ id: string; version: number }> = await pool.query(
      `insert into wms.outbound_orders
         (entity_id, doc_no, client_id, contract_id, warehouse_id, order_type, status, ship_to_name, ship_to_phone, ship_to_address, ship_to_area)
       values ($1, $2, $3, $4, $5, 'standard', 'draft', 'x', 'x', 'x', 'x') returning id, version`,
      [entityId, docNoResult.rows[0]?.doc_no, fixtureClientId, unpricedContractId, warehouseId],
    );
    const draft = draftResult.rows[0] as { id: string; version: number };
    // Tracked like every other fixture row — afterAll deletes orders (and lines) before the
    // contracts they FK to, before the price lists those FK to (finding 1 FK-safe order).
    extraOrderIds.push(draft.id);
    await pool.query(
      `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom) values ('wms.outbound_orders', $1, 1, $2, '1.000', 'EA')`,
      [draft.id, fixtureSkuId],
    );
    // Stock goes into THIS file's own location (finding 1) — never a shared WH1 row.
    await postMovement(
      ctx,
      {
        entityId,
        entry: {
          clientId: fixtureClientId,
          skuId: fixtureSkuId,
          fromLocationId: null,
          toLocationId: fixtureLocationId,
          qty: Quantity.of('10.000'),
          batchNo: '',
          movementType: RECEIPT_MOVEMENT_TYPE,
          uom: 'EA',
        },
        correlationId: nextCorrelationId(),
        performedBy: FIXTURE_ACTOR_UUID,
      },
      ledgerDeps,
    );

    const result = await handleRunOutboundChecks(
      requestWithKey({ orderId: draft.id, expectedVersion: draft.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'NoServicePriceError' });
    expect(JSON.stringify(result.body)).toMatch(/wms\.outbound\.check\.noServicePrice/);
  });
});

describe('CancelOutbound without a reason maps to a 4xx Problem, never a bare throw', () => {
  it('handleCancelOutbound: missing reason -> 4xx Problem', async () => {
    const order = await insertFreshChecksPendingOrder();
    const result = await handleCancelOutbound(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });
});

// --- Idempotency-Key REPLAY --------------------------------------------------------------------

describe('the same Idempotency-Key and body twice: the second response equals the first and the command ran once', () => {
  it('handleApproveOutbound: identical key + body -> identical response, version bumped exactly once', async () => {
    const order = await insertFreshChecksPendingOrder();
    const idempotencyKey = randomUUID();
    const body = { orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() };

    const first = await handleApproveOutbound(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const second = await handleApproveOutbound(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const versionResult: QueryResult<{ version: number }> = await pool.query(`select version from wms.outbound_orders where id = $1`, [order.id]);
    expect(versionResult.rows[0]?.version).toBe((order.version as number) + 1); // bumped once.
  });

  it('handleApproveOutbound: the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const order = await insertFreshChecksPendingOrder();
    const idempotencyKey = randomUUID();
    const body = { orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() };

    const first = await handleApproveOutbound(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = { orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() };
    const result = await handleApproveOutbound(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

// --- Unknown (500) error is logged, never sent to the client ------------------------------------

describe('an unknown error maps to 500 with a generic detail, and is logged through deps.logger.error', () => {
  it('handleApproveOutbound: an unexpected repository failure -> 500, generic detail, logger.error receives { correlationId, err: <the Error object> }', async () => {
    const order = await insertFreshChecksPendingOrder();
    const logger = spyLogger();
    const depsWithSpyLogger = createProcessOutboundDeps({ clock, ids, logger });
    const thrown = new TypeError('unexpected repository failure — never sent to the client');
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        getOrderForUpdate: async (): Promise<never> => {
          throw thrown;
        },
      },
    };
    const correlationId = nextCorrelationId();

    const result = await handleApproveOutbound(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId }),
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

// --- createProcessOutboundDeps({ clock, ids, logger }) --------------------------------------------

describe('createProcessOutboundDeps accepts an injected logger', () => {
  it('deps.logger is the exact injected spy, not a default pino instance', () => {
    const logger = spyLogger();
    const injectedDeps = createProcessOutboundDeps({ clock, ids, logger });
    expect(injectedDeps.logger).toBe(logger);
  });

  it('deps.logger defaults to a logger implementing the Logger port when none is injected', () => {
    const defaultDeps = createProcessOutboundDeps({ clock, ids });
    expect(typeof defaultDeps.logger?.error).toBe('function');
    expect(typeof defaultDeps.logger?.info).toBe('function');
  });
});

// --- WBS 2.11 part 2: handleAllocate / handleGeneratePickList wiring (_slice-2.11.brief.md part 2,
// Master decisions 2/3/5) — RED until pg-backend adds both handlers + composition wiring. ----------

describe('handleAllocate: a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('no Idempotency-Key header -> 400', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const result = await handleAllocate(
      requestWithoutKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('handleAllocate: IllegalTransitionError before approval maps to 422', () => {
  it('a still-checks_pending order -> 422, title "IllegalTransitionError"', async () => {
    const order = await insertFreshChecksPendingOrder();
    const result = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });
});

describe('handleAllocate: StaleVersionError maps to 409', () => {
  it('a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const result = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version + 999, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('handleAllocate: a successful full allocation maps to 200, status "allocated"', () => {
  it('an approved order with sufficient stock -> 200', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const result = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(200);
    expect('body' in result ? result.body : null).toMatchObject({ status: 'allocated' });
  });
});

describe('handleAllocate: the same Idempotency-Key and body twice replays the first response', () => {
  it('identical key + body -> identical response, version bumped exactly once', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const idempotencyKey = randomUUID();
    const body = { orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() };

    const first = await handleAllocate(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);
    const second = await handleAllocate(requestWithKey(body, idempotencyKey), deps);
    expect(second).toEqual(first);

    const versionResult: QueryResult<{ version: number }> = await pool.query(`select version from wms.outbound_orders where id = $1`, [order.id]);
    expect(versionResult.rows[0]?.version).toBe((order.version as number) + 1);
  });

  it('the same key with a DIFFERENT body -> 409 IdempotencyConflictError', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const idempotencyKey = randomUUID();
    const body = { orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() };
    const first = await handleAllocate(requestWithKey(body, idempotencyKey), deps);
    expect(first.status).toBe(200);

    const differentBody = { orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() };
    const result = await handleAllocate(requestWithKey(differentBody, idempotencyKey), deps);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'IdempotencyConflictError' });
  });
});

describe('handleGeneratePickList: illegal before allocation maps to 422', () => {
  it('an approved-but-not-yet-allocated order -> 422, title "IllegalTransitionError"', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const result = await handleGeneratePickList(
      requestWithoutKey({ orderId: order.id, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'IllegalTransitionError' });
  });
});

describe('handleGeneratePickList: read-only, works WITHOUT an Idempotency-Key header (Master decision 5)', () => {
  it('an allocated order -> 200, no Idempotency-Key required', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const allocateResult = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(allocateResult.status).toBe(200);

    const result = await handleGeneratePickList(
      requestWithoutKey({ orderId: order.id, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(200);
  });
});

// --- WBS 2.12 part 1, fix round 1 finding 8: handlePickLine / handleCheckOrder coverage (same
// missing-Idempotency-Key / typed-domain-error / stale-version pattern as every earlier command in
// this file). -----------------------------------------------------------------------------------

describe('handlePickLine: a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('no Idempotency-Key header -> 400', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const allocateResult = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(allocateResult.status).toBe(200);
    const allocatedVersion = (allocateResult.body as { version: number }).version;

    const result = await handlePickLine(
      requestWithoutKey({ orderId: order.id, lineId: order.lineId, expectedVersion: allocatedVersion, qtyActual: '1.000', correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('handlePickLine: StaleVersionError maps to 409, title = error.name', () => {
  it('a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const allocateResult = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(allocateResult.status).toBe(200);
    const allocatedVersion = (allocateResult.body as { version: number }).version;

    const result = await handlePickLine(
      requestWithKey({ orderId: order.id, lineId: order.lineId, expectedVersion: allocatedVersion + 999, qtyActual: '1.000', correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

// --- WBS 2.12 part 2 (_slice-2.12.brief.md), item 2: handleCheckOrder's own missing 400/409 tests —
// same missing-Idempotency-Key / stale-version pattern as handlePickLine's own pair immediately
// above. -----------------------------------------------------------------------------------------

describe('handleCheckOrder: a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('no Idempotency-Key header -> 400', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const allocateResult = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(allocateResult.status).toBe(200);
    const allocatedVersion = (allocateResult.body as { version: number }).version;

    const pickResult = await handlePickLine(
      requestWithKey({ orderId: order.id, lineId: order.lineId, expectedVersion: allocatedVersion, qtyActual: '1.000', correlationId: nextCorrelationId() }),
      deps,
    );
    expect(pickResult.status).toBe(200);
    const pickedVersion = (pickResult.body as { version: number }).version;

    const result = await handleCheckOrder(
      requestWithoutKey({ orderId: order.id, expectedVersion: pickedVersion, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('handleCheckOrder: StaleVersionError maps to 409, title = error.name', () => {
  it('a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const allocateResult = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(allocateResult.status).toBe(200);
    const allocatedVersion = (allocateResult.body as { version: number }).version;

    const pickResult = await handlePickLine(
      requestWithKey({ orderId: order.id, lineId: order.lineId, expectedVersion: allocatedVersion, qtyActual: '1.000', correlationId: nextCorrelationId() }),
      deps,
    );
    expect(pickResult.status).toBe(200);
    const pickedVersion = (pickResult.body as { version: number }).version;

    const result = await handleCheckOrder(
      requestWithKey({ orderId: order.id, expectedVersion: pickedVersion + 999, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('handleCheckOrder: SelfCheckNotAllowedError maps to 422, title = error.name', () => {
  it('the same actor who picked the order calling handleCheckOrder -> 422, title "SelfCheckNotAllowedError", order stays "picked"', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const allocateResult = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(allocateResult.status).toBe(200);
    const allocatedVersion = (allocateResult.body as { version: number }).version;

    const pickResult = await handlePickLine(
      requestWithKey({ orderId: order.id, lineId: order.lineId, expectedVersion: allocatedVersion, qtyActual: '1.000', correlationId: nextCorrelationId() }),
      deps,
    );
    expect(pickResult.status).toBe(200);
    expect('body' in pickResult ? pickResult.body : null).toMatchObject({ status: 'picked' });
    const pickedVersion = (pickResult.body as { version: number }).version;

    // request.ctx is the SAME fixed actor (FIXTURE_ACTOR_UUID) for both requestWithKey calls —
    // exactly the self-check case doc 38 row 2.12's own acceptance line names.
    const result = await handleCheckOrder(
      requestWithKey({ orderId: order.id, expectedVersion: pickedVersion, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ title: 'SelfCheckNotAllowedError' });

    const statusResult: QueryResult<{ status: string }> = await pool.query(`select status from wms.outbound_orders where id = $1`, [order.id]);
    expect(statusResult.rows[0]?.status).toBe('picked');
  });
});

// --- Round 3: StockBalanceRowMissingError (Allocate's increment / CancelOutbound's decrement matched
// no wms.stock_balance row) is a TYPED domain error — handlers.ts maps it to 422, never the unknown-
// error 500 path. The repository port is swapped for one whose lot write throws the real error class,
// the same deps-override pattern the 500 test above uses. -------------------------------------------

// errors.ts: StockBalanceRowMissingError.i18nKey (extends OutboundCheckError, Master round 3).
const STOCK_BALANCE_ROW_MISSING_I18N_KEY = 'wms.outbound.allocation.stockBalanceRowMissing';

describe('StockBalanceRowMissingError maps to 422 carrying its i18n key + params, never 500', () => {
  it('handleAllocate: incrementLotAllocated throws StockBalanceRowMissingError -> 422, title "StockBalanceRowMissingError", i18nKey + { clientId, skuId, locationId, batchNo } of the lot, not logged as unknown, order stays "approved"', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const logger = spyLogger();
    const depsWithSpyLogger = createProcessOutboundDeps({ clock, ids, logger });
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        // Throws exactly what the real repository throws: the params of the row it was asked to update.
        incrementLotAllocated: async (_tx: unknown, params: IncrementLotAllocatedParams): Promise<never> => {
          throw new StockBalanceRowMissingError('incrementLotAllocated matched no wms.stock_balance row', {
            clientId: params.clientId,
            skuId: params.skuId,
            locationId: params.locationId,
            batchNo: params.batchNo,
          });
        },
      },
    };

    const result = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      brokenDeps,
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      title: 'StockBalanceRowMissingError',
      i18nKey: STOCK_BALANCE_ROW_MISSING_I18N_KEY,
      // The one lot insertFreshApprovedOrderWithLine stocked: this file's own client/SKU/location, batch ''.
      params: { clientId: fixtureClientId, skuId: fixtureSkuId, locationId: fixtureLocationId, batchNo: '' },
    });
    expect(logger.errorCalls).toHaveLength(0);
    const statusResult: QueryResult<{ status: string }> = await pool.query(`select status from wms.outbound_orders where id = $1`, [order.id]);
    expect(statusResult.rows[0]?.status).toBe('approved');
  });

  it('handleCancelOutbound: decrementLotAllocated throws StockBalanceRowMissingError -> 422, title "StockBalanceRowMissingError", i18nKey + { clientId, skuId, locationId, batchNo } of the lot, not logged as unknown, order stays "allocated"', async () => {
    const order = await insertFreshApprovedOrderWithLine();
    const allocateResult = await handleAllocate(
      requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(allocateResult.status).toBe(200);
    const allocatedVersion = (allocateResult.body as { version: number }).version;

    const logger = spyLogger();
    const depsWithSpyLogger = createProcessOutboundDeps({ clock, ids, logger });
    const brokenDeps = {
      ...depsWithSpyLogger,
      repo: {
        ...depsWithSpyLogger.repo,
        // Throws exactly what the real repository throws: the params of the row it was asked to update.
        decrementLotAllocated: async (_tx: unknown, params: IncrementLotAllocatedParams): Promise<never> => {
          throw new StockBalanceRowMissingError('decrementLotAllocated matched no wms.stock_balance row', {
            clientId: params.clientId,
            skuId: params.skuId,
            locationId: params.locationId,
            batchNo: params.batchNo,
          });
        },
      },
    };

    const result = await handleCancelOutbound(
      requestWithKey({ orderId: order.id, expectedVersion: allocatedVersion, reason: 'test release failure', correlationId: nextCorrelationId() }),
      brokenDeps,
    );

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      title: 'StockBalanceRowMissingError',
      i18nKey: STOCK_BALANCE_ROW_MISSING_I18N_KEY,
      // The one lot insertFreshApprovedOrderWithLine stocked: this file's own client/SKU/location, batch ''.
      params: { clientId: fixtureClientId, skuId: fixtureSkuId, locationId: fixtureLocationId, batchNo: '' },
    });
    expect(logger.errorCalls).toHaveLength(0);
    const statusResult: QueryResult<{ status: string }> = await pool.query(`select status from wms.outbound_orders where id = $1`, [order.id]);
    expect(statusResult.rows[0]?.status).toBe('allocated');
  });
});

// --- WBS 2.12 part 4 (_slice-2.12.brief.md), fix round finding 3: handlePackOrder / handleLoadOrder
// own missing-Idempotency-Key / stale-version tests — same pattern as handleCheckOrder's own pair
// above (lines 717-766), moved here from ./process-outbound.test.ts (never in the integration file,
// every other handler test in this use case lives in THIS file). -----------------------------------

/** Walks a fresh order through Allocate -> PickLine -> CheckOrder (via the checker actor, never the
 *  picker — CheckOrder's own self-check gate) to 'checked', PackOrder's own precondition. */
async function buildCheckedOrderViaHandlers(): Promise<{ id: string; version: number; lineId: string }> {
  const order = await insertFreshApprovedOrderWithLine();
  const allocateResult = await handleAllocate(
    requestWithKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
    deps,
  );
  expect(allocateResult.status).toBe(200);
  const allocatedVersion = (allocateResult.body as { version: number }).version;

  const pickResult = await handlePickLine(
    requestWithKey({ orderId: order.id, lineId: order.lineId, expectedVersion: allocatedVersion, qtyActual: '1.000', correlationId: nextCorrelationId() }),
    deps,
  );
  expect(pickResult.status).toBe(200);
  const pickedVersion = (pickResult.body as { version: number }).version;

  const checkResult = await handleCheckOrder(
    { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() }, body: { orderId: order.id, expectedVersion: pickedVersion, correlationId: nextCorrelationId() }, ctx: checkerCtx },
    deps,
  );
  expect(checkResult.status).toBe(200);
  const checkedVersion = (checkResult.body as { version: number }).version;

  return { id: order.id, version: checkedVersion, lineId: order.lineId };
}

/** PackOrder on top of buildCheckedOrderViaHandlers — LoadOrder's own precondition. */
async function buildPackedOrderViaHandlers(): Promise<{ id: string; version: number; lineId: string }> {
  const checkedOrder = await buildCheckedOrderViaHandlers();
  const packResult = await handlePackOrder(
    requestWithKey({ orderId: checkedOrder.id, expectedVersion: checkedOrder.version, correlationId: nextCorrelationId() }),
    deps,
  );
  expect(packResult.status).toBe(200);
  return { ...checkedOrder, version: (packResult.body as { version: number }).version };
}

describe('handlePackOrder: a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('no Idempotency-Key header -> 400', async () => {
    const order = await buildCheckedOrderViaHandlers();
    const result = await handlePackOrder(
      requestWithoutKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('handlePackOrder: StaleVersionError maps to 409, title = error.name', () => {
  it('a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const order = await buildCheckedOrderViaHandlers();
    const result = await handlePackOrder(
      requestWithKey({ orderId: order.id, expectedVersion: order.version + 999, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});

describe('handleLoadOrder: a missing Idempotency-Key is rejected with a 400 Problem', () => {
  it('no Idempotency-Key header -> 400', async () => {
    const order = await buildPackedOrderViaHandlers();
    const result = await handleLoadOrder(
      requestWithoutKey({ orderId: order.id, expectedVersion: order.version, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(400);
  });
});

describe('handleLoadOrder: StaleVersionError maps to 409, title = error.name', () => {
  it('a stale expectedVersion -> 409, title "StaleVersionError"', async () => {
    const order = await buildPackedOrderViaHandlers();
    const result = await handleLoadOrder(
      requestWithKey({ orderId: order.id, expectedVersion: order.version + 999, correlationId: nextCorrelationId() }),
      deps,
    );
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ title: 'StaleVersionError' });
  });
});
