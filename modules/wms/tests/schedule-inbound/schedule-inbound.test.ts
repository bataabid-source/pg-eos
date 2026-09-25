// modules/wms/tests/schedule-inbound/schedule-inbound.test.ts — WBS 2.9b (lane 2).
//
// Integration tests, one per scenario in ./schedule-inbound.feature, against the real database as
// pgeos_app. Sources: docs/notes/slice-briefs/_slice-2.9b.brief.md (Facts/D1-D8, verbatim),
// docs/notes/SCR-WMS-INB-01-receive-inbound-rules.md §7/§8, .claude/briefs/wms.brief.md.
// Migration 0023_2_schedule-inbound.sql is APPLIED (nine new columns + CHECKs exist live) — this
// suite is RED only because the application/domain/infrastructure/api layers under
// modules/wms/{domain,application,infrastructure,api}/schedule-inbound/** do not exist yet.
//
// Expected new surface (RED until pg-backend builds it, brief D1-D8):
//   modules/wms/application/schedule-inbound/index.ts
//     - scheduleInbound(ctx, input, deps) -> { version: number }
//       input: { orderId, expectedVersion, correlationId, expectedAt (ISO datetime string),
//         dockCode?, scheduleNote?, handoverPoint?, transportBy?, vehicleType?, labourBy?,
//         labourCount?, idem? }
//     - listScheduledAppointmentsToday(ctx, { warehouseId }, deps) -> readonly rows, each carrying
//       at least { orderId, expectedAt, vehicleType, labourCount }
//   modules/wms/api/schedule-inbound/composition.ts
//     - createScheduleInboundDeps({ clock, ids }) -> ScheduleInboundDeps
//   modules/wms/domain/schedule-inbound/errors.ts
//     - ScheduleInPastError, InvalidVehicleTypeError, IllegalTransitionError, RoleRequiredError,
//       OrderNotFoundError, StaleVersionError, MissingActorError
//   modules/wms/domain/schedule-inbound/invariants.ts
//     - isFutureTimestamp(candidate: Date, now: Date): boolean
//     - isValidVehicleType(value: string | null | undefined): boolean
//     - isNonEmptyReason(value: string | null | undefined): boolean (reused by
//       ../../application/receive-inbound/cancel-inbound.ts's CancelReasonRequiredError check —
//       recorded default, flagged in the closing report: the brief names no file for this shared
//       predicate, and domain/receive-inbound/invariants.ts is NOT in this slice's Write ONLY list)
//   packages/contracts/wms/schedule-inbound.ts
//     - ScheduleInboundInputSchema
//
// D5 (delivery_task_id NEVER populated this slice) and the audit-masking discipline (brief
// Schema note, pre-migration review finding 1: commercial columns read back through
// platform.sanitize_audit as "•••", the event payload carries the raw values) are both asserted
// directly below.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus real
// identity.users/user_entities/user_roles rows, same as
// modules/wms/tests/receive-inbound/receive-inbound.test.ts (the golden slice). PG_APP_USER=pgeos_app
// is REQUIRED to run this suite (every command call goes through withContext(ctx, fn) as
// pgeos_app, genuinely subject to RLS). platform.audit_log rows are NEVER deleted.

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';
import { IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';

// The modules under test — do not exist yet (RED).
import { scheduleInbound, listScheduledAppointmentsToday } from '../../application/schedule-inbound/index.js';
import { createScheduleInboundDeps } from '../../api/schedule-inbound/composition.js';
import {
  IllegalTransitionError,
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
  OrderNotFoundError,
  RoleRequiredError,
  ScheduleInPastError,
  StaleVersionError,
} from '../../domain/schedule-inbound/errors.js';
import { ScheduleInboundInputSchema } from '@pg-eos/contracts/wms/schedule-inbound';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

const appPool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PG_APP_USER'] ?? 'pgeos_app',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

// --- literals, each cited to the schema fact, decision or brief line they come from -------------

const WH_MGR_ROLE_CODE = 'WH_MGR';
const WH_SUP_ROLE_CODE = 'WH_SUP';
const QTY_ORDERED = '10.000';
const SAFE_SKU_GROSS_WEIGHT_KG = '1.000';
const SAFE_SKU_VOLUME_CBM = '0.00100';
const SCHEDULED_EVENT_TYPE = 'wms.inbound.scheduled'; // brief Facts — live in
// packages/events/catalog.ts (added by the Master, commit 5644b5c); kept as the raw string here
// because it is queried straight off platform.outbox.event_type.

// migration 0023 CHECK chk_inbound_orders_vehicle_type.
const VALID_VEHICLE_TYPES = ['container_20', 'container_40', 'truck', 'trailer', 'van', 'pickup', 'other'] as const;
const INVALID_VEHICLE_TYPE = 'motorcycle'; // not in the closed list.
const VALID_HANDOVER_POINT = 'client_site'; // migration 0023 CHECK chk_inbound_orders_handover_point.
const VALID_TRANSPORT_BY = 'premium'; // migration 0023 CHECK chk_inbound_orders_transport_by.
const VALID_LABOUR_BY = 'premium'; // migration 0023 CHECK chk_inbound_orders_labour_by.
const VALID_LABOUR_COUNT = 3;
// migration 0023: dock_code is free text (no docks table, no CHECK) — same literal as the
// ScheduleInboundInputSchema contract test below.
const VALID_DOCK_CODE = 'D-01';
// Round-2 review finding 3: one value OUTSIDE each migration 0023 CHECK. 'shared' is a legal
// labour_by value but NOT a legal transport_by value (chk_inbound_orders_transport_by lists only
// client/premium) — a deliberate cross-list near-miss. labour_count's CHECK is `>= 0`, so -1 is
// the first illegal value.
const INVALID_HANDOVER_POINT = 'airport';
const INVALID_TRANSPORT_BY = 'shared';
const INVALID_LABOUR_BY = 'contractor';
const INVALID_LABOUR_COUNT = -1;

const WH_MGR_ACTOR_UUID = '00000000-0000-4000-8000-0000000209b1';
const NO_ROLE_ACTOR_UUID = '00000000-0000-4000-8000-0000000209b2';
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000209b3'; // RLS: no user_entities row for this order's entity.
// pg-reviewer round-3 finding 5: WH_MGR_ACTOR_UUID above holds BOTH WH_MGR and WH_SUP — nothing
// proves a WH_SUP-ONLY caller can call ScheduleInbound (D1: legal for WH_MGR OR WH_SUP). Same
// fixture pattern as tests/count-inventory/count-inventory.test.ts:437 /
// tests/take-occupancy-snapshot/take-occupancy-snapshot.test.ts:423.
const WH_SUP_ONLY_ACTOR_UUID = '00000000-0000-4000-8000-0000000209b4';

// The injected clock's own "now" — every "future"/"past" expectedAt in this suite is derived from
// it, never from `new Date()` directly (CLAUDE.md: no Math.random()/new Date() in domain/; this
// suite only uses `new Date()` to compute TEST FIXTURE literals relative to CLOCK_NOW, exactly the
// convention modules/wms/tests/manage-space/manage-space.test.ts's own `daysFrom` helper uses).
const CLOCK_NOW = new Date('2026-09-25T00:00:00.000Z');
const FUTURE_EXPECTED_AT = new Date(CLOCK_NOW.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString(); // +6 days.
const FURTHER_FUTURE_EXPECTED_AT = new Date(CLOCK_NOW.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(); // +10 days (reschedule).
const PAST_EXPECTED_AT = new Date(CLOCK_NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(); // -1 day.

const clock = new FixedClock(CLOCK_NOW);
const ids = new SequentialIdGenerator(2091);
const deps = createScheduleInboundDeps({ clock, ids });

const roleCtx = { userId: WH_MGR_ACTOR_UUID, clientId: null, isInternal: true };
const noRoleCtx = { userId: NO_ROLE_ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: true };
const whSupOnlyCtx = { userId: WH_SUP_ONLY_ACTOR_UUID, clientId: null, isInternal: true };

let entityId: string;
let warehouseId: string;
let fixtureClientId: string;

const fixtureClientCode = `_schedinb_fixture_${randomUUID()}`;
const fixtureSkuIds: string[] = [];
const fixtureOrderIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

/** sha256 hex of the canonical JSON body, the endpoint 'wms.schedule-inbound.<command>',
 *  successStatus 200 — same shape as receive-inbound.test.ts's own idemFor. */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `wms.schedule-inbound.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function insertSku(clientId: string, code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.skus (client_id, code, name_ar, gross_weight_kg, volume_cbm)
     values ($1, $2, $3, $4::numeric, $5::numeric) returning id`,
    [clientId, code, `صنف اختبار الجدولة ${code}`, SAFE_SKU_GROSS_WEIGHT_KG, SAFE_SKU_VOLUME_CBM],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture wms.skus insert returned no row');
  fixtureSkuIds.push(row.id);
  return row.id;
}

async function createInboundOrder(
  clientId: string,
  status: 'draft' | 'approved' | 'cancelled',
): Promise<{ orderId: string; version: number }> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(
    `select platform.next_doc_no($1, 'INB') as doc_no`,
    [entityId],
  );
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error('platform.next_doc_no returned no row for INB');

  const skuId = await insertSku(clientId, `SCHEDINB-${randomUUID()}`);

  const orderResult: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id, status)
     values ($1, $2, $3, $4, $5) returning id, version`,
    [entityId, docNo, clientId, warehouseId, status],
  );
  const orderRow = orderResult.rows[0];
  if (!orderRow) throw new Error('fixture wms.inbound_orders insert returned no row');
  fixtureOrderIds.push(orderRow.id);

  await pool.query(
    `insert into wms.order_lines (order_table, order_id, line_no, sku_id, qty_ordered, uom)
     values ('wms.inbound_orders', $1, 1, $2, $3::numeric, 'EA')`,
    [orderRow.id, skuId, QTY_ORDERED],
  );

  return { orderId: orderRow.id, version: orderRow.version };
}

async function getOrder(orderId: string): Promise<{
  status: string;
  version: number;
  expected_at: Date | null;
  scheduled_by: string | null;
  scheduled_at: Date | null;
  dock_code: string | null;
  handover_point: string | null;
  transport_by: string | null;
  vehicle_type: string | null;
  labour_by: string | null;
  labour_count: number | null;
  delivery_task_id: string | null;
  cancel_reason: string | null;
}> {
  const result = await pool.query(
    `select status, version, expected_at, scheduled_by, scheduled_at, dock_code, handover_point,
            transport_by, vehicle_type, labour_by, labour_count, delivery_task_id, cancel_reason
       from wms.inbound_orders where id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no wms.inbound_orders row for id ${orderId}`);
  return row;
}

/** Exact-count outbox assertion — never `.some`/`> 0`. Raw event_type string matched against
 *  platform.outbox.event_type (the wms.inbound.* names are live in packages/events/catalog.ts
 *  since commit 5644b5c). */
async function outboxRowsForCorrelationAndType(
  correlationId: string,
  eventType: string,
): Promise<Array<{ id: string; payload: unknown }>> {
  const result: QueryResult<{ id: string; payload: unknown }> = await pool.query(
    `select id::text as id, payload from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

async function auditRowsForCorrelation(
  correlationId: string,
): Promise<Array<{ new_value: Record<string, unknown> }>> {
  const result: QueryResult<{ new_value: Record<string, unknown> }> = await pool.query(
    `select new_value from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return result.rows;
}

/** The audit row's newValue read back THROUGH platform.sanitize_audit — the function is applied
 *  at read time (the golden-slice writeAuditRow stores the raw newValue, unsanitized — confirmed by
 *  reading modules/wms/infrastructure/receive-inbound/repository.ts's own writeAuditRow), so the
 *  masking this brief's pre-migration review finding 1 requires is only observable THIS way, never
 *  by reading platform.audit_log.new_value directly. Requires the audit newValue's JSON keys to be
 *  the DB's own SNAKE_CASE column names (handover_point, not handoverPoint) — sanitize_audit joins
 *  identity.column_classification on column_name verbatim; a camelCase key silently fails to mask
 *  (flagged in the closing report as a build-time gotcha for pg-backend). */
async function sanitizedAuditNewValue(correlationId: string): Promise<Record<string, unknown>> {
  const result: QueryResult<{ sanitized: Record<string, unknown> }> = await pool.query(
    `select platform.sanitize_audit(schema_name, table_name, new_value) as sanitized
       from platform.audit_log where correlation_id = $1 limit 1`,
    [correlationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no platform.audit_log row for correlation_id ${correlationId}`);
  return row.sanitized;
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
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_schedinb_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار جدولة الوارد — WBS 2.9b'],
  );
  for (const eid of entityIds) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
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

  await createFixtureActor(WH_MGR_ACTOR_UUID, []);
  await createFixtureActor(NO_ROLE_ACTOR_UUID, []);
  await createFixtureActor(OUTSIDER_ACTOR_UUID, []);
  await createFixtureActor(WH_SUP_ONLY_ACTOR_UUID, []);
  const allEntitiesResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  const allEntityIds = allEntitiesResult.rows.map((row) => row.id);
  for (const userId of [WH_MGR_ACTOR_UUID, NO_ROLE_ACTOR_UUID, WH_SUP_ONLY_ACTOR_UUID]) {
    for (const eid of allEntityIds) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [userId, eid]);
    }
  }
  for (const eid of allEntityIds) {
    if (eid !== entityId) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
        OUTSIDER_ACTOR_UUID,
        eid,
      ]);
    }
  }

  await grantRole(WH_MGR_ACTOR_UUID, WH_MGR_ROLE_CODE);
  await grantRole(WH_MGR_ACTOR_UUID, WH_SUP_ROLE_CODE);
  await grantRole(WH_SUP_ONLY_ACTOR_UUID, WH_SUP_ROLE_CODE); // finding 5 — WH_SUP only, no WH_MGR.

  const clientResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [fixtureClientCode, 'عميل اختبار جدولة الوارد'],
  );
  fixtureClientId = (clientResult.rows[0] as { id: string }).id;
});

afterAll(async () => {
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [[...usedCorrelationIds]]);
  }
  if (fixtureOrderIds.length > 0) {
    await pool.query(`delete from wms.order_lines where order_id = any($1::uuid[])`, [fixtureOrderIds]);
    await pool.query(`delete from wms.inbound_orders where id = any($1::uuid[])`, [fixtureOrderIds]);
  }
  if (fixtureSkuIds.length > 0) await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  if (fixtureClientId) await pool.query(`delete from sales.accounts where id = $1`, [fixtureClientId]);
  for (const userId of [WH_MGR_ACTOR_UUID, NO_ROLE_ACTOR_UUID, OUTSIDER_ACTOR_UUID, WH_SUP_ONLY_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
  await appPool.end();
});

// --- contract stub -------------------------------------------------------------------------

describe('@pg-eos/contracts/wms/schedule-inbound — ScheduleInboundInputSchema', () => {
  it('accepts { orderId, expectedVersion, correlationId, expectedAt } with the optional logistics terms and no performedBy field', () => {
    const parsed = ScheduleInboundInputSchema.parse({
      orderId: randomUUID(),
      expectedVersion: 1,
      correlationId: randomUUID(),
      expectedAt: FUTURE_EXPECTED_AT,
      dockCode: 'D-01',
      scheduleNote: 'gate 3',
      handoverPoint: VALID_HANDOVER_POINT,
      transportBy: VALID_TRANSPORT_BY,
      vehicleType: 'truck',
      labourBy: VALID_LABOUR_BY,
      labourCount: VALID_LABOUR_COUNT,
    });
    expect(parsed.expectedAt).toBe(FUTURE_EXPECTED_AT);
    expect('performedBy' in parsed).toBe(false);
  });

  it('accepts a minimal input with only expectedAt (every logistics term optional, D6)', () => {
    const parsed = ScheduleInboundInputSchema.parse({
      orderId: randomUUID(),
      expectedVersion: 1,
      correlationId: randomUUID(),
      expectedAt: FUTURE_EXPECTED_AT,
    });
    expect(parsed.orderId).toBeDefined();
  });
});

// --- Scenario: happy path — future expectedAt on a draft order -------------------------------

describe('Scenario: ScheduleInbound with a future expectedAt on a draft order', () => {
  it('sets expected_at/scheduled_by/scheduled_at, bumps version, and writes one wms.inbound.scheduled outbox row + one audit row, same correlationId', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
    const correlationId = nextCorrelationId();

    const result = await scheduleInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId, expectedAt: FUTURE_EXPECTED_AT, dockCode: VALID_DOCK_CODE },
      deps,
    );
    expect(result.version).toBeGreaterThan(version);

    const after = await getOrder(orderId);
    expect(after.expected_at?.toISOString()).toBe(FUTURE_EXPECTED_AT);
    expect(after.scheduled_by).toBe(WH_MGR_ACTOR_UUID);
    expect(after.scheduled_at).not.toBeNull();
    expect(after.version).toBe(result.version);
    expect(after.status).toBe('draft'); // D1 — self-transition, no status change.
    // Round-4 review finding 2: dock_code is persisted on the stored column.
    expect(after.dock_code).toBe(VALID_DOCK_CODE);

    const outboxRows = await outboxRowsForCorrelationAndType(correlationId, SCHEDULED_EVENT_TYPE);
    expect(outboxRows).toHaveLength(1);
    expect((outboxRows[0]?.payload as Record<string, unknown>)['dockCode']).toBe(VALID_DOCK_CODE);

    const auditRows = await auditRowsForCorrelation(correlationId);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.new_value['dockCode']).toBe(VALID_DOCK_CODE);
    // dock_code is classified `public` (migration 0023) — sanitize_audit leaves the value readable.
    expect((await sanitizedAuditNewValue(correlationId))['dockCode']).toBe(VALID_DOCK_CODE);
  });
});

// --- Scenario: past expectedAt is rejected ----------------------------------------------------

describe('Scenario: ScheduleInbound with a past expectedAt is rejected', () => {
  it('rejects with ScheduleInPastError and writes nothing', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    await expect(
      scheduleInbound(
        roleCtx,
        { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: PAST_EXPECTED_AT },
        deps,
      ),
    ).rejects.toBeInstanceOf(ScheduleInPastError);

    const after = await getOrder(orderId);
    expect(after.expected_at).toBeNull();
    expect(after.scheduled_by).toBeNull();
    expect(after.version).toBe(version);
  });
});

// --- Scenario: rescheduling ---------------------------------------------------------------------

describe('Scenario: rescheduling — calling ScheduleInbound again bumps version and writes a SECOND event', () => {
  it('the second call updates expected_at/scheduled_at and writes its own wms.inbound.scheduled row', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
    const firstCorrelationId = nextCorrelationId();
    const first = await scheduleInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId: firstCorrelationId, expectedAt: FUTURE_EXPECTED_AT },
      deps,
    );

    const secondCorrelationId = nextCorrelationId();
    const second = await scheduleInbound(
      roleCtx,
      {
        orderId,
        expectedVersion: first.version,
        correlationId: secondCorrelationId,
        expectedAt: FURTHER_FUTURE_EXPECTED_AT,
      },
      deps,
    );
    expect(second.version).toBeGreaterThan(first.version);

    const after = await getOrder(orderId);
    expect(after.expected_at?.toISOString()).toBe(FURTHER_FUTURE_EXPECTED_AT);

    expect(await outboxRowsForCorrelationAndType(firstCorrelationId, SCHEDULED_EVENT_TYPE)).toHaveLength(1);
    expect(await outboxRowsForCorrelationAndType(secondCorrelationId, SCHEDULED_EVENT_TYPE)).toHaveLength(1);
  });
});

// --- Scenario: pg-reviewer round-3 finding 2 — reschedule omitting a term keeps the coalesced value

describe('Scenario: rescheduling that OMITS a logistics term keeps the previously-stored (coalesced) value, in both the event payload and the audit newValue', () => {
  it('a second ScheduleInbound call that only changes expectedAt leaves dockCode/handoverPoint/transportBy/vehicleType/labourBy/labourCount at their FIRST-call values, not null, in both the wms.inbound.scheduled event payload and the audit row newValue', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    const first = await scheduleInbound(
      roleCtx,
      {
        orderId,
        expectedVersion: version,
        correlationId: nextCorrelationId(),
        expectedAt: FUTURE_EXPECTED_AT,
        dockCode: VALID_DOCK_CODE,
        handoverPoint: VALID_HANDOVER_POINT,
        transportBy: VALID_TRANSPORT_BY,
        vehicleType: 'truck',
        labourBy: VALID_LABOUR_BY,
        labourCount: VALID_LABOUR_COUNT,
      },
      deps,
    );

    // Second call: only expectedAt changes — every logistics term is OMITTED from the input, not
    // explicitly re-supplied. A regression that nulled the omitted term (instead of coalescing
    // against the previously-stored value) would pass every other test in this suite.
    const secondCorrelationId = nextCorrelationId();
    const second = await scheduleInbound(
      roleCtx,
      {
        orderId,
        expectedVersion: first.version,
        correlationId: secondCorrelationId,
        expectedAt: FURTHER_FUTURE_EXPECTED_AT,
      },
      deps,
    );
    expect(second.version).toBeGreaterThan(first.version);

    const after = await getOrder(orderId);
    expect(after.expected_at?.toISOString()).toBe(FURTHER_FUTURE_EXPECTED_AT);
    // The columns themselves keep the FIRST call's values (coalesced), never nulled by the omission.
    expect(after.dock_code).toBe(VALID_DOCK_CODE);
    expect(after.handover_point).toBe(VALID_HANDOVER_POINT);
    expect(after.transport_by).toBe(VALID_TRANSPORT_BY);
    expect(after.vehicle_type).toBe('truck');
    expect(after.labour_by).toBe(VALID_LABOUR_BY);
    expect(after.labour_count).toBe(VALID_LABOUR_COUNT);

    const outboxRows = await outboxRowsForCorrelationAndType(secondCorrelationId, SCHEDULED_EVENT_TYPE);
    expect(outboxRows).toHaveLength(1);
    const payload = outboxRows[0]?.payload as Record<string, unknown>;
    expect(payload['dockCode']).toBe(VALID_DOCK_CODE);
    expect(payload['handoverPoint']).toBe(VALID_HANDOVER_POINT);
    expect(payload['transportBy']).toBe(VALID_TRANSPORT_BY);
    expect(payload['vehicleType']).toBe('truck');
    expect(payload['labourBy']).toBe(VALID_LABOUR_BY);
    expect(payload['labourCount']).toBe(VALID_LABOUR_COUNT);

    const sanitized = await sanitizedAuditNewValue(secondCorrelationId);
    // commercial columns masked at read time (same discipline as every other audit assertion in
    // this suite). This proves only that the KEY is present: sanitize_audit masks a classified key
    // whatever its value, `null` included, so the mask alone cannot tell a value from a null.
    expect(sanitized['handover_point']).toBe('•••');
    expect(sanitized['transport_by']).toBe('•••');
    expect(sanitized['labour_by']).toBe('•••');
    expect(sanitized['labour_count']).toBe('•••');

    // The raw (unmasked) newValue is what actually proves "not null" — sanitize_audit replaces a
    // real value AND `null` alike with "•••" for a classified key, so only the raw newValue carries
    // the null-vs-value distinction.
    const rawAuditRows = await auditRowsForCorrelation(secondCorrelationId);
    expect(rawAuditRows).toHaveLength(1);
    const rawNewValue = rawAuditRows[0]?.new_value as Record<string, unknown>;
    // Round-4 review finding 1: the audit row records the stored (coalesced) public terms too.
    expect(rawNewValue['dockCode']).toBe(VALID_DOCK_CODE);
    expect(rawNewValue['vehicleType']).toBe('truck');
    expect(rawNewValue['handover_point']).toBe(VALID_HANDOVER_POINT);
    expect(rawNewValue['transport_by']).toBe(VALID_TRANSPORT_BY);
    expect(rawNewValue['labour_by']).toBe(VALID_LABOUR_BY);
    expect(rawNewValue['labour_count']).toBe(VALID_LABOUR_COUNT);
  });
});

// --- Scenario: legal on an approved order too (self-transition, D1) -----------------------------

describe('Scenario: ScheduleInbound is also legal on an "approved" order (self-transition)', () => {
  it('succeeds and leaves the status "approved"', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'approved');

    const result = await scheduleInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT },
      deps,
    );

    const after = await getOrder(orderId);
    expect(after.status).toBe('approved');
    expect(after.version).toBe(result.version);
  });
});

// --- Scenario: illegal once the order has left draft/approved -----------------------------------

describe('Scenario: ScheduleInbound is illegal on a cancelled order', () => {
  it('rejects with IllegalTransitionError and writes nothing', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'cancelled');

    await expect(
      scheduleInbound(
        roleCtx,
        { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT },
        deps,
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const after = await getOrder(orderId);
    expect(after.expected_at).toBeNull();
    expect(after.version).toBe(version);
  });
});

// --- Scenario: logistics terms persisted; delivery_task_id NEVER auto-populated (D5) ------------

describe('Scenario: the four logistics terms are written, and delivery_task_id is never auto-populated (D5)', () => {
  it('persists handover_point/transport_by/vehicle_type/labour_by/labour_count exactly as supplied, leaving delivery_task_id null even for transportBy=premium + handoverPoint=client_site', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    await scheduleInbound(
      roleCtx,
      {
        orderId,
        expectedVersion: version,
        correlationId: nextCorrelationId(),
        expectedAt: FUTURE_EXPECTED_AT,
        handoverPoint: VALID_HANDOVER_POINT, // 'client_site'
        transportBy: VALID_TRANSPORT_BY, // 'premium'
        vehicleType: 'truck',
        labourBy: VALID_LABOUR_BY,
        labourCount: VALID_LABOUR_COUNT,
      },
      deps,
    );

    const after = await getOrder(orderId);
    expect(after.handover_point).toBe(VALID_HANDOVER_POINT);
    expect(after.transport_by).toBe(VALID_TRANSPORT_BY);
    expect(after.vehicle_type).toBe('truck');
    expect(after.labour_by).toBe(VALID_LABOUR_BY);
    expect(after.labour_count).toBe(VALID_LABOUR_COUNT);
    // D5 — the one scenario proving no tms.delivery_tasks row is ever created/linked this slice.
    expect(after.delivery_task_id).toBeNull();
  });
});

// --- Scenario: vehicle_type outside the closed list -----------------------------------------------

describe('Scenario: vehicle_type outside the closed list is rejected', () => {
  it('rejects with InvalidVehicleTypeError and writes nothing', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    await expect(
      scheduleInbound(
        roleCtx,
        {
          orderId,
          expectedVersion: version,
          correlationId: nextCorrelationId(),
          expectedAt: FUTURE_EXPECTED_AT,
          vehicleType: INVALID_VEHICLE_TYPE,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidVehicleTypeError);

    const after = await getOrder(orderId);
    expect(after.vehicle_type).toBeNull();
    expect(after.version).toBe(version);
  });

  it.each(VALID_VEHICLE_TYPES)('accepts the closed-list value %s', async (vehicleType) => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    const result = await scheduleInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT, vehicleType },
      deps,
    );
    expect(result.version).toBeGreaterThan(version);
    expect((await getOrder(orderId)).vehicle_type).toBe(vehicleType);
  });
});

// --- Scenario: the other three closed-list terms and labour_count >= 0 (round-2 finding 3) -----

describe('Scenario: an invalid handoverPoint/transportBy/labourBy or a negative labourCount is rejected (migration 0023 CHECKs, dual enforcement)', () => {
  const invalidTermCases = [
    { term: 'handoverPoint', patch: { handoverPoint: INVALID_HANDOVER_POINT }, error: InvalidHandoverPointError },
    { term: 'transportBy', patch: { transportBy: INVALID_TRANSPORT_BY }, error: InvalidTransportByError },
    { term: 'labourBy', patch: { labourBy: INVALID_LABOUR_BY }, error: InvalidLabourByError },
    { term: 'labourCount', patch: { labourCount: INVALID_LABOUR_COUNT }, error: InvalidLabourCountError },
  ] as const;

  it.each(invalidTermCases)(
    'an invalid $term rejects with its typed error (422) and writes nothing — no column, no version bump, no outbox row, no audit row',
    async ({ patch, error }) => {
      const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
      const correlationId = nextCorrelationId();

      await expect(
        scheduleInbound(
          roleCtx,
          { orderId, expectedVersion: version, correlationId, expectedAt: FUTURE_EXPECTED_AT, ...patch },
          deps,
        ),
      ).rejects.toBeInstanceOf(error);

      const after = await getOrder(orderId);
      expect(after.version).toBe(version);
      expect(after.expected_at).toBeNull();
      expect(after.scheduled_by).toBeNull();
      expect(after.scheduled_at).toBeNull();
      expect(after.handover_point).toBeNull();
      expect(after.transport_by).toBeNull();
      expect(after.labour_by).toBeNull();
      expect(after.labour_count).toBeNull();
      expect(await outboxRowsForCorrelationAndType(correlationId, SCHEDULED_EVENT_TYPE)).toHaveLength(0);
      expect(await auditRowsForCorrelation(correlationId)).toHaveLength(0);
    },
  );

  it('labourCount = 0 is the legal boundary (labour_count >= 0) and is persisted as 0, not null', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    const result = await scheduleInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT, labourCount: 0 },
      deps,
    );
    expect(result.version).toBeGreaterThan(version);
    expect((await getOrder(orderId)).labour_count).toBe(0);
  });
});

// --- Scenario: scheduleNote has no column — audit row + event payload only ---------------------

describe('Scenario: scheduleNote has no column — it reaches only the audit row and the event payload', () => {
  it('no wms.inbound_orders column stores it, but the audit newValue and event payload both carry it', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
    const correlationId = nextCorrelationId();
    const SCHEDULE_NOTE = 'client asked for gate 3, morning slot';

    await scheduleInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId, expectedAt: FUTURE_EXPECTED_AT, scheduleNote: SCHEDULE_NOTE },
      deps,
    );

    // No column named schedule_note exists (migration 0023 comment, brief Schema section) — a
    // SELECT * style assertion isn't meaningful here; the absence is structural (the migration
    // itself never adds the column), so this test asserts the two places it DOES reach instead.
    const auditRows = await auditRowsForCorrelation(correlationId);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.new_value['scheduleNote']).toBe(SCHEDULE_NOTE);

    const outboxRows = await outboxRowsForCorrelationAndType(correlationId, SCHEDULED_EVENT_TYPE);
    expect(outboxRows).toHaveLength(1);
    expect((outboxRows[0]?.payload as Record<string, unknown>)['scheduleNote']).toBe(SCHEDULE_NOTE);
  });
});

// --- Scenario: commercial columns masked in the audit row, unmasked in the event payload --------

describe('Scenario: commercial-classified logistics-term columns are masked in the audit row (pre-migration review finding 1)', () => {
  it('platform.sanitize_audit masks handover_point/transport_by/labour_by/labour_count to "•••"; delivery_task_id is never even a key in the audit newValue (D5, never populated); the event payload stays unmasked', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
    const correlationId = nextCorrelationId();

    await scheduleInbound(
      roleCtx,
      {
        orderId,
        expectedVersion: version,
        correlationId,
        expectedAt: FUTURE_EXPECTED_AT,
        handoverPoint: VALID_HANDOVER_POINT,
        transportBy: VALID_TRANSPORT_BY,
        vehicleType: 'truck',
        labourBy: VALID_LABOUR_BY,
        labourCount: VALID_LABOUR_COUNT,
      },
      deps,
    );

    const sanitized = await sanitizedAuditNewValue(correlationId);
    // sanitize_audit keys against identity.column_classification.column_name — the SNAKE_CASE DB
    // column name, not a camelCase JS field. The audit newValue this command writes MUST therefore
    // use snake_case keys for these four columns (a build-time requirement, flagged in the closing
    // report — every OTHER command in this repo's audit newValue uses camelCase field names that
    // happen to equal their snake_case column name, e.g. "status"/"version", so this is a genuinely
    // new constraint this slice introduces).
    expect(sanitized['handover_point']).toBe('•••');
    expect(sanitized['transport_by']).toBe('•••');
    expect(sanitized['labour_by']).toBe('•••');
    expect(sanitized['labour_count']).toBe('•••');
    // delivery_task_id is never written to the audit newValue at all (D5 — the column is never
    // populated by this command, so writeAuditRow's own newValue object never carries the key) —
    // a genuine assertion of the absence, not a masked-value claim this scenario cannot support.
    expect('delivery_task_id' in sanitized).toBe(false);

    const outboxRows = await outboxRowsForCorrelationAndType(correlationId, SCHEDULED_EVENT_TYPE);
    expect(outboxRows).toHaveLength(1);
    const payload = outboxRows[0]?.payload as Record<string, unknown>;
    expect(payload['handoverPoint']).toBe(VALID_HANDOVER_POINT);
    expect(payload['transportBy']).toBe(VALID_TRANSPORT_BY);
    expect(payload['labourBy']).toBe(VALID_LABOUR_BY);
    expect(payload['labourCount']).toBe(VALID_LABOUR_COUNT);
  });
});

// --- Scenario: idempotency ------------------------------------------------------------------------

describe('Scenario: ScheduleInbound is idempotent — same Idempotency-Key + body replays the stored result', () => {
  it('the second call returns the stored result, version bumps exactly once, one outbox row exists', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
    const idemKey = `schedule-replay-${randomUUID()}`;
    const correlationId = nextCorrelationId();
    const body = { orderId, expectedVersion: version, correlationId, expectedAt: FUTURE_EXPECTED_AT };

    const first = await scheduleInbound(roleCtx, { ...body, idem: idemFor('schedule', idemKey, body) }, deps);
    const afterFirst = await getOrder(orderId);

    const second = await scheduleInbound(roleCtx, { ...body, idem: idemFor('schedule', idemKey, body) }, deps);
    expect(second).toEqual(first);

    const afterSecond = await getOrder(orderId);
    expect(afterSecond.version).toBe(afterFirst.version); // bumped exactly once.
    expect(await outboxRowsForCorrelationAndType(correlationId, SCHEDULED_EVENT_TYPE)).toHaveLength(1);
  });

  it('the same idem key with a DIFFERENT body is rejected with IdempotencyConflictError', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
    const idemKey = `schedule-mismatch-${randomUUID()}`;
    const firstBody = { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT };
    await scheduleInbound(roleCtx, { ...firstBody, idem: idemFor('schedule', idemKey, firstBody) }, deps);

    const differentBody = { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FURTHER_FUTURE_EXPECTED_AT };
    await expect(
      scheduleInbound(roleCtx, { ...differentBody, idem: idemFor('schedule', idemKey, differentBody) }, deps),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

// --- Scenario: stale version -------------------------------------------------------------------

describe('Scenario: a stale expectedVersion on ScheduleInbound is rejected', () => {
  it('rejects with StaleVersionError and leaves the order unchanged', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    await expect(
      scheduleInbound(
        roleCtx,
        { orderId, expectedVersion: version + 1, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT },
        deps,
      ),
    ).rejects.toBeInstanceOf(StaleVersionError);

    const after = await getOrder(orderId);
    expect(after.expected_at).toBeNull();
    expect(after.version).toBe(version);
  });
});

// --- Scenario: role gate ---------------------------------------------------------------------

describe('Scenario: ScheduleInbound without role WH_MGR/WH_SUP is rejected', () => {
  it('rejects with RoleRequiredError and writes nothing', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    await expect(
      scheduleInbound(
        noRoleCtx,
        { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT },
        deps,
      ),
    ).rejects.toBeInstanceOf(RoleRequiredError);

    const after = await getOrder(orderId);
    expect(after.expected_at).toBeNull();
    expect(after.version).toBe(version);
  });
});

// --- Scenario: WH_SUP-only caller (pg-reviewer round-3 finding 5) ------------------------------

describe('Scenario: ScheduleInbound succeeds for a caller holding ONLY the WH_SUP role (D1: legal for WH_MGR OR WH_SUP)', () => {
  it('a caller with WH_SUP and no WH_MGR role succeeds', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

    const result = await scheduleInbound(
      whSupOnlyCtx,
      { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT },
      deps,
    );
    expect(result.version).toBeGreaterThan(version);

    const after = await getOrder(orderId);
    expect(after.scheduled_by).toBe(WH_SUP_ONLY_ACTOR_UUID);
    expect(after.version).toBe(result.version);
  });
});

// --- Scenario: RLS — cross-entity isolation ---------------------------------------------------

describe('Scenario: RLS — an outsider cannot schedule an order outside their entity', () => {
  it('rejects with OrderNotFoundError (same convention as a missing order) and leaves the order unchanged', async () => {
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');

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

    await expect(
      scheduleInbound(
        outsiderCtx,
        { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: FUTURE_EXPECTED_AT },
        deps,
      ),
    ).rejects.toBeInstanceOf(OrderNotFoundError);

    const after = await getOrder(orderId);
    expect(after.expected_at).toBeNull();
    expect(after.version).toBe(version);
  });
});

// --- Scenario: listScheduledAppointmentsToday ---------------------------------------------------

describe('Scenario: listScheduledAppointmentsToday returns today\'s appointments ordered by expected_at, excludes orders with no appointment', () => {
  it('returns only orders scheduled for CLOCK_NOW\'s own date, ordered ascending, each carrying vehicleType/labourCount; an approved order with expected_at still null is excluded', async () => {
    const todayLater = new Date(CLOCK_NOW.getTime() + 6 * 60 * 60 * 1000).toISOString(); // same day, +6h.
    const todayEarlier = new Date(CLOCK_NOW.getTime() + 2 * 60 * 60 * 1000).toISOString(); // same day, +2h.
    const tomorrow = new Date(CLOCK_NOW.getTime() + 26 * 60 * 60 * 1000).toISOString(); // next day.

    const orderLater = await createInboundOrder(fixtureClientId, 'draft');
    await scheduleInbound(
      roleCtx,
      { orderId: orderLater.orderId, expectedVersion: orderLater.version, correlationId: nextCorrelationId(), expectedAt: todayLater, vehicleType: 'van', labourCount: 2 },
      deps,
    );

    const orderEarlier = await createInboundOrder(fixtureClientId, 'draft');
    await scheduleInbound(
      roleCtx,
      { orderId: orderEarlier.orderId, expectedVersion: orderEarlier.version, correlationId: nextCorrelationId(), expectedAt: todayEarlier, vehicleType: 'truck', labourCount: 4 },
      deps,
    );

    const orderTomorrow = await createInboundOrder(fixtureClientId, 'draft');
    await scheduleInbound(
      roleCtx,
      { orderId: orderTomorrow.orderId, expectedVersion: orderTomorrow.version, correlationId: nextCorrelationId(), expectedAt: tomorrow },
      deps,
    );

    // approved, never scheduled — expected_at stays null ("بلا موعد").
    const { orderId: noAppointmentOrderId } = await createInboundOrder(fixtureClientId, 'approved');

    const rows = await listScheduledAppointmentsToday(roleCtx, { warehouseId }, deps);
    const ids = rows.map((r) => r.orderId);

    expect(ids).toContain(orderEarlier.orderId);
    expect(ids).toContain(orderLater.orderId);
    expect(ids).not.toContain(orderTomorrow.orderId);
    // pg-reviewer round-3 finding 1: the approved-with-no-appointment order was created above but
    // never actually asserted excluded — assert it here.
    expect(ids).not.toContain(noAppointmentOrderId);
    expect(ids.indexOf(orderEarlier.orderId)).toBeLessThan(ids.indexOf(orderLater.orderId));

    const earlierRow = rows.find((r) => r.orderId === orderEarlier.orderId);
    expect(earlierRow?.vehicleType).toBe('truck');
    expect(earlierRow?.labourCount).toBe(4);
  });

  // pg-reviewer round-3 finding 1: D10's status filter has no test at all — cancelled/closed
  // orders are excluded from the board even if expected_at falls today.
  it('excludes an order whose status is cancelled even though its expected_at falls today (D10)', async () => {
    const todaySlot = new Date(CLOCK_NOW.getTime() + 3 * 60 * 60 * 1000).toISOString(); // same day, +3h.
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
    await scheduleInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: todaySlot },
      deps,
    );
    // Direct fixture-style status mutation (same convention as createInboundOrder's own direct
    // INSERT) — CancelInbound itself belongs to receive-inbound, out of this suite's scope; only
    // the resulting terminal status matters for D10's exclusion rule.
    await pool.query(`update wms.inbound_orders set status = 'cancelled' where id = $1`, [orderId]);

    const rows = await listScheduledAppointmentsToday(roleCtx, { warehouseId }, deps);
    expect(rows.map((r) => r.orderId)).not.toContain(orderId);
  });

  it('excludes an order whose status is closed even though its expected_at falls today (D10)', async () => {
    const todaySlot = new Date(CLOCK_NOW.getTime() + 4 * 60 * 60 * 1000).toISOString(); // same day, +4h.
    const { orderId, version } = await createInboundOrder(fixtureClientId, 'draft');
    await scheduleInbound(
      roleCtx,
      { orderId, expectedVersion: version, correlationId: nextCorrelationId(), expectedAt: todaySlot },
      deps,
    );
    await pool.query(`update wms.inbound_orders set status = 'closed' where id = $1`, [orderId]);

    const rows = await listScheduledAppointmentsToday(roleCtx, { warehouseId }, deps);
    expect(rows.map((r) => r.orderId)).not.toContain(orderId);
  });
});
