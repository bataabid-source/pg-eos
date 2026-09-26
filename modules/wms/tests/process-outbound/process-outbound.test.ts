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
// Condition execution order (Master decision 3): 1, 3, 4, 5, 6, 7, 8, 9, 10 run first (any failure
// THROWS and leaves the order 'draft', nothing persisted); condition 2 (credit hold) is checked
// LAST and, on failure, transitions the order to 'credit_rejected' instead of throwing. Every
// per-condition failure test below satisfies every condition BEFORE the one under test so the
// failure under test is the one that actually fires. Condition 10 (WBS 2.11 part 5, D-189): a
// per-contract, per-SKU order-quantity limit read from `sales.contract_sku_limits` (read-only,
// cross-schema, inside RunOutboundChecks' own repository — see insertContractSkuLimit below); a
// missing row means no cap for that (contract, sku) pair.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test — part 1's four commands, plus part 2's own Allocate/GeneratePickList
// (_slice-2.11.brief.md part 2, Master decisions 2/3) — RED until pg-backend adds both to the
// application/process-outbound barrel.
import {
  allocate,
  approveOutbound,
  cancelOutbound,
  checkOrder,
  createOutbound,
  generatePickList,
  pickLine,
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
  LineAlreadyPickedError,
  LineNotReservedForPickError,
  OutboundLocationBlockedError,
  NoServicePriceError,
  OrderLineNotFoundError,
  OrderNotFoundError,
  OrderQuantityExceededError,
  PickQuantityExceedsReservedError,
  RoleRequiredError,
  SelfCheckNotAllowedError,
  ShelfLifeTooShortError,
  SkuBlockedError,
  SkuClientMismatchError,
  StaleVersionError,
  VarianceReasonRequiredError,
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
// _slice-2.11.brief.md, Allocation rule (Master ruling, verbatim): a partially-allocated line carries
// "the `insufficient_stock` variance constant".
const INSUFFICIENT_STOCK_VARIANCE_REASON = 'insufficient_stock';

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
const fixtureContractSkuLimitIds: string[] = []; // WBS 2.11 part 5 (condition 10, D-189).
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

/** WBS 2.11 part 5 (condition 10, D-189, migration 0026): a per-(contract, sku) order-quantity
 *  cap. `sales.contract_sku_limits` does not exist in code yet (no repository/domain surface) —
 *  this is a plain raw-SQL insert against the table the pending migration adds, same "direct SQL
 *  fixture" discipline createDraftOutboundOrderFixture already uses for wms.order_lines. RED until
 *  migration 0026 lands: fails with "relation sales.contract_sku_limits does not exist" until then. */
async function insertContractSkuLimit(params: {
  readonly contractId: string;
  readonly skuId: string;
  readonly maxOrderQty: string;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.contract_sku_limits (entity_id, contract_id, sku_id, max_order_qty, created_by)
     values ($1, $2, $3, $4::numeric, $5) returning id`,
    [entityId, params.contractId, params.skuId, params.maxOrderQty, ROLE_ACTOR_UUID],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture sales.contract_sku_limits insert returned no row');
  fixtureContractSkuLimitIds.push(row.id);
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
    // WBS 2.11 part 2, Master decision 2: wms.skus.picking_policy ('FIFO'|'FEFO'|'LIFO'), default
    // 'FIFO' (schema default) — Allocate's own FEFO/FIFO ordering scenarios override this.
    readonly pickingPolicy?: 'FIFO' | 'FEFO' | 'LIFO';
  } = {},
): Promise<string> {
  const code = `PROCOUT-${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, status, track_expiry, min_remaining_life_issue_days, picking_policy)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      clientId,
      code,
      `صنف اختبار صرف صادر ${code}`,
      opts.status ?? 'active',
      opts.trackExpiry ?? false,
      opts.minRemainingLifeIssueDays ?? null,
      opts.pickingPolicy ?? 'FIFO',
    ],
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

async function insertLocation(
  zoneId: string,
  opts: {
    readonly isBlocked?: boolean;
    readonly blockReason?: string;
    // WBS 2.11 part 2, Master decision 3 (GeneratePickList "shortest path"): wms.locations.position_no,
    // the same proximity proxy 2.9/2.10's own SuggestLocation already uses.
    readonly positionNo?: number | null;
  } = {},
): Promise<string> {
  for (let attempt = 0; attempt < FIXTURE_LOCATION_MAX_ATTEMPTS; attempt += 1) {
    const code = randomFixtureLocationCode();
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.locations (warehouse_id, zone_id, code, location_type, is_blocked, block_reason, position_no)
       values ($1, $2, $3, 'pallet', $4, $5, $6)
       on conflict (warehouse_id, code) do nothing
       returning id`,
      [warehouseId, zoneId, code, opts.isBlocked ?? false, opts.blockReason ?? null, opts.positionNo ?? null],
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
  // WBS 2.11 part 2 (Master decision 2, FIFO): postMovement always sets last_movement_at = now()
  // (the FIXED clock's own instant) — two lots seeded in the same test run land on the SAME
  // instant, which can never exercise FIFO ordering. This override applies a direct follow-up
  // UPDATE, same mechanism as `expiryDate` above (postMovement's own LedgerEntry carries no
  // override field for either).
  readonly lastMovementAt?: string;
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
  if (params.lastMovementAt !== undefined) {
    await pool.query(
      `update wms.stock_balance set last_movement_at = $1::timestamptz
        where client_id = $2 and sku_id = $3 and location_id = $4 and batch_no = $5`,
      [params.lastMovementAt, params.clientId, params.skuId, params.locationId, batchNo],
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

// --- WBS 2.11 part 2 fixture helpers (Allocate / GeneratePickList / extended CancelOutbound) -------

/** Walks buildValidScenario's order through RunOutboundChecks + ApproveOutbound (the real
 *  commands, not a shortcut) to 'approved' — Allocate's own precondition. */
async function buildApprovedOrder(
  overrides: Parameters<typeof buildValidScenario>[0] = {},
): Promise<Awaited<ReturnType<typeof buildValidScenario>>> {
  const built = await buildValidScenario(overrides);
  const afterChecks = await runOutboundChecks(
    roleCtx,
    { orderId: built.orderId, expectedVersion: built.version, correlationId: nextCorrelationId() },
    deps,
  );
  const afterApprove = await approveOutbound(
    roleCtx,
    { orderId: built.orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() },
    deps,
  );
  return { ...built, version: afterApprove.version };
}

async function getOrderLine(lineId: string): Promise<{
  status: string;
  location_id: string | null;
  batch_no: string | null;
  qty_actual: string | null;
  variance_reason: string | null;
}> {
  const result: QueryResult<{
    status: string;
    location_id: string | null;
    batch_no: string | null;
    qty_actual: string | null;
    variance_reason: string | null;
  }> = await pool.query(
    `select status, location_id, batch_no, qty_actual::text as qty_actual, variance_reason
       from wms.order_lines where id = $1`,
    [lineId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.order_lines row for id ${lineId}`);
  return row;
}

async function getStockBalanceQtyAllocated(clientId: string, skuId: string, locationId: string, batchNo: string): Promise<string> {
  const result: QueryResult<{ qty_allocated: string }> = await pool.query(
    `select qty_allocated::text as qty_allocated from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = $4`,
    [clientId, skuId, locationId, batchNo],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.stock_balance row for client ${clientId} sku ${skuId} location ${locationId} batch ${batchNo}`);
  return row.qty_allocated;
}

async function stockMovementCountForClient(clientId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.stock_movements where client_id = $1`,
    [clientId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Round 3: every wms.stock_balance row of a client/SKU — proves Allocate never creates or touches
 *  a balance row for a SKU that has no stock. */
async function stockBalanceRowCountForSku(clientId: string, skuId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.stock_balance where client_id = $1 and sku_id = $2`,
    [clientId, skuId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Forces a draft fixture order straight to 'approved' (admin pool) — the same shortcut the
 *  partial-allocation scenarios below already take to reach Allocate without RunOutboundChecks'
 *  own condition-3 gate. Returns the order's version for Allocate's expectedVersion. */
async function forceApprove(orderId: string): Promise<number> {
  const approvedResult: QueryResult<{ version: number }> = await pool.query(
    `update wms.outbound_orders set status = 'approved', credit_check_passed = true, credit_checked_at = now()
      where id = $1 returning version`,
    [orderId],
  );
  const row = approvedResult.rows[0];
  if (!row) throw new Error(`no wms.outbound_orders row for id ${orderId}`);
  return row.version;
}

/** Round 3 (doc 40 §A1 P7): the `new_value` of the ONE wms.outbound_orders audit row a command
 *  wrote under `correlationId` — read on the admin pool, never deleted. */
async function auditNewValueForCorrelation(correlationId: string): Promise<Record<string, unknown>> {
  const result: QueryResult<{ new_value: Record<string, unknown> }> = await pool.query(
    `select new_value from platform.audit_log
      where correlation_id = $1 and schema_name = 'wms' and table_name = 'outbound_orders'`,
    [correlationId],
  );
  expect(result.rows).toHaveLength(1);
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.audit_log row for correlation ${correlationId}`);
  return row.new_value;
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
      ['sales.contract_sku_limits', () => pool.query(`delete from sales.contract_sku_limits where id = any($1::uuid[])`, [fixtureContractSkuLimitIds])],
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

// --- Scenario: all ten conditions pass -------------------------------------------------------------

describe('Scenario: All ten conditions pass — reaches checks_pending', () => {
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

    const correlationId = nextCorrelationId();
    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ContractNotActiveError);
    expect(error).not.toBeInstanceOf(ContractExpiredError);
    expect((error as ContractNotActiveError).i18nKey).toBe('wms.outbound.check.contractNotActive');
    expect((await getOrder(orderId)).status).toBe('draft');
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
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

// --- Scenario: condition 10 — per-contract, per-SKU order limit (WBS 2.11 part 5, D-189) ------------

/** Manual setup mirroring buildValidScenario but with a caller-chosen line quantity — condition
 *  10's own tests need quantities other than the fixed QTY_ORDERED. Stock is seeded generously
 *  (10x the ordered quantity) so condition 3 (insufficient stock) never fires here — the point
 *  under test is condition 10 alone. */
async function buildCondition10Scenario(qtyOrdered: string): Promise<{
  orderId: string;
  version: number;
  clientId: string;
  contractId: string;
  skuId: string;
}> {
  const clientId = await insertClient();
  const priceListId = await insertPriceList();
  const contractId = await insertContract(clientId, { priceListId });
  const skuId = await insertSku(clientId);
  const zoneId = await insertZone();
  const locationId = await insertLocation(zoneId);
  const generousStock = (Number(qtyOrdered) * 10 + 1000).toFixed(3);
  await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: generousStock });
  const { orderId, version } = await createDraftOutboundOrderFixture({
    clientId,
    contractId,
    shipToName: 'x',
    shipToPhone: 'x',
    shipToAddress: 'x',
    shipToArea: 'x',
    lines: [{ skuId, qtyOrdered }],
  });
  return { orderId, version, clientId, contractId, skuId };
}

describe('Scenario: Condition 10 passes when the SKU has no contract limit row', () => {
  it('no sales.contract_sku_limits row for this contract/SKU -> condition 10 does not fail (no limit means no cap)', async () => {
    const { orderId, version } = await buildCondition10Scenario('50.000');
    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('checks_pending');
  });
});

describe('Scenario: Condition 10 passes when the ordered quantity is within the limit', () => {
  it('max_order_qty 100, ordered 50 -> condition 10 does not fail', async () => {
    const { orderId, version, contractId, skuId } = await buildCondition10Scenario('50.000');
    await insertContractSkuLimit({ contractId, skuId, maxOrderQty: '100.000' });
    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('checks_pending');
  });
});

describe('Scenario: Condition 10 fails when the ordered quantity exceeds the limit', () => {
  it('rejects with OrderQuantityExceededError (i18nKey wms.outbound.check.orderQuantityExceeded) naming the SKU code, ordered quantity and limit — status stays "draft", nothing written to outbox or audit', async () => {
    const ORDERED = '15.000';
    const LIMIT = '10.000';
    const { orderId, version, contractId, skuId } = await buildCondition10Scenario(ORDERED);
    await insertContractSkuLimit({ contractId, skuId, maxOrderQty: LIMIT });
    const skuCode = skuCodeById.get(skuId);
    if (!skuCode) throw new Error('fixture sku code not recorded');

    const correlationId = nextCorrelationId();
    const error = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId }, deps).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(OrderQuantityExceededError);
    expect((error as OrderQuantityExceededError).i18nKey).toBe('wms.outbound.check.orderQuantityExceeded');
    expect((error as OrderQuantityExceededError).params).toMatchObject({ skuCode, ordered: ORDERED, limit: LIMIT });

    const after = await getOrder(orderId);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(version);
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });
});

describe('Scenario: Condition 10\'s limit is exact — ordered equal to the limit still passes', () => {
  it('max_order_qty 10, ordered exactly 10 -> condition 10 does not fail (the limit is inclusive)', async () => {
    const { orderId, version, contractId, skuId } = await buildCondition10Scenario('10.000');
    await insertContractSkuLimit({ contractId, skuId, maxOrderQty: '10.000' });
    const result = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('checks_pending');
  });
});

// Scenario: All ten conditions now have a failing test with the correct message (doc 38 row 2.11).
// Not a literal runnable test — a bookkeeping note, matching this file's own condition 1-9 coverage
// above: conditions 1 (ContractNotActiveError/ContractExpiredError), 2 (credit hold, evaluateCreditHold),
// 3 (InsufficientStockError), 4 (SkuClientMismatchError), 5 (ShelfLifeTooShortError), 6
// (SkuBlockedError), 7 (OutboundLocationBlockedError), 8 (DeliveryAddressIncompleteError), 9
// (NoServicePriceError) each have a failing-message test above; condition 10 (OrderQuantityExceededError)
// is added by the four describe blocks immediately above this comment — doc-38 row 2.11's acceptance
// criterion ("Each of ten conditions has a failing test with the correct message") is met once
// pg-backend turns these RED tests GREEN.

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

describe("Scenario: Cancel from an unreachable status is illegal (picking onward — 2.12's job)", () => {
  // WBS 2.11 part 2 (Master decision 1): `allocated`/`partially_allocated` are NOW legal
  // CancelOutbound sources (see "Scenario: Cancelling an allocated order releases the reservation"
  // below) — this scenario moves to `picking`, the first status past allocation that still has NO
  // CANCEL edge (2.12's own job).
  it('an order forced to "picking" rejects CancelOutbound with IllegalTransitionError', async () => {
    const { orderId, version } = await buildValidScenario();
    // No PickList/StartPicking command exists yet (2.12's job) — the admin pool sets the status
    // directly to exercise the machine's own refusal, exactly as receive-inbound's own
    // "CancelInbound on an order still receiving" scenario forces status via SQL, not a shortcut
    // command that doesn't exist yet.
    await pool.query(`update wms.outbound_orders set status = 'picking' where id = $1`, [orderId]);
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

  it('illegal source status (forced "picking", part 2\'s allocated/partially_allocated are now legal) -> IllegalTransitionError, nothing written', async () => {
    const { orderId, version } = await buildValidScenario();
    await pool.query(`update wms.outbound_orders set status = 'picking' where id = $1`, [orderId]);
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

// ================================================================================================
// WBS 2.11 part 2 — Allocate, GeneratePickList, CancelOutbound extension
// (_slice-2.11.brief.md part 2, Master decisions 2-7). RED until pg-backend adds allocate.ts,
// generate-pick-list.ts, and edits cancel-outbound.ts/machine.ts/invariants.ts/repository.ts.
// Every scenario below EXTENDS this file — nothing above this marker is touched except the two
// "unreachable status" tests updated above (allocated/partially_allocated are now legal Cancel
// sources, so those tests moved to 'picking').
// ================================================================================================

// --- Scenario: FEFO allocation picks the earliest-expiring lot first ----------------------------

describe('Scenario: FEFO allocation picks the earliest-expiring lot first', () => {
  async function runFefoScenario(lotQty: string): Promise<void> {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId, { trackExpiry: true, pickingPolicy: 'FEFO' });
    const zoneId = await insertZone();
    const nearExpiryLocationId = await insertLocation(zoneId);
    const farExpiryLocationId = await insertLocation(zoneId);
    const NEAR_EXPIRY_DATE = '2026-10-01';
    const FAR_EXPIRY_DATE = '2027-01-01';
    const nearBatch = `LOT-NEAR-${randomUUID().slice(0, 8)}`;
    const farBatch = `LOT-FAR-${randomUUID().slice(0, 8)}`;
    await seedStockViaReceipt({ clientId, skuId, locationId: nearExpiryLocationId, qtyOnHand: lotQty, batchNo: nearBatch, expiryDate: NEAR_EXPIRY_DATE });
    await seedStockViaReceipt({ clientId, skuId, locationId: farExpiryLocationId, qtyOnHand: lotQty, batchNo: farBatch, expiryDate: FAR_EXPIRY_DATE });

    const { orderId, version, lineIds } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: lotQty }],
    });
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const afterApprove = await approveOutbound(roleCtx, { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() }, deps);

    const result = await allocate(roleCtx, { orderId, expectedVersion: afterApprove.version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('allocated');

    const line = await getOrderLine(lineIds[0] as string);
    expect(line.status).toBe('complete');
    expect(line.location_id).toBe(nearExpiryLocationId);
    expect(line.batch_no).toBe(nearBatch);
    expect(await getStockBalanceQtyAllocated(clientId, skuId, nearExpiryLocationId, nearBatch)).toBe(lotQty);
    expect(await getStockBalanceQtyAllocated(clientId, skuId, farExpiryLocationId, farBatch)).toBe('0.000');
  }

  it('consumes the earlier-expiring lot first, sets order_lines location/batch, status "allocated"', async () => {
    await runFefoScenario('6.000');
  });

  it('fractional (3-decimal) quantities allocate correctly with FEFO ordering (finding-7 regression guard)', async () => {
    await runFefoScenario('6.375');
  });
});

// --- Scenario: FIFO allocation for a non-expiry SKU picks the oldest-moved lot first ------------

describe('Scenario: FIFO allocation for a non-expiry SKU picks the oldest-moved lot first', () => {
  it('consumes the lot with the earliest last_movement_at first', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId, { pickingPolicy: 'FIFO' });
    const zoneId = await insertZone();
    const olderLocationId = await insertLocation(zoneId);
    const newerLocationId = await insertLocation(zoneId);
    const olderBatch = `LOT-OLDER-${randomUUID().slice(0, 8)}`;
    const newerBatch = `LOT-NEWER-${randomUUID().slice(0, 8)}`;
    const LOT_QTY = '4.500';
    await seedStockViaReceipt({
      clientId,
      skuId,
      locationId: olderLocationId,
      qtyOnHand: LOT_QTY,
      batchNo: olderBatch,
      lastMovementAt: '2026-01-01T00:00:00.000Z',
    });
    await seedStockViaReceipt({
      clientId,
      skuId,
      locationId: newerLocationId,
      qtyOnHand: LOT_QTY,
      batchNo: newerBatch,
      lastMovementAt: '2026-09-01T00:00:00.000Z',
    });

    const { orderId, version, lineIds } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: LOT_QTY }],
    });
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const afterApprove = await approveOutbound(roleCtx, { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() }, deps);

    const result = await allocate(roleCtx, { orderId, expectedVersion: afterApprove.version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('allocated');

    const line = await getOrderLine(lineIds[0] as string);
    expect(line.location_id).toBe(olderLocationId);
    expect(line.batch_no).toBe(olderBatch);
    expect(await getStockBalanceQtyAllocated(clientId, skuId, olderLocationId, olderBatch)).toBe(LOT_QTY);
    expect(await getStockBalanceQtyAllocated(clientId, skuId, newerLocationId, newerBatch)).toBe('0.000');
  });
});

// --- Scenario: partial allocation when stock runs out mid-line -----------------------------------

describe('Scenario: Partial allocation when stock runs out mid-line', () => {
  async function runPartialScenario(available: string, ordered: string): Promise<{ orderId: string; lineId: string }> {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: available });

    // condition 3 sums ALL locations including blocked (Master decision 3, part 1) — to reach
    // Allocate with LESS than `ordered` truly available, this line must skip RunOutboundChecks'
    // own condition 3 gate: the order is force-approved directly (admin pool), matching this file's
    // own "Cancel from an unreachable status" pattern of forcing a status a command can't reach any
    // other way — condition 3's own sufficiency check is part 1's job, already covered there;
    // Allocate's OWN partial-allocation path (this scenario) is a distinct code path this part adds.
    const { orderId, lineIds } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: ordered }],
    });
    const approvedResult: QueryResult<{ version: number }> = await pool.query(
      `update wms.outbound_orders set status = 'approved', credit_check_passed = true, credit_checked_at = now()
        where id = $1 returning version`,
      [orderId],
    );
    const version = (approvedResult.rows[0] as { version: number }).version;

    const result = await allocate(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('partially_allocated');

    const line = await getOrderLine(lineIds[0] as string);
    expect(line.status).toBe('partial');
    expect((await getOrder(orderId)).status).toBe('partially_allocated');
    return { orderId, lineId: lineIds[0] as string };
  }

  it('status is "partially_allocated", the line is "partial", the order is not auto-closed', async () => {
    await runPartialScenario('3.000', '10.000');
  });

  it('fractional shortfall (3 decimals) still partially allocates correctly (finding-7 regression guard)', async () => {
    await runPartialScenario('3.125', '10.375');
  });
});

// --- Scenario: Allocate is illegal before approval ------------------------------------------------

describe('Scenario: Allocate is illegal before approval (still draft or checks_pending)', () => {
  it('rejects with IllegalTransitionError when the order is still "draft"', async () => {
    const { orderId, version } = await buildValidScenario();
    await expect(
      allocate(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await getOrder(orderId)).status).toBe('draft');
  });

  it('rejects with IllegalTransitionError when the order is "checks_pending"', async () => {
    const { orderId, version } = await buildValidScenario();
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    await expect(
      allocate(roleCtx, { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await getOrder(orderId)).status).toBe('checks_pending');
  });
});

// --- Scenario: Stale version is rejected on Allocate and the extended CancelOutbound --------------

describe('Scenario: Stale version is rejected on Allocate and the extended CancelOutbound', () => {
  it('rejects a stale expectedVersion on Allocate with StaleVersionError, nothing written', async () => {
    const { orderId, version } = await buildApprovedOrder();
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, StaleVersionError, () =>
      allocate(roleCtx, { orderId, expectedVersion: version + 999, correlationId }, deps),
    );
  });

  it('rejects a stale expectedVersion on the extended CancelOutbound with StaleVersionError, nothing released, nothing written (allocated source)', async () => {
    const { orderId, version, clientId, skuId, locationId } = await buildApprovedOrder();
    const afterAllocate = await allocate(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('allocated');
    const qtyAllocatedBefore = await getStockBalanceQtyAllocated(clientId, skuId, locationId, '');
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, StaleVersionError, () =>
      cancelOutbound(roleCtx, { orderId, expectedVersion: afterAllocate.version + 999, reason: 'test', correlationId }, deps),
    );
    // item 4 gap 2: the reserved lot's qty_allocated is genuinely unchanged, not just the order's
    // own status/version/outbox/audit counts (already covered by expectFailedAttemptRolledBack).
    expect(await getStockBalanceQtyAllocated(clientId, skuId, locationId, '')).toBe(qtyAllocatedBefore);
  });

  it('rejects a stale expectedVersion on the extended CancelOutbound with StaleVersionError, nothing released, nothing written (partially_allocated source)', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: '3.000' });
    const { orderId } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: '10.000' }],
    });
    const version = await forceApprove(orderId);
    const afterAllocate = await allocate(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('partially_allocated');
    const qtyAllocatedBefore = await getStockBalanceQtyAllocated(clientId, skuId, locationId, '');
    const correlationId = nextCorrelationId();
    await expectFailedAttemptRolledBack(orderId, correlationId, StaleVersionError, () =>
      cancelOutbound(roleCtx, { orderId, expectedVersion: afterAllocate.version + 999, reason: 'test', correlationId }, deps),
    );
    expect(await getStockBalanceQtyAllocated(clientId, skuId, locationId, '')).toBe(qtyAllocatedBefore);
  });
});

// --- Scenario: Idempotent replay and conflicting replay on Allocate --------------------------------

describe('Scenario: Idempotent replay and conflicting replay on Allocate', () => {
  it('replays the stored result for the same key + same body', async () => {
    const { orderId, version } = await buildApprovedOrder();
    const idemKey = `allocate-replay-${randomUUID()}`;
    const correlationId = nextCorrelationId();
    const body = { orderId, expectedVersion: version, correlationId };
    const first = await allocate(roleCtx, { ...body, idem: idemFor('allocate', idemKey, body) }, deps);
    const second = await allocate(roleCtx, { ...body, idem: idemFor('allocate', idemKey, body) }, deps);
    expect(second).toEqual(first);
    expect((await getOrder(orderId)).status).toBe('allocated');
    // item 4 gap 3: no second write happened for this correlationId — outbox and audit rows stay
    // at exactly one after the replay, not just `second toEqual first`.
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('rejects a conflicting replay (same key, different body) with IdempotencyConflictError', async () => {
    const { orderId, version } = await buildApprovedOrder();
    const idemKey = `allocate-mismatch-${randomUUID()}`;
    const firstBody = { orderId, expectedVersion: version, correlationId: nextCorrelationId() };
    await allocate(roleCtx, { ...firstBody, idem: idemFor('allocate', idemKey, firstBody) }, deps);

    const differentBody = { orderId, expectedVersion: version, correlationId: nextCorrelationId() };
    await expect(
      allocate(roleCtx, { ...differentBody, idem: idemFor('allocate', idemKey, differentBody) }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- Scenario: Allocate writes outbox + audit, never a stock_movements row -----------------------

describe('Scenario: Allocate writes outbox + audit, never a stock_movements row', () => {
  it('full allocation writes exactly one wms.outbound.allocated event + one audit row, no stock_movements row', async () => {
    const { orderId, version, clientId } = await buildApprovedOrder();
    const before = await stockMovementCountForClient(clientId);
    const correlationId = nextCorrelationId();
    const result = await allocate(roleCtx, { orderId, expectedVersion: version, correlationId }, deps);
    expect(result.status).toBe('allocated');

    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.allocated')).toHaveLength(1);
    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.partially_allocated')).toHaveLength(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
    expect(await stockMovementCountForClient(clientId)).toBe(before);
  });

  it('partial allocation writes exactly one wms.outbound.partially_allocated event + one audit row, no stock_movements row', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: '2.000' });
    const { orderId } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: '9.000' }],
    });
    const approvedResult: QueryResult<{ version: number }> = await pool.query(
      `update wms.outbound_orders set status = 'approved', credit_check_passed = true, credit_checked_at = now()
        where id = $1 returning version`,
      [orderId],
    );
    const version = (approvedResult.rows[0] as { version: number }).version;
    const before = await stockMovementCountForClient(clientId);

    const correlationId = nextCorrelationId();
    const result = await allocate(roleCtx, { orderId, expectedVersion: version, correlationId }, deps);
    expect(result.status).toBe('partially_allocated');

    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.partially_allocated')).toHaveLength(1);
    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.allocated')).toHaveLength(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
    expect(await stockMovementCountForClient(clientId)).toBe(before);
  });
});

// --- Scenario: GeneratePickList orders by position_no, not line order ----------------------------

describe('Scenario: GeneratePickList orders by position_no (shortest path), not line order', () => {
  it('returns lines ordered by location position_no ascending, ties broken by line_no', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuA = await insertSku(clientId);
    const skuB = await insertSku(clientId);
    const skuC = await insertSku(clientId);
    const zoneId = await insertZone();
    // Far location gets line 1 (declared first), near location gets line 2 — GeneratePickList must
    // still return the NEAR location's line first (position_no, not declaration/line order).
    const farLocationId = await insertLocation(zoneId, { positionNo: 90 });
    const nearLocationId = await insertLocation(zoneId, { positionNo: 5 });
    // A second line sharing the near location's position_no (tie), with a HIGHER line_no — must
    // sort AFTER the near location's own first line.
    const tieLocationId = await insertLocation(zoneId, { positionNo: 5 });
    const QTY = '2.000';
    await seedStockViaReceipt({ clientId, skuId: skuA, locationId: farLocationId, qtyOnHand: QTY });
    await seedStockViaReceipt({ clientId, skuId: skuB, locationId: nearLocationId, qtyOnHand: QTY });
    await seedStockViaReceipt({ clientId, skuId: skuC, locationId: tieLocationId, qtyOnHand: QTY });

    const { orderId, version, lineIds } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [
        { skuId: skuA, qtyOrdered: QTY }, // line 1, far (position_no 90)
        { skuId: skuB, qtyOrdered: QTY }, // line 2, near (position_no 5)
        { skuId: skuC, qtyOrdered: QTY }, // line 3, tie with line 2 (position_no 5)
      ],
    });
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const afterApprove = await approveOutbound(roleCtx, { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() }, deps);
    const afterAllocate = await allocate(roleCtx, { orderId, expectedVersion: afterApprove.version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('allocated');

    // Local shape mirroring the contract GeneratePickList's result is expected to carry (brief
    // Master decision 3: "every allocated order_lines row ... joined to its location's position_no,
    // sorted ascending, ties broken by line_no") — documents the expectation, keeps this callback
    // explicitly typed (CLAUDE.md: no implicit `any`).
    const pickList: { readonly lines: ReadonlyArray<{ readonly lineId: string }> } = await generatePickList(
      roleCtx,
      { orderId, correlationId: nextCorrelationId() },
      deps,
    );
    expect(pickList.lines.map((l: { readonly lineId: string }) => l.lineId)).toEqual([lineIds[1], lineIds[2], lineIds[0]]);
  });
});

describe('Scenario: GeneratePickList is illegal before allocation', () => {
  it('rejects with IllegalTransitionError when the order is "approved" but not yet allocated', async () => {
    const { orderId } = await buildApprovedOrder();
    await expect(
      generatePickList(roleCtx, { orderId, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});

// --- Scenario: Cancelling an allocated / partially_allocated order releases the reservation -------

describe('Scenario: Cancelling an allocated order releases the reservation', () => {
  it('qty_allocated on the consumed lot returns to its pre-allocation value, status is "cancelled"', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    const batchNo = '';
    const LOT_QTY = '5.000';
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: LOT_QTY });

    const { orderId, version } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: LOT_QTY }],
    });
    const afterChecks = await runOutboundChecks(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const afterApprove = await approveOutbound(roleCtx, { orderId, expectedVersion: afterChecks.version, correlationId: nextCorrelationId() }, deps);
    const afterAllocate = await allocate(roleCtx, { orderId, expectedVersion: afterApprove.version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('allocated');
    expect(await getStockBalanceQtyAllocated(clientId, skuId, locationId, batchNo)).toBe(LOT_QTY);

    const result = await cancelOutbound(
      roleCtx,
      { orderId, expectedVersion: afterAllocate.version, reason: 'test release', correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('cancelled');
    expect(await getStockBalanceQtyAllocated(clientId, skuId, locationId, batchNo)).toBe('0.000');
  });
});

describe('Scenario: Cancelling a partially_allocated order releases only the lot it reserved', () => {
  it('a SECOND lot of the SAME client/SKU at another location that Allocate never reached is unaffected; the consumed lot returns to its pre-allocation value', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId, { pickingPolicy: 'FIFO' });
    const zoneId = await insertZone();
    const consumedLocationId = await insertLocation(zoneId);
    const untouchedLocationId = await insertLocation(zoneId);
    const batchNo = '';
    // The FIRST lot in FIFO order (earlier last_movement_at) — Allocate's single-lot rule (Master
    // ruling, fix round 1 findings 1/3) always picks the first-in-policy-order lot when no lot
    // fully covers the line, so this is the one that gets consumed.
    await seedStockViaReceipt({
      clientId,
      skuId,
      locationId: consumedLocationId,
      qtyOnHand: '3.000',
      lastMovementAt: '2026-01-01T00:00:00.000Z',
    });
    // A SECOND lot of the SAME client/SKU (fix round 1 finding 4: the previous fixture used a
    // DIFFERENT client's SKU here, which Allocate could never reach anyway — the assertion could
    // never meaningfully fail). This lot is ordered AFTER the consumed lot by FIFO and, on its own,
    // is too small to be chosen as a "fully covering" lot ahead of it — a real, reachable candidate
    // that the single-lot rule correctly leaves untouched.
    await seedStockViaReceipt({
      clientId,
      skuId,
      locationId: untouchedLocationId,
      qtyOnHand: '2.000',
      lastMovementAt: '2026-06-01T00:00:00.000Z',
    });

    const { orderId } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: '9.000' }],
    });
    const approvedResult: QueryResult<{ version: number }> = await pool.query(
      `update wms.outbound_orders set status = 'approved', credit_check_passed = true, credit_checked_at = now()
        where id = $1 returning version`,
      [orderId],
    );
    const approvedVersion = (approvedResult.rows[0] as { version: number }).version;
    const afterAllocate = await allocate(roleCtx, { orderId, expectedVersion: approvedVersion, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('partially_allocated');
    expect(await getStockBalanceQtyAllocated(clientId, skuId, consumedLocationId, batchNo)).toBe('3.000');
    expect(await getStockBalanceQtyAllocated(clientId, skuId, untouchedLocationId, batchNo)).toBe('0.000');

    const result = await cancelOutbound(
      roleCtx,
      { orderId, expectedVersion: afterAllocate.version, reason: 'test partial release', correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('cancelled');
    expect(await getStockBalanceQtyAllocated(clientId, skuId, consumedLocationId, batchNo)).toBe('0.000');
    expect(await getStockBalanceQtyAllocated(clientId, skuId, untouchedLocationId, batchNo)).toBe('0.000');
  });
});

// --- Scenario: a line larger than any single lot — partial allocation from ONE lot (single-lot rule,
// Master ruling; round 3 finding 4 maps it to its own Gherkin scenario) --------------------------------

describe('Scenario: A line larger than any single lot is partially allocated from one lot, the remainder unallocated', () => {
  it('order lands "partially_allocated", the line is "partial", qty_actual equals the first-in-FIFO-order lot\'s availability (not the sum) with variance reason "insufficient_stock", and the other lot is completely untouched', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId, { pickingPolicy: 'FIFO' });
    const zoneId = await insertZone();
    const largerLocationId = await insertLocation(zoneId); // first in FIFO order (the best single lot).
    const smallerLocationId = await insertLocation(zoneId); // second in FIFO order, the smaller lot.
    const batchNo = '';
    const LARGER_QTY = '5.000';
    const SMALLER_QTY = '4.000';
    const ORDERED_QTY = '8.000'; // neither lot alone covers 8.000; the SUM (9.000) would.
    await seedStockViaReceipt({
      clientId,
      skuId,
      locationId: largerLocationId,
      qtyOnHand: LARGER_QTY,
      lastMovementAt: '2026-01-01T00:00:00.000Z',
    });
    await seedStockViaReceipt({
      clientId,
      skuId,
      locationId: smallerLocationId,
      qtyOnHand: SMALLER_QTY,
      lastMovementAt: '2026-06-01T00:00:00.000Z',
    });

    const { orderId, lineIds } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: ORDERED_QTY }],
    });
    const approvedResult: QueryResult<{ version: number }> = await pool.query(
      `update wms.outbound_orders set status = 'approved', credit_check_passed = true, credit_checked_at = now()
        where id = $1 returning version`,
      [orderId],
    );
    const approvedVersion = (approvedResult.rows[0] as { version: number }).version;
    const afterAllocate = await allocate(roleCtx, { orderId, expectedVersion: approvedVersion, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('partially_allocated');

    const line = await getOrderLine(lineIds[0] as string);
    expect(line.status).toBe('partial');
    expect(line.location_id).toBe(largerLocationId);
    expect(line.batch_no).toBe(batchNo);
    expect(line.qty_actual).toBe(LARGER_QTY);
    expect(line.variance_reason).toBe(INSUFFICIENT_STOCK_VARIANCE_REASON);
    expect(await getStockBalanceQtyAllocated(clientId, skuId, largerLocationId, batchNo)).toBe(LARGER_QTY);
    expect(await getStockBalanceQtyAllocated(clientId, skuId, smallerLocationId, batchNo)).toBe('0.000');

    // --- cancelling this partially-allocated order releases exactly the one lot that was touched,
    //     leaving the untouched lot exactly as it was.
    const result = await cancelOutbound(
      roleCtx,
      { orderId, expectedVersion: afterAllocate.version, reason: 'test single-lot partial release', correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('cancelled');
    expect(await getStockBalanceQtyAllocated(clientId, skuId, largerLocationId, batchNo)).toBe('0.000');
    expect(await getStockBalanceQtyAllocated(clientId, skuId, smallerLocationId, batchNo)).toBe('0.000');
  });
});

// --- Scenario: two concurrent Allocate calls drawing from the SAME single lot never double-book it
// (WBS 2.11 part 2, `for update` lock on getCandidateLots — Promise.allSettled pattern from
// receive-inbound.test.ts's own concurrent-ApproveInbound scenario) ---------------------------------

describe('Scenario: Two concurrent Allocates on the same lot never over-reserve it', () => {
  it('exactly one order fully allocates the lot; the other ends up "partially_allocated" with its line still "open" — the lot is never oversold, qty_allocated never exceeds its own availability', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    const batchNo = '';
    const LOT_QTY = '5.000'; // only ONE order's worth of stock exists.
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: LOT_QTY });

    async function buildForceApprovedOrder(): Promise<{ orderId: string; lineId: string; version: number }> {
      const { orderId, lineIds } = await createDraftOutboundOrderFixture({
        clientId,
        contractId,
        shipToName: 'x',
        shipToPhone: 'x',
        shipToAddress: 'x',
        shipToArea: 'x',
        lines: [{ skuId, qtyOrdered: LOT_QTY }],
      });
      const approvedResult: QueryResult<{ version: number }> = await pool.query(
        `update wms.outbound_orders set status = 'approved', credit_check_passed = true, credit_checked_at = now()
          where id = $1 returning version`,
        [orderId],
      );
      const version = (approvedResult.rows[0] as { version: number }).version;
      return { orderId, lineId: lineIds[0] as string, version };
    }

    const orderA = await buildForceApprovedOrder();
    const orderB = await buildForceApprovedOrder();

    const [resultA, resultB] = await Promise.allSettled([
      allocate(roleCtx, { orderId: orderA.orderId, expectedVersion: orderA.version, correlationId: nextCorrelationId() }, deps),
      allocate(roleCtx, { orderId: orderB.orderId, expectedVersion: orderB.version, correlationId: nextCorrelationId() }, deps),
    ]);

    // The `for update` lock on wms.stock_balance serialises the two calls — neither can ever
    // observe the other's still-in-flight consumption, so both calls always FULFIL (they are
    // different orders, no version conflict), but the second one to acquire the lock sees
    // qty_available already at 0 and allocates nothing.
    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('fulfilled');
    const statusA = (resultA as PromiseFulfilledResult<Awaited<ReturnType<typeof allocate>>>).value.status;
    const statusB = (resultB as PromiseFulfilledResult<Awaited<ReturnType<typeof allocate>>>).value.status;
    expect([statusA, statusB].sort()).toEqual(['allocated', 'partially_allocated']);

    const emptyLine = statusA === 'partially_allocated' ? orderA.lineId : orderB.lineId;
    expect((await getOrderLine(emptyLine)).status).toBe('open');

    // Exactly the lot's own availability was consumed in total — never negative, never double-sold.
    const allocatedTotal = await getStockBalanceQtyAllocated(clientId, skuId, locationId, batchNo);
    expect(allocatedTotal).toBe(LOT_QTY);
  });
});

// --- Round 3 finding 4: the single-lot allocation rule, one test per Gherkin scenario ---------------
// _slice-2.11.brief.md, Allocation rule (Master ruling, verbatim): "a line is allocated from a single
// lot. FEFO/FIFO picks the first lot whose qty_available covers the line; if none covers it, the best
// single lot supplies min(available, ordered) → `partially_allocated` with the `insufficient_stock`
// variance constant; if no lot has stock the line stays unallocated; a line is never split across two
// lots." Every fixture below owns its client/SKU/zone/M9 locations (insertLocation), tracked in the
// fixture arrays afterAll unwinds.

// Fixture expiry dates, both after CLOCK_DATE — the same pair the FEFO scenario above uses.
const SINGLE_LOT_NEAR_EXPIRY_DATE = '2026-10-01';
const SINGLE_LOT_FAR_EXPIRY_DATE = '2027-01-01';

interface TwoLotFefoFixture {
  readonly clientId: string;
  readonly contractId: string;
  readonly skuId: string;
  readonly nearLocationId: string;
  readonly nearBatch: string;
  readonly farLocationId: string;
  readonly farBatch: string;
}

/** A FEFO SKU with two lots at two of this run's own M9 locations: `near` expires first. */
async function buildTwoLotFefoStock(nearQty: string, farQty: string): Promise<TwoLotFefoFixture> {
  const clientId = await insertClient();
  const priceListId = await insertPriceList();
  const contractId = await insertContract(clientId, { priceListId });
  const skuId = await insertSku(clientId, { trackExpiry: true, pickingPolicy: 'FEFO' });
  const zoneId = await insertZone();
  const nearLocationId = await insertLocation(zoneId);
  const farLocationId = await insertLocation(zoneId);
  const nearBatch = `LOT-NEAR-${randomUUID().slice(0, 8)}`;
  const farBatch = `LOT-FAR-${randomUUID().slice(0, 8)}`;
  await seedStockViaReceipt({ clientId, skuId, locationId: nearLocationId, qtyOnHand: nearQty, batchNo: nearBatch, expiryDate: SINGLE_LOT_NEAR_EXPIRY_DATE });
  await seedStockViaReceipt({ clientId, skuId, locationId: farLocationId, qtyOnHand: farQty, batchNo: farBatch, expiryDate: SINGLE_LOT_FAR_EXPIRY_DATE });
  return { clientId, contractId, skuId, nearLocationId, nearBatch, farLocationId, farBatch };
}

/** One force-approved order with ONE line of `skuId` for `qtyOrdered`. */
async function buildForceApprovedSingleLineOrder(
  clientId: string,
  contractId: string,
  skuId: string,
  qtyOrdered: string,
): Promise<{ orderId: string; lineId: string; version: number }> {
  const { orderId, lineIds } = await createDraftOutboundOrderFixture({
    clientId,
    contractId,
    shipToName: 'x',
    shipToPhone: 'x',
    shipToAddress: 'x',
    shipToArea: 'x',
    lines: [{ skuId, qtyOrdered }],
  });
  const version = await forceApprove(orderId);
  return { orderId, lineId: lineIds[0] as string, version };
}

describe('Scenario: A line fully covered by the FEFO-first lot is reserved from that lot alone', () => {
  it('only the earlier-expiring lot\'s qty_allocated grows, by exactly the ordered quantity; the line is "complete" with that lot\'s location/batch and no variance reason; status "allocated"; the later-expiring lot is untouched', async () => {
    const LOT_QTY = '8.000';
    const ORDERED_QTY = '5.250'; // < each lot alone.
    const stock = await buildTwoLotFefoStock(LOT_QTY, LOT_QTY);
    const order = await buildForceApprovedSingleLineOrder(stock.clientId, stock.contractId, stock.skuId, ORDERED_QTY);

    const result = await allocate(roleCtx, { orderId: order.orderId, expectedVersion: order.version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('allocated');

    const line = await getOrderLine(order.lineId);
    expect(line.status).toBe('complete');
    expect(line.location_id).toBe(stock.nearLocationId);
    expect(line.batch_no).toBe(stock.nearBatch);
    expect(line.qty_actual).toBe(ORDERED_QTY);
    expect(line.variance_reason).toBeNull();
    expect(await getStockBalanceQtyAllocated(stock.clientId, stock.skuId, stock.nearLocationId, stock.nearBatch)).toBe(ORDERED_QTY);
    expect(await getStockBalanceQtyAllocated(stock.clientId, stock.skuId, stock.farLocationId, stock.farBatch)).toBe('0.000');
  });
});

describe('Scenario: When the FEFO-first lot cannot cover the line, the first lot that covers it whole is reserved', () => {
  it('the later-expiring lot alone is reserved for the whole line, the line is "complete", and the earlier-expiring lot is untouched (never split across two lots)', async () => {
    const NEAR_QTY = '2.000'; // too small for the line on its own.
    const FAR_QTY = '6.000'; // covers the line on its own.
    const ORDERED_QTY = '5.000';
    const stock = await buildTwoLotFefoStock(NEAR_QTY, FAR_QTY);
    const order = await buildForceApprovedSingleLineOrder(stock.clientId, stock.contractId, stock.skuId, ORDERED_QTY);

    const result = await allocate(roleCtx, { orderId: order.orderId, expectedVersion: order.version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('allocated');

    const line = await getOrderLine(order.lineId);
    expect(line.status).toBe('complete');
    expect(line.location_id).toBe(stock.farLocationId);
    expect(line.batch_no).toBe(stock.farBatch);
    expect(line.qty_actual).toBe(ORDERED_QTY);
    expect(await getStockBalanceQtyAllocated(stock.clientId, stock.skuId, stock.farLocationId, stock.farBatch)).toBe(ORDERED_QTY);
    expect(await getStockBalanceQtyAllocated(stock.clientId, stock.skuId, stock.nearLocationId, stock.nearBatch)).toBe('0.000');
  });
});

describe('Scenario: A line with no stock stays unallocated', () => {
  it('status is "partially_allocated", the line stays "open" with no location and no batch, and no stock_balance row is created or changed', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId); // never stocked.
    const order = await buildForceApprovedSingleLineOrder(clientId, contractId, skuId, '4.000');

    const result = await allocate(roleCtx, { orderId: order.orderId, expectedVersion: order.version, correlationId: nextCorrelationId() }, deps);
    expect(result.status).toBe('partially_allocated');
    expect((await getOrder(order.orderId)).status).toBe('partially_allocated');

    const line = await getOrderLine(order.lineId);
    expect(line.status).toBe('open');
    expect(line.location_id).toBeNull();
    expect(line.batch_no).toBeNull();
    expect(await stockBalanceRowCountForSku(clientId, skuId)).toBe(0);
  });
});

describe("Scenario: Allocate's audit row records the reserved lot per line", () => {
  it('exactly one audit row; its lines carry the reserved lot\'s locationId/batchNo for the covered line and null/null for the unallocated line', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const stockedSkuId = await insertSku(clientId);
    const emptySkuId = await insertSku(clientId); // never stocked.
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    const batchNo = `LOT-AUD-${randomUUID().slice(0, 8)}`;
    const STOCKED_QTY = '3.000';
    await seedStockViaReceipt({ clientId, skuId: stockedSkuId, locationId, qtyOnHand: STOCKED_QTY, batchNo });

    const { orderId, lineIds } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [
        { skuId: stockedSkuId, qtyOrdered: STOCKED_QTY },
        { skuId: emptySkuId, qtyOrdered: '2.000' },
      ],
    });
    const [coveredLineId, emptyLineId] = lineIds as [string, string];
    const version = await forceApprove(orderId);

    const correlationId = nextCorrelationId();
    const result = await allocate(roleCtx, { orderId, expectedVersion: version, correlationId }, deps);
    expect(result.status).toBe('partially_allocated');

    const newValue = await auditNewValueForCorrelation(correlationId);
    const lines = newValue['lines'];
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lineId: coveredLineId, locationId, batchNo }),
        expect.objectContaining({ lineId: emptyLineId, locationId: null, batchNo: null }),
      ]),
    );
  });
});

describe('Scenario: Cancel after allocation releases exactly the one reserved lot', () => {
  it('the shared lot\'s qty_allocated drops by exactly the cancelled order\'s reserved quantity, the other order\'s reservation on it stays, and the second lot is untouched', async () => {
    const LOT_QTY = '10.000';
    const ORDER_A_QTY = '4.000';
    const ORDER_B_QTY = '3.000'; // A + B still fit inside the FEFO-first lot alone.
    const stock = await buildTwoLotFefoStock(LOT_QTY, LOT_QTY);
    const orderA = await buildForceApprovedSingleLineOrder(stock.clientId, stock.contractId, stock.skuId, ORDER_A_QTY);
    const orderB = await buildForceApprovedSingleLineOrder(stock.clientId, stock.contractId, stock.skuId, ORDER_B_QTY);

    const allocatedA = await allocate(roleCtx, { orderId: orderA.orderId, expectedVersion: orderA.version, correlationId: nextCorrelationId() }, deps);
    const allocatedB = await allocate(roleCtx, { orderId: orderB.orderId, expectedVersion: orderB.version, correlationId: nextCorrelationId() }, deps);
    expect(allocatedA.status).toBe('allocated');
    expect(allocatedB.status).toBe('allocated');
    expect(await getStockBalanceQtyAllocated(stock.clientId, stock.skuId, stock.nearLocationId, stock.nearBatch)).toBe(
      Quantity.of(ORDER_A_QTY).add(Quantity.of(ORDER_B_QTY)).toString(),
    );
    expect(await getStockBalanceQtyAllocated(stock.clientId, stock.skuId, stock.farLocationId, stock.farBatch)).toBe('0.000');

    const cancelled = await cancelOutbound(
      roleCtx,
      { orderId: orderA.orderId, expectedVersion: allocatedA.version, reason: 'test exact single-lot release', correlationId: nextCorrelationId() },
      deps,
    );
    expect(cancelled.status).toBe('cancelled');
    expect(await getStockBalanceQtyAllocated(stock.clientId, stock.skuId, stock.nearLocationId, stock.nearBatch)).toBe(ORDER_B_QTY);
    expect(await getStockBalanceQtyAllocated(stock.clientId, stock.skuId, stock.farLocationId, stock.farBatch)).toBe('0.000');

    const lineB = await getOrderLine(orderB.lineId);
    expect(lineB.status).toBe('complete');
    expect(lineB.location_id).toBe(stock.nearLocationId);
    expect((await getOrder(orderB.orderId)).status).toBe('allocated');
  });
});

describe("Scenario: CancelOutbound's audit row records exactly the released lot per line", () => {
  it('from "allocated": released is exactly [{ lineId, locationId, batchNo, qty }] of the one lot the line reserved', async () => {
    const built = await buildApprovedOrder();
    const afterAllocate = await allocate(roleCtx, { orderId: built.orderId, expectedVersion: built.version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('allocated');
    const line = await getOrderLine(built.lineIds[0] as string);

    const correlationId = nextCorrelationId();
    await cancelOutbound(roleCtx, { orderId: built.orderId, expectedVersion: afterAllocate.version, reason: 'test audit release', correlationId }, deps);

    const newValue = await auditNewValueForCorrelation(correlationId);
    expect(newValue['released']).toEqual([
      { lineId: built.lineIds[0], locationId: built.locationId, batchNo: line.batch_no, qty: QTY_ORDERED },
    ]);
  });

  it('from "approved" (nothing allocated yet): released is empty', async () => {
    const built = await buildApprovedOrder();
    const correlationId = nextCorrelationId();
    await cancelOutbound(roleCtx, { orderId: built.orderId, expectedVersion: built.version, reason: 'test audit no release', correlationId }, deps);

    const newValue = await auditNewValueForCorrelation(correlationId);
    expect(newValue['released']).toEqual([]);
  });

  it('from "partially_allocated" whose only line was never allocated (no stock): released is empty', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId); // never stocked.
    const order = await buildForceApprovedSingleLineOrder(clientId, contractId, skuId, '4.000');
    const afterAllocate = await allocate(roleCtx, { orderId: order.orderId, expectedVersion: order.version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('partially_allocated');

    const correlationId = nextCorrelationId();
    await cancelOutbound(roleCtx, { orderId: order.orderId, expectedVersion: afterAllocate.version, reason: 'test audit nothing reserved', correlationId }, deps);

    const newValue = await auditNewValueForCorrelation(correlationId);
    expect(newValue['released']).toEqual([]);
  });
});

// --- Scenario: RLS on Allocate ---------------------------------------------------------------------

describe('Scenario: RLS — a caller scoped to another entity cannot see or allocate the order', () => {
  it('READ isolation: an approved order is invisible to a pgeos_app query scoped to the outsider', async () => {
    const { orderId } = await buildApprovedOrder();

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

  it('WRITE isolation: Allocate as the outsider fails with OrderNotFoundError, status unchanged', async () => {
    const { orderId, version } = await buildApprovedOrder();
    await expect(
      allocate(outsiderCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect((await getOrder(orderId)).status).toBe('approved');
  });
});

// =====================================================================================================
// Part 3 — PickLine + CheckOrder (WBS 2.12 part 1, _slice-2.12.brief.md). Meets doc 38 row 2.12's own
// acceptance criterion, verbatim: "Self-check rejected". New machine edges: {allocated,
// partially_allocated} --START_PICKING--> picking, picking --COMPLETE_PICKING--> picked,
// picked --CHECK--> checked. PackOrder/LoadOrder are part 2, not exercised here.
//
// RED until pg-backend adds `pickLine`/`checkOrder` to application/process-outbound/index.js and
// `SelfCheckNotAllowedError`/`VarianceReasonRequiredError` to domain/process-outbound/errors.ts.
// =====================================================================================================

/** Full-value column read for wms.outbound_orders this part needs beyond `getOrder`'s own four
 *  columns (status, version, credit_check_passed, credit_checked_at) — `picked_by`/`checked_by`
 *  (01-Data-Model.sql:768). */
async function getOrderPickCheck(orderId: string): Promise<{
  status: string;
  version: number;
  picked_by: string | null;
  checked_by: string | null;
}> {
  const result: QueryResult<{ status: string; version: number; picked_by: string | null; checked_by: string | null }> = await pool.query(
    `select status, version, picked_by, checked_by from wms.outbound_orders where id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.outbound_orders row for id ${orderId}`);
  return row;
}

/** Both quantity columns of one wms.stock_balance row — PickLine's own real-consumption invariant
 *  (Master decision 2) needs both qty_on_hand AND qty_allocated, unlike Allocate/Cancel's own
 *  qty_allocated-only helper (getStockBalanceQtyAllocated). */
async function getStockBalanceBoth(clientId: string, skuId: string, locationId: string, batchNo: string): Promise<{
  qty_on_hand: string;
  qty_allocated: string;
}> {
  const result: QueryResult<{ qty_on_hand: string; qty_allocated: string }> = await pool.query(
    `select qty_on_hand::text as qty_on_hand, qty_allocated::text as qty_allocated from wms.stock_balance
      where client_id = $1 and sku_id = $2 and location_id = $3 and batch_no = $4`,
    [clientId, skuId, locationId, batchNo],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.stock_balance row for client ${clientId} sku ${skuId} location ${locationId} batch ${batchNo}`);
  return row;
}

/** Every wms.stock_movements row of type 'pick' for a client — asserted exactly, never `.some`. */
async function pickMovementsForClient(clientId: string): Promise<
  Array<{ qty: string; from_location_id: string | null; sku_id: string }>
> {
  const result: QueryResult<{ qty: string; from_location_id: string | null; sku_id: string }> = await pool.query(
    `select qty::text as qty, from_location_id, sku_id::text as sku_id from wms.stock_movements
      where client_id = $1 and movement_type = 'pick'`,
    [clientId],
  );
  return result.rows;
}

/** Walks an order through the full pipeline (create → checks → approve → allocate) via the real
 *  commands, to 'allocated' — PickLine's own precondition. Mirrors buildApprovedOrder's own
 *  "real commands, not a shortcut" discipline. Batch is always '' (buildValidScenario/
 *  seedStockViaReceipt's own default — no batchNo override there). */
async function buildAllocatedOrder(
  overrides: Parameters<typeof buildValidScenario>[0] = {},
): Promise<{
  orderId: string;
  lineId: string;
  version: number;
  clientId: string;
  skuId: string;
  locationId: string;
}> {
  const built = await buildApprovedOrder(overrides);
  const afterAllocate = await allocate(roleCtx, { orderId: built.orderId, expectedVersion: built.version, correlationId: nextCorrelationId() }, deps);
  expect(afterAllocate.status).toBe('allocated');
  return {
    orderId: built.orderId,
    lineId: built.lineIds[0] as string,
    version: afterAllocate.version,
    clientId: built.clientId,
    skuId: built.skuId,
    locationId: built.locationId,
  };
}

/** A two-line allocated order (both lines fully covered by their own stock), for the
 *  picking-then-picked transition scenario, which needs an intermediate "picking" state that a
 *  single-line order can never observe (the FIRST PickLine call would also be the LAST). */
async function buildAllocatedTwoLineOrder(): Promise<{
  orderId: string;
  lineIdA: string;
  lineIdB: string;
  version: number;
  clientId: string;
  skuIdA: string;
  skuIdB: string;
  locationIdA: string;
  locationIdB: string;
}> {
  const clientId = await insertClient();
  const priceListId = await insertPriceList();
  const contractId = await insertContract(clientId, { priceListId });
  const skuIdA = await insertSku(clientId);
  const skuIdB = await insertSku(clientId);
  const zoneId = await insertZone();
  const locationIdA = await insertLocation(zoneId);
  const locationIdB = await insertLocation(zoneId);
  const QTY = '4.000';
  await seedStockViaReceipt({ clientId, skuId: skuIdA, locationId: locationIdA, qtyOnHand: QTY });
  await seedStockViaReceipt({ clientId, skuId: skuIdB, locationId: locationIdB, qtyOnHand: QTY });
  const { orderId, lineIds } = await createDraftOutboundOrderFixture({
    clientId,
    contractId,
    shipToName: 'x',
    shipToPhone: 'x',
    shipToAddress: 'x',
    shipToArea: 'x',
    lines: [
      { skuId: skuIdA, qtyOrdered: QTY },
      { skuId: skuIdB, qtyOrdered: QTY },
    ],
  });
  const version = await forceApprove(orderId);
  const afterAllocate = await allocate(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
  expect(afterAllocate.status).toBe('allocated');
  return {
    orderId,
    lineIdA: lineIds[0] as string,
    lineIdB: lineIds[1] as string,
    version: afterAllocate.version,
    clientId,
    skuIdA,
    skuIdB,
    locationIdA,
    locationIdB,
  };
}

// --- Scenario: PickLine records the picked quantity and posts a pick ledger movement ---------------

describe('Scenario: PickLine records the picked quantity and posts a pick ledger movement', () => {
  it('a full-quantity pick posts a wms.stock_movements "pick" row, drops qty_on_hand AND qty_allocated by that amount, line becomes "complete"', async () => {
    const order = await buildAllocatedOrder();
    const before = await getStockBalanceBoth(order.clientId, order.skuId, order.locationId, '');
    expect(before.qty_on_hand).toBe(QTY_ORDERED);
    expect(before.qty_allocated).toBe(QTY_ORDERED);

    const correlationId = nextCorrelationId();
    const result = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId },
      deps,
    );
    expect(result.status).toBe('picked'); // sole line, complete -> order also complete.

    const movements = await pickMovementsForClient(order.clientId);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ qty: QTY_ORDERED, from_location_id: order.locationId, sku_id: order.skuId });

    const after = await getStockBalanceBoth(order.clientId, order.skuId, order.locationId, '');
    expect(after.qty_on_hand).toBe('0.000');
    expect(after.qty_allocated).toBe('0.000');

    const line = await getOrderLine(order.lineId);
    expect(line.status).toBe('complete');
    expect(line.qty_actual).toBe(QTY_ORDERED);
  });

  it('a fractional 3-decimal full pick (5.250) drops both quantities exactly, no float drift', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    const QTY = '5.250';
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: QTY });
    const { orderId, lineIds } = await createDraftOutboundOrderFixture({
      clientId,
      contractId,
      shipToName: 'x',
      shipToPhone: 'x',
      shipToAddress: 'x',
      shipToArea: 'x',
      lines: [{ skuId, qtyOrdered: QTY }],
    });
    const version = await forceApprove(orderId);
    const afterAllocate = await allocate(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('allocated');
    const lineId = lineIds[0] as string;

    const result = await pickLine(
      roleCtx,
      { orderId, lineId, expectedVersion: afterAllocate.version, qtyActual: QTY, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('picked');

    const after = await getStockBalanceBoth(clientId, skuId, locationId, '');
    expect(after.qty_on_hand).toBe('0.000');
    expect(after.qty_allocated).toBe('0.000');
    const movements = await pickMovementsForClient(clientId);
    expect(movements).toEqual([expect.objectContaining({ qty: QTY, from_location_id: locationId, sku_id: skuId })]);
  });
});

// --- Scenario: The order transitions to picking on the first PickLine call, then picked when complete

describe('Scenario: The order transitions to picking on the first PickLine call, then picked when complete', () => {
  it('status is "picking" after the first line, "picked" (picked_by set) after the last line completes', async () => {
    const order = await buildAllocatedTwoLineOrder();

    const afterFirst = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineIdA, expectedVersion: order.version, qtyActual: '4.000', correlationId: nextCorrelationId() },
      deps,
    );
    expect(afterFirst.status).toBe('picking');
    expect((await getOrderPickCheck(order.orderId)).status).toBe('picking');

    const afterSecond = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineIdB, expectedVersion: afterFirst.version, qtyActual: '4.000', correlationId: nextCorrelationId() },
      deps,
    );
    expect(afterSecond.status).toBe('picked');
    const finalOrder = await getOrderPickCheck(order.orderId);
    expect(finalOrder.status).toBe('picked');
    expect(finalOrder.picked_by).toBe(ROLE_ACTOR_UUID);
  });
});

// --- Scenario: A shortage on PickLine requires a variance_reason -------------------------------------

describe('Scenario: A shortage on PickLine requires a variance_reason', () => {
  it('rejects with VarianceReasonRequiredError before any write when qty_actual < qty_ordered and no variance_reason is given', async () => {
    const order = await buildAllocatedOrder();
    const correlationId = nextCorrelationId();
    const shortQty = '4.000'; // < QTY_ORDERED (10.000).

    await expect(
      pickLine(roleCtx, { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: shortQty, correlationId }, deps),
    ).rejects.toBeInstanceOf(VarianceReasonRequiredError);

    // Nothing written BY PickLine: the line is exactly as Allocate itself already left it (Allocate
    // stamps status='complete'/qty_actual=the reserved amount on every fully-reserved line as its
    // OWN reservation outcome — application/process-outbound/allocate.ts LINE_STATUS_COMPLETE — this
    // order reached "allocated" so its sole line was fully reserved before PickLine ever ran). Stock
    // balance, movements, order version and outbox/audit prove the rejected call itself wrote nothing.
    const line = await getOrderLine(order.lineId);
    expect(line.status).toBe('complete');
    expect(line.qty_actual).toBe(QTY_ORDERED);
    const balance = await getStockBalanceBoth(order.clientId, order.skuId, order.locationId, '');
    expect(balance.qty_on_hand).toBe(QTY_ORDERED);
    expect(balance.qty_allocated).toBe(QTY_ORDERED);
    expect(await pickMovementsForClient(order.clientId)).toHaveLength(0);
    expect((await getOrderPickCheck(order.orderId)).status).toBe('allocated');
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });

  it('a fractional 3-decimal shortage (9.999 picked of 10.000 ordered) with no reason is also rejected', async () => {
    const order = await buildAllocatedOrder();
    await expect(
      pickLine(
        roleCtx,
        { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: '9.999', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(VarianceReasonRequiredError);
  });

  it('the SAME shortage WITH a variance_reason succeeds — line "partial", reason recorded', async () => {
    const order = await buildAllocatedOrder();
    const shortQty = '4.000';
    const reason = 'damaged in transit';
    const result = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: shortQty, varianceReason: reason, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('picked'); // sole line, now settled (partial), order still completes.
    const line = await getOrderLine(order.lineId);
    expect(line.status).toBe('partial');
    expect(line.qty_actual).toBe(shortQty);
    expect(line.variance_reason).toBe(reason);
  });
});

// --- Scenario: PickLine is illegal before allocation --------------------------------------------------

describe('Scenario: PickLine is illegal before allocation', () => {
  it('rejects with IllegalTransitionError when the order is only "approved"', async () => {
    const built = await buildApprovedOrder();
    await expect(
      pickLine(
        roleCtx,
        { orderId: built.orderId, lineId: built.lineIds[0] as string, expectedVersion: built.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await getOrder(built.orderId)).status).toBe('approved');
  });
});

// --- Scenario: PickLine fix round 1 bug-fix scenarios (findings 2/3/4/5/6/7) --------------------------

describe('Scenario: PickLine rejects a repeat pick on an already-picked line (finding 2)', () => {
  it('picking the SAME line twice (fresh expectedVersion, fresh correlationId each time) rejects the second call with LineAlreadyPickedError, before any write', async () => {
    const order = await buildAllocatedTwoLineOrder();
    const afterFirst = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineIdA, expectedVersion: order.version, qtyActual: '4.000', correlationId: nextCorrelationId() },
      deps,
    );
    expect(afterFirst.status).toBe('picking'); // line B still open — the order stays "picking".

    const beforeLine = await getOrderLine(order.lineIdA);
    const correlationId = nextCorrelationId();
    await expect(
      pickLine(
        roleCtx,
        { orderId: order.orderId, lineId: order.lineIdA, expectedVersion: afterFirst.version, qtyActual: '4.000', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(LineAlreadyPickedError);

    // Nothing written by the rejected second attempt: the line, the order version/status and the
    // pick-movement count are exactly where the first (legitimate) call left them.
    expect(await getOrderLine(order.lineIdA)).toEqual(beforeLine);
    expect((await getOrder(order.orderId)).status).toBe('picking');
    expect((await getOrder(order.orderId)).version).toBe(afterFirst.version);
    expect(await pickMovementsForClient(order.clientId)).toHaveLength(1); // line A's own pick, once.
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });
});

describe('Scenario: PickLine rejects an over-pick beyond the line\'s reserved quantity (finding 3)', () => {
  it('qtyActual greater than the reserved quantity rejects with PickQuantityExceedsReservedError, before any write', async () => {
    const order = await buildAllocatedOrder(); // reserved = QTY_ORDERED (10.000).
    const overQty = '11.000';
    const correlationId = nextCorrelationId();

    await expect(
      pickLine(roleCtx, { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: overQty, correlationId }, deps),
    ).rejects.toBeInstanceOf(PickQuantityExceedsReservedError);

    const line = await getOrderLine(order.lineId);
    expect(line.status).toBe('complete'); // Allocate's own stamp, untouched.
    expect(line.qty_actual).toBe(QTY_ORDERED);
    expect((await getOrderPickCheck(order.orderId)).status).toBe('allocated');
    expect(await pickMovementsForClient(order.clientId)).toHaveLength(0);
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });

  it('a fractional 3-decimal over-pick (reserved 5.250, picked 5.251) is also rejected', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId);
    const zoneId = await insertZone();
    const locationId = await insertLocation(zoneId);
    const QTY = '5.250';
    await seedStockViaReceipt({ clientId, skuId, locationId, qtyOnHand: QTY });
    const order = await buildForceApprovedSingleLineOrder(clientId, contractId, skuId, QTY);
    const afterAllocate = await allocate(roleCtx, { orderId: order.orderId, expectedVersion: order.version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('allocated');

    await expect(
      pickLine(
        roleCtx,
        { orderId: order.orderId, lineId: order.lineId, expectedVersion: afterAllocate.version, qtyActual: '5.251', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(PickQuantityExceedsReservedError);
    expect(await pickMovementsForClient(clientId)).toHaveLength(0);
  });
});

describe("Scenario: A partial pick with a reason releases the line's FULL reserved qty_allocated, not just the picked amount (finding 4)", () => {
  it('qty_on_hand drops only by the picked amount; qty_allocated drops to zero (the whole reservation released)', async () => {
    const order = await buildAllocatedOrder(); // reserved = QTY_ORDERED (10.000).
    const pickedQty = '4.000';
    const reason = 'damaged in transit';

    const result = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: pickedQty, varianceReason: reason, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('picked'); // sole line settled (partial) -> order still completes.

    const balance = await getStockBalanceBoth(order.clientId, order.skuId, order.locationId, '');
    expect(balance.qty_on_hand).toBe('6.000'); // 10.000 - 4.000 picked.
    expect(balance.qty_allocated).toBe('0.000'); // the FULL 10.000 reservation released, not 6.000.
  });
});

describe('Scenario: A zero-qty pick with a variance_reason releases the reservation and posts no ledger row (finding 5)', () => {
  it('no wms.stock_movements "pick" row is posted; qty_allocated drops to zero; qty_on_hand is untouched; the order can still proceed', async () => {
    const order = await buildAllocatedOrder(); // reserved = QTY_ORDERED (10.000).
    const reason = 'total loss';

    const result = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: '0.000', varianceReason: reason, correlationId: nextCorrelationId() },
      deps,
    );
    expect(result.status).toBe('picked'); // qty_actual=0 line does not count as "open" -> order completes.

    expect(await pickMovementsForClient(order.clientId)).toHaveLength(0);
    const balance = await getStockBalanceBoth(order.clientId, order.skuId, order.locationId, '');
    expect(balance.qty_on_hand).toBe(QTY_ORDERED); // untouched — no ledger write at all.
    expect(balance.qty_allocated).toBe('0.000'); // the full reservation released.

    const line = await getOrderLine(order.lineId);
    expect(line.status).toBe('partial');
    expect(line.qty_actual).toBe('0.000');
    expect(line.variance_reason).toBe(reason);
  });
});

describe('Scenario: PickLine rejects a positive quantity against a line with no reservation (finding 6)', () => {
  it('a line whose location_id is null (never allocated — the open remainder of a partially_allocated order) rejects qtyActual > 0 with LineNotReservedForPickError, before any write', async () => {
    const clientId = await insertClient();
    const priceListId = await insertPriceList();
    const contractId = await insertContract(clientId, { priceListId });
    const skuId = await insertSku(clientId); // never stocked -> Allocate leaves it "open".
    const order = await buildForceApprovedSingleLineOrder(clientId, contractId, skuId, '4.000');

    const afterAllocate = await allocate(roleCtx, { orderId: order.orderId, expectedVersion: order.version, correlationId: nextCorrelationId() }, deps);
    expect(afterAllocate.status).toBe('partially_allocated');
    const line = await getOrderLine(order.lineId);
    expect(line.location_id).toBeNull();

    const correlationId = nextCorrelationId();
    await expect(
      pickLine(
        roleCtx,
        { orderId: order.orderId, lineId: order.lineId, expectedVersion: afterAllocate.version, qtyActual: '1.000', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(LineNotReservedForPickError);

    expect((await getOrder(order.orderId)).status).toBe('partially_allocated');
    expect((await getOrder(order.orderId)).version).toBe(afterAllocate.version);
    expect(await pickMovementsForClient(clientId)).toHaveLength(0);
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });
});

describe('Scenario: PickLine rejects an unknown lineId with a typed 422, never a bare 500 (finding 7)', () => {
  it('a lineId not on the order rejects with OrderLineNotFoundError, before any write', async () => {
    const order = await buildAllocatedOrder();
    const unknownLineId = randomUUID();
    const correlationId = nextCorrelationId();

    await expect(
      pickLine(
        roleCtx,
        { orderId: order.orderId, lineId: unknownLineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(OrderLineNotFoundError);

    expect((await getOrder(order.orderId)).status).toBe('allocated');
    expect((await getOrder(order.orderId)).version).toBe(order.version);
    expect(await pickMovementsForClient(order.clientId)).toHaveLength(0);
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });
});

// --- Scenario: CheckOrder rejects a self-check ---------------------------------------------------------

describe('Scenario: CheckOrder rejects a self-check', () => {
  it('the same actor who picked the order calling CheckOrder is rejected with SelfCheckNotAllowedError, status stays "picked"', async () => {
    const order = await buildAllocatedOrder();
    const picked = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() },
      deps,
    );
    expect(picked.status).toBe('picked');
    expect((await getOrderPickCheck(order.orderId)).picked_by).toBe(ROLE_ACTOR_UUID);

    const correlationId = nextCorrelationId();
    await expect(
      checkOrder(roleCtx, { orderId: order.orderId, expectedVersion: picked.version, correlationId }, deps),
    ).rejects.toBeInstanceOf(SelfCheckNotAllowedError);

    const after = await getOrderPickCheck(order.orderId);
    expect(after.status).toBe('picked');
    expect(after.checked_by).toBeNull();
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });
});

// --- Scenario: CheckOrder succeeds when the checker differs from the picker ----------------------------

describe('Scenario: CheckOrder succeeds when the checker differs from the picker', () => {
  it('status becomes "checked", checked_by is set to the second actor', async () => {
    const order = await buildAllocatedOrder();
    const picked = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() },
      deps,
    );
    expect(picked.status).toBe('picked');

    const correlationId = nextCorrelationId();
    const result = await checkOrder(noRoleCtx, { orderId: order.orderId, expectedVersion: picked.version, correlationId }, deps);
    expect(result.status).toBe('checked');

    const after = await getOrderPickCheck(order.orderId);
    expect(after.status).toBe('checked');
    expect(after.checked_by).toBe(NO_ROLE_ACTOR_UUID);
    expect(await outboxRowsForCorrelationAndType(correlationId, 'wms.outbound.checked')).toHaveLength(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });
});

// --- Scenario: CheckOrder is illegal before picking completes ------------------------------------------

describe('Scenario: CheckOrder is illegal before picking completes', () => {
  it('rejects with IllegalTransitionError when the order is still "allocated" (no PickLine called yet)', async () => {
    const order = await buildAllocatedOrder();
    await expect(
      checkOrder(roleCtx, { orderId: order.orderId, expectedVersion: order.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await getOrder(order.orderId)).status).toBe('allocated');
  });

  it('rejects with IllegalTransitionError when the order is "picking" (one of two lines still open)', async () => {
    const order = await buildAllocatedTwoLineOrder();
    const afterFirst = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineIdA, expectedVersion: order.version, qtyActual: '4.000', correlationId: nextCorrelationId() },
      deps,
    );
    expect(afterFirst.status).toBe('picking');
    await expect(
      checkOrder(roleCtx, { orderId: order.orderId, expectedVersion: afterFirst.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    expect((await getOrder(order.orderId)).status).toBe('picking');
  });
});

// --- Scenario: Stale version is rejected on PickLine and CheckOrder ------------------------------------

describe('Scenario: Stale version is rejected on PickLine and CheckOrder', () => {
  it('rejects a stale expectedVersion on PickLine with StaleVersionError, nothing written', async () => {
    const order = await buildAllocatedOrder();
    const correlationId = nextCorrelationId();
    await expect(
      pickLine(
        roleCtx,
        { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version + 999, qtyActual: QTY_ORDERED, correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(StaleVersionError);
    expect(await pickMovementsForClient(order.clientId)).toHaveLength(0);
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });

  it('rejects a stale expectedVersion on CheckOrder with StaleVersionError, nothing written', async () => {
    const order = await buildAllocatedOrder();
    const picked = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() },
      deps,
    );
    const correlationId = nextCorrelationId();
    await expect(
      checkOrder(noRoleCtx, { orderId: order.orderId, expectedVersion: picked.version + 999, correlationId }, deps),
    ).rejects.toBeInstanceOf(StaleVersionError);
    const after = await getOrderPickCheck(order.orderId);
    expect(after.status).toBe('picked');
    expect(after.checked_by).toBeNull();
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(0);
    expect(await auditCountForCorrelation(correlationId)).toBe(0);
  });
});

// --- Scenario: Idempotent replay and conflicting replay on PickLine and CheckOrder ----------------------

describe('Scenario: Idempotent replay and conflicting replay on PickLine and CheckOrder', () => {
  it('replays the stored PickLine result for the same key + same body, no second write', async () => {
    const order = await buildAllocatedOrder();
    const idemKey = `pickline-replay-${randomUUID()}`;
    const correlationId = nextCorrelationId();
    const body = { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId };
    const first = await pickLine(roleCtx, { ...body, idem: idemFor('pickLine', idemKey, body) }, deps);
    // Fix round 1, finding 1 (ledger adapter): a nonzero-qty PickLine call ALSO posts its own
    // 'wms.stock.moved' outbox+audit pair via postMovementInTx (G9), in ADDITION to this command's
    // own order-level 'wms.outbound.picked' event — both under the SAME correlationId, so the
    // outbox count is 2 after the FIRST (real) write, never 1.
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(2);
    const second = await pickLine(roleCtx, { ...body, idem: idemFor('pickLine', idemKey, body) }, deps);
    expect(second).toEqual(first);
    expect(await pickMovementsForClient(order.clientId)).toHaveLength(1);
    // The replay is served entirely from the stored idempotency result — it writes NOTHING new,
    // ledger or otherwise: the count stays 2 after the replay, never 4.
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(2);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('rejects a conflicting PickLine replay (same key, different body) with IdempotencyConflictError', async () => {
    const order = await buildAllocatedOrder();
    const idemKey = `pickline-mismatch-${randomUUID()}`;
    const firstBody = { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() };
    await pickLine(roleCtx, { ...firstBody, idem: idemFor('pickLine', idemKey, firstBody) }, deps);
    const differentBody = { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() };
    await expect(
      pickLine(roleCtx, { ...differentBody, idem: idemFor('pickLine', idemKey, differentBody) }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('replays the stored CheckOrder result for the same key + same body, no second write', async () => {
    const order = await buildAllocatedOrder();
    const picked = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() },
      deps,
    );
    const idemKey = `checkorder-replay-${randomUUID()}`;
    const correlationId = nextCorrelationId();
    const body = { orderId: order.orderId, expectedVersion: picked.version, correlationId };
    const first = await checkOrder(noRoleCtx, { ...body, idem: idemFor('checkOrder', idemKey, body) }, deps);
    const second = await checkOrder(noRoleCtx, { ...body, idem: idemFor('checkOrder', idemKey, body) }, deps);
    expect(second).toEqual(first);
    expect(await anyOutboxCountForCorrelation(correlationId)).toBe(1);
    expect(await auditCountForCorrelation(correlationId)).toBe(1);
  });

  it('rejects a conflicting CheckOrder replay (same key, different body) with IdempotencyConflictError', async () => {
    const order = await buildAllocatedOrder();
    const picked = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() },
      deps,
    );
    const idemKey = `checkorder-mismatch-${randomUUID()}`;
    const firstBody = { orderId: order.orderId, expectedVersion: picked.version, correlationId: nextCorrelationId() };
    await checkOrder(noRoleCtx, { ...firstBody, idem: idemFor('checkOrder', idemKey, firstBody) }, deps);
    const differentBody = { orderId: order.orderId, expectedVersion: picked.version, correlationId: nextCorrelationId() };
    await expect(
      checkOrder(noRoleCtx, { ...differentBody, idem: idemFor('checkOrder', idemKey, differentBody) }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- Scenario: RLS — a caller scoped to another entity cannot pick or check the order -------------------

describe('Scenario: RLS — a caller scoped to another entity cannot pick or check the order', () => {
  it('PickLine as the outsider fails with OrderNotFoundError, status and stock unchanged', async () => {
    const order = await buildAllocatedOrder();
    await expect(
      pickLine(
        outsiderCtx,
        { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect((await getOrder(order.orderId)).status).toBe('allocated');
    expect(await pickMovementsForClient(order.clientId)).toHaveLength(0);
  });

  it('CheckOrder as the outsider fails with OrderNotFoundError, status unchanged', async () => {
    const order = await buildAllocatedOrder();
    const picked = await pickLine(
      roleCtx,
      { orderId: order.orderId, lineId: order.lineId, expectedVersion: order.version, qtyActual: QTY_ORDERED, correlationId: nextCorrelationId() },
      deps,
    );
    await expect(
      checkOrder(outsiderCtx, { orderId: order.orderId, expectedVersion: picked.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect((await getOrderPickCheck(order.orderId)).status).toBe('picked');
  });
});
