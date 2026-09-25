// modules/wms/tests/process-outbound/process-outbound.test.ts — WBS 2.11 part 1.
//
// Integration tests, one per scenario in ./process-outbound.feature, against the real database as
// pgeos_app. Sources: docs/notes/slice-briefs/_slice-2.11.brief.md, D-blueprint 03 §4.2/§4.2.1,
// 13B-Schema-Reference-Consolidation.sql:2326-2327 (chk_outbound_orders_status).
//
// RED until pg-backend builds modules/wms/{domain,application,infrastructure,api}/process-outbound/*
// (currently only stale receive-inbound-shaped scaffolds exist under those paths — the imports
// below name the part-1 surface this brief defines, not what exists today).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as receive-inbound.test.ts (brief Read ONLY
// item 12). PG_APP_USER=pgeos_app is REQUIRED — every command call goes through withContext(ctx, fn)
// as pgeos_app, genuinely subject to RLS. platform.audit_log rows are NEVER deleted.
//
// Condition execution order (Master decision 3): 1, 3, 4, 5, 6, 7, 8, 9 run first (any failure
// THROWS and leaves the order 'draft', nothing persisted); condition 2 (credit hold) is checked
// LAST and, on failure, transitions the order to 'credit_rejected' instead of throwing. Every
// per-condition failure test below satisfies every condition BEFORE the one under test so the
// failure under test is the one that actually fires. Condition 10 is BLOCKED (no schema source) —
// never implemented, never asserted as a failure.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test — part 1's four commands only (Allocate/GeneratePickList are part 2).
import {
  approveOutbound,
  cancelOutbound,
  createOutbound,
  runOutboundChecks,
} from '../../application/process-outbound/index.js';
import { createProcessOutboundDeps } from '../../api/process-outbound/composition.js';
import {
  CancelReasonRequiredError,
  ClientNotQualifiedError,
  ContractExpiredError,
  ContractNotActiveError,
  DeliveryAddressIncompleteError,
  IllegalTransitionError,
  InsufficientStockError,
  OutboundLocationBlockedError,
  NoServicePriceError,
  OrderNotFoundError,
  RoleRequiredError,
  ShelfLifeTooShortError,
  SkuBlockedError,
  SkuClientMismatchError,
  StaleVersionError,
} from '../../domain/process-outbound/errors.js';
// pg-reviewer finding 1 (2.11 part 1, round 1): stock is seeded through a REAL 'receipt' movement
// via the module's own public postMovement (../../index.js) — never a direct wms.stock_balance
// INSERT, which leaves a ledgerless balance row and fails guard G1
// (wms.verify_balance_integrity()). Same pattern
// modules/wms/tests/count-inventory/count-inventory.test.ts's own seedStockViaReceipt uses.
import { postMovement, type LedgerDeps } from '../../index.js';

// The ledger-based G1 fixture fix (seedStockViaReceipt) adds a real postMovement transaction
// (advisory lock + row locks) per stocked location — a few tests seed 2-3 locations, which can
// exceed vitest's 5000ms default under load. Raised for this file only, same headroom
// count-inventory.test.ts's own suite needs for the same reason.
vi.setConfig({ testTimeout: 20000 });

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// pgeos_app-role pool — dedicated so the RLS test genuinely runs under RLS, not the admin connection.
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

const SERVICE_CODE = 'OF-01'; // brief background: "seeded services including OF-01".
const OUT_DOC_TYPE = 'OUT'; // wms.brief.md §4: doc_type OUT. The live seed (platform.counters,
// 01-Data-Model.sql) prefixes every doc_type with the entity's OWN code, not a fixed group prefix
// — 'PST-OUT-' for entity PST, matching 'PST-IN-'/'PST-CNT-' already used elsewhere in this module.
const WH_MGR_ROLE_CODE = 'WH_MGR';
const QTY_ORDERED = '10.000';
const PRICE_LIST_PRICE = '25.000';
const ORDER_TYPE_STANDARD = 'standard';
const ORDER_TYPE_TRANSFER = 'transfer'; // Master decision 3, condition 8: no delivery address required.
const CREDIT_HOLD_REASON = 'overdue';

// pg-reviewer round 2 finding 1 (parallel-safety): per-RUN random actor ids, never a fixed UUID —
// two concurrent runs of this same file (or of this file and ./handlers.test.ts) never share, delete
// or re-create each other's identity.users rows.
const ROLE_ACTOR_UUID = randomUUID();
const NO_ROLE_ACTOR_UUID = randomUUID();
const OUTSIDER_ACTOR_UUID = randomUUID(); // RLS: no user_entities row for entityId.

const CLOCK_DATE = '2026-09-25'; // finding 13: fixtures deriving an expiry offset MUST use this
// fixed date, never `current_date` — the command under test runs against a FIXED clock, so a
// `current_date`-derived fixture silently drifts out of sync with it after 2026-10-20.
const clock = new FixedClock(new Date(`${CLOCK_DATE}T00:00:00.000Z`));
// pg-reviewer round 2 finding 8: every fixture date (price_lists.valid_from, contracts.start_date,
// a price list's lapsed valid_to) is derived IN SQL from this same fixed clock date, passed as a
// bound parameter — never from `current_date`, which drifts away from the command's own FixedClock
// as the calendar moves on (the old `current_date - interval '1 year'` fixtures break in 2027).
const ids = new SequentialIdGenerator(211);
const deps = createProcessOutboundDeps({ clock, ids });
// A separate SequentialIdGenerator instance for ledger seeding, distinct from the command deps'
// own `ids` — same separation count-inventory.test.ts's own `ledgerDeps` keeps from its command deps.
const ledgerDeps: LedgerDeps = { clock, ids: new SequentialIdGenerator(2115) };
const RECEIPT_MOVEMENT_TYPE = 'receipt';
const SEED_UOM = 'EA';
// afterAll unwinds every fixture row this run created (FK-safe order, many tables) — same
// headroom-over-the-default-10s-hook-timeout reasoning as stock-ledger.test.ts's own
// CONCURRENCY_TEST_TIMEOUT_MS (modules/wms/tests/integration/stock-ledger.test.ts).
const CLEANUP_HOOK_TIMEOUT_MS = 30000;

const roleCtx = { userId: ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let warehouseId: string;
let serviceId: string;

const fixtureClientIds: string[] = [];
const fixtureContractIds: string[] = [];
const fixturePriceListIds: string[] = [];
const fixtureSkuIds: string[] = [];
const fixtureZoneIds: string[] = [];
const fixtureLocationIds: string[] = [];
const fixtureOrderIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

/** sha256 hex of the canonical JSON body, endpoint 'wms.process-outbound.<command>'. */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `wms.process-outbound.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

// --- fixture builders --------------------------------------------------------------------------

async function insertClient(opts: {
  readonly creditHold?: boolean;
  readonly holdReason?: string | null;
  readonly status?: string;
  readonly deletedAt?: Date;
} = {}): Promise<string> {
  const code = `_procout_fixture_${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type, status, credit_hold, hold_reason, deleted_at)
     values ($1, $2, 'client', $3, $4, $5, $6) returning id`,
    [
      code,
      'عميل اختبار صرف صادر',
      opts.status ?? 'active',
      opts.creditHold ?? false,
      opts.holdReason ?? null,
      opts.deletedAt ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.accounts insert returned no row');
  fixtureClientIds.push(row.id);
  return row.id;
}

// chk_price_lists_status (13B:2413, live CHECK): draft · active · expired.
type PriceListStatus = 'draft' | 'active' | 'expired';

async function insertPriceList(
  opts: {
    readonly withOf01Price?: boolean;
    readonly status?: PriceListStatus;
    /** ISO date or null (open-ended, the default). */
    readonly validTo?: string | null;
  } = {},
): Promise<string> {
  const code = `_procout_pl_${randomUUID()}`;
  // finding 8: valid_from is one year before the FIXED clock date, never current_date.
  const listResult: QueryResult<{ id: string }> = await pool.query(
    `insert into catalog.price_lists (entity_id, code, name_ar, valid_from, valid_to, status)
     values ($1, $2, $3, $4::date - interval '1 year', $5::date, $6) returning id`,
    [entityId, code, 'قائمة تسعير اختبار صرف صادر', CLOCK_DATE, opts.validTo ?? null, opts.status ?? 'active'],
  );
  const row = listResult.rows[0];
  if (!row) throw new Error('fixture catalog.price_lists insert returned no row');
  fixturePriceListIds.push(row.id);
  if (opts.withOf01Price ?? true) {
    await pool.query(
      `insert into catalog.price_list_lines (price_list_id, service_id, price) values ($1, $2, $3::numeric)`,
      [row.id, serviceId, PRICE_LIST_PRICE],
    );
  }
  return row.id;
}

async function insertContract(
  clientId: string,
  opts: { readonly status?: string; readonly endDate?: string | null; readonly priceListId?: string | null } = {},
): Promise<string> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, 'CNT') as doc_no`,
    [entityId],
  );
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for CNT');
  // finding 8: start_date is one year before the FIXED clock date, never current_date.
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contracts (entity_id, doc_no, account_id, title, status, start_date, end_date, price_list_id)
     values ($1, $2, $3, $4, $5, $6::date - interval '1 year', $7::date, $8) returning id`,
    [
      entityId,
      docNo,
      clientId,
      'عقد اختبار صرف صادر',
      opts.status ?? 'active',
      CLOCK_DATE,
      opts.endDate ?? null,
      opts.priceListId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.contracts insert returned no row');
  fixtureContractIds.push(row.id);
  return row.id;
}

// finding 6: condition 3/5/6/7 error params name the SKU/location CODE, not the bare id — these
// maps let each test recover the code it fixture-generated to assert against.
const skuCodeById = new Map<string, string>();
const locationCodeById = new Map<string, string>();

async function insertSku(
  clientId: string,
  opts: {
    readonly status?: string;
    readonly trackExpiry?: boolean;
    readonly minRemainingLifeIssueDays?: number | null;
  } = {},
): Promise<string> {
  const code = `PROCOUT-${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, status, track_expiry, min_remaining_life_issue_days)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [clientId, code, `صنف اختبار صرف صادر ${code}`, opts.status ?? 'active', opts.trackExpiry ?? false, opts.minRemainingLifeIssueDays ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.skus insert returned no row');
  fixtureSkuIds.push(row.id);
  skuCodeById.set(row.id, code);
  return row.id;
}

// pg-reviewer round 2 finding 1 (code range + parallel-safety).
// 019-Warehouse-WH1-Setup.sql:59 chk_locations_code_format: a pallet/shelf code must match
// `^[PGMT][1-9]-[0-9]{2}-[1-9]$`, and wms.locations is unique on (warehouse_id, code). WH1's real
// layout uses only the prefixes P1-P3, G1-G5, M1-M5, T1-T5 (019 seed); 'T9-' is the WBS 2.10
// receive-inbound fixture's own block. This slice's fixtures own the 'M9-' block (900 codes,
// M9-00-1 .. M9-99-9), shared ONLY with ./handlers.test.ts. Each code is picked at random and
// claimed through `insert ... on conflict (warehouse_id, code) do nothing` — the database's own
// unique constraint arbitrates, so two concurrent runs (of this file, of handlers.test.ts, or of
// the same file twice) can never collide: a taken code simply re-rolls.
const FIXTURE_LOCATION_PREFIX = 'M9';
const FIXTURE_LOCATION_SEQ_COUNT = 100; // the regex's `[0-9]{2}` segment: 00..99.
const FIXTURE_LOCATION_LEVEL_COUNT = 9; // the regex's trailing `[1-9]` segment: 1..9.
const FIXTURE_LOCATION_MAX_ATTEMPTS = 200;

function randomFixtureLocationCode(): string {
  const [seqByte = 0, levelByte = 0] = randomBytes(2);
  const seq = String(seqByte % FIXTURE_LOCATION_SEQ_COUNT).padStart(2, '0');
  const level = (levelByte % FIXTURE_LOCATION_LEVEL_COUNT) + 1;
  return `${FIXTURE_LOCATION_PREFIX}-${seq}-${level}`;
}

async function insertZone(): Promise<string> {
  const code = `_procout_zone_${randomUUID().slice(0, 8)}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type) values ($1, $2, $3, 'storage') returning id`,
    [warehouseId, code, 'منطقة اختبار صرف صادر'],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.zones insert returned no row');
  fixtureZoneIds.push(row.id);
  return row.id;
}

async function insertLocation(zoneId: string, opts: { readonly isBlocked?: boolean; readonly blockReason?: string } = {}): Promise<string> {
  for (let attempt = 0; attempt < FIXTURE_LOCATION_MAX_ATTEMPTS; attempt += 1) {
    const code = randomFixtureLocationCode();
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.locations (warehouse_id, zone_id, code, location_type, is_blocked, block_reason)
       values ($1, $2, $3, 'pallet', $4, $5)
       on conflict (warehouse_id, code) do nothing
       returning id`,
      [warehouseId, zoneId, code, opts.isBlocked ?? false, opts.blockReason ?? null],
    );
    const row = result.rows[0];
    if (row) {
      fixtureLocationIds.push(row.id);
      locationCodeById.set(row.id, code);
      return row.id;
    }
  }
  throw new Error(`no free ${FIXTURE_LOCATION_PREFIX}-xx-x fixture location code after ${FIXTURE_LOCATION_MAX_ATTEMPTS} attempts`);
}

/** postMovement's own 2.8/WBS 2.4 guard (checkLocationLimitsForEntries) REFUSES to post a movement
 *  INTO an already-blocked location — so a condition-7 fixture needing stock ON a blocked location
 *  must seed it via seedStockViaReceipt FIRST (while unblocked), then flip `is_blocked` via a
 *  direct UPDATE afterwards. Blocking is location metadata, not a ledger fact — this does not
 *  touch wms.stock_balance/stock_movements at all, so it cannot trip G1. */
async function blockLocation(locationId: string, reason: string): Promise<void> {
  await pool.query(`update wms.locations set is_blocked = true, block_reason = $1 where id = $2`, [reason, locationId]);
}

/** pg-reviewer finding 1 / G1: seeds stock through a REAL 'receipt' movement via the module's own
 *  public `postMovement` (../../index.js) — never a direct wms.stock_balance INSERT, which leaves
 *  a ledgerless balance row and fails guard G1 (`wms.verify_balance_integrity()`). Same call shape
 *  as modules/wms/tests/count-inventory/count-inventory.test.ts's own `seedStockViaReceipt`.
 *  `batchNo` defaults to '' (stock_balance's own key default) — pass a real one when a test needs
 *  to assert a specific lot/batch number (condition 5). `expiryDate`, when given, is applied via a
 *  follow-up UPDATE on the just-posted wms.stock_balance row: postMovement's own `LedgerEntry`
 *  (modules/wms/src/stock-ledger/domain.ts) carries no expiry field at all — a pre-existing gap in
 *  the 2.8 ledger mechanism, outside this tests-only slice's write scope to fix. G1
 *  (`wms.verify_balance_integrity`) groups only by (client_id, sku_id, location_id,
 *  coalesce(batch_no,'')), never expiry_date (domain.ts's own header comment), so this UPDATE
 *  cannot desync the guard's own qty check — it only sets metadata the ledger mechanism does not
 *  yet populate. */
async function seedStockViaReceipt(params: {
  readonly clientId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly qtyOnHand?: string;
  readonly batchNo?: string;
  readonly expiryDate?: string | null;
}): Promise<void> {
  const batchNo = params.batchNo ?? '';
  await postMovement(
    roleCtx,
    {
      entityId,
      entry: {
        clientId: params.clientId,
        skuId: params.skuId,
        fromLocationId: null,
        toLocationId: params.locationId,
        qty: Quantity.of(params.qtyOnHand ?? QTY_ORDERED),
        batchNo,
        movementType: RECEIPT_MOVEMENT_TYPE,
        uom: SEED_UOM,
      },
      correlationId: nextCorrelationId(),
      performedBy: ROLE_ACTOR_UUID,
    },
    ledgerDeps,
  );
  if (params.expiryDate !== undefined) {
    await pool.query(
      `update wms.stock_balance set expiry_date = $1::date
        where client_id = $2 and sku_id = $3 and location_id = $4 and batch_no = $5`,
      [params.expiryDate, params.clientId, params.skuId, params.locationId, batchNo],
    );
  }
}

interface DraftOrderLine {
  readonly skuId: string;
  readonly qtyOrdered: string;
}

/** Direct-SQL fixture, mirroring receive-inbound.test.ts's own createDraftInboundOrder — order
 *  LINES are not part of this slice's CreateOutbound surface (Master decision 2 names no `lines`
 *  field), so every test that needs lines builds them directly, exactly as the golden slice does
 *  for wms.order_lines against wms.inbound_orders. */
async function createDraftOutboundOrderFixture(params: {
  readonly clientId: string;
  readonly contractId?: string | null;
  readonly orderType?: string;
  readonly shipToName?: string | null;
  readonly shipToPhone?: string | null;
  readonly shipToAddress?: string | null;
  readonly shipToArea?: string | null;
  readonly lines: readonly DraftOrderLine[];
}): Promise<{ orderId: string; version: number; lineIds: string[] }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, $2) as doc_no`,
    [entityId, OUT_DOC_TYPE],
  );
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for OUT');

  const orderResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.outbound_orders
       (entity_id, doc_no, client_id, contract_id, warehouse_id, order_type, status,
        ship_to_name, ship_to_phone, ship_to_address, ship_to_area)
     values ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10)
     returning id, version`,
    [
      entityId,
      docNo,
      params.clientId,
      params.contractId ?? null,
      warehouseId,
      params.orderType ?? ORDER_TYPE_STANDARD,
      params.shipToName ?? null,
      params.shipToPhone ?? null,
      params.shipToAddress ?? null,
      params.shipToArea ?? null,
    ],
  );
  const orderRow = orderResult.rows[0];
  if (!orderRow) throw new Error('fixture wms.outbound_orders insert returned no row');
  fixtureOrderIds.push(orderRow.id);

  const lineIds: string[] = [];
  for (const [index, line] of params.lines.entries()) {
    const lineResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
       values ('wms.outbound_orders', $1, $2, $3, $4::numeric, 'EA') returning id`,
      [orderRow.id, index + 1, line.skuId, line.qtyOrdered],
    );
    const lineRow = lineResult.rows[0];
    if (!lineRow) throw new Error('fixture wms.order_lines insert returned no row');
    lineIds.push(lineRow.id);
  }

  return { orderId: orderRow.id, version: orderRow.version, lineIds };
}

async function getOrder(orderId: string): Promise<{
  status: string;
  version: number;
  credit_check_passed: boolean | null;
  credit_checked_at: Date | null;
}> {
  const result: QueryResult<{
    status: string;
    version: number;
    credit_check_passed: boolean | null;
    credit_checked_at: Date | null;
  }> = await pool.query(
    `select status, version, credit_check_passed, credit_checked_at from wms.outbound_orders where id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.outbound_orders row for id ${orderId}`);
  return row;
}

/** finding 10: outbox rows for a correlationId + eventType — exact-count assertion, never
 *  `.some`/`> 0`, same discipline as receive-inbound.test.ts's own outboxRowsForCorrelationAndType. */
async function outboxRowsForCorrelationAndType(
  correlationId: string,
  eventType: string,
): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  const result: QueryResult<{ id: string; payload: Record<string, unknown> }> = await pool.query(
    `select id::text as id, payload from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

async function auditCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log
      where correlation_id = $1 and schema_name = 'wms' and table_name = 'outbound_orders'`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** finding 6 (round 2): rollback proof independent of the correlationId — every outbox row whose
 *  aggregate is this order, and every audit row whose record is this order, whatever correlationId
 *  wrote them. A failed command must leave both counts exactly where they were. */
async function outboxCountForOrder(orderId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.outbox where aggregate_id = $1`,
    [orderId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function auditCountForOrder(orderId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log
      where record_id = $1 and schema_name = 'wms' and table_name = 'outbound_orders'`,
    [orderId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function anyOutboxCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.outbox where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Runs `attempt` (expected to reject with `errorClass`) and asserts it left ZERO new outbox rows
 *  and ZERO new audit rows — both for its own correlationId and for the order as an aggregate —
 *  and did not change the order's status or version. */
async function expectFailedAttemptRolledBack(
  orderId: string,
  correlationId: string,
  errorClass: new (message: string) => Error,
  attempt: () => Promise<unknown>,
): Promise<void> {
  const before = await getOrder(orderId);
  const outboxBefore = await outboxCountForOrder(orderId);
  const auditBefore = await auditCountForOrder(orderId);

  await expect(attempt()).rejects.toBeInstanceOf(errorClass);

  expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
  expect(await auditCountForCorrelation(correlationId)).toBe(0);
  expect(await outboxCountForOrder(orderId)).toBe(outboxBefore);
  expect(await auditCountForOrder(orderId)).toBe(auditBefore);
  const after = await getOrder(orderId);
  expect(after.status).toBe(before.status);
  expect(after.version).toBe(before.version);
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [roleCode]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleId]);
}

async function createFixtureActor(userId: string, entityIds: readonly string[]): Promise<void> {
  // userId is a fresh per-run randomUUID (finding 1) — no pre-delete of a shared fixed id needed.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_procout_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار صرف صادر — WBS 2.11'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

/** A fully-valid scenario: active contract with a priced OF-01, one SKU with enough stock on an
 *  unblocked location, standard order type with a complete ship-to address. Every condition-failure
 *  test below takes this as its base and breaks exactly ONE piece. */
async function buildValidScenario(overrides: {
  readonly clientId?: string;
  readonly contractId?: string;
  readonly skuId?: string;
  readonly locationId?: string;
  readonly orderType?: string;
  readonly shipToComplete?: boolean;
} = {}): Promise<{
  orderId: string;
  version: number;
  lineIds: string[];
  clientId: string;
  contractId: string;
  skuId: string;
  locationId: string;
}> {
  const clientId = overrides.clientId ?? (await insertClient());
  const priceListId = await insertPriceList();
  const contractId = overrides.contractId ?? (await insertContract(clientId, { priceListId }));
  const skuId = overrides.skuId ?? (await insertSku(clientId));
  const zoneId = await insertZone();
  const locationId = overrides.locationId ?? (await insertLocation(zoneId));
  await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: QTY_ORDERED });

  const shipToComplete = overrides.shipToComplete ?? true;
  const { orderId, version, lineIds } = await createDraftOutboundOrderFixture({
    clientId,
    contractId,
    orderType: overrides.orderType ?? ORDER_TYPE_STANDARD,
    shipToName: shipToComplete ? 'مستلم اختبار' : null,
    shipToPhone: shipToComplete ? '+965 555 0100' : null,
    shipToAddress: shipToComplete ? 'شارع الاختبار 1' : null,
    shipToArea: shipToComplete ? 'حولي' : null,
    lines: [{ skuId, qtyOrdered: QTY_ORDERED }],
  });

  return { orderId, version, lineIds, clientId, contractId, skuId, locationId };
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PST']);
  entityId = (entityResult.rows[0] as { id: string }).id;

  const warehouseResult: QueryResult<{ id: string }> = await pool.query(`select id from wms.warehouses where code = 'WH1'`);
  warehouseId = (warehouseResult.rows[0] as { id: string }).id;

  const serviceResult: QueryResult<{ id: string }> = await pool.query(`select id from catalog.services where code = $1`, [SERVICE_CODE]);
  const serviceRow = serviceResult.rows[0];
  if (!serviceRow) throw new Error(`catalog.services row not found for code ${SERVICE_CODE} — expected pre-seeded`);
  serviceId = serviceRow.id;

  await createFixtureActor(ROLE_ACTOR_UUID, []);
  await createFixtureActor(NO_ROLE_ACTOR_UUID, []);
  await createFixtureActor(OUTSIDER_ACTOR_UUID, []);
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  const allEntityIds = allEntitiesResult.rows.map((row) => row.id);
  for (const userId of [ROLE_ACTOR_UUID, NO_ROLE_ACTOR_UUID]) {
    for (const eid of allEntityIds) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
    }
  }
  for (const eid of allEntityIds) {
    if (eid !== entityId) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [OUTSIDER_ACTOR_UUID, eid]);
    }
  }

  await grantRole(ROLE_ACTOR_UUID, WH_MGR_ROLE_CODE);
});

/** pg-reviewer round 2 finding 1: every cleanup statement runs even if an earlier one throws — a
 *  partial cleanup must never leave rows behind that block the NEXT run (the previous version
 *  aborted at the first failing DELETE and leaked every later table's rows). Each failure is
 *  collected and re-thrown together at the end, so a broken cleanup is still loud, never silent. */
async function runCleanupSteps(steps: ReadonlyArray<readonly [string, () => Promise<unknown>]>): Promise<void> {
  const failures: string[] = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (err: unknown) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(' | ')}`);
}

afterAll(async () => {
  const actorIds = [ROLE_ACTOR_UUID, NO_ROLE_ACTOR_UUID, OUTSIDER_ACTOR_UUID];
  try {
    // FK-safe order: outbox → stock_movements → stock_balance → order_lines → outbound_orders →
    // locations → zones → skus → contracts (FK contracts.price_list_id → price_lists, so a contract
    // goes BEFORE its price list) → price_list_lines → price_lists → accounts → identity rows.
    // Every statement is scoped to an id this run itself created — never a prefix-wide delete.
    await runCleanupSteps([
      ['platform.outbox', () => pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]])],
      ['wms.stock_movements', () => pool.query(`delete from wms.stock_movements where client_id = any($1::uuid[])`, [fixtureClientIds])],
      ['wms.stock_balance', () => pool.query(`delete from wms.stock_balance where client_id = any($1::uuid[])`, [fixtureClientIds])],
      ['wms.order_lines', () => pool.query(`delete from wms.order_lines where order_id = any($1::uuid[])`, [fixtureOrderIds])],
      ['wms.outbound_orders', () => pool.query(`delete from wms.outbound_orders where id = any($1::uuid[])`, [fixtureOrderIds])],
      ['wms.locations', () => pool.query(`delete from wms.locations where id = any($1::uuid[])`, [fixtureLocationIds])],
      ['wms.zones', () => pool.query(`delete from wms.zones where id = any($1::uuid[])`, [fixtureZoneIds])],
      ['wms.skus', () => pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds])],
      ['sales.contracts', () => pool.query(`delete from sales.contracts where id = any($1::uuid[])`, [fixtureContractIds])],
      ['catalog.price_list_lines', () => pool.query(`delete from catalog.price_list_lines where price_list_id = any($1::uuid[])`, [fixturePriceListIds])],
      ['catalog.price_lists', () => pool.query(`delete from catalog.price_lists where id = any($1::uuid[])`, [fixturePriceListIds])],
      ['sales.accounts', () => pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [fixtureClientIds])],
      ['platform.idempotency_keys', () => pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [actorIds])],
      ['identity.user_roles', () => pool.query(`delete from identity.user_roles where user_id = any($1::uuid[])`, [actorIds])],
      ['identity.user_entities', () => pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [actorIds])],
      ['identity.users', () => pool.query(`delete from identity.users where id = any($1::uuid[])`, [actorIds])],
    ]);
  } finally {
    await pool.end();
    await appPool.end();
  }
}, CLEANUP_HOOK_TIMEOUT_MS); // the ledger-seeding fixtures (G1 fix) add many more fixture rows to
// unwind per run than the default 10s hook timeout comfortably covers — same headroom
// count-inventory.test.ts's own afterAll needs for the same reason.

// --- Scenario: Create a draft order ---------------------------------------------------------------

describe('Scenario: Create a draft order', () => {
  it('status is "draft", version 1, doc_no from the OUT series', async () => {
    const clientId = await insertClient();
    const correlationId = nextCorrelationId();
    const result = await createOutbound(
      roleCtx,
      { entityId, clientId, warehouseId, orderType: ORDER_TYPE_STANDARD, correlationId },
      deps,
    );
    fixtureOrderIds.push(result.orderId);
    expect(result.status).toBe('draft');
    expect(result.version).toBe(1);
    expect(result.docNo.startsWith('PST-OUT-')).toBe(true);

    // finding 10: outbox + audit written in the SAME transaction as the state change, keyed by the
    // SAME correlationId ('wms.outbound.drafted' — create-outbound.ts's own event constant).
    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.drafted')).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('a failing command (unqualified client) writes NEITHER an outbox row NOR an audit row — the transaction rolls back', async () => {
    const clientId = await insertClient({ deletedAt: clock.now() });
    const correlationId = nextCorrelationId();
    await expect(
      createOutbound(roleCtx, { entityId, clientId, warehouseId, orderType: ORDER_TYPE_STANDARD, correlationId }, deps),
    ).rejects.toBeInstanceOf(ClientNotQualifiedError);

    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.drafted')).toHaveLength(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });
});

describe('Scenario: CreateOutbound refuses an unqualified client', () => {
  it('a soft-deleted client is rejected with ClientNotQualifiedError, no order written', async () => {
    const clientId = await insertClient({ deletedAt: clock.now() });
    await expect(
      createOutbound(roleCtx, { entityId, clientId, warehouseId, orderType: ORDER_TYPE_STANDARD, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(ClientNotQualifiedError);
  });

  it('a non-active client is rejected with ClientNotQualifiedError', async () => {
    // chk_accounts_status (live CHECK) permits only active|suspended|closed — 'suspended' is a
    // legal non-active status, unlike 'prospect' which is never valid post-creation.
    const clientId = await insertClient({ status: 'suspended' });
    await expect(
      createOutbound(roleCtx, { entityId, clientId, warehouseId, orderType: ORDER_TYPE_STANDARD, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(ClientNotQualifiedError);
  });
});

// --- Scenario: all nine conditions pass -------------------------------------------------------------

describe('Scenario: All nine conditions pass — reaches checks_pending', () => {
  it('status is "checks_pending", credit_check_passed is true, credit_checked_at is set', async () => {
    const { orderId, version } = await buildValidScenario();
    const correlationId = nextCorrelationId();
    await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId }, deps);
    const after = await getOrder(orderId);
    expect(after.status).toBe('checks_pending');
    expect(after.credit_check_passed).toBe(true);
    expect(after.credit_checked_at).not.toBeNull();

    // finding 10: outbox + audit, same transaction, same correlationId.
    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.checks_started')).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: condition 1 — expired contract -------------------------------------------------------

describe('Scenario: Condition 1 fails — expired contract', () => {
  it('rejects with ContractExpiredError (i18nKey wms.outbound.check.contractExpired), status stays draft', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const expiredEndDate = '2020-01-01';
    const contractId = await insertContract(clientId, { priceListId, endDate: expiredEndDate });
    const { orderId, version } = await buildValidScenario({ clientId, contractId });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ContractExpiredError);
    expect((error as ContractExpiredError).i18nKey).toBe('wms.outbound.check.contractExpired');
    expect((error as ContractExpiredError).params).toMatchObject({ expiryDate: expiredEndDate });

    expect((await getOrder(orderId)).status).toBe('draft');
  });
});

describe('Scenario: Condition 1 resolves the contract by client/entity when the order carries no contractId', () => {
  it('CreateOutbound with NO contractId, the client has an active priced contract -> RunOutboundChecks passes condition 1 and reaches checks_pending', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: QTY_ORDERED });

    // The real command, no contractId in the input (Master decision 2: contractId is optional).
    const created = await createOutbound(
      roleCtx,
      {
        entityId,
        clientId,
        warehouseId,
        orderType: ORDER_TYPE_STANDARD,
        shipToName: 'مستلم اختبار',
        shipToPhone: '+965 555 0100',
        shipToAddress: 'شارع الاختبار 1',
        shipToArea: 'حولي',
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    fixtureOrderIds.push(created.orderId);
    const stored: QueryResult<{ contract_id: string | null }> = await pool.query(
      `select contract_id from wms.outbound_orders where id = $1`,
      [created.orderId],
    );
    expect(stored.rows[0]?.contract_id).toBeNull();

    // Lines are not part of CreateOutbound's surface (Master decision 2) — added directly, same as
    // createDraftOutboundOrderFixture.
    await pool.query(
      `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
       values ('wms.outbound_orders', $1, 1, $2, $3::numeric, 'EA')`,
      [created.orderId, skuId, QTY_ORDERED],
    );

    const result = await runOutboundChecks(
      roleCtx,
      { orderId: created.orderId, expectedVersion: created.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('checks_pending');
    expect((await getOrder(created.orderId)).credit_check_passed).toBe(true);
  });
});

describe('Scenario: Condition 1 fails — the client has no active contract at all', () => {
  it('no sales.contracts row exists for the client -> ContractNotActiveError (i18nKey wms.outbound.check.contractNotActive), status stays draft, nothing written', async () => {
    const clientId = await insertClient();
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: QTY_ORDERED });
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId: null,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: QTY_ORDERED }],
    });

    const correlationId = nextCorrelationId();
    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ContractNotActiveError);
    expect(error).not.toBeInstanceOf(ContractExpiredError);
    expect((error as ContractNotActiveError).i18nKey).toBe('wms.outbound.check.contractNotActive');
    expect((error as ContractNotActiveError).params).not.toHaveProperty('expiryDate');

    const after = await getOrder(orderId);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(version);
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });

  it('the client\'s only contract is not status "active" (draft) -> ContractNotActiveError, not ContractExpiredError', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    // chk_contracts_status (13B:2318): 'draft' is a legal non-active status.
    const draftContractId = await insertContract(clientId, { priceListId, status: 'draft' });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: QTY_ORDERED });
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId: draftContractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: QTY_ORDERED }],
    });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ContractNotActiveError);
    expect((error as ContractNotActiveError).i18nKey).toBe('wms.outbound.check.contractNotActive');
    expect((await getOrder(orderId)).status).toBe('draft');
  });
});

// --- Scenario: condition 2 — credit hold (checked last, no throw) ------------------------------------

describe('Scenario: Condition 2 fails — credit hold moves the order to its own status, not a thrown error', () => {
  it('status becomes credit_rejected, credit_check_passed is false, reason recorded, no error thrown', async () => {
    const clientId = await insertClient({ creditHold: true, holdReason: CREDIT_HOLD_REASON });
    const { orderId, version } = await buildValidScenario({ clientId });
    const correlationId = nextCorrelationId();

    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId }, deps);
    expect(result.status).toBe('credit_rejected');

    const after = await getOrder(orderId);
    expect(after.status).toBe('credit_rejected');
    expect(after.credit_check_passed).toBe(false);
    expect(after.credit_checked_at).not.toBeNull();

    // finding 9: "the reason is recorded" — the credit_rejected outbox event's own payload carries
    // the account's hold_reason (run-outbound-checks.ts's own condition-2 branch).
    const outboxRows = await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.credit_rejected');
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.payload).toMatchObject({ reason: CREDIT_HOLD_REASON });
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

describe('Scenario: Condition 2 — the credit_rejected result itself carries the i18n key and the reason', () => {
  it('RunOutboundChecksResult.i18nKey === "wms.outbound.check.creditHold" and .params.reason is the account\'s hold_reason', async () => {
    const clientId = await insertClient({ creditHold: true, holdReason: CREDIT_HOLD_REASON });
    const { orderId, version } = await buildValidScenario({ clientId });

    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('credit_rejected');
    expect(result.i18nKey).toBe('wms.outbound.check.creditHold');
    expect(result.params).toEqual({ reason: CREDIT_HOLD_REASON });
    expect(result.version).toBe((await getOrder(orderId)).version);
  });

  it('on the checks_pending outcome the result carries NO i18n key and NO params', async () => {
    const { orderId, version } = await buildValidScenario();
    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('checks_pending');
    expect(result.i18nKey).toBeNull();
    expect(result.params).toBeNull();
  });
});

// --- Scenario: condition 3 — insufficient stock -------------------------------------------------------

describe('Scenario: Condition 3 fails — insufficient stock', () => {
  it('rejects with InsufficientStockError (i18nKey wms.outbound.check.insufficientStock)', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    // Only half the ordered quantity is available.
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: '5.000' });
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: QTY_ORDERED }],
    });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(InsufficientStockError);
    expect((error as InsufficientStockError).i18nKey).toBe('wms.outbound.check.insufficientStock');
    // finding 6: the brief's own condition-3 message names the SKU code, available/ordered
    // quantities, and the single location code (exactly one location holds this SKU's stock here)
    // — domain/process-outbound/invariants.ts's own assertSufficientStock names this param `location`.
    expect((error as InsufficientStockError).params).toMatchObject({
      skuCode: skuCodeById.get(skuId),
      available: '5.000',
      ordered: QTY_ORDERED,
      location: locationCodeById.get(locationId),
    });
  });
});

// --- Scenario: condition 4 — SKU/client mismatch -------------------------------------------------------

describe('Scenario: Condition 4 fails — SKU belongs to a different client', () => {
  it('rejects with SkuClientMismatchError (i18nKey wms.outbound.check.skuClientMismatch)', async () => {
    const orderClientId = await insertClient();
    const otherClientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(orderClientId, { priceListId });
    const skuOwnedByOther = await insertSku(otherClientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId: orderClientId, skuId: skuOwnedByOther, locationId, qtyOnHand: QTY_ORDERED });
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId: orderClientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId: skuOwnedByOther, qtyOrdered: QTY_ORDERED }],
    });

    const correlationId = nextCorrelationId();
    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(SkuClientMismatchError);
    expect((error as SkuClientMismatchError).i18nKey).toBe('wms.outbound.check.skuClientMismatch');
    expect((error as SkuClientMismatchError).params).toMatchObject({
      skuId: skuOwnedByOther,
      skuCode: skuCodeById.get(skuOwnedByOther),
    });

    // finding 10: a condition failure THROWS and the whole transaction rolls back — neither the
    // outbox event nor the audit row for this correlationId was ever written.
    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.checks_started')).toHaveLength(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });
});

// --- Scenario: condition 5 — shelf life too short -------------------------------------------------------

describe('Scenario: Condition 5 fails — remaining shelf life too short', () => {
  it('rejects with ShelfLifeTooShortError (i18nKey wms.outbound.check.shelfLifeTooShort)', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId, { trackExpiry: true, minRemainingLifeIssueDays: 30 });
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    // finding 13: derived from the FIXED clock date (2026-09-25), never `current_date` — expires
    // in 5 days, below the 30-day minimum.
    const NEAR_EXPIRY_DATE = '2026-09-30';
    const LOT_NUMBER = `LOT-${randomUUID().slice(0, 8)}`;
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: QTY_ORDERED, batchNo: LOT_NUMBER, expiryDate: NEAR_EXPIRY_DATE });
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: QTY_ORDERED }],
    });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ShelfLifeTooShortError);
    expect((error as ShelfLifeTooShortError).i18nKey).toBe('wms.outbound.check.shelfLifeTooShort');
    // finding 6: the brief's own condition-5 message names the lot/batch number, not just the SKU.
    expect((error as ShelfLifeTooShortError).params).toMatchObject({
      batchNo: LOT_NUMBER,
      remainingDays: 5,
      minRemainingLifeIssueDays: 30,
    });
  });
});

// --- Scenario: condition 6 — SKU blocked -------------------------------------------------------

describe('Scenario: Condition 6 fails — SKU blocked', () => {
  it('rejects with SkuBlockedError (i18nKey wms.outbound.check.skuBlocked) naming SKU + status', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId, { status: 'on_hold' });
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: QTY_ORDERED });
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: QTY_ORDERED }],
    });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(SkuBlockedError);
    expect((error as SkuBlockedError).i18nKey).toBe('wms.outbound.check.skuBlocked');
    expect((error as SkuBlockedError).params).toMatchObject({ skuCode: skuCodeById.get(skuId), status: 'on_hold' });
  });
});

// --- Scenario: condition 7 — location blocked -------------------------------------------------------

describe('Scenario: Condition 7 fails — every candidate location is blocked', () => {
  it('rejects with OutboundLocationBlockedError (i18nKey wms.outbound.check.locationBlocked)', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    // Seeded UNBLOCKED (postMovement itself refuses to post into an already-blocked location),
    // then blocked afterward via a plain metadata UPDATE — see blockLocation's own comment.
    const blockedLocationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId: blockedLocationId, qtyOnHand: QTY_ORDERED });
    await blockLocation(blockedLocationId, 'maintenance');
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: QTY_ORDERED }],
    });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(OutboundLocationBlockedError);
    expect((error as OutboundLocationBlockedError).i18nKey).toBe('wms.outbound.check.locationBlocked');
    // finding 6: the brief's own condition-7 message names the location code + its block reason —
    // domain/process-outbound/invariants.ts's own assertNonBlockedLocationsSufficient names this
    // param `blockReason`.
    expect((error as OutboundLocationBlockedError).params).toMatchObject({
      locationCode: locationCodeById.get(blockedLocationId),
      blockReason: 'maintenance',
    });
  });
});

describe('Scenario: Condition 7 passes when an alternative non-blocked location holds enough stock', () => {
  it('does not fail condition 7', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const blockedLocationId = await insertLocation(zoneId);
    const openLocationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId: blockedLocationId, qtyOnHand: '3.000' });
    await blockLocation(blockedLocationId, 'maintenance');
    await seedStockViaReceipt({ clientId, skuId, locationId: openLocationId, qtyOnHand: QTY_ORDERED });
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: QTY_ORDERED }],
    });

    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).not.toBe('draft');
  });
});

// --- Scenario: condition 8 — delivery address -------------------------------------------------------

describe('Scenario: Condition 8 fails — delivery order with an incomplete address', () => {
  it('rejects with DeliveryAddressIncompleteError (i18nKey wms.outbound.check.deliveryAddressIncomplete)', async () => {
    const { orderId, version } = await buildValidScenario({ shipToComplete: false, orderType: ORDER_TYPE_STANDARD });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(DeliveryAddressIncompleteError);
    expect((error as DeliveryAddressIncompleteError).i18nKey).toBe('wms.outbound.check.deliveryAddressIncomplete');
  });
});

describe('Scenario: Condition 8 is skipped for a transfer order with no ship-to fields', () => {
  it('does not fail condition 8', async () => {
    const { orderId, version } = await buildValidScenario({ shipToComplete: false, orderType: ORDER_TYPE_TRANSFER });
    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).not.toBe('draft');
  });
});

// --- Scenario: condition 9 — no service price -------------------------------------------------------

describe('Scenario: Condition 9 fails — no price for OF-01 in the client\'s contract', () => {
  it('rejects with NoServicePriceError (i18nKey wms.outbound.check.noServicePrice) quoting OF-01', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList({ withOf01Price: false }); // list exists, no OF-01 line.
    const contractId = await insertContract(clientId, { priceListId });
    const { orderId, version } = await buildValidScenario({ clientId, contractId });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(NoServicePriceError);
    expect((error as NoServicePriceError).i18nKey).toBe('wms.outbound.check.noServicePrice');
    expect((error as NoServicePriceError).params).toMatchObject({ serviceCode: SERVICE_CODE });
  });
});

describe('Scenario: Condition 9 fails when the only OF-01 price sits on a price list that is not in force', () => {
  async function expectNoServicePrice(priceListId: string): Promise<void> {
    const clientId = await insertClient();
    const contractId = await insertContract(clientId, { priceListId });
    const { orderId, version } = await buildValidScenario({ clientId, contractId });

    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(NoServicePriceError);
    expect((error as NoServicePriceError).i18nKey).toBe('wms.outbound.check.noServicePrice');
    expect((error as NoServicePriceError).params).toMatchObject({ serviceCode: SERVICE_CODE });
    expect((await getOrder(orderId)).status).toBe('draft');
  }

  it('a DRAFT price list carrying an OF-01 line -> NoServicePriceError', async () => {
    await expectNoServicePrice(await insertPriceList({ withOf01Price: true, status: 'draft' }));
  });

  it('an EXPIRED-status price list carrying an OF-01 line -> NoServicePriceError', async () => {
    await expectNoServicePrice(await insertPriceList({ withOf01Price: true, status: 'expired' }));
  });

  it('an "active" price list whose valid_to is before the clock date carrying an OF-01 line -> NoServicePriceError', async () => {
    // One day before CLOCK_DATE (2026-09-25) — lapsed by date, status still 'active'.
    const LAPSED_VALID_TO = '2026-09-24';
    await expectNoServicePrice(await insertPriceList({ withOf01Price: true, status: 'active', validTo: LAPSED_VALID_TO }));
  });
});

// --- Scenario: condition 10 — deliberate gap -------------------------------------------------------

describe('Scenario: Condition 10 is never evaluated — documents the deliberate gap', () => {
  it('an implausibly large order quantity (with matching available stock) is NOT rejected on account of condition 10', async () => {
    // finding 14: a genuinely large quantity, not QTY_ORDERED — the point being tested is that NO
    // "quantity within the agreed order limit" cap exists (condition 10, BLOCKED, no schema
    // source), so this passes however large the order is, as long as every OTHER condition is
    // still satisfied (in particular condition 3 — stock must cover it).
    const LARGE_QTY = '999999.000';
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: LARGE_QTY });
    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: LARGE_QTY }],
    });

    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('checks_pending');
  });
});

// --- Scenario: approve -------------------------------------------------------------------------------

describe('Scenario: WH_MGR approves a checks_pending order', () => {
  it('status is "approved"', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const correlationId = nextCorrelationId();
    const result = await approveOutbound(roleCtx, { orderId, expectedVersion: afterChecks.version, correlationId }, deps);
    expect(result.status).toBe('approved');

    // finding 10: outbox + audit, same transaction, same correlationId.
    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.approved')).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

describe('Scenario: ApproveOutbound without role WH_MGR is rejected', () => {
  it('rejects with RoleRequiredError, status stays unchanged', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    await expect(
      approveOutbound(noRoleCtx, { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    expect((await getOrder(orderId)).status).toBe('checks_pending');
  });
});

describe('Scenario: ApproveOutbound is illegal from "draft" (checks were never run)', () => {
  it('rejects with IllegalTransitionError, status stays draft', async () => {
    const { orderId, version } = await buildValidScenario();
    await expect(
      approveOutbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await getOrder(orderId)).status).toBe('draft');
  });
});

// --- Scenario: cancel from every reachable status -----------------------------------------------------

describe('Scenario Outline: Cancelling an order reachable in this part', () => {
  it('from draft', async () => {
    const { orderId, version } = await buildValidScenario();
    const correlationId = nextCorrelationId();
    const result = await cancelOutbound(roleCtx, { orderId, expectedVersion: version, reason: 'test', correlationId }, deps);
    expect(result.status).toBe('cancelled');

    // finding 10: outbox + audit, same transaction, same correlationId.
    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.cancelled')).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('from checks_pending', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const result = await cancelOutbound(
      roleCtx,
      { orderId, expectedVersion: afterChecks.version, reason: 'test', correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('cancelled');
  });

  it('from credit_rejected', async () => {
    const clientId = await insertClient({ creditHold: true, holdReason: CREDIT_HOLD_REASON });
    const { orderId, version } = await buildValidScenario({ clientId });
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(afterChecks.status).toBe('credit_rejected');
    const result = await cancelOutbound(
      roleCtx,
      { orderId, expectedVersion: afterChecks.version, reason: 'test', correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('cancelled');
  });

  it('from approved', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const afterApprove = await approveOutbound(roleCtx, { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() }, deps);
    const result = await cancelOutbound(
      roleCtx,
      { orderId, expectedVersion: afterApprove.version, reason: 'test', correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('cancelled');
  });
});

describe('Scenario: CancelOutbound without role WH_MGR is rejected', () => {
  it('rejects with RoleRequiredError, status stays unchanged', async () => {
    const { orderId, version } = await buildValidScenario();
    await expect(
      cancelOutbound(noRoleCtx, { orderId, expectedVersion: version, reason: 'test', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);
    expect((await getOrder(orderId)).status).toBe('draft');
  });
});

describe('Scenario: CancelOutbound without a reason is rejected', () => {
  it('rejects with CancelReasonRequiredError before any write', async () => {
    const { orderId, version } = await buildValidScenario();
    await expect(
      cancelOutbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(CancelReasonRequiredError);
    expect((await getOrder(orderId)).status).toBe('draft');
  });
});

describe("Scenario: Cancel from an unreachable status is illegal (part 2's statuses don't exist yet)", () => {
  it('an order forced to "allocated" rejects CancelOutbound with IllegalTransitionError', async () => {
    const { orderId, version } = await buildValidScenario();
    // No Allocate command exists in this part (part 2's job) — the admin pool sets the status
    // directly to exercise the machine's own refusal, exactly as receive-inbound's own
    // "CancelInbound on an order still receiving" scenario forces status via SQL, not a shortcut
    // command that doesn't exist yet.
    await pool.query(`update wms.outbound_orders set status = 'allocated' where id = $1`, [orderId]);
    await expect(
      cancelOutbound(roleCtx, { orderId, expectedVersion: version, reason: 'test', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

// --- Scenario: failed Approve/Cancel attempts roll back (finding 6, round 2) --------------------

describe('Scenario: A failed ApproveOutbound writes ZERO outbox and ZERO audit rows (rollback proof)', () => {
  it('illegal transition (still draft) -> IllegalTransitionError, nothing written', async () => {
    const { orderId, version } = await buildValidScenario();
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, IllegalTransitionError, () =>
      approveOutbound(roleCtx, { orderId, expectedVersion: version, correlationId }, deps),
    );
  });

  it('caller without WH_MGR -> RoleRequiredError, nothing written', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, RoleRequiredError, () =>
      approveOutbound(noRoleCtx, { orderId, expectedVersion: afterChecks.version, correlationId }, deps),
    );
  });

  it('stale expectedVersion -> StaleVersionError, nothing written', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, StaleVersionError, () =>
      approveOutbound(roleCtx, { orderId, expectedVersion: afterChecks.version + 1, correlationId }, deps),
    );
  });
});

describe('Scenario: A failed CancelOutbound writes ZERO outbox and ZERO audit rows (rollback proof)', () => {
  it('no reason -> CancelReasonRequiredError, nothing written', async () => {
    const { orderId, version } = await buildValidScenario();
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, CancelReasonRequiredError, () =>
      cancelOutbound(roleCtx, { orderId, expectedVersion: version, correlationId }, deps),
    );
  });

  it('caller without WH_MGR -> RoleRequiredError, nothing written', async () => {
    const { orderId, version } = await buildValidScenario();
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, RoleRequiredError, () =>
      cancelOutbound(noRoleCtx, { orderId, expectedVersion: version, reason: 'test', correlationId }, deps),
    );
  });

  it('stale expectedVersion -> StaleVersionError, nothing written', async () => {
    const { orderId, version } = await buildValidScenario();
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, StaleVersionError, () =>
      cancelOutbound(roleCtx, { orderId, expectedVersion: version + 1, reason: 'test', correlationId }, deps),
    );
  });

  it('illegal source status (forced "allocated") -> IllegalTransitionError, nothing written', async () => {
    const { orderId, version } = await buildValidScenario();
    await pool.query(`update wms.outbound_orders set status = 'allocated' where id = $1`, [orderId]);
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, IllegalTransitionError, () =>
      cancelOutbound(roleCtx, { orderId, expectedVersion: version, reason: 'test', correlationId }, deps),
    );
  });
});

// --- Scenario: stale version -----------------------------------------------------------------------

describe('Scenario: Stale version is rejected on every mutating command', () => {
  it('RunOutboundChecks rejects a stale expectedVersion', async () => {
    const { orderId, version } = await buildValidScenario();
    await expect(
      runOutboundChecks(roleCtx, { orderId, expectedVersion: version + 1, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it('ApproveOutbound rejects a stale expectedVersion', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    await expect(
      approveOutbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(StaleVersionError);
    void afterChecks;
  });

  it('CancelOutbound rejects a stale expectedVersion', async () => {
    const { orderId, version } = await buildValidScenario();
    await expect(
      cancelOutbound(roleCtx, { orderId, expectedVersion: version + 1, reason: 'test', correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(StaleVersionError);
  });
});

// --- Scenario: unknown order --------------------------------------------------------------------------

describe('Scenario: An unknown order is rejected', () => {
  it('RunOutboundChecks on a non-existent orderId rejects with OrderNotFoundError', async () => {
    await expect(
      runOutboundChecks(roleCtx, { orderId: randomUUID(), expectedVersion: 1, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
  });
});

// --- Scenario: idempotency ----------------------------------------------------------------------------

describe('Scenario: Idempotent replay and conflicting replay', () => {
  it('ApproveOutbound replays the stored result for the same key + same body', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const idemKey = `approve-replay-${randomUUID()}`;
    const body = { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() };

    const first = await approveOutbound(roleCtx, { ...body, idem: idemFor('approve-outbound', idemKey, body) }, deps);
    const second = await approveOutbound(roleCtx, { ...body, idem: idemFor('approve-outbound', idemKey, body) }, deps);
    expect(second).toEqual(first);

    const after = await getOrder(orderId);
    expect(after.status).toBe('approved');
  });

  it('the same key with a different body is rejected with IdempotencyConflictError', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const idemKey = `approve-mismatch-${randomUUID()}`;
    const firstBody = { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() };
    await approveOutbound(roleCtx, { ...firstBody, idem: idemFor('approve-outbound', idemKey, firstBody) }, deps);

    const differentBody = { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() };
    await expect(
      approveOutbound(roleCtx, { ...differentBody, idem: idemFor('approve-outbound', idemKey, differentBody) }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- Scenario: RLS -----------------------------------------------------------------------------------

describe('Scenario: RLS — a caller scoped to another entity cannot see or write the order', () => {
  // finding 12: split into two INDEPENDENT `it` blocks — read isolation and write isolation each
  // build their OWN order fixture, so the read half's failing assertion (below) can never abort
  // the write half before it runs (the original single-`it` version threw at the read assertion
  // and the write-isolation half after it never executed at all).

  // A pre-existing wms.outbound_orders entity_scope RLS defect (SCR-RLS-03/D-181) made this
  // assertion RED earlier in this slice's fix round (2026-09-25) — reported to the Master; the
  // assertion itself was never weakened. Fixed by migration 0025 (merged to main, confirmed applied
  // on the shared DB): client_portal_scope now reads `NOT is_internal() AND client_id =
  // current_client_id()`, and entity_scope alone governs an internal caller's read (no more
  // is_internal() bypass for a user with no identity.user_entities row). Now GREEN: the outsider
  // (no identity.user_entities row for entity PST) genuinely sees zero rows. Left exactly as the
  // acceptance scenario requires — do not soften it back.
  it('READ isolation: the order is invisible to a pgeos_app query scoped to the outsider', async () => {
    const { orderId } = await buildValidScenario();

    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [OUTSIDER_ACTOR_UUID]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      const visible: QueryResult<{ id: string }> = await client.query(`select id from wms.outbound_orders where id = $1`, [orderId]);
      expect(visible.rows).toHaveLength(0);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('WRITE isolation: ApproveOutbound as the outsider fails with OrderNotFoundError, status unchanged', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    await expect(
      approveOutbound(outsiderCtx, { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect((await getOrder(orderId)).status).toBe('checks_pending');
  });
});
