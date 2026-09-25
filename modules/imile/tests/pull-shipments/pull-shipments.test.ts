// modules/imile/tests/pull-shipments/pull-shipments.test.ts — WBS 3.14 (part 2).
//
// Integration tests, one per scenario in ./pull-shipments.feature, against the real database as
// pgeos_app. Sources: docs/notes/slice-briefs/_slice-3.14.brief.md, .claude/briefs/imile.brief.md,
// docs/package/40-Build-Specification-EN.md §C8, database/schema/01-Data-Model.sql:1315-1339 /
// 1426-1436.
//
// Binding behaviour this suite asserts:
//   - `PullShipments` takes ONLY `{ correlationId }` — no caller-supplied shipment data; the
//     injected `ImilePortalPort` is the only data source (brief Contract line, same separation
//     `EvaluateAlertRules` uses for its job body).
//   - every iMile-sourced field on an EXISTING row (merchant, zone_code, area, recipient_phone,
//     is_cod, cod_amount, is_fresh, imile_status, raw) is written ONLY by this use case; internal_
//     status, cage_code, driver_code, delivery_task_id belong to other use cases and are NEVER
//     touched here.
//   - `imile.shipments.version` (optimistic lock) is migration 0024 (tasks/backlog/
//     MIGRATION-REQUEST-3.md row 1, issued as commit 3eb4465, applied). The "status-change update"
//     and "concurrent pull cycles" scenarios below reference that column directly (both in the
//     fixture INSERT and in the UPDATE path), against the real, migrated schema — do not weaken
//     these two scenarios to route around it.
//   - a portal-unreachable failure is caught INSIDE the command: it never throws past the command's
//     own boundary, and is instead recorded as a failed imile.agent_health row (session_valid=false,
//     error_message set) with a PullShipmentsResult of all-zero counts.
//   - a malformed portal record (no tracking number) is skipped and counted; it never aborts the
//     rest of the pull cycle.
//   - imile.agent_health carries no correlation_id / entity_id column (schema, cited above) — this
//     suite locates "the health row this call wrote" by exact `reported_at` equality against the
//     FixedClock's own `now()` at call time (deterministic, no assumption about the health row's
//     `agent_id` value, which this brief never specifies).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus a real
// identity.users row for the dedicated station-agent actor, same as
// modules/imile/tests/report-agent-health/report-agent-health.test.ts. PG_APP_USER=pgeos_app is
// REQUIRED to run this suite (every command call goes through withContext(ctx, fn) as pgeos_app,
// genuinely subject to RLS).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The modules under test.
import { pullShipments } from '../../application/pull-shipments/index.js';
import { createPullShipmentsDeps } from '../../api/pull-shipments/composition.js';
import { StaleVersionError, PortalUnreachableError } from '../../domain/pull-shipments/errors.js';
import type { ImilePortalPort, PortalShipmentRecord } from '../../application/pull-shipments/ports.js';
import { PullShipmentsInputSchema } from '@pg-eos/contracts/imile/pull-shipments';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

const STATION_AGENT_ACTOR_UUID = '00000000-0000-4000-8000-0000003140a1';

const clock = new FixedClock(new Date('2026-09-25T00:00:00.000Z'));
const ids = new SequentialIdGenerator(3140);

const internalCtx = { userId: STATION_AGENT_ACTOR_UUID, clientId: null, isInternal: true };

const usedTrackingNos = new Set<string>();

function freshTrackingNo(label: string): string {
  const trackingNo = `SHP-${label}-${randomUUID()}`;
  usedTrackingNos.add(trackingNo);
  return trackingNo;
}

function nextCorrelationId(): string {
  return randomUUID();
}

/** Synchronization latch for the "two concurrent pull cycles" scenario below. `PullShipmentsDeps
 *  .onBeforeUpdate` (application/pull-shipments/ports.ts, reviewer finding 9 round 1, finding 1
 *  round 3) is awaited by `pullShipments` for every matched record WHOSE iMile-sourced fields
 *  actually differ, right after that comparison and BEFORE `repo.updateShipmentIMileFields` runs
 *  — this scenario's own fixture always changes `imile_status`, so both racing calls reliably
 *  reach it. Building `onBeforeUpdate` from a shared
 *  counter + a promise that resolves only once BOTH concurrent calls have reached that point turns
 *  the race into a genuine, deterministic one: both SELECTs are guaranteed to have completed
 *  before EITHER UPDATE fires, every run — not a connection-pool warm-up guess (the reviewer
 *  reproduced a real flake, 1 failure in 4 runs, with warm-up alone). A safety timeout guards
 *  against a hang if the production wiring ever stops calling `onBeforeUpdate` for some reason. */
const RACE_BARRIER_ARRIVALS_EXPECTED = 2;
const RACE_BARRIER_SAFETY_TIMEOUT_MS = 5_000;

function createArrivalBarrier(expectedArrivals: number, safetyTimeoutMs: number): () => Promise<void> {
  let arrivals = 0;
  let release: () => void = () => undefined;
  const everyoneArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const safety = setTimeout(release, safetyTimeoutMs);
  return async (): Promise<void> => {
    arrivals += 1;
    if (arrivals >= expectedArrivals) {
      clearTimeout(safety);
      release();
    }
    await everyoneArrived;
  };
}

// Test isolation only, same discipline as report-agent-health.test.ts: one module-level FixedClock
// shared by every scenario. Advancing between scenarios keeps each scenario's own `reported_at` (the
// only handle this suite has on "the health row THIS call wrote" — imile.agent_health carries no
// correlation_id) in its own disjoint window.
const SCENARIO_CLOCK_STEP_MS = 5_000;
function beginScenario(): void {
  clock.advance(SCENARIO_CLOCK_STEP_MS);
}

/** Minimal FakeImilePortalAdapter test double (brief: "you define the fake inline ... do NOT write
 *  production infrastructure/portal-adapter.ts"). Every scenario below builds its own instance from
 *  a fixed list of records, or a thrower for the "portal unreachable" scenario. */
function fakePortal(records: readonly unknown[]): ImilePortalPort {
  return {
    fetchShipments: async () => records,
  };
}

function unreachablePortal(): ImilePortalPort {
  return {
    fetchShipments: async () => {
      throw new PortalUnreachableError('iMile portal connection refused (fixture)');
    },
  };
}

function validPortalRecord(trackingNo: string, overrides: Partial<PortalShipmentRecord> = {}): PortalShipmentRecord {
  return {
    tracking_no: trackingNo,
    merchant: 'Acme Trading',
    zone_code: 'Z-12',
    area: 'Hawally',
    recipient_phone: '+96555512345',
    is_cod: true,
    cod_amount: '12.500',
    is_fresh: false,
    imile_status: 'created',
    raw: { trackingNo, source: 'fixture' },
    ...overrides,
  };
}

async function getShipmentRow(trackingNo: string): Promise<{
  id: string;
  tracking_no: string;
  merchant: string | null;
  zone_code: string | null;
  area: string | null;
  recipient_phone: string | null;
  is_cod: boolean | null;
  cod_amount: string | null;
  is_fresh: boolean;
  imile_status: string | null;
  internal_status: string;
  cage_code: string | null;
  driver_code: string | null;
  delivery_task_id: string | null;
  raw: unknown;
} | undefined> {
  const result = await pool.query(
    `select id::text as id, tracking_no, merchant, zone_code, area, recipient_phone, is_cod, cod_amount::text as cod_amount,
            is_fresh, imile_status, internal_status, cage_code, driver_code, delivery_task_id::text as delivery_task_id, raw
       from imile.shipments where tracking_no = $1`,
    [trackingNo],
  );
  return result.rows[0];
}

/** Total row count of imile.shipments — used by the "portal unreachable" and "empty response"
 *  scenarios below to assert the whole table is untouched (neither scenario has a specific
 *  tracking_no to key on, since the portal never returns a record). */
async function getShipmentsTotalCount(): Promise<number> {
  const result: QueryResult<{ count: string }> = await pool.query(`select count(*)::text as count from imile.shipments`);
  return Number(result.rows[0]?.count ?? '0');
}

async function getShipmentVersion(trackingNo: string): Promise<number | undefined> {
  const result: QueryResult<{ version: number }> = await pool.query(
    `select version from imile.shipments where tracking_no = $1`,
    [trackingNo],
  );
  return result.rows[0]?.version;
}

/** Raw fixture INSERT — a "shipment already known locally". `version` defaults to the migration
 *  0024 column default (1); the two scenarios that need a specific starting version pass it
 *  explicitly (see file header). */
async function insertExistingShipment(params: {
  trackingNo: string;
  imileStatus: string;
  internalStatus: string;
  cageCode: string | null;
  driverCode: string | null;
  version?: number;
}): Promise<void> {
  if (params.version !== undefined) {
    await pool.query(
      `insert into imile.shipments
         (tracking_no, station_code, merchant, zone_code, area, recipient_phone, is_cod, cod_amount,
          is_fresh, imile_status, internal_status, cage_code, driver_code, delivery_task_id, version)
       values ($1, 'CSP04', 'Original Merchant', 'Z-01', 'Salmiya', '+96555500000', false, null,
               false, $2, $3, $4, $5, null, $6)`,
      [params.trackingNo, params.imileStatus, params.internalStatus, params.cageCode, params.driverCode, params.version],
    );
  } else {
    await pool.query(
      `insert into imile.shipments
         (tracking_no, station_code, merchant, zone_code, area, recipient_phone, is_cod, cod_amount,
          is_fresh, imile_status, internal_status, cage_code, driver_code, delivery_task_id)
       values ($1, 'CSP04', 'Original Merchant', 'Z-01', 'Salmiya', '+96555500000', false, null,
               false, $2, $3, $4, $5, null)`,
      [params.trackingNo, params.imileStatus, params.internalStatus, params.cageCode, params.driverCode],
    );
  }
}

/** platform.audit_log rows written by one pullShipments() call, keyed by correlationId — same
 *  lookup discipline as the golden slice's own auditCountForCorrelation
 *  (modules/wms/tests/receive-inbound/receive-inbound.test.ts). Reviewer round 2 finding 2: no
 *  existing test in this file read platform.audit_log at all — every `writeAuditRow` call in
 *  application/pull-shipments/pull-shipments.ts / infrastructure/pull-shipments/repository.ts
 *  could be deleted and the suite would stay green. The scenarios below close that gap. */
async function auditRowsForCorrelation(correlationId: string): Promise<
  Array<{
    table_name: string;
    record_id: string | null;
    operation: string;
    changed_fields: string[] | null;
  }>
> {
  const result = await pool.query(
    `select table_name, record_id::text as record_id, operation, changed_fields
       from platform.audit_log where correlation_id = $1 order by occurred_at`,
    [correlationId],
  );
  return result.rows;
}

async function agentHealthRowAtExactly(reportedAt: Date): Promise<{
  session_valid: boolean;
  last_pull_at: Date | null;
  error_message: string | null;
} | undefined> {
  const result = await pool.query(
    `select session_valid, last_pull_at, error_message from imile.agent_health where reported_at = $1`,
    [reportedAt.toISOString()],
  );
  return result.rows[0];
}

async function createFixtureActor(userId: string): Promise<void> {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
  await pool.query(`delete from identity.users where id = $1`, [userId]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [userId, `_imilepull_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار سحب شحنات iMile — WBS 3.14'],
  );
}

beforeAll(async () => {
  await createFixtureActor(STATION_AGENT_ACTOR_UUID);
});

afterAll(async () => {
  if (usedTrackingNos.size > 0) {
    await pool.query(`delete from imile.shipments where tracking_no = any($1::text[])`, [[...usedTrackingNos]]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [STATION_AGENT_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [STATION_AGENT_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [STATION_AGENT_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [STATION_AGENT_ACTOR_UUID]);
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/imile/pull-shipments — PullShipmentsInputSchema shape', () => {
  it('accepts { correlationId } only — no caller-supplied shipment data (brief Contract line)', () => {
    const parsed = PullShipmentsInputSchema.parse({ correlationId: randomUUID() });
    expect(parsed.correlationId).toEqual(expect.any(String));
  });

  it('rejects a body carrying shipment fields the portal alone may supply', () => {
    const result = PullShipmentsInputSchema.safeParse({
      correlationId: randomUUID(),
      trackingNo: 'SHP-INJECTED',
    });
    // additive extra keys are either stripped or rejected — either way `trackingNo` must never
    // reach the command as validated input.
    if (result.success) {
      expect((result.data as Record<string, unknown>)['trackingNo']).toBeUndefined();
    } else {
      expect(result.success).toBe(false);
    }
  });
});

// --- Scenario: a shipment appears on the portal for the first time ------------------------------

describe('Scenario: a shipment appears on the portal for the first time', () => {
  it('inserts a new imile.shipments row with internal_status "expected", iMile fields matching the payload, and records a successful pull', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('FIRST');
    const record = validPortalRecord(trackingNo);
    const deps = createPullShipmentsDeps({ clock, ids, portal: fakePortal([record]) });
    const reportedAt = clock.now();
    const correlationId = nextCorrelationId();

    const result = await pullShipments(internalCtx, { correlationId }, deps);

    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 0, unchanged: 0 });

    const row = await getShipmentRow(trackingNo);
    expect(row?.internal_status).toBe('expected');
    expect(row?.merchant).toBe(record.merchant);
    expect(row?.zone_code).toBe(record.zone_code);
    expect(row?.area).toBe(record.area);
    expect(row?.recipient_phone).toBe(record.recipient_phone);
    expect(row?.is_cod).toBe(record.is_cod);
    expect(row?.cod_amount).toBe(record.cod_amount);
    expect(row?.imile_status).toBe(record.imile_status);
    expect(row?.raw).toEqual(record.raw);

    const health = await agentHealthRowAtExactly(reportedAt);
    expect(health?.session_valid).toBe(true);
    expect(health?.last_pull_at?.toISOString()).toBe(reportedAt.toISOString());

    // Reviewer round 2 finding 2: a new-shipment insert AND the pull cycle's own agent_health
    // insert each leave exactly one platform.audit_log row, correctly correlated.
    const auditRows = await auditRowsForCorrelation(correlationId);
    expect(auditRows).toHaveLength(2);
    const shipmentAudit = auditRows.find((r) => r.table_name === 'shipments');
    expect(shipmentAudit).toBeDefined();
    expect(shipmentAudit?.operation).toBe('insert');
    expect(shipmentAudit?.record_id).toBe(row?.id);
    const healthAudit = auditRows.find((r) => r.table_name === 'agent_health');
    expect(healthAudit).toBeDefined();
    expect(healthAudit?.operation).toBe('insert');
  });
});

// --- Scenario: a shipment already known locally has changed iMile-side status -------------------

describe('Scenario: a shipment already known locally has changed iMile-side status', () => {
  it('updates imile_status, bumps version, and leaves internal_status/cage_code/driver_code/delivery_task_id untouched', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('STATUSCHANGE');
    await insertExistingShipment({
      trackingNo,
      imileStatus: 'created',
      internalStatus: 'arrived',
      cageCode: 'CAGE-KEEP',
      driverCode: 'DRV-KEEP',
      version: 1,
    });

    const record = validPortalRecord(trackingNo, { imile_status: 'picked_up' });
    const deps = createPullShipmentsDeps({ clock, ids, portal: fakePortal([record]) });
    const correlationId = nextCorrelationId();

    const result = await pullShipments(internalCtx, { correlationId }, deps);

    expect(result).toEqual({ inserted: 0, updated: 1, skipped: 0, unchanged: 0 });

    const row = await getShipmentRow(trackingNo);
    expect(row?.imile_status).toBe('picked_up');
    expect(row?.internal_status).toBe('arrived'); // untouched — belongs to another use case.
    expect(row?.cage_code).toBe('CAGE-KEEP'); // untouched.
    expect(row?.driver_code).toBe('DRV-KEEP'); // untouched.
    expect(row?.delivery_task_id).toBeNull(); // untouched.

    expect(await getShipmentVersion(trackingNo)).toBe(2);

    // Reviewer round 2 finding 2: the update itself leaves exactly one platform.audit_log row for
    // imile.shipments, correctly correlated and operation='update'.
    const auditRows = await auditRowsForCorrelation(correlationId);
    const shipmentAudit = auditRows.find((r) => r.table_name === 'shipments');
    expect(shipmentAudit).toBeDefined();
    expect(shipmentAudit?.operation).toBe('update');
    expect(shipmentAudit?.record_id).toBe(row?.id);
  });
});

// --- Scenario: the portal is unreachable ---------------------------------------------------------

describe('Scenario: the portal is unreachable', () => {
  it('writes no imile.shipments row, records a failed pull, and does not throw past the command boundary', async () => {
    beginScenario();
    const deps = createPullShipmentsDeps({ clock, ids, portal: unreachablePortal() });
    const reportedAt = clock.now();
    const countBefore = await getShipmentsTotalCount();
    const correlationId = nextCorrelationId();

    const result = await pullShipments(internalCtx, { correlationId }, deps);

    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 0, unchanged: 0 });

    const health = await agentHealthRowAtExactly(reportedAt);
    expect(health?.session_valid).toBe(false);
    expect(health?.error_message).toBeTruthy();

    expect(await getShipmentsTotalCount()).toBe(countBefore);

    // Reviewer round 2 finding 2: the FAILED-pull agent_health insert also leaves its own
    // platform.audit_log row — the failure path writes an audit row too, not just the success path.
    const auditRows = await auditRowsForCorrelation(correlationId);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.table_name).toBe('agent_health');
    expect(auditRows[0]?.operation).toBe('insert');
  });
});

// --- Scenario: an empty portal response is not an error -------------------------------------------

describe('Scenario: an empty portal response is not an error', () => {
  it('records a successful pull with zero shipments touched and writes nothing to imile.shipments', async () => {
    beginScenario();
    const deps = createPullShipmentsDeps({ clock, ids, portal: fakePortal([]) });
    const reportedAt = clock.now();
    const countBefore = await getShipmentsTotalCount();

    const result = await pullShipments(internalCtx, { correlationId: nextCorrelationId() }, deps);

    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 0, unchanged: 0 });

    const health = await agentHealthRowAtExactly(reportedAt);
    expect(health?.session_valid).toBe(true);

    expect(await getShipmentsTotalCount()).toBe(countBefore);
  });
});

// --- Scenario: a malformed portal record is skipped, not fatal ------------------------------------

describe('Scenario: a malformed portal record is skipped, not fatal', () => {
  it('writes the valid shipment, skips and counts the malformed one, and still reports success', async () => {
    beginScenario();
    const validTrackingNo = freshTrackingNo('VALIDONE');
    const validRecord = validPortalRecord(validTrackingNo);
    const malformedRecord = { merchant: 'No Tracking Number Co', imile_status: 'created' }; // no tracking_no.
    const deps = createPullShipmentsDeps({ clock, ids, portal: fakePortal([validRecord, malformedRecord]) });
    const reportedAt = clock.now();

    const result = await pullShipments(internalCtx, { correlationId: nextCorrelationId() }, deps);

    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 1, unchanged: 0 });

    const row = await getShipmentRow(validTrackingNo);
    expect(row?.tracking_no).toBe(validTrackingNo);

    const health = await agentHealthRowAtExactly(reportedAt);
    expect(health?.session_valid).toBe(true);
  });
});

// --- Scenario: two concurrent pull cycles racing on the same shipment -----------------------------

describe('Scenario: two concurrent pull cycles racing on the same shipment', () => {
  it('exactly one update succeeds (version 1 -> 2); the other rejects with StaleVersionError, no silent overwrite', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('RACE');
    await insertExistingShipment({
      trackingNo,
      imileStatus: 'created',
      internalStatus: 'arrived',
      cageCode: null,
      driverCode: null,
      version: 1,
    });

    const recordA = validPortalRecord(trackingNo, { imile_status: 'picked_up' });
    const recordB = validPortalRecord(trackingNo, { imile_status: 'picked_up' });
    // Both calls' onBeforeUpdate resolve from the SAME barrier instance, so neither call's UPDATE
    // can start until both calls' SELECT has completed — a real synchronization barrier, not
    // connection-warm-up timing luck (see createArrivalBarrier doc comment above).
    const barrier = createArrivalBarrier(RACE_BARRIER_ARRIVALS_EXPECTED, RACE_BARRIER_SAFETY_TIMEOUT_MS);
    const depsA = createPullShipmentsDeps({ clock, ids, portal: fakePortal([recordA]), onBeforeUpdate: barrier });
    const depsB = createPullShipmentsDeps({ clock, ids, portal: fakePortal([recordB]), onBeforeUpdate: barrier });

    const [resultA, resultB] = await Promise.allSettled([
      pullShipments(internalCtx, { correlationId: nextCorrelationId() }, depsA),
      pullShipments(internalCtx, { correlationId: nextCorrelationId() }, depsB),
    ]);

    const fulfilled = [resultA, resultB].filter((r) => r.status === 'fulfilled');
    const rejected = [resultA, resultB].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleVersionError);
    expect((fulfilled[0] as PromiseFulfilledResult<{ updated: number }>).value.updated).toBe(1);

    expect(await getShipmentVersion(trackingNo)).toBe(2);
  });
});

// --- Scenario: an update's audit row narrows changed_fields to the true diff ----------------------
//
// Appended at the end of the file (not interleaved with the scenarios above) deliberately: every
// scenario above keys its own imile.agent_health row lookup on an exact reportedAt timestamp
// derived from ONE shared module-level clock advanced a fixed step per scenario (beginScenario) —
// inserting a new scenario between two existing ones would shift every later timestamp and risk
// colliding with an agent_health row a previous, unrelated test run left behind (this suite never
// deletes imile.agent_health rows). Appending here changes no existing scenario's clock offset.
describe("Scenario: the update audit row's changed_fields lists only the fields that actually changed", () => {
  it('changed_fields is [imile_status, raw, last_sync_at] — not the full 8-field iMile-sourced bag — when imile_status and raw both differ in value', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('AUDITNARROW');
    // Fixture row carries the same values as `validPortalRecord`'s defaults for every OTHER
    // 8-field iMile-sourced column, but leaves `raw` NULL (the insert below names no `raw`
    // column) while the incoming portal record's `raw` is a real object — so `imile_status` AND
    // `raw` both genuinely differ in value, `last_sync_at` differs too (a fresh clock read), and
    // none of the other 6 iMile-sourced fields do. Isolates changed_fields to prove the audit row
    // reflects the true VALUE diff, not the whole iMile-sourced bag and not just "any field
    // changed, so raw/last_sync_at are added unconditionally" (pg-reviewer round 2 finding 2,
    // round 3 finding 2, round 4 finding 1/2 — the sibling test below, "excludes raw from
    // changed_fields…", proves the unconditional reading is wrong: raw is compared by value).
    await pool.query(
      `insert into imile.shipments
         (tracking_no, station_code, merchant, zone_code, area, recipient_phone, is_cod, cod_amount,
          is_fresh, imile_status, internal_status, cage_code, driver_code, delivery_task_id, version)
       values ($1, 'CSP04', 'Acme Trading', 'Z-12', 'Hawally', '+96555512345', true, '12.500',
               false, 'created', 'arrived', null, null, null, 1)`,
      [trackingNo],
    );

    const record = validPortalRecord(trackingNo, { imile_status: 'picked_up' });
    const deps = createPullShipmentsDeps({ clock, ids, portal: fakePortal([record]) });
    const correlationId = nextCorrelationId();

    const result = await pullShipments(internalCtx, { correlationId }, deps);
    expect(result).toEqual({ inserted: 0, updated: 1, skipped: 0, unchanged: 0 });

    const auditRows = await auditRowsForCorrelation(correlationId);
    const shipmentAudit = auditRows.find((r) => r.table_name === 'shipments');
    expect(shipmentAudit).toBeDefined();
    expect(shipmentAudit?.operation).toBe('update');
    expect(shipmentAudit?.changed_fields).toEqual(['imile_status', 'raw', 'last_sync_at']);
  });

  it('excludes raw from changed_fields when the incoming raw payload is byte-identical to the stored one (pg-reviewer round 3 finding 2)', async () => {
    beginScenario();
    const trackingNo = freshTrackingNo('AUDITRAWEQ');
    const sameRaw = { trackingNo, source: 'fixture', note: 'unchanged-raw' };
    // Fixture row's `raw` is set to the EXACT payload the incoming portal record will also carry —
    // only imile_status will differ. Proves `raw` is compared by value (isDeepStrictEqual), not
    // assumed changed just because the UPDATE statement always names the column.
    await pool.query(
      `insert into imile.shipments
         (tracking_no, station_code, merchant, zone_code, area, recipient_phone, is_cod, cod_amount,
          is_fresh, imile_status, raw, internal_status, cage_code, driver_code, delivery_task_id, version)
       values ($1, 'CSP04', 'Acme Trading', 'Z-12', 'Hawally', '+96555512345', true, '12.500',
               false, 'created', $2::jsonb, 'arrived', null, null, null, 1)`,
      [trackingNo, JSON.stringify(sameRaw)],
    );

    const record = validPortalRecord(trackingNo, { imile_status: 'picked_up', raw: sameRaw });
    const deps = createPullShipmentsDeps({ clock, ids, portal: fakePortal([record]) });
    const correlationId = nextCorrelationId();

    const result = await pullShipments(internalCtx, { correlationId }, deps);
    expect(result).toEqual({ inserted: 0, updated: 1, skipped: 0, unchanged: 0 });

    const auditRows = await auditRowsForCorrelation(correlationId);
    const shipmentAudit = auditRows.find((r) => r.table_name === 'shipments');
    expect(shipmentAudit).toBeDefined();
    // last_sync_at still changes (a fresh clock read every cycle) but raw does not, since the
    // stored and incoming payloads are deep-equal.
    expect(shipmentAudit?.changed_fields).toEqual(['imile_status', 'last_sync_at']);
    expect(shipmentAudit?.changed_fields).not.toContain('raw');
  });
});
