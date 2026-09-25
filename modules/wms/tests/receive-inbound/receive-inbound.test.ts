// modules/wms/tests/receive-inbound/receive-inbound.test.ts — WBS 2.9, THE GOLDEN SLICE.
//
// Integration tests, one per scenario in ./receive-inbound.feature, against the real database as
// pgeos_app. Sources: docs/package/40-Build-Specification-EN.md §C3, .claude/briefs/wms.brief.md.
//
// Binding behaviour this rewrite asserts (RED until pg-backend's parallel fix lands):
//   - every command input carries `expectedVersion`; a mismatch -> StaleVersionError (409); EVERY
//     command bumps wms.inbound_orders.version, not only ApproveInbound/CloseInbound;
//   - `performedBy` is REMOVED from every input — the actor is ctx.userId;
//   - `photoUrl` is REMOVED from ReceiveLineInput;
//   - the GRN (platform.documents) and the 'wms.inbound.received' event are written when the order
//     reaches 'received' (the call that receipts the LAST line), NOT on CloseInbound. GRN doc_no
//     comes from the 'DOC' series (13B-Schema-Reference-Consolidation.sql:3334, prefix 'PST-DC-'
//     for entity PST — not the INB series). GRN rendered_data carries the lines (sku code, ordered,
//     actual, uom, batch, expiry, variance_reason). CloseInbound only sets status, closed_at,
//     closed_by (= ctx.userId) — no document, no event.
//   - ReceiveLine with qtyActual != qtyOrdered emits a SECOND event, 'wms.inbound.variance'
//     (outbox + audit, SAME correlationId as the receipt) — no variance document.
//   - arrived_at and received_by are set on the FIRST receipt of the order (not every receipt).
//   - a line with qtyActual = '0.000' plus a varianceReason is allowed: no ledger row is posted for
//     it, and it counts as complete for CloseInbound WITHOUT ever going through ConfirmPutaway.
//   - a lineId that does not belong to the given orderId -> LineNotFoundError. Re-receiving an
//     already-receipted line -> LineAlreadyReceivedError. Re-putaway of an already-put-away line ->
//     LineAlreadyPutAwayError. In every case: nothing is written (no second ledger row, no line/
//     order mutation).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as stock-ledger.test.ts/location-limits.test.ts.
// PG_APP_USER=pgeos_app is REQUIRED to run this suite (every command call goes through
// withContext(ctx, fn) as pgeos_app, genuinely subject to RLS). platform.audit_log rows are NEVER
// deleted.
//
// ------------------------------------------------------------------------------------------------
// WBS 2.10 EXTENSION (pg-tester, RED-first) — docs/notes/slice-briefs/_slice-2.10.brief.md, doc 38
// row 2.10 "Suggestion respects conditions, ABC, capacity, client assignment". EVERY scenario above
// this marker is UNCHANGED (2.9's own acceptance, re-run in full as the regression guarantee, Master
// decision 6) — only new `describe` blocks are appended below for the 5 new Gherkin scenarios in
// ./receive-inbound.feature. The new surface these scenarios exercise (RED until pg-backend builds
// it, Master decisions 1/4/5):
//   - `wms.skus.abc_class` ('A'|'B'|'C'|null) now drives `suggestLocation`'s ranking: for an 'A'
//     SKU, a closer (lower position_no) location outranks a roomier one; for 'B'/'C'/null, 2.9's
//     own capacity-first order is UNCHANGED.
//   - `suggestLocationCandidatesQuery` gains a temperature-condition filter: a candidate location's
//     zone must be able to satisfy the SKU's declared temp_min/temp_max (when the SKU declares
//     one) — an incompatible zone's locations are EXCLUDED FROM THE CANDIDATE LIST ENTIRELY, not
//     merely ranked last. A SKU with no temperature requirement (`temp_min`/`temp_max` both null)
//     is unaffected — every zone remains a candidate, exactly 2.9's existing behaviour. NOTE (open
//     question, batched for the GM, default taken below): the brief's own Master decision 4 SQL text
//     ("a null zone bound means 'no constraint on that side'") would let a zone with NO temperature
//     bounds at all (an ordinary ambient zone) pass for ANY SKU including a frozen one — which
//     contradicts the brief's own Scenario ("a temperature-sensitive SKU excludes an incompatible
//     [ambient] zone entirely"). This file's tests bind to the SCENARIO (the acceptance criterion):
//     an ambient zone (temp_min AND temp_max both null) does NOT satisfy a SKU that itself declares
//     a temperature requirement; a zone with no bounds is only a valid candidate for a SKU that
//     ALSO has no temperature requirement. Default taken: the zone must have an explicit range
//     that covers the SKU's declared range, OR the SKU has no requirement at all.
//   - `LocationCandidate`/`SuggestLocationResult` (application layer) gain `abcClass` on every
//     candidate — informational, read once per call, same value on every row.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
// The shared idempotency helper, package barrel export.
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test.
import {
  approveInbound,
  cancelInbound,
  closeInbound,
  confirmPutaway,
  receiveLine,
  suggestLocation,
} from '../../application/receive-inbound/index.js';
import { createReceiveInboundDeps } from '../../api/receive-inbound/composition.js';
import {
  CancelBlockedError,
  CloseBlockedError,
  IllegalTransitionError,
  LineAlreadyPutAwayError,
  LineAlreadyReceivedError,
  LineNotFoundError,
  RoleRequiredError,
  OrderNotFoundError,
  SkuClientMismatchError,
  StaleVersionError,
  VarianceReasonRequiredError,
  // A variance-photo pair on a NON-variance receipt.
  VariancePhotoWithoutVarianceError,
} from '../../domain/receive-inbound/errors.js';
// LocationLimitExceededError is the EXISTING WBS 2.4 typed error, reused not duplicated.
import { LocationLimitExceededError } from '../../index.js';
// the package subpath export (@pg-eos/contracts/wms/receive-inbound), not a deep relative
// path — packages/contracts/package.json's own `exports` map already carries this entry.
import {
  ApproveInboundInputSchema,
  CancelInboundInputSchema,
  ReceiveLineInputSchema,
} from '@pg-eos/contracts/wms/receive-inbound';

// ------------------------------------------------------------------------------------------------
// WBS 2.9b EXTENSION (pg-tester, RED-first) — docs/notes/slice-briefs/_slice-2.9b.brief.md, D2/D3.
// Reused typed errors for the two extended commands. Neither domain/receive-inbound/errors.ts nor
// domain/receive-inbound/invariants.ts is in this slice's Write ONLY list (only
// application/receive-inbound/{approve-inbound,cancel-inbound}.ts is, under the D-180 scoped
// grant) — InvalidVehicleTypeError is therefore expected to live in the NEW, writable
// modules/wms/domain/schedule-inbound/errors.ts and be imported by approve-inbound.ts (used below
// for ApproveInbound's optional vehicleType slot). ScheduleInPastError applies only to
// ScheduleInbound's own expectedAt validation — covered by
// modules/wms/tests/schedule-inbound/schedule-inbound.test.ts, not this file, so it is not
// imported here. CancelReasonRequiredError lives in the same domain/schedule-inbound/errors.ts
// (round-1 review finding 7 moved it there; round-2 review finding 12: this import now points at
// that real home, so cancel-inbound.ts's backward-compatibility re-export shim can be removed).
// Round-2 review finding 3: the four logistics-term errors and LogisticsTermsRequireExpectedAtError
// are imported from the same file (thrown by the extended approveInbound).
import {
  CancelReasonRequiredError,
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
  LogisticsTermsRequireExpectedAtError,
} from '../../domain/schedule-inbound/errors.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// pgeos_app-role pool — dedicated so the RLS test (below) genuinely runs under RLS, not the
// admin/superuser connection.
const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

const SAFE_SKU_GROSS_WEIGHT_KG = '1.000';
const SAFE_SKU_VOLUME_CBM = '0.00100';
const OVER_PALLET_WEIGHT_KG = '1500.000'; // 019:236-237 pallet hard barrier, exceeded by 1 unit.
// 019-Warehouse-WH1-Setup.sql:236 (pallet) / :240 (shelf) — the real WH1 generator's own
// max_weight_kg per location_type, mirrored on this file's own M9- fixture locations (item 0 fix)
// so the over-weight ConfirmPutaway scenario still has a hard barrier to exceed.
const M9_PALLET_MAX_WEIGHT_KG = '1000.000';
const M9_SHELF_MAX_WEIGHT_KG = '750.000';
const QTY_ORDERED = '10.000';
const VARIANCE_QTY_ACTUAL = '8.000';
const VARIANCE_REASON = 'damaged in transit';
const ZERO_QTY = '0.000';
const ZERO_QTY_REASON = 'nothing arrived on the truck';

const WH_MGR_ROLE_CODE = 'WH_MGR';
const WH_SUP_ROLE_CODE = 'WH_SUP';
const GRN_TEMPLATE_CODE = 'GRN-01';
const DOC_NO_PREFIX = 'PST-DC-'; // entity PST + doc_type DOC's own seeded prefix.
const INBOUND_RECEIVED_EVENT_TYPE = 'wms.inbound.received';
const INBOUND_VARIANCE_EVENT_TYPE = 'wms.inbound.variance';
// WBS 2.9b — the three event names are live in packages/events/catalog.ts (added by the Master,
// commit 5644b5c); kept as raw event_type strings here because they are queried straight off
// platform.outbox.event_type.
const INBOUND_SCHEDULED_EVENT_TYPE = 'wms.inbound.scheduled';
const INBOUND_APPROVED_EVENT_TYPE = 'wms.inbound.approved';
const INBOUND_CANCELLED_EVENT_TYPE = 'wms.inbound.cancelled';
// migration 0023 CHECK chk_inbound_orders_vehicle_type — same closed list as
// modules/wms/tests/schedule-inbound/schedule-inbound.test.ts.
const SCHEDULE_SLOT_FUTURE_EXPECTED_AT = new Date(Date.parse('2026-09-24T00:00:00.000Z') + 6 * 24 * 60 * 60 * 1000).toISOString();
const INVALID_VEHICLE_TYPE_2_9B = 'motorcycle';
const CANCEL_REASON_2_9B = 'client requested cancellation';
// Round-2 review finding 3: one value outside each migration 0023 CHECK — same literals as
// modules/wms/tests/schedule-inbound/schedule-inbound.test.ts ('shared' is a legal labour_by but
// NOT a legal transport_by; labour_count's CHECK is `>= 0`).
const INVALID_HANDOVER_POINT_2_9B = 'airport';
const INVALID_TRANSPORT_BY_2_9B = 'shared';
const INVALID_LABOUR_BY_2_9B = 'contractor';
const INVALID_LABOUR_COUNT_2_9B = -1;
// Round-2 review finding 6: the sentinel platform.sanitize_audit substitutes for a
// `commercial`-classified column (brief Schema section / pre-migration review finding 1) — the
// same literal modules/wms/tests/schedule-inbound/schedule-inbound.test.ts asserts.
const SANITIZE_AUDIT_MASK = '•••';

const ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000209a1';
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000209a2';
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000209a3'; // RLS test: no user_entities row for this order's entity.

const clock = new FixedClock(new Date('2026-09-24T00:00:00.000Z'));
const ids = new SequentialIdGenerator(209);
const deps = createReceiveInboundDeps({ clock, ids });

const roleCtx = { userId: ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let warehouseId: string;
let fixtureClientId: string;
let fixtureClientIdY: string;
let grnTemplateId: string;

const fixtureClientCodeX = `_recvinb_fixture_x_${randomUUID()}`;
const fixtureClientCodeY = `_recvinb_fixture_y_${randomUUID()}`;
const fixtureSkuIds: string[] = [];
const fixtureOrderIds: string[] = [];
const usedCorrelationIds = new Set<string>();
// WBS 2.10: own zone/location fixtures for the ABC-ranking and temperature-filter scenarios below
// — deleted in afterAll, never left behind (locations first, FK to zones).
const fixtureZoneIds: string[] = [];
const fixtureLocationIds: string[] = [];

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

/** sha256 hex of the canonical JSON body, the endpoint 'wms.receive-inbound.<command>',
 *  successStatus 200 — the same shape the api handlers build. */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `wms.receive-inbound.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

const VARIANCE_PHOTO_URL = 'https://cdn.pg-eos.local/variance-photos/test-fixture.jpg';
const VARIANCE_PHOTO_SHA256 = 'a'.repeat(64);
const INVALID_SHA256 = 'not-a-valid-sha';

async function insertSku(clientId: string, code: string, grossWeightKg: string, volumeCbm: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [clientId, code, `صنف اختبار الاستلام ${code}`, grossWeightKg, volumeCbm],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.skus insert returned no row');
  fixtureSkuIds.push(row.id);
  return row.id;
}

// --- WBS 2.10 fixtures: own zones/locations for ABC-ranking + temperature-filter scenarios -------

const ABC_ZONE_TYPE = 'storage'; // wms.zones.zone_type — any non-'receiving' value; unused by the query.

async function insertZone(params: {
  readonly code: string;
  readonly tempMin: string | null;
  readonly tempMax: string | null;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.zones (warehouse_id, code, name_ar, zone_type, temp_min, temp_max)
     values ($1, $2, $3, $4, $5::numeric, $6::numeric) returning id`,
    [warehouseId, params.code, `منطقة اختبار ${params.code}`, ABC_ZONE_TYPE, params.tempMin, params.tempMax],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.zones insert returned no row');
  fixtureZoneIds.push(row.id);
  return row.id;
}

// 019-Warehouse-WH1-Setup.sql:57-64 chk_locations_code_format: for location_type in ('pallet',
// 'shelf'), code MUST match `^[PGMT][1-9]-[0-9]{2}-[1-9]$` (fixed 7 chars). Item-0's own
// pickFreshWh1Location fix showed a sequential/ordered code generator over the SHARED wms.locations
// table (previously a fixed 'T9-<seq>-8/9' block, 200 codes) collides with — or gets shadowed
// (`order by code desc`) by — leaked rows from a crashed/interrupted prior run: the fixed block
// runs out or gets re-claimed by a stale row, producing `locations_warehouse_id_code_key`
// duplicate-key errors and WH1 location/zone COUNT mismatches. Same fix as item 0: draw from the
// 'M9-' code block (019-Warehouse-WH1-Setup.sql:59 chk_locations_code_format
// `^[PGMT][1-9]-[0-9]{2}-[1-9]$`; WH1's real layout uses P1-P3/G1-G5/M1-M5/T1-T5, 'M9-' is reserved
// for this file's own fixtures) at random, claimed with
// `on conflict (warehouse_id, code) do nothing` so the table's own unique constraint — not
// generator ordering — arbitrates between concurrent/leaked rows. The old 'T9-*' leaked rows from
// prior runs are orphans (D-183: never deleted by a worker here) but no longer collide with or
// shadow this generator, since it no longer claims codes sequentially from a shared, exhaustible
// block.
async function insertLocationInZone(params: {
  readonly zoneId: string;
  readonly positionNo: number;
  readonly maxWeightKg: string | null;
}): Promise<string> {
  for (let attempt = 0; attempt < M9_FIXTURE_LOCATION_MAX_ATTEMPTS; attempt += 1) {
    const code = randomM9FixtureLocationCode();
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.locations (warehouse_id, zone_id, code, location_type, position_no, max_weight_kg)
       values ($1, $2, $3, 'pallet', $4, $5::numeric)
       on conflict (warehouse_id, code) do nothing
       returning id`,
      [warehouseId, params.zoneId, code, params.positionNo, params.maxWeightKg],
    );
    const row = result.rows[0];
    if (row) {
      fixtureLocationIds.push(row.id);
      return row.id;
    }
  }
  throw new Error(
    `no free ${M9_FIXTURE_LOCATION_PREFIX}-xx-x fixture location code after ${M9_FIXTURE_LOCATION_MAX_ATTEMPTS} attempts`,
  );
}

async function setSkuAbcClass(skuId: string, abcClass: 'A' | 'B' | 'C' | null): Promise<void> {
  await pool.query(`update wms.skus set abc_class = $1 where id = $2`, [abcClass, skuId]);
}

async function setSkuTempRange(skuId: string, tempMin: string | null, tempMax: string | null): Promise<void> {
  await pool.query(`update wms.skus set temp_min = $1::numeric, temp_max = $2::numeric where id = $3`, [
    tempMin,
    tempMax,
    skuId,
  ]);
}

// Same class of bug as WBS 2.10's own finding 1 (handlers.test.ts/process-outbound.test.ts): a
// `select ... from wms.locations ... order by code desc limit 1` over the SHARED table can pick a
// real WH1 production location OR another test file's leftover fixture row, and `order by code
// desc` means an orphaned high-sorting code is picked FIRST. Fix (mirrors
// modules/wms/tests/process-outbound/handlers.test.ts's `insertOwnLocation`): this function creates
// its OWN dedicated zone + location under the 'M9-' code block
// (019-Warehouse-WH1-Setup.sql:59 chk_locations_code_format `^[PGMT][1-9]-[0-9]{2}-[1-9]$`; WH1's
// real layout uses P1-P3/G1-G5/M1-M5/T1-T5 — 'M9-' is this fixture's block), claimed with
// `on conflict (warehouse_id, code) do nothing` so the table's own unique constraint arbitrates
// between concurrent runs. Tracked in fixtureZoneIds/fixtureLocationIds (already deleted in
// afterAll, locations before zones for the FK) — never left behind. Shared with insertLocationInZone
// above (item-0-class fix, part 2): both draw from this SAME 'M9-' block, arbitrated purely by the
// table's unique constraint, never by generator ordering.
const M9_FIXTURE_LOCATION_PREFIX = 'M9';
const M9_FIXTURE_LOCATION_SEQ_COUNT = 100;
const M9_FIXTURE_LOCATION_LEVEL_COUNT = 9;
const M9_FIXTURE_LOCATION_MAX_ATTEMPTS = 200;

function randomM9FixtureLocationCode(): string {
  const [seqByte = 0, levelByte = 0] = randomBytes(2);
  const seq = String(seqByte % M9_FIXTURE_LOCATION_SEQ_COUNT).padStart(2, '0');
  const level = (levelByte % M9_FIXTURE_LOCATION_LEVEL_COUNT) + 1;
  return `${M9_FIXTURE_LOCATION_PREFIX}-${seq}-${level}`;
}

async function pickFreshWh1Location(locationType: 'pallet' | 'shelf'): Promise<{ id: string; code: string }> {
  const zoneId = await insertZone({ code: `_recvinb_M9_zone_${randomUUID()}`, tempMin: null, tempMax: null });
  const maxWeightKg = locationType === 'pallet' ? M9_PALLET_MAX_WEIGHT_KG : M9_SHELF_MAX_WEIGHT_KG;
  for (let attempt = 0; attempt < M9_FIXTURE_LOCATION_MAX_ATTEMPTS; attempt += 1) {
    const code = randomM9FixtureLocationCode();
    const result: QueryResult<{ id: string; code: string }> = await pool.query(
      `insert into wms.locations (warehouse_id, zone_id, code, location_type, max_weight_kg)
       values ($1, $2, $3, $4, $5::numeric)
       on conflict (warehouse_id, code) do nothing
       returning id, code`,
      [warehouseId, zoneId, code, locationType, maxWeightKg],
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

interface DraftOrderLine {
  readonly skuId: string;
  readonly qtyOrdered: string;
}

async function createDraftInboundOrder(
  clientId: string,
  lines: readonly DraftOrderLine[],
): Promise<{ orderId: string; version: number; lineIds: string[] }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, 'INB') as doc_no`,
    [entityId],
  );
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for INB');

  const orderResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
     values ($1, $2, $3, $4, 'draft') returning id, version`,
    [entityId, docNo, clientId, warehouseId],
  );
  const orderRow = orderResult.rows[0];
  if (!orderRow) throw new Error('fixture wms.inbound_orders insert returned no row');
  fixtureOrderIds.push(orderRow.id);

  const lineIds: string[] = [];
  for (const [index, line] of lines.entries()) {
    const lineResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
       values ('wms.inbound_orders', $1, $2, $3, $4::numeric, 'EA') returning id`,
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
  arrived_at: Date | null;
  received_by: string | null;
  closed_at: Date | null;
  closed_by: string | null;
}> {
  const result: QueryResult<{
    status: string;
    version: number;
    arrived_at: Date | null;
    received_by: string | null;
    closed_at: Date | null;
    closed_by: string | null;
  }> = await pool.query(
    `select status, version, arrived_at, received_by, closed_at, closed_by from wms.inbound_orders where id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.inbound_orders row for id ${orderId}`);
  return row;
}

async function getLine(lineId: string): Promise<{
  status: string;
  qty_actual: string | null;
  location_id: string | null;
  variance_reason: string | null;
}> {
  const result: QueryResult<{
    status: string;
    qty_actual: string | null;
    location_id: string | null;
    variance_reason: string | null;
  }> = await pool.query(
    `select status, qty_actual::text as qty_actual, location_id, variance_reason from wms.order_lines where id = $1`,
    [lineId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.order_lines row for id ${lineId}`);
  return row;
}

async function movementCountForLine(clientId: string, skuId: string, orderId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.stock_movements
      where client_id = $1 and sku_id = $2 and ref_table = 'wms.inbound_orders' and ref_id = $3`,
    [clientId, skuId, orderId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** Exact-count outbox assertion — never `.some`/`> 0`. */
async function outboxRowsForCorrelationAndType(
  correlationId: string,
  eventType: string,
): Promise<Array<{ id: string }>> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `select id::text as id from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

async function auditCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function documentsForSource(orderId: string): Promise<Array<{ doc_no: string }>> {
  const result: QueryResult<{ doc_no: string }> = await pool.query(
    `select doc_no from platform.documents where source_table = 'wms.inbound_orders' and source_id = $1`,
    [orderId],
  );
  return result.rows;
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(
    `select id from identity.roles where code = $1`,
    [roleCode],
  );
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2)`, [userId, roleId]);
}

async function createFixtureActor(userId: string, entityIds: readonly string[]): Promise<void> {
  // platform.idempotency_keys FKs to identity.users — cleared first, idempotent against a
  // leftover row from a previously interrupted run reusing the same fixed fixture id.
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_recvinb_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار استلام الوارد — WBS 2.9'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
  }
}

/** Walks an order to 'received' with EVERY line receipted at qtyOrdered (no variance), through the
 *  commands under test (not a shortcut around them). */
async function approveAndReceiveAllLines(orderId: string, lineIds: readonly string[], qtyOrdered: string): Promise<void> {
  const order = await getOrder(orderId);
  await approveInbound(roleCtx, { orderId, expectedVersion: order.version, correlationId: nextCorrelationId() }, deps);
  for (const lineId of lineIds) {
    const before = await getOrder(orderId);
    await receiveLine(
      roleCtx,
      { orderId, lineId, qtyActual: qtyOrdered, expectedVersion: before.version, correlationId: nextCorrelationId() },
      deps,
    );
  }
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  entityId = (entityResult.rows[0] as { id: string }).id;

  const warehouseResult: QueryResult<{ id: string }> = await pool.query(`select id from wms.warehouses where code = 'WH1'`);
  warehouseId = (warehouseResult.rows[0] as { id: string }).id;

  // Fixture actors. OUTSIDER gets NO user_entities row for `entityId` at all (RLS scenario).
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
  // OUTSIDER_ACTOR_UUID: granted every entity EXCEPT `entityId` (PST) — deliberately, for the RLS
  // "cannot see or approve an order outside their entity" scenario.
  for (const eid of allEntityIds) {
    if (eid !== entityId) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
        OUTSIDER_ACTOR_UUID,
        eid,
      ]);
    }
  }

  await grantRole(ROLE_ACTOR_UUID, WH_MGR_ROLE_CODE);
  await grantRole(ROLE_ACTOR_UUID, WH_SUP_ROLE_CODE);

  const templateResult: QueryResult<{ id: string }> = await pool.query(
    `insert into platform.document_templates (code, name_ar, entity_id, body_html)
     values ($1, $2, null, $3) on conflict (code) do update set body_html = excluded.body_html returning id`,
    [GRN_TEMPLATE_CODE, 'إذن استلام بضاعة', '<div>GRN {{doc_no}}</div>'],
  );
  grnTemplateId = (templateResult.rows[0] as { id: string }).id;

  const clientResultX: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [fixtureClientCodeX, 'عميل اختبار استلام الوارد X'],
  );
  fixtureClientId = (clientResultX.rows[0] as { id: string }).id;

  const clientResultY: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [fixtureClientCodeY, 'عميل اختبار استلام الوارد Y'],
  );
  fixtureClientIdY = (clientResultY.rows[0] as { id: string }).id;
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureOrderIds.length > 0) {
    await pool.query(`delete from platform.documents where source_id = any($1::uuid[])`, [fixtureOrderIds]);
    await pool.query(`delete from wms.order_lines where order_id = any($1::uuid[])`, [fixtureOrderIds]);
    await pool.query(`delete from wms.inbound_orders where id = any($1::uuid[])`, [fixtureOrderIds]);
  }
  for (const clientId of [fixtureClientId, fixtureClientIdY]) {
    if (clientId) {
      await pool.query(`delete from wms.stock_balance where client_id = $1`, [clientId]);
      await pool.query(`delete from wms.stock_movements where client_id = $1`, [clientId]);
    }
  }
  if (fixtureSkuIds.length > 0) await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  // WBS 2.10 fixtures — locations before zones (FK).
  if (fixtureLocationIds.length > 0) {
    await pool.query(`delete from wms.locations where id = any($1::uuid[])`, [fixtureLocationIds]);
  }
  if (fixtureZoneIds.length > 0) {
    await pool.query(`delete from wms.zones where id = any($1::uuid[])`, [fixtureZoneIds]);
  }
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  if (fixtureClientIdY) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientIdY]);
  if (grnTemplateId) await pool.query(`delete from platform.document_templates where id = $1`, [grnTemplateId]);
  for (const userId of [ROLE_ACTOR_UUID, NO_ROLE_ACTOR_UUID, OUTSIDER_ACTOR_UUID]) {
    // Idempotent commands write a platform.idempotency_keys row keyed on (user_id, key) — the
    // idempotency scenarios above use these same fixture actors, so their rows must go before the
    // identity.users row they FK to (platform.audit_log is NEVER deleted; this is not that table).
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
  await appPool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/wms/receive-inbound — schemas match expectedVersion / no performedBy / no photoUrl', () => {
  it('ApproveInboundInputSchema accepts { orderId, expectedVersion, correlationId } with no performedBy field', () => {
    const parsed = ApproveInboundInputSchema.parse({ orderId: randomUUID(), expectedVersion: 1, correlationId: randomUUID() });
    expect(parsed.expectedVersion).toBe(1);
    expect('performedBy' in parsed).toBe(false);
  });

  it('ReceiveLineInputSchema accepts { orderId, lineId, qtyActual, varianceReason, expectedVersion, correlationId } and has no photoUrl field', () => {
    const parsed = ReceiveLineInputSchema.parse({
      orderId: randomUUID(),
      lineId: randomUUID(),
      qtyActual: VARIANCE_QTY_ACTUAL,
      varianceReason: VARIANCE_REASON,
      expectedVersion: 1,
      correlationId: randomUUID(),
    });
    expect(parsed.qtyActual).toBe(VARIANCE_QTY_ACTUAL);
    expect('photoUrl' in parsed).toBe(false);
  });
});

// --- Scenario: two-line happy path -----------------------------------------------------------

describe('Scenario: full happy path with a TWO-line order — receiving observed after line 1, received after line 2', () => {
  it('walks every named state, sets arrived_at/received_by on the FIRST receipt, writes the GRN (DOC series) + event at received, and closeInbound only sets status/closed_at/closed_by', async () => {
    const skuA = await insertSku(fixtureClientId, `RECVINB-HAPPY-A-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const skuB = await insertSku(fixtureClientId, `RECVINB-HAPPY-B-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [
      { skuId: skuA, qtyOrdered: QTY_ORDERED },
      { skuId: skuB, qtyOrdered: QTY_ORDERED },
    ]);
    const [lineA, lineB] = lineIds as [string, string];

    const approved = await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(approved.status).toBe('approved');
    expect((await getOrder(orderId)).status).toBe('approved');

    const afterApprove = await getOrder(orderId);
    const receiveA = await receiveLine(
      roleCtx,
      { orderId, lineId: lineA, qtyActual: QTY_ORDERED, expectedVersion: afterApprove.version, correlationId: nextCorrelationId() },
      deps,
    );
    expect(receiveA.orderStatus).toBe('receiving');
    const afterA = await getOrder(orderId);
    expect(afterA.arrived_at).not.toBeNull();
    expect(afterA.received_by).toBe(ROLE_ACTOR_UUID);

    const receiveBCorrelationId = nextCorrelationId();
    const receiveB = await receiveLine(
      roleCtx,
      { orderId, lineId: lineB, qtyActual: QTY_ORDERED, expectedVersion: afterA.version, correlationId: receiveBCorrelationId },
      deps,
    );
    expect(receiveB.orderStatus).toBe('received');

    const receivedRows = await outboxRowsForCorrelationAndType(receiveBCorrelationId, INBOUND_RECEIVED_EVENT_TYPE);
    expect(receivedRows).toHaveLength(1);
    const grnDocs = await documentsForSource(orderId);
    expect(grnDocs).toHaveLength(1);
    expect(grnDocs[0]?.doc_no.startsWith(DOC_NO_PREFIX)).toBe(true);

    const afterReceived = await getOrder(orderId);
    const arrivedAtAfterA = afterA.arrived_at?.toISOString();
    expect(afterReceived.arrived_at?.toISOString()).toBe(arrivedAtAfterA); // unchanged on line 2.

    const suggestionA = await suggestLocation(roleCtx, { skuId: skuA, qty: QTY_ORDERED, warehouseId }, deps);
    const chosenA = suggestionA.candidates[0] as { locationId: string };
    await confirmPutaway(
      roleCtx,
      { orderId, lineId: lineA, toLocationId: chosenA.locationId, expectedVersion: afterReceived.version, correlationId: nextCorrelationId() },
      deps,
    );
    const afterPutawayA = await getOrder(orderId);
    expect(afterPutawayA.status).toBe('putaway');

    const suggestionB = await suggestLocation(roleCtx, { skuId: skuB, qty: QTY_ORDERED, warehouseId }, deps);
    const chosenB = suggestionB.candidates[0] as { locationId: string };
    await confirmPutaway(
      roleCtx,
      { orderId, lineId: lineB, toLocationId: chosenB.locationId, expectedVersion: afterPutawayA.version, correlationId: nextCorrelationId() },
      deps,
    );

    const beforeClose = await getOrder(orderId);
    const closeCorrelationId = nextCorrelationId();
    const closed = await closeInbound(roleCtx, { orderId, expectedVersion: beforeClose.version, correlationId: closeCorrelationId }, deps);
    expect(closed.status).toBe('closed');

    const afterClose = await getOrder(orderId);
    expect(afterClose.closed_at).not.toBeNull();
    expect(afterClose.closed_by).toBe(ROLE_ACTOR_UUID);
    // Close writes NO document and NO event (moved to the 'received' transition above).
    expect(await documentsForSource(orderId)).toHaveLength(1); // still just the one from `received`.
    expect(await outboxRowsForCorrelationAndType(closeCorrelationId, INBOUND_RECEIVED_EVENT_TYPE)).toHaveLength(0);
  });
});

// --- Scenario: variance event ----------------------------------------------------------------------

describe('Scenario: a quantity variance emits wms.inbound.variance (outbox + audit, same correlationId)', () => {
  it('writes exactly one wms.inbound.variance outbox row and a matching audit_log row', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-VAREVENT-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    const varianceCorrelationId = nextCorrelationId();
    await receiveLine(
      roleCtx,
      {
        orderId,
        lineId,
        qtyActual: VARIANCE_QTY_ACTUAL,
        varianceReason: VARIANCE_REASON,
        expectedVersion: (await getOrder(orderId)).version,
        correlationId: varianceCorrelationId,
      },
      deps,
    );

    const varianceRows = await outboxRowsForCorrelationAndType(varianceCorrelationId, INBOUND_VARIANCE_EVENT_TYPE);
    expect(varianceRows).toHaveLength(1);
    expect(await auditCountForCorrelation(varianceCorrelationId)).toBeGreaterThan(0);
  });

  it('a non-variance receipt emits NO wms.inbound.variance row', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-NOVAR-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    const correlationId = nextCorrelationId();
    await receiveLine(roleCtx, { orderId, lineId, qtyActual: QTY_ORDERED, expectedVersion: (await getOrder(orderId)).version, correlationId }, deps);
    expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_VARIANCE_EVENT_TYPE)).toHaveLength(0);
  });
});

// --- Scenario: zero-qty line — 'received' has no CLOSE edge -------------------------------------

describe('Scenario: a zero-quantity line with a varianceReason posts no ledger row and completes without putaway', () => {
  it('qtyActual = 0.000 plus a varianceReason: no stock movement, line counts complete, but CloseInbound from "received" is illegal — CancelInbound is the only way out', async () => {
    const skuZero = await insertSku(fixtureClientId, `RECVINB-ZEROQTY-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: skuZero, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    const zeroReceiptCorrelationId = nextCorrelationId();
    await receiveLine(
      roleCtx,
      {
        orderId,
        lineId,
        qtyActual: ZERO_QTY,
        varianceReason: ZERO_QTY_REASON,
        expectedVersion: (await getOrder(orderId)).version,
        correlationId: zeroReceiptCorrelationId,
      },
      deps,
    );

    expect(await movementCountForLine(fixtureClientId, skuZero, orderId)).toBe(0);
    const line = await getLine(lineId);
    expect(line.status).toBe('complete');

    const beforeClose = await getOrder(orderId);
    expect(beforeClose.status).toBe('received');

    // SCR-WMS-INB-01 §6 — an all-zero order reaches 'received' with NO GRN document and NO
    // 'wms.inbound.received' event, even though the order genuinely reached 'received'. A zero
    // line is still a variance, so 'wms.inbound.variance' IS written for it.
    expect(await documentsForSource(orderId)).toHaveLength(0);
    expect(await outboxRowsForCorrelationAndType(zeroReceiptCorrelationId, INBOUND_RECEIVED_EVENT_TYPE)).toHaveLength(0);
    expect(await outboxRowsForCorrelationAndType(zeroReceiptCorrelationId, INBOUND_VARIANCE_EVENT_TYPE)).toHaveLength(1);

    // The machine has no received --CLOSE--> closed edge.
    await expect(
      closeInbound(roleCtx, { orderId, expectedVersion: beforeClose.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    // Every line is qty_actual = 0 (nothing physically moved) — CancelInbound is legal even though
    // the order already reached 'received'.
    const cancelled = await cancelInbound(
      roleCtx,
      { orderId, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId(), cancelReason: 'all-zero order, cancelling after received' },
      deps,
    );
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('an all-zero order reaches received with no GRN and no wms.inbound.received event (SCR-WMS-INB-01 §6)', () => {
  it('a TWO-line order where every line is receipted at qtyActual = 0 writes no platform.documents row and no wms.inbound.received outbox row, yet the order reaches "received" and CancelInbound still succeeds (SCR-WMS-INB-01 §6)', async () => {
    const skuA = await insertSku(fixtureClientId, `RECVINB-ALLZERO-A-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const skuB = await insertSku(fixtureClientId, `RECVINB-ALLZERO-B-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [
      { skuId: skuA, qtyOrdered: QTY_ORDERED },
      { skuId: skuB, qtyOrdered: QTY_ORDERED },
    ]);
    const [lineA, lineB] = lineIds as [string, string];
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    await receiveLine(
      roleCtx,
      {
        orderId,
        lineId: lineA,
        qtyActual: ZERO_QTY,
        varianceReason: ZERO_QTY_REASON,
        expectedVersion: (await getOrder(orderId)).version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );

    const lastLineCorrelationId = nextCorrelationId();
    const receiveResult = await receiveLine(
      roleCtx,
      {
        orderId,
        lineId: lineB,
        qtyActual: ZERO_QTY,
        varianceReason: ZERO_QTY_REASON,
        expectedVersion: (await getOrder(orderId)).version,
        correlationId: lastLineCorrelationId,
      },
      deps,
    );
    expect(receiveResult.orderStatus).toBe('received');

    const afterReceived = await getOrder(orderId);
    expect(afterReceived.status).toBe('received');
    expect(afterReceived.version).toBeGreaterThan(version); // version still bumped.

    expect(await documentsForSource(orderId)).toHaveLength(0);
    expect(await outboxRowsForCorrelationAndType(lastLineCorrelationId, INBOUND_RECEIVED_EVENT_TYPE)).toHaveLength(0);
    // Each zero line is still a variance — 'wms.inbound.variance' fires for the last line too.
    expect(await outboxRowsForCorrelationAndType(lastLineCorrelationId, INBOUND_VARIANCE_EVENT_TYPE)).toHaveLength(1);

    const cancelled = await cancelInbound(
      roleCtx,
      { orderId, expectedVersion: afterReceived.version, correlationId: nextCorrelationId(), cancelReason: 'both lines zero-qty, cancelling after received' },
      deps,
    );
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('Scenario: a MIXED order (one zero-qty line, one non-zero line) reaches "putaway" through its non-zero line and closes', () => {
  it('the zero-qty line counts complete without ConfirmPutaway; putting away only the non-zero line reaches "putaway", and CloseInbound then succeeds', async () => {
    const skuZero = await insertSku(fixtureClientId, `RECVINB-MIXED-ZERO-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const skuNonZero = await insertSku(fixtureClientId, `RECVINB-MIXED-NONZERO-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [
      { skuId: skuZero, qtyOrdered: QTY_ORDERED },
      { skuId: skuNonZero, qtyOrdered: QTY_ORDERED },
    ]);
    const [lineZero, lineNonZero] = lineIds as [string, string];
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    await receiveLine(
      roleCtx,
      {
        orderId,
        lineId: lineZero,
        qtyActual: ZERO_QTY,
        varianceReason: ZERO_QTY_REASON,
        expectedVersion: (await getOrder(orderId)).version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );
    const lastLineCorrelationId = nextCorrelationId();
    await receiveLine(
      roleCtx,
      { orderId, lineId: lineNonZero, qtyActual: QTY_ORDERED, expectedVersion: (await getOrder(orderId)).version, correlationId: lastLineCorrelationId },
      deps,
    );

    expect((await getOrder(orderId)).status).toBe('received');
    expect((await getLine(lineZero)).status).toBe('complete');
    expect((await getLine(lineZero)).location_id).toBeNull();

    // SCR-WMS-INB-01 §6 — MIXED order (at least one line > 0): the GRN and the event ARE written,
    // exactly as today, because SCR-WMS-INB-01 §6 only withholds them when EVERY line is zero.
    expect(await documentsForSource(orderId)).toHaveLength(1);
    expect(await outboxRowsForCorrelationAndType(lastLineCorrelationId, INBOUND_RECEIVED_EVENT_TYPE)).toHaveLength(1);

    const suggestion = await suggestLocation(roleCtx, { skuId: skuNonZero, qty: QTY_ORDERED, warehouseId }, deps);
    const chosen = suggestion.candidates[0] as { locationId: string };
    await confirmPutaway(
      roleCtx,
      { orderId, lineId: lineNonZero, toLocationId: chosen.locationId, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId() },
      deps,
    );

    const afterPutaway = await getOrder(orderId);
    expect(afterPutaway.status).toBe('putaway');

    const closed = await closeInbound(roleCtx, { orderId, expectedVersion: afterPutaway.version, correlationId: nextCorrelationId() }, deps);
    expect(closed.status).toBe('closed');
  });
});

// --- Scenario: cross-order / re-receive / re-putaway rejections -------------------------------------

describe('Scenario: a lineId that does not belong to the given orderId is rejected', () => {
  it('LineNotFoundError, nothing written', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-XORDER-A-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const orderA = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const orderB = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    await approveInbound(roleCtx, { orderId: orderA.orderId, expectedVersion: orderA.version, correlationId: nextCorrelationId() }, deps);

    await expect(
      receiveLine(
        roleCtx,
        {
          orderId: orderA.orderId,
          lineId: orderB.lineIds[0] as string, // belongs to orderB, not orderA.
          qtyActual: QTY_ORDERED,
          expectedVersion: (await getOrder(orderA.orderId)).version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(LineNotFoundError);
  });
});

describe('Scenario: re-receiving an already-receipted line is rejected', () => {
  it('LineAlreadyReceivedError, no second ledger row', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-REREC-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveAndReceiveAllLines(orderId, [lineId], QTY_ORDERED);
    const movementsBefore = await movementCountForLine(fixtureClientId, sku, orderId);

    await expect(
      receiveLine(
        roleCtx,
        { orderId, lineId, qtyActual: QTY_ORDERED, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(LineAlreadyReceivedError);

    expect(await movementCountForLine(fixtureClientId, sku, orderId)).toBe(movementsBefore);
  });
});

describe('Scenario: re-putaway of an already-put-away line is rejected', () => {
  it('LineAlreadyPutAwayError, no second transfer', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-REPUTAWAY-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveAndReceiveAllLines(orderId, [lineId], QTY_ORDERED);
    const suggestion = await suggestLocation(roleCtx, { skuId: sku, qty: QTY_ORDERED, warehouseId }, deps);
    const chosen = suggestion.candidates[0] as { locationId: string };
    await confirmPutaway(
      roleCtx,
      { orderId, lineId, toLocationId: chosen.locationId, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId() },
      deps,
    );
    const movementsBefore = await movementCountForLine(fixtureClientId, sku, orderId);

    await expect(
      confirmPutaway(
        roleCtx,
        { orderId, lineId, toLocationId: chosen.locationId, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(LineAlreadyPutAwayError);

    expect(await movementCountForLine(fixtureClientId, sku, orderId)).toBe(movementsBefore);
  });
});

// --- Scenario: stale expectedVersion (409) — EVERY command bumps version ---------------------------

describe('Scenario: a stale expectedVersion on ApproveInbound is rejected', () => {
  it('rejects with StaleVersionError and leaves status/version unchanged', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-STALE-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);

    await expect(
      approveInbound(roleCtx, { orderId, expectedVersion: version + 1, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(StaleVersionError);

    const after = await getOrder(orderId);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(version);
  });

  it('ReceiveLine also bumps version — a stale expectedVersion on ReceiveLine is rejected too', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-STALE-RL-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    const approved = await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    expect(approved.version).toBeGreaterThan(version); // ApproveInbound bumped it.

    await expect(
      receiveLine(
        roleCtx,
        { orderId, lineId, qtyActual: QTY_ORDERED, expectedVersion: version, correlationId: nextCorrelationId() }, // the OLD, now-stale version.
        deps,
      ),
    ).rejects.toBeInstanceOf(StaleVersionError);
  });
});

// --- Scenario: illegal transition -------------------------------------------------------------------

describe('Scenario: ReceiveLine on a never-approved (still draft) order is rejected', () => {
  it('rejects with IllegalTransitionError and writes nothing', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-ILLEGAL-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;

    await expect(
      receiveLine(roleCtx, { orderId, lineId, qtyActual: QTY_ORDERED, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    expect((await getLine(lineId)).qty_actual).toBeNull();
    expect((await getOrder(orderId)).status).toBe('draft');
  });
});

// --- Scenario: SKU/client mismatch (INV-C3-3) -------------------------------------------------------

describe('Scenario: a SKU belonging to a different client is rejected (INV-C3-3)', () => {
  it('rejects with SkuClientMismatchError and writes nothing', async () => {
    const skuOwnedByY = await insertSku(fixtureClientIdY, `RECVINB-MISMATCH-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: skuOwnedByY, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    await expect(
      receiveLine(
        roleCtx,
        { orderId, lineId, qtyActual: QTY_ORDERED, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(SkuClientMismatchError);

    expect((await getLine(lineId)).qty_actual).toBeNull();
  });
});

// --- Scenario: variance requires a reason (INV-C3-5) --------------------------------------------------

describe('Scenario: a quantity variance without a reason is rejected before any write (INV-C3-5)', () => {
  it('rejects with VarianceReasonRequiredError and never reaches the DB CHECK', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-VARIANCE-NOREASON-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    await expect(
      receiveLine(
        roleCtx,
        { orderId, lineId, qtyActual: VARIANCE_QTY_ACTUAL, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(VarianceReasonRequiredError);

    expect((await getLine(lineId)).qty_actual).toBeNull();
  });
});

// --- Scenario: over-weight ConfirmPutaway is rejected (INV-C3-4, inherited from WBS 2.4) -------------

describe('Scenario: ConfirmPutaway into a location that would exceed its weight limit is rejected (INV-C3-4)', () => {
  it('rejects with LocationLimitExceededError and the line stays un-put-away', async () => {
    const heavySku = await insertSku(fixtureClientId, `RECVINB-OVERWEIGHT-${randomUUID()}`, OVER_PALLET_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds } = await createDraftInboundOrder(fixtureClientId, [{ skuId: heavySku, qtyOrdered: '1.000' }]);
    const lineId = lineIds[0] as string;
    await approveAndReceiveAllLines(orderId, [lineId], '1.000');
    const overweightLocation = await pickFreshWh1Location('pallet');

    await expect(
      confirmPutaway(
        roleCtx,
        { orderId, lineId, toLocationId: overweightLocation.id, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(LocationLimitExceededError);

    const line = await getLine(lineId);
    expect(line.location_id).toBeNull();
  });
});

// --- Scenario: CloseInbound blocked while any line is open -------------------------------------------

describe('Scenario: CloseInbound is refused while any line is still open', () => {
  it('rejects with CloseBlockedError and the order stays "putaway"', async () => {
    const skuA = await insertSku(fixtureClientId, `RECVINB-CLOSEBLOCK-A-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const skuB = await insertSku(fixtureClientId, `RECVINB-CLOSEBLOCK-B-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds } = await createDraftInboundOrder(fixtureClientId, [
      { skuId: skuA, qtyOrdered: '2.000' },
      { skuId: skuB, qtyOrdered: '2.000' },
    ]);
    const [lineA, lineB] = lineIds as [string, string];
    await approveAndReceiveAllLines(orderId, [lineA, lineB], '2.000');

    const suggestionA = await suggestLocation(roleCtx, { skuId: skuA, qty: '2.000', warehouseId }, deps);
    const chosenA = suggestionA.candidates[0] as { locationId: string };
    await confirmPutaway(
      roleCtx,
      { orderId, lineId: lineA, toLocationId: chosenA.locationId, expectedVersion: (await getOrder(orderId)).version, correlationId: nextCorrelationId() },
      deps,
    );

    const orderBeforeClose = await getOrder(orderId);
    expect(orderBeforeClose.status).toBe('putaway');
    await expect(
      closeInbound(roleCtx, { orderId, expectedVersion: orderBeforeClose.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(CloseBlockedError);

    expect((await getOrder(orderId)).status).toBe('putaway');
  });
});

// --- Scenario: CancelInbound ---------------------------------------------------------------------------

describe('Scenario: CancelInbound from draft is allowed', () => {
  it('sets status to cancelled', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-CANCEL-DRAFT-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const result = await cancelInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId(), cancelReason: 'draft order, no longer needed' }, deps);
    expect(result.status).toBe('cancelled');
  });
});

describe('Scenario: CancelInbound after any line has been received is rejected', () => {
  it('rejects with CancelBlockedError and leaves status unchanged', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-CANCEL-AFTER-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveAndReceiveAllLines(orderId, [lineId], QTY_ORDERED);
    const receivedOrder = await getOrder(orderId);
    expect(receivedOrder.status).toBe('received');

    await expect(
      cancelInbound(roleCtx, { orderId, expectedVersion: receivedOrder.version, correlationId: nextCorrelationId(), cancelReason: 'attempting cancel after line received' }, deps),
    ).rejects.toBeInstanceOf(CancelBlockedError);
  });
});

describe('Scenario: CancelInbound on an order still receiving is rejected', () => {
  it('rejects with IllegalTransitionError — the machine has no receiving --CANCEL--> cancelled edge', async () => {
    const skuA = await insertSku(fixtureClientId, `RECVINB-CANCEL-RECEIVING-A-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const skuB = await insertSku(fixtureClientId, `RECVINB-CANCEL-RECEIVING-B-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [
      { skuId: skuA, qtyOrdered: QTY_ORDERED },
      { skuId: skuB, qtyOrdered: QTY_ORDERED },
    ]);
    const [lineA] = lineIds as [string, string];
    const approved = await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    // Only ONE of the two lines is receipted — the order is 'receiving', not 'received'.
    await receiveLine(
      roleCtx,
      { orderId, lineId: lineA, qtyActual: QTY_ORDERED, expectedVersion: approved.version, correlationId: nextCorrelationId() },
      deps,
    );
    const stillReceiving = await getOrder(orderId);
    expect(stillReceiving.status).toBe('receiving');

    await expect(
      cancelInbound(roleCtx, { orderId, expectedVersion: stillReceiving.version, correlationId: nextCorrelationId(), cancelReason: 'attempting cancel while still receiving' }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const after = await getOrder(orderId);
    expect(after.status).toBe('receiving');
    expect(after.version).toBe(stillReceiving.version);
  });
});

// --- Scenario: role gates ------------------------------------------------------------------------------

describe('Scenario: ApproveInbound without role WH_MGR is rejected', () => {
  it('rejects with RoleRequiredError', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-ROLE-MGR-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    await expect(
      approveInbound(noRoleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);
  });
});

describe('Scenario: CloseInbound without role WH_SUP is rejected', () => {
  it('rejects with RoleRequiredError and leaves status/version unchanged', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-ROLE-SUP-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    await approveAndReceiveAllLines(orderId, [lineIds[0] as string], QTY_ORDERED);
    const before = await getOrder(orderId);
    expect(before.status).toBe('received');

    await expect(
      closeInbound(noRoleCtx, { orderId, expectedVersion: before.version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    const after = await getOrder(orderId);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
  });
});

describe('Scenario: CancelInbound without role WH_MGR is rejected', () => {
  it('rejects with RoleRequiredError and leaves status/version unchanged', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-ROLE-CANCEL-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);

    await expect(
      cancelInbound(noRoleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId(), cancelReason: 'attempting cancel without WH_MGR role' }, deps),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    const after = await getOrder(orderId);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(version);
  });
});

// --- Scenario: idempotency — ApproveInbound is idempotent ----------------------------------------

describe('Scenario: ApproveInbound called twice with the same idem key + same body replays the stored result', () => {
  it('the second call returns the stored result, version bumps exactly once, and only one audit row exists for the first correlationId', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-IDEM-REPLAY-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const idemKey = `approve-replay-${randomUUID()}`;
    const firstCorrelationId = nextCorrelationId();
    const body = { orderId, expectedVersion: version, correlationId: firstCorrelationId };

    const first = await approveInbound(roleCtx, { ...body, idem: idemFor('approve', idemKey, body) }, deps);
    expect(first.status).toBe('approved');
    const afterFirst = await getOrder(orderId);
    expect(afterFirst.version).toBeGreaterThan(version);

    // Same key, same body (including the SAME expectedVersion, now stale) — replay must NOT
    // re-run the command (it would otherwise hit StaleVersionError against the bumped row).
    const second = await approveInbound(roleCtx, { ...body, idem: idemFor('approve', idemKey, body) }, deps);
    expect(second).toEqual(first);

    const afterSecond = await getOrder(orderId);
    expect(afterSecond.version).toBe(afterFirst.version); // bumped exactly once.
    expect(await auditCountForCorrelation(firstCorrelationId)).toBe(1);
  });

  it('the same idem key with a DIFFERENT body is rejected with IdempotencyConflictError', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-IDEM-MISMATCH-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const idemKey = `approve-mismatch-${randomUUID()}`;
    const firstBody = { orderId, expectedVersion: version, correlationId: nextCorrelationId() };

    await approveInbound(roleCtx, { ...firstBody, idem: idemFor('approve', idemKey, firstBody) }, deps);

    const differentBody = { orderId, expectedVersion: version, correlationId: nextCorrelationId() }; // different correlationId -> different hash.
    await expect(
      approveInbound(roleCtx, { ...differentBody, idem: idemFor('approve', idemKey, differentBody) }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe('Scenario: ReceiveLine is idempotent — the PDA-retry double-post case', () => {
  it('the same idem key + same body sent twice posts exactly ONE stock_movements row, the second call returns the stored result, and the version bumps exactly once', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-IDEM-RECEIVELINE-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    const approved = await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    const idemKey = `receive-line-replay-${randomUUID()}`;
    const body = { orderId, lineId, qtyActual: QTY_ORDERED, expectedVersion: approved.version, correlationId: nextCorrelationId() };

    const first = await receiveLine(roleCtx, { ...body, idem: idemFor('receive-line', idemKey, body) }, deps);
    const afterFirst = await getOrder(orderId);

    // Same key, same body — including the SAME (now stale) expectedVersion. A PDA that never saw
    // the first response and retries the identical request must get the FIRST result back, not a
    // second post.
    const second = await receiveLine(roleCtx, { ...body, idem: idemFor('receive-line', idemKey, body) }, deps);
    expect(second).toEqual(first);

    expect(await movementCountForLine(fixtureClientId, sku, orderId)).toBe(1);
    const afterSecond = await getOrder(orderId);
    expect(afterSecond.version).toBe(afterFirst.version); // bumped exactly once.
  });
});

// --- Scenario: variance photo ---------------------------------------------------------------------

describe('Scenario: a variance receipt with a photo pair persists variance_photo_url/variance_photo_sha256', () => {
  it('persists both columns on the order line', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-VARPHOTO-OK-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    await receiveLine(
      roleCtx,
      {
        orderId,
        lineId,
        qtyActual: VARIANCE_QTY_ACTUAL,
        varianceReason: VARIANCE_REASON,
        variancePhotoUrl: VARIANCE_PHOTO_URL,
        variancePhotoSha256: VARIANCE_PHOTO_SHA256,
        expectedVersion: (await getOrder(orderId)).version,
        correlationId: nextCorrelationId(),
      },
      deps,
    );

    const result: QueryResult<{ variance_photo_url: string | null; variance_photo_sha256: string | null }> = await pool.query(
      `select variance_photo_url, variance_photo_sha256 from wms.order_lines where id = $1`,
      [lineId],
    );
    const row = result.rows[0];
    expect(row?.variance_photo_url).toBe(VARIANCE_PHOTO_URL);
    expect(row?.variance_photo_sha256).toBe(VARIANCE_PHOTO_SHA256);
  });
});

describe('Scenario: a photo pair on a NON-variance receipt is rejected', () => {
  it('rejects with VariancePhotoWithoutVarianceError and writes nothing', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-VARPHOTO-NOVAR-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const lineId = lineIds[0] as string;
    await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);

    await expect(
      receiveLine(
        roleCtx,
        {
          orderId,
          lineId,
          qtyActual: QTY_ORDERED, // no variance — matches qty_ordered.
          variancePhotoUrl: VARIANCE_PHOTO_URL,
          variancePhotoSha256: VARIANCE_PHOTO_SHA256,
          expectedVersion: (await getOrder(orderId)).version,
          correlationId: nextCorrelationId(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(VariancePhotoWithoutVarianceError);

    expect((await getLine(lineId)).qty_actual).toBeNull();
  });
});

describe('Scenario: an invalid variance-photo sha256 is rejected by the contract schema', () => {
  it('ReceiveLineInputSchema.parse throws on a malformed sha256', () => {
    expect(() =>
      ReceiveLineInputSchema.parse({
        orderId: randomUUID(),
        lineId: randomUUID(),
        qtyActual: VARIANCE_QTY_ACTUAL,
        varianceReason: VARIANCE_REASON,
        variancePhotoUrl: VARIANCE_PHOTO_URL,
        variancePhotoSha256: INVALID_SHA256,
        expectedVersion: 1,
        correlationId: randomUUID(),
      }),
    ).toThrow();
  });
});

// --- Scenario: RLS — an outsider cannot see or approve an order outside their entity -----------

describe('Scenario: an entity-scoped RLS outsider cannot see or approve the order', () => {
  it('the order is invisible to a pgeos_app query scoped to the outsider, and ApproveInbound fails', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-RLS-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);

    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [OUTSIDER_ACTOR_UUID]);
      await client.query(`select set_config('app.client_id', $1, true)`, [null]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      const visible: QueryResult<{ id: string }> = await client.query(
        `select id from wms.inbound_orders where id = $1`,
        [orderId],
      );
      expect(visible.rows).toHaveLength(0);
      await client.query('rollback');
    } finally {
      client.release();
    }

    // ApproveInbound as the outsider: RLS makes the row invisible to the command's own locked read,
    // so it is OrderNotFoundError — the same answer as a missing order, by design — and nothing
    // about the order changes.
    await expect(
      approveInbound(outsiderCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    const after = await getOrder(orderId);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(version);
  });
});

// --- Scenario: concurrency ------------------------------------------------------------------------

describe('Scenario: two concurrent ReceiveLines on the LAST two lines leave the order in received, not stuck in receiving', () => {
  it('exactly one of the two concurrent calls observes "last line" and the order ends up received', async () => {
    const skuA = await insertSku(fixtureClientId, `RECVINB-CONC-A-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const skuB = await insertSku(fixtureClientId, `RECVINB-CONC-B-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const skuC = await insertSku(fixtureClientId, `RECVINB-CONC-C-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, lineIds, version } = await createDraftInboundOrder(fixtureClientId, [
      { skuId: skuA, qtyOrdered: '1.000' },
      { skuId: skuB, qtyOrdered: '1.000' },
      { skuId: skuC, qtyOrdered: '1.000' },
    ]);
    const [lineA, lineB, lineC] = lineIds as [string, string, string];
    const approved = await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps);
    await receiveLine(roleCtx, { orderId, lineId: lineA, qtyActual: '1.000', expectedVersion: approved.version, correlationId: nextCorrelationId() }, deps);
    const beforeConcurrent = await getOrder(orderId);
    expect(beforeConcurrent.status).toBe('receiving');

    // Two concurrent ReceiveLines on the two REMAINING lines, both racing against the same
    // expectedVersion — the optimistic-lock retry/serialization is the mechanism under test; only
    // the END STATE (order 'received', not stuck in 'receiving') is asserted, never a hardcoded
    // "which call won" ordering.
    const [resultB, resultC] = await Promise.allSettled([
      receiveLine(roleCtx, { orderId, lineId: lineB, qtyActual: '1.000', expectedVersion: beforeConcurrent.version, correlationId: nextCorrelationId() }, deps),
      receiveLine(roleCtx, { orderId, lineId: lineC, qtyActual: '1.000', expectedVersion: beforeConcurrent.version, correlationId: nextCorrelationId() }, deps),
    ]);

    // At least one may legitimately hit StaleVersionError (both raced the same expectedVersion) —
    // the caller is expected to retry with a fresh version on 409, same as any optimistic-lock
    // command; a retry loop is exercised here directly rather than asserting a raw double-race.
    for (const [result, lineId] of [
      [resultB, lineB],
      [resultC, lineC],
    ] as const) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(StaleVersionError);
        const retryVersion = await getOrder(orderId);
        await receiveLine(roleCtx, { orderId, lineId, qtyActual: '1.000', expectedVersion: retryVersion.version, correlationId: nextCorrelationId() }, deps);
      }
    }

    expect((await getOrder(orderId)).status).toBe('received');
  });
});

describe('Scenario: two concurrent ApproveInbound calls with the SAME expectedVersion — exactly one succeeds, the other gets 409', () => {
  it('exactly one fulfils, the other rejects with StaleVersionError', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-CONC-APPROVE-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);

    const [resultA, resultB] = await Promise.allSettled([
      approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
      approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId() }, deps),
    ]);

    const fulfilled = [resultA, resultB].filter((r) => r.status === 'fulfilled');
    const rejected = [resultA, resultB].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleVersionError);
    expect((await getOrder(orderId)).status).toBe('approved');
  });
});

// ==================================================================================================
// WBS 2.10 — new scenarios (docs/notes/slice-briefs/_slice-2.10.brief.md, "Scenario" section).
// Every scenario above this marker is 2.9's own suite, unmodified — the regression guarantee (Master
// decision 6) is this whole file re-run in full, not a new assertion.
// ==================================================================================================

// wms.skus.gross_weight_kg used for every fixture SKU in this file: SAFE_SKU_GROSS_WEIGHT_KG ('1.000').
// remainingCapacityRatio = 1 - (qty * gross_weight_kg) / max_weight_kg when max_volume_cbm is null
// (volume component is then 1, so weight is the only binding dimension) — QTY_ORDERED = '10.000'.
// 1 - 10/25 = 0.60; 1 - 10/100 = 0.90 (brief Scenario's own 60%/90% figures).
const ABC_NEAR_LOCATION_MAX_WEIGHT_KG = '25.000';
const ABC_FAR_LOCATION_MAX_WEIGHT_KG = '100.000';
const ABC_NEAR_POSITION_NO = 1;
const ABC_FAR_POSITION_NO = 20;

const FROZEN_SKU_TEMP_C = '-18.00'; // brief Scenario: "requires temp_min -18, temp_max -18 (frozen)".
const FROZEN_ZONE_TEMP_MIN_C = '-25.00'; // brief Scenario: "Z-FROZEN has temp_min -25, temp_max -15".
const FROZEN_ZONE_TEMP_MAX_C = '-15.00';
// Fix round 1 (pg-reviewer FAIL, item 4): a zone with BOTH bounds set but a range that does not
// cover the SKU's requirement — a 0..8°C chilled zone for a -18°C frozen SKU.
const CHILLED_ZONE_TEMP_MIN_C = '0.00';
const CHILLED_ZONE_TEMP_MAX_C = '8.00';

describe('Scenario: a class-A SKU prefers a closer, slightly tighter location over a roomier, farther one (WBS 2.10)', () => {
  it('ranks the position_no=1/60%-capacity location before the position_no=20/90%-capacity location for an abc_class A SKU', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-ABC-A-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    await setSkuAbcClass(sku, 'A');
    const zone = await insertZone({ code: `_ABC_A_ZONE_${randomUUID()}`, tempMin: null, tempMax: null });
    const near = await insertLocationInZone({
      zoneId: zone,
      positionNo: ABC_NEAR_POSITION_NO,
      maxWeightKg: ABC_NEAR_LOCATION_MAX_WEIGHT_KG,
    });
    const far = await insertLocationInZone({
      zoneId: zone,
      positionNo: ABC_FAR_POSITION_NO,
      maxWeightKg: ABC_FAR_LOCATION_MAX_WEIGHT_KG,
    });

    const suggestion = await suggestLocation(roleCtx, { skuId: sku, qty: QTY_ORDERED, warehouseId }, deps);
    const ids = suggestion.candidates.map((c) => c.locationId);
    expect(ids.indexOf(near)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(far)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(far));

    const nearCandidate = suggestion.candidates.find((c) => c.locationId === near) as { abcClass: string | null };
    expect(nearCandidate.abcClass).toBe('A');
  });
});

describe('Scenario: a class-C SKU keeps the 2.9 capacity-first order (WBS 2.10)', () => {
  it('ranks the position_no=20/90%-capacity location before the position_no=1/60%-capacity location for an abc_class C SKU', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-ABC-C-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    await setSkuAbcClass(sku, 'C');
    const zone = await insertZone({ code: `_ABC_C_ZONE_${randomUUID()}`, tempMin: null, tempMax: null });
    const near = await insertLocationInZone({
      zoneId: zone,
      positionNo: ABC_NEAR_POSITION_NO,
      maxWeightKg: ABC_NEAR_LOCATION_MAX_WEIGHT_KG,
    });
    const far = await insertLocationInZone({
      zoneId: zone,
      positionNo: ABC_FAR_POSITION_NO,
      maxWeightKg: ABC_FAR_LOCATION_MAX_WEIGHT_KG,
    });

    const suggestion = await suggestLocation(roleCtx, { skuId: sku, qty: QTY_ORDERED, warehouseId }, deps);
    const ids = suggestion.candidates.map((c) => c.locationId);
    expect(ids.indexOf(near)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(far)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(far)).toBeLessThan(ids.indexOf(near));
  });
});

describe('Scenario: a SKU with no abc_class set behaves exactly like the class-C case (regression guarantee, WBS 2.10)', () => {
  it('ranks the position_no=20/90%-capacity location before the position_no=1/60%-capacity location when abc_class is null, identically to class C', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-ABC-NULL-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    // abc_class left at its default (null) — no setSkuAbcClass call, deliberately.
    const zone = await insertZone({ code: `_ABC_NULL_ZONE_${randomUUID()}`, tempMin: null, tempMax: null });
    const near = await insertLocationInZone({
      zoneId: zone,
      positionNo: ABC_NEAR_POSITION_NO,
      maxWeightKg: ABC_NEAR_LOCATION_MAX_WEIGHT_KG,
    });
    const far = await insertLocationInZone({
      zoneId: zone,
      positionNo: ABC_FAR_POSITION_NO,
      maxWeightKg: ABC_FAR_LOCATION_MAX_WEIGHT_KG,
    });

    const suggestion = await suggestLocation(roleCtx, { skuId: sku, qty: QTY_ORDERED, warehouseId }, deps);
    const ids = suggestion.candidates.map((c) => c.locationId);
    expect(ids.indexOf(near)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(far)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(far)).toBeLessThan(ids.indexOf(near));

    const nearCandidate = suggestion.candidates.find((c) => c.locationId === near) as { abcClass: string | null };
    expect(nearCandidate.abcClass).toBeNull();
  });
});

describe('Scenario: a temperature-sensitive SKU excludes an incompatible zone entirely (WBS 2.10)', () => {
  it('excludes the ambient-zone location from the candidate list while including the frozen-zone location, for a frozen SKU', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-TEMP-COLD-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    await setSkuTempRange(sku, FROZEN_SKU_TEMP_C, FROZEN_SKU_TEMP_C);
    const ambientZone = await insertZone({ code: `_TEMP_AMBIENT_${randomUUID()}`, tempMin: null, tempMax: null });
    const frozenZone = await insertZone({
      code: `_TEMP_FROZEN_${randomUUID()}`,
      tempMin: FROZEN_ZONE_TEMP_MIN_C,
      tempMax: FROZEN_ZONE_TEMP_MAX_C,
    });
    const ambientLoc = await insertLocationInZone({
      zoneId: ambientZone,
      positionNo: 1,
      maxWeightKg: null,
    });
    const frozenLoc = await insertLocationInZone({
      zoneId: frozenZone,
      positionNo: 1,
      maxWeightKg: null,
    });

    const suggestion = await suggestLocation(roleCtx, { skuId: sku, qty: QTY_ORDERED, warehouseId }, deps);
    const ids = suggestion.candidates.map((c) => c.locationId);
    expect(ids).toContain(frozenLoc);
    expect(ids).not.toContain(ambientLoc);
  });
});

// Fix round 1 (pg-reviewer FAIL, item 4): a filter that only checks "zone has bounds set at all"
// would pass every test above (the ambient zone has NO bounds). This scenario proves the range
// itself, not merely the presence of bounds, is what's checked.
describe('Scenario: a temperature-sensitive SKU excludes a zone with BOTH bounds set that does not cover its range (WBS 2.10, fix round 1)', () => {
  it('excludes a 0..8°C chilled-zone location for a -18°C frozen SKU, even though the zone has both temp_min and temp_max set', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-TEMP-CHILLED-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    await setSkuTempRange(sku, FROZEN_SKU_TEMP_C, FROZEN_SKU_TEMP_C);
    const chilledZone = await insertZone({
      code: `_TEMP_CHILLED_${randomUUID()}`,
      tempMin: CHILLED_ZONE_TEMP_MIN_C,
      tempMax: CHILLED_ZONE_TEMP_MAX_C,
    });
    const chilledLoc = await insertLocationInZone({
      zoneId: chilledZone,
      positionNo: 1,
      maxWeightKg: null,
    });

    const suggestion = await suggestLocation(roleCtx, { skuId: sku, qty: QTY_ORDERED, warehouseId }, deps);
    const ids = suggestion.candidates.map((c) => c.locationId);
    expect(ids).not.toContain(chilledLoc);
  });
});

describe('Scenario: a SKU with only ONE temperature bound set matches on that bound independently (WBS 2.10, fix round 1)', () => {
  it('includes a Z-FROZEN location for a SKU that declares only temp_min (-18, no temp_max) when the zone is compatible on that bound', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-TEMP-MINONLY-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    await setSkuTempRange(sku, FROZEN_SKU_TEMP_C, null);
    const frozenZone = await insertZone({
      code: `_TEMP_MINONLY_FROZEN_${randomUUID()}`,
      tempMin: FROZEN_ZONE_TEMP_MIN_C,
      tempMax: FROZEN_ZONE_TEMP_MAX_C,
    });
    const frozenLoc = await insertLocationInZone({
      zoneId: frozenZone,
      positionNo: 1,
      maxWeightKg: null,
    });

    const suggestion = await suggestLocation(roleCtx, { skuId: sku, qty: QTY_ORDERED, warehouseId }, deps);
    const ids = suggestion.candidates.map((c) => c.locationId);
    expect(ids).toContain(frozenLoc);
  });
});

describe('Scenario: a SKU with no temperature requirement is unaffected by zone temperature (WBS 2.10)', () => {
  it('includes both the ambient-zone and frozen-zone locations as candidates when the SKU has no temp_min/temp_max', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-TEMP-AMBIENT-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    // temp_min/temp_max left at their default (null) — no setSkuTempRange call, deliberately.
    const ambientZone = await insertZone({ code: `_TEMP_NOREQ_AMBIENT_${randomUUID()}`, tempMin: null, tempMax: null });
    const frozenZone = await insertZone({
      code: `_TEMP_NOREQ_FROZEN_${randomUUID()}`,
      tempMin: FROZEN_ZONE_TEMP_MIN_C,
      tempMax: FROZEN_ZONE_TEMP_MAX_C,
    });
    const ambientLoc = await insertLocationInZone({
      zoneId: ambientZone,
      positionNo: 1,
      maxWeightKg: null,
    });
    const frozenLoc = await insertLocationInZone({
      zoneId: frozenZone,
      positionNo: 1,
      maxWeightKg: null,
    });

    const suggestion = await suggestLocation(roleCtx, { skuId: sku, qty: QTY_ORDERED, warehouseId }, deps);
    const ids = suggestion.candidates.map((c) => c.locationId);
    expect(ids).toContain(ambientLoc);
    expect(ids).toContain(frozenLoc);
  });
});

// ==================================================================================================
// WBS 2.9b — new scenarios (docs/notes/slice-briefs/_slice-2.9b.brief.md, D2/D3). Every scenario
// above this marker is 2.9's (and 2.10's) own suite, UNCHANGED — the regression guarantee is this
// whole file re-run in full, not a new assertion (same discipline as the 2.10 marker above).
// ==================================================================================================

// Round-1 review finding 9: getOrder() (above) only selects 2.9's own columns — a dedicated query
// for the nine WBS 2.9b logistics/appointment columns so the "sets expected_at" scenario below can
// actually assert them, instead of only status/version.
async function getScheduleColumns(orderId: string): Promise<{
  expected_at: Date | null;
  scheduled_by: string | null;
  scheduled_at: Date | null;
  dock_code: string | null;
  handover_point: string | null;
  transport_by: string | null;
  vehicle_type: string | null;
  labour_by: string | null;
  labour_count: number | null;
}> {
  const result: QueryResult<{
    expected_at: Date | null;
    scheduled_by: string | null;
    scheduled_at: Date | null;
    dock_code: string | null;
    handover_point: string | null;
    transport_by: string | null;
    vehicle_type: string | null;
    labour_by: string | null;
    labour_count: number | null;
  }> = await pool.query(
    `select expected_at, scheduled_by, scheduled_at, dock_code, handover_point, transport_by,
            vehicle_type, labour_by, labour_count
       from wms.inbound_orders where id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.inbound_orders row for id ${orderId}`);
  return row;
}

// Round-1 review finding 9: outboxRowsForCorrelationAndType() (above) only selects `id` — this
// slice's new event-payload assertions need the payload column too.
async function outboxPayloadsForCorrelationAndType(
  correlationId: string,
  eventType: string,
): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  const result: QueryResult<{ id: string; payload: Record<string, unknown> }> = await pool.query(
    `select id::text as id, payload from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

describe('Scenario: ApproveInbound with expectedAt present emits BOTH wms.inbound.approved and wms.inbound.scheduled (D2)', () => {
  it('writes both events in the SAME transaction/correlationId, sets expected_at/scheduled_by/scheduled_at and the logistics columns, and bumps version once', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-APPROVESLOT-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const correlationId = nextCorrelationId();

    const approved = await approveInbound(
      roleCtx,
      {
        orderId,
        expectedVersion: version,
        correlationId,
        expectedAt: SCHEDULE_SLOT_FUTURE_EXPECTED_AT,
        dockCode: 'D-09',
        handoverPoint: 'client_site',
        transportBy: 'premium',
        vehicleType: 'truck',
        labourBy: 'premium',
        labourCount: 2,
      },
      deps,
    );
    expect(approved.status).toBe('approved');

    const after = await getOrder(orderId);
    expect(after.status).toBe('approved');
    expect(after.version).toBe(approved.version);

    // Round-1 review finding 9: actually read back expected_at/scheduled_by/scheduled_at and the
    // logistics columns, not just status/version.
    const scheduleColumns = await getScheduleColumns(orderId);
    expect(scheduleColumns.expected_at?.toISOString()).toBe(SCHEDULE_SLOT_FUTURE_EXPECTED_AT);
    expect(scheduleColumns.scheduled_by).toBe(ROLE_ACTOR_UUID);
    expect(scheduleColumns.scheduled_at).not.toBeNull();
    expect(scheduleColumns.dock_code).toBe('D-09');
    expect(scheduleColumns.handover_point).toBe('client_site');
    expect(scheduleColumns.transport_by).toBe('premium');
    expect(scheduleColumns.vehicle_type).toBe('truck');
    expect(scheduleColumns.labour_by).toBe('premium');
    expect(scheduleColumns.labour_count).toBe(2);

    expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_APPROVED_EVENT_TYPE)).toHaveLength(1);
    const scheduledRows = await outboxPayloadsForCorrelationAndType(correlationId, INBOUND_SCHEDULED_EVENT_TYPE);
    expect(scheduledRows).toHaveLength(1);
    const scheduledPayload = scheduledRows[0]?.payload as Record<string, unknown>;
    // Round-1 review finding 6 (pg-backend's parallel fix): the payload's expectedAt is built via
    // `.toISOString()` on both emitting paths (ISO 8601), not an echo of Postgres's own
    // `timestamptz::text` format — asserted as an exact ISO 8601 string match (round-3 finding 3:
    // a Date-value-only comparison would pass a regression back to the old format undetected).
    expect(scheduledPayload['expectedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(scheduledPayload['expectedAt']).toBe(SCHEDULE_SLOT_FUTURE_EXPECTED_AT);
    expect(scheduledPayload).toMatchObject({
      orderId,
      dockCode: 'D-09',
      handoverPoint: 'client_site',
      transportBy: 'premium',
      vehicleType: 'truck',
      labourBy: 'premium',
      labourCount: 2,
    });
  });

  it('rejects with InvalidVehicleTypeError when the optional slot carries a vehicleType outside the closed list, and writes nothing', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-APPROVESLOT-BADVEH-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);

    await expect(
      approveInbound(
        roleCtx,
        {
          orderId,
          expectedVersion: version,
          correlationId: nextCorrelationId(),
          expectedAt: SCHEDULE_SLOT_FUTURE_EXPECTED_AT,
          vehicleType: INVALID_VEHICLE_TYPE_2_9B,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidVehicleTypeError);

    const after = await getOrder(orderId);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(version);
  });
});

// --- WBS 2.9b pg-reviewer round-3 finding 4c: approve-with-slot idempotent replay ----------------

describe('Scenario: ApproveInbound-with-slot (D2) is idempotent — same Idempotency-Key + body replays the stored result', () => {
  it('the second call returns the stored result, version bumps exactly once, and exactly one wms.inbound.approved + one wms.inbound.scheduled outbox row exist, not two of each', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-APPROVESLOT-REPLAY-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const idemKey = `approve-slot-replay-${randomUUID()}`;
    const correlationId = nextCorrelationId();
    const body = {
      orderId,
      expectedVersion: version,
      correlationId,
      expectedAt: SCHEDULE_SLOT_FUTURE_EXPECTED_AT,
      dockCode: 'D-11',
      handoverPoint: 'client_site',
      transportBy: 'premium',
      vehicleType: 'truck',
      labourBy: 'premium',
      labourCount: 2,
    };

    const first = await approveInbound(roleCtx, { ...body, idem: idemFor('approve', idemKey, body) }, deps);
    expect(first.status).toBe('approved');
    const afterFirst = await getOrder(orderId);
    expect(afterFirst.version).toBeGreaterThan(version);

    const second = await approveInbound(roleCtx, { ...body, idem: idemFor('approve', idemKey, body) }, deps);
    expect(second).toEqual(first);

    const afterSecond = await getOrder(orderId);
    expect(afterSecond.version).toBe(afterFirst.version); // bumped exactly once.

    expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_APPROVED_EVENT_TYPE)).toHaveLength(1);
    expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_SCHEDULED_EVENT_TYPE)).toHaveLength(1);
  });
});

// --- Round-2 review finding 6: the approve-with-slot audit row's actual contents ----------------

/** Every platform.audit_log row for a correlationId, returning BOTH the raw stored newValue and the
 *  same value read back through platform.sanitize_audit — the masking is applied at read time (same
 *  helper shape as modules/wms/tests/schedule-inbound/schedule-inbound.test.ts's own
 *  sanitizedAuditNewValue), so the commercial-column assertion is only observable this way. */
async function auditRowsWithSanitizedForCorrelation(
  correlationId: string,
): Promise<Array<{ raw: Record<string, unknown>; sanitized: Record<string, unknown> }>> {
  const result: QueryResult<{ raw: Record<string, unknown>; sanitized: Record<string, unknown> }> = await pool.query(
    `select new_value as raw, platform.sanitize_audit(schema_name, table_name, new_value) as sanitized
       from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return result.rows;
}

describe('Scenario: the approve-with-slot audit row carries the nine appointment/logistics columns, the four commercial ones masked (round-2 finding 6)', () => {
  it('exactly one audit row; newValue carries expectedAt/scheduledBy/scheduledAt/dockCode/vehicleType + handover_point/transport_by/labour_by/labour_count; platform.sanitize_audit masks the four commercial keys to "•••" and leaves the five public ones raw', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-APPROVESLOT-AUDIT-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const correlationId = nextCorrelationId();

    const approved = await approveInbound(
      roleCtx,
      {
        orderId,
        expectedVersion: version,
        correlationId,
        expectedAt: SCHEDULE_SLOT_FUTURE_EXPECTED_AT,
        dockCode: 'D-10',
        handoverPoint: 'premium_warehouse',
        transportBy: 'client',
        vehicleType: 'van',
        labourBy: 'shared',
        labourCount: 5,
      },
      deps,
    );

    const auditRows = await auditRowsWithSanitizedForCorrelation(correlationId);
    expect(auditRows).toHaveLength(1);
    const { raw, sanitized } = auditRows[0] as { raw: Record<string, unknown>; sanitized: Record<string, unknown> };

    // The nine columns this path writes (brief D1/D2) — every key present.
    const NINE_COLUMN_KEYS = [
      'expectedAt',
      'scheduledBy',
      'scheduledAt',
      'dockCode',
      'vehicleType',
      'handover_point',
      'transport_by',
      'labour_by',
      'labour_count',
    ] as const;
    for (const key of NINE_COLUMN_KEYS) {
      expect(raw, `audit newValue is missing key "${key}"`).toHaveProperty(key);
    }
    // The status transition itself is still recorded alongside the slot.
    expect(raw['status']).toBe('approved');
    expect(raw['version']).toBe(approved.version);

    // The four commercial-classified keys (migration 0023 classification) — masked at read time.
    expect(sanitized['handover_point']).toBe(SANITIZE_AUDIT_MASK);
    expect(sanitized['transport_by']).toBe(SANITIZE_AUDIT_MASK);
    expect(sanitized['labour_by']).toBe(SANITIZE_AUDIT_MASK);
    expect(sanitized['labour_count']).toBe(SANITIZE_AUDIT_MASK);
    // ...and genuinely carried the supplied values before masking (the mask is not hiding a null).
    expect(raw['handover_point']).toBe('premium_warehouse');
    expect(raw['transport_by']).toBe('client');
    expect(raw['labour_by']).toBe('shared');
    expect(raw['labour_count']).toBe(5);

    // The five public keys pass through sanitize_audit unmasked, with the stored values.
    expect(new Date(sanitized['expectedAt'] as string).toISOString()).toBe(SCHEDULE_SLOT_FUTURE_EXPECTED_AT);
    expect(sanitized['scheduledBy']).toBe(ROLE_ACTOR_UUID);
    expect(new Date(sanitized['scheduledAt'] as string).toISOString()).toBe(clock.now().toISOString());
    expect(sanitized['dockCode']).toBe('D-10');
    expect(sanitized['vehicleType']).toBe('van');

    // D5 — delivery_task_id is never written on this path, so it is never an audit key either.
    expect('delivery_task_id' in raw).toBe(false);
  });
});

// --- Round-2 review finding 3: invalid logistics terms / terms without expectedAt ---------------

describe('Scenario: ApproveInbound rejects an invalid handoverPoint/transportBy/labourBy or a negative labourCount on its optional slot (migration 0023 CHECKs)', () => {
  const invalidTermCases = [
    { term: 'handoverPoint', patch: { handoverPoint: INVALID_HANDOVER_POINT_2_9B }, error: InvalidHandoverPointError },
    { term: 'transportBy', patch: { transportBy: INVALID_TRANSPORT_BY_2_9B }, error: InvalidTransportByError },
    { term: 'labourBy', patch: { labourBy: INVALID_LABOUR_BY_2_9B }, error: InvalidLabourByError },
    { term: 'labourCount', patch: { labourCount: INVALID_LABOUR_COUNT_2_9B }, error: InvalidLabourCountError },
  ] as const;

  it.each(invalidTermCases)(
    'an invalid $term rejects with its typed error (422) and writes nothing — status still draft, no version bump, no slot column, no event, no audit row',
    async ({ term, patch, error }) => {
      const sku = await insertSku(fixtureClientId, `RECVINB-APPROVESLOT-BAD-${term}-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
      const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
      const correlationId = nextCorrelationId();

      await expect(
        approveInbound(
          roleCtx,
          { orderId, expectedVersion: version, correlationId, expectedAt: SCHEDULE_SLOT_FUTURE_EXPECTED_AT, ...patch },
          deps,
        ),
      ).rejects.toBeInstanceOf(error);

      const after = await getOrder(orderId);
      expect(after.status).toBe('draft');
      expect(after.version).toBe(version);
      const slot = await getScheduleColumns(orderId);
      expect(slot.expected_at).toBeNull();
      expect(slot.scheduled_by).toBeNull();
      expect(slot.handover_point).toBeNull();
      expect(slot.transport_by).toBeNull();
      expect(slot.labour_by).toBeNull();
      expect(slot.labour_count).toBeNull();
      expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_APPROVED_EVENT_TYPE)).toHaveLength(0);
      expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_SCHEDULED_EVENT_TYPE)).toHaveLength(0);
      expect(await auditCountForCorrelation(correlationId)).toBe(0);
    },
  );
});

describe('Scenario: ApproveInbound with a logistics term but NO expectedAt is rejected (round-1 finding 5 default: the slot is one atomic unit)', () => {
  const termsWithoutExpectedAt = [
    { term: 'dockCode', patch: { dockCode: 'D-11' } },
    { term: 'handoverPoint', patch: { handoverPoint: 'client_site' } },
    { term: 'transportBy', patch: { transportBy: 'premium' } },
    { term: 'vehicleType', patch: { vehicleType: 'truck' } },
    { term: 'labourBy', patch: { labourBy: 'premium' } },
    { term: 'labourCount', patch: { labourCount: 2 } },
  ] as const;

  it.each(termsWithoutExpectedAt)(
    'a valid $term without expectedAt rejects with LogisticsTermsRequireExpectedAtError (422) and writes nothing — status still draft, no version bump, no event, no audit row',
    async ({ term, patch }) => {
      const sku = await insertSku(fixtureClientId, `RECVINB-APPROVE-NOANCHOR-${term}-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
      const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
      const correlationId = nextCorrelationId();

      await expect(
        approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId, ...patch }, deps),
      ).rejects.toBeInstanceOf(LogisticsTermsRequireExpectedAtError);

      const after = await getOrder(orderId);
      expect(after.status).toBe('draft');
      expect(after.version).toBe(version);
      const slot = await getScheduleColumns(orderId);
      expect(slot.expected_at).toBeNull();
      expect(slot.dock_code).toBeNull();
      expect(slot.handover_point).toBeNull();
      expect(slot.transport_by).toBeNull();
      expect(slot.vehicle_type).toBeNull();
      expect(slot.labour_by).toBeNull();
      expect(slot.labour_count).toBeNull();
      expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_APPROVED_EVENT_TYPE)).toHaveLength(0);
      expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_SCHEDULED_EVENT_TYPE)).toHaveLength(0);
      expect(await auditCountForCorrelation(correlationId)).toBe(0);
    },
  );
});

describe('Scenario: ApproveInbound WITHOUT expectedAt emits wms.inbound.approved only (regression, D2 — Master ruling on finding 8)', () => {
  it('transitions to "approved" and writes exactly one wms.inbound.approved outbox row and NO wms.inbound.scheduled row', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-APPROVENOSLOT-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const correlationId = nextCorrelationId();

    const approved = await approveInbound(roleCtx, { orderId, expectedVersion: version, correlationId }, deps);
    expect(approved.status).toBe('approved');

    // Master ruling on finding 8: wms.inbound.approved fires on every successful ApproveInbound;
    // wms.inbound.scheduled fires additionally only when expectedAt is present.
    expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_APPROVED_EVENT_TYPE)).toHaveLength(1);
    expect(await outboxRowsForCorrelationAndType(correlationId, INBOUND_SCHEDULED_EVENT_TYPE)).toHaveLength(0);
  });
});

describe('Scenario: CancelInbound without cancelReason is rejected (D3 — now mandatory)', () => {
  it('rejects with CancelReasonRequiredError, a 422, and writes nothing', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-CANCELNOREASON-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);

    await expect(
      cancelInbound(roleCtx, { orderId, expectedVersion: version, correlationId: nextCorrelationId(), cancelReason: '' }, deps),
    ).rejects.toBeInstanceOf(CancelReasonRequiredError);

    const after = await getOrder(orderId);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(version);
  });

  it('the contract schema itself rejects a missing cancelReason before the command runs', () => {
    expect(() =>
      CancelInboundInputSchema.parse({ orderId: randomUUID(), expectedVersion: 1, correlationId: randomUUID() }),
    ).toThrow();
    expect(() =>
      CancelInboundInputSchema.parse({ orderId: randomUUID(), expectedVersion: 1, correlationId: randomUUID(), cancelReason: '' }),
    ).toThrow();
  });
});

describe('Scenario: CancelInbound with cancelReason persists cancel_reason and emits wms.inbound.cancelled (D3)', () => {
  it('persists cancel_reason on the order row and writes exactly one wms.inbound.cancelled outbox row carrying it', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-CANCELREASON-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);
    const correlationId = nextCorrelationId();

    const cancelled = await cancelInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId, cancelReason: CANCEL_REASON_2_9B },
      deps,
    );
    expect(cancelled.status).toBe('cancelled');

    const result: QueryResult<{ cancel_reason: string | null }> = await pool.query(
      `select cancel_reason from wms.inbound_orders where id = $1`,
      [orderId],
    );
    expect(result.rows[0]?.cancel_reason).toBe(CANCEL_REASON_2_9B);

    // Round-1 review finding 9: also assert the wms.inbound.cancelled event payload itself carries
    // cancelReason (brief D3), not only the outbox row's existence.
    const rows = await outboxPayloadsForCorrelationAndType(correlationId, INBOUND_CANCELLED_EVENT_TYPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ orderId, status: 'cancelled', cancelReason: CANCEL_REASON_2_9B });
  });
});

describe('Scenario: cross-entity isolation still holds for the extended commands (RLS regression, D2/D3)', () => {
  it('ApproveInbound with expectedAt still rejects an outsider with OrderNotFoundError, and nothing is scheduled', async () => {
    const sku = await insertSku(fixtureClientId, `RECVINB-RLS-SLOT-${randomUUID()}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM);
    const { orderId, version } = await createDraftInboundOrder(fixtureClientId, [{ skuId: sku, qtyOrdered: QTY_ORDERED }]);

    await expect(
      approveInbound(
        outsiderCtx,
        { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: SCHEDULE_SLOT_FUTURE_EXPECTED_AT },
        deps,
      ),
    ).rejects.toBeInstanceOf(OrderNotFoundError);

    const after = await getOrder(orderId);
    expect(after.status).toBe('draft');
    expect(after.version).toBe(version);
  });
});
