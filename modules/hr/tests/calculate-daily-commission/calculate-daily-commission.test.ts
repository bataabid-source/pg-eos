// modules/hr/tests/calculate-daily-commission/calculate-daily-commission.test.ts — WBS 3.13 part 2.
//
// Integration tests, one per scenario in ./calculate-daily-commission.feature, against the real
// database as pgeos_app (RLS genuinely enforced — every command call goes through withContext/
// withIdempotentContext, same discipline as this module's own register-employee precedent and
// modules/imile/tests/assign-driver-id/assign-driver-id.test.ts). Sources:
// docs/notes/slice-briefs/_slice-3.13.brief.md "Scenario"/"Contract"/"Defaults taken" blocks
// (verbatim); .claude/briefs/hr.brief.md and .claude/briefs/imile.brief.md (tables/RLS);
// database/schema/13-Schema-Additions.sql:281-389 (imile.driver_ids, imile.driver_id_assignments,
// imile.shipments_attributed VIEW — the ONLY allowed attribution source, hr.commission_rules,
// hr.commission_daily); database/schema/13B-Schema-Reference-Consolidation.sql:2449-2451
// (chk_commission_daily_status), 4990-5044 (chk_commission_rules_driver_shape,
// chk_commission_rules_valid_window).
//
// **Migration 0027 (brief, "Migration 0027 issued by the Master"):** landed and applied —
// `hr.commission_daily` now carries the internal-only, entity-scoped `internal_write` INSERT/UPDATE
// policies alongside the entity-scoped `own_commission` SELECT policy, plus the `version` column
// (both migration 0027 items). Do NOT grant a policy here, do NOT bypass RLS to work around
// anything — this file only proves the RLS behaviour, it never patches it.
//
// Surface this file exercises (GREEN and built — same "test pins the contract" discipline as every
// prior slice this lane has built):
//   modules/hr/domain/calculate-daily-commission/{errors.ts,invariants.ts}
//     - CommissionAlreadyCalculatedError, NoApplicableCommissionRuleError,
//       AmbiguousCommissionRuleError (brief, Deliver's own final paragraph).
//   modules/hr/application/calculate-daily-commission/index.ts (re-exports calculateDailyCommission)
//     - calculateDailyCommission(ctx, input, deps): Promise<CalculateDailyCommissionResult>
//       -> { commissionDailyId, grossCommission, deliveredCount, failedCount, returnedCount }
//       (Contract line).
//   modules/hr/api/calculate-daily-commission/composition.ts
//     - createCalculateDailyCommissionDeps(overrides).
//
// CalculateDailyCommissionInput (Contract line): { employeeId: uuid, workDate: string (date),
// correlationId: uuid } — entityId resolved from ctx, never caller-supplied (brief default,
// same discipline as register-employee/register-vehicle/assign-driver-id's own
// resolveCallerEntityId pattern).
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus a real
// identity.users row for a dedicated internal actor and one outsider. PG_APP_USER=pgeos_app is
// REQUIRED to run this suite (every command call goes through withContext(ctx, fn) as pgeos_app,
// genuinely subject to RLS). D-183: a DELETE against the shared database is only allowed in this
// suite's own `afterAll`, never in `beforeAll` — `beforeAll` only ever upserts the fixture actor(s).
// platform.audit_log rows are NEVER deleted.
//
// A FixedClock at a date safely in the PAST relative to real wall-clock time (2024-06-01) is used
// throughout — a clock literal too close to real "now" caused a false failure in WBS 3.12's own
// suite when a DB trigger's own now() raced it (lesson recorded this session).

import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The modules under test.
import { calculateDailyCommission } from '../../application/calculate-daily-commission/index.js';
import { createCalculateDailyCommissionDeps } from '../../api/calculate-daily-commission/composition.js';
import {
  AmbiguousCommissionRuleError,
  CommissionAlreadyCalculatedError,
  EntityScopeAmbiguousError,
  NoApplicableCommissionRuleError,
  NotInternalActorError,
} from '../../domain/calculate-daily-commission/errors.js';
// Part 1's OWN round-2 finding 1 — pg-backend's cross-entity/employee-visibility fix (already
// GREEN, built and merged as 6c16c41: see modules/hr/domain/calculate-daily-commission/errors.ts's
// own header, and ../../application/calculate-daily-commission/calculate-daily-commission.ts,
// which reads hr.employees and throws this BEFORE the shipments/rule-matching steps). Part 2's own
// round-1 finding 1 is a DIFFERENT bug (the Kuwait business-day boundary) — see that finding's own
// describe block further below, which cites it correctly.
import { EmployeeNotInCallerEntityError } from '../../domain/calculate-daily-commission/errors.js';
// the package subpath export (@pg-eos/contracts/hr/calculate-daily-commission), not a deep relative
// path — packages/contracts/hr/calculate-daily-commission.ts is pg-backend's own file to author
// (Write ONLY line, brief), not this test file's.
import { CalculateDailyCommissionInputSchema } from '@pg-eos/contracts/hr/calculate-daily-commission';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const ACTOR_UUID = '00000000-0000-4000-8000-0000003130a1';
// no identity.user_entities row is ever inserted for this one — deliberately, same fixture pattern
// as modules/imile/tests/assign-driver-id/assign-driver-id.test.ts's own `outsiderCtx`.
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000003130a2';
// part 2 round-2 finding 2's own actor — a real entity-scoped actor (unlike OUTSIDER_ACTOR_UUID,
// which has NO identity.user_entities row and so fails at resolveCallerEntityId itself) whose
// ctx.isInternal is false — this one reaches the application layer's own explicit `ctx.isInternal`
// gate (calculate-daily-commission.ts step 1a, checked AFTER resolveCallerEntityId succeeds but
// BEFORE any employee/shipment/rule read or the INSERT) and is refused with NotInternalActorError,
// TRANSLATING what would otherwise surface only as hr.commission_daily's own `internal_write`
// policy (migration 0027) rejecting the INSERT itself.
const NON_INTERNAL_WITH_ENTITY_ACTOR_UUID = '00000000-0000-4000-8000-0000003130a3';
// part 2 round-2 finding 2's own SELECT-visibility actor — a caller scoped to entity B, holding
// `hr.commission.read_all` (SALES_MGR/CFO/GM — 13B-Schema-Reference-Consolidation.sql:5216-5222) —
// proves own_commission's entity-scoped SELECT (migration 0027 item 2) hides an entity-A row from
// an entity-B read_all holder.
const ENTITY_B_READ_ALL_ACTOR_UUID = '00000000-0000-4000-8000-0000003130a4';
const SALES_MGR_ROLE_CODE = 'SALES_MGR';

// Safely in the past (lesson this session — see file header). 2024-06-01T06:00:00Z is 09:00
// Asia/Kuwait (UTC+3, no DST), well inside the same Kuwait business date, avoiding any midnight
// boundary ambiguity.
const clock = new FixedClock(new Date('2024-06-01T06:00:00.000Z'));
const ids = new SequentialIdGenerator(3130);
const ctx = { userId: ACTOR_UUID, clientId: null, isInternal: true };
const outsiderCtx = { userId: OUTSIDER_ACTOR_UUID, clientId: null, isInternal: false };

const TODAY = '2024-06-01';
// Well before RULE_VALID_FROM below — no hr.commission_rules row can match this date, in isolation
// from every other scenario's own fixture rule (brief default 1's own valid-window filter).
const NO_RULE_WORKDATE = '2024-01-01';
const RULE_VALID_FROM = '2024-05-01';
const RATE_PER_UNIT = '5.000';

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    roleCode,
  ]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(
    `insert into identity.user_roles (user_id, role_id) values ($1, $2) on conflict do nothing`,
    [userId, roleId],
  );
}

let entityId: string;
let entityBId: string;
const fixtureEmployeeIds: string[] = [];
const fixtureDriverIdIds: string[] = [];
const fixtureShipmentIds: string[] = [];
const fixtureCommissionRuleIds: string[] = [];
const fixtureCommissionDailyIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

// Migration 0029 (SCR-HR-EMP-01, doc 40 §C7) adds chk_employees_code_format on hr.employees:
// code ~ '^PG-[0-9]{4}$'. This suite's own fixture codes (including the cross-entity fixture
// below) stay in the PG-7100-PG-7199 range (disjoint from imile's PG-5xxx/PG-6xxx and hr's own
// 1xxx-4xxx/9xxx) and share one module-level counter for uniqueness within this file's own
// inserts (no afterEach cleanup here — all fixture rows persist until this suite's own afterAll,
// so every call site in this file needs a distinct code).
let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (100 + employeeCodeCounter++).toString();
  return `PG-7${suffix}`;
}

async function createFixtureEmployee(labelSuffix: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, 'active') returning id::text as id`,
    [entityId, nextEmployeeCode(), `سائق اختبار عمولة — WBS 3.13 ${labelSuffix}`],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  return id;
}

async function createFixtureDriverId(status: 'available' | 'assigned' = 'assigned'): Promise<{ id: string; imileCode: string }> {
  const imileCode = `DRV-3130-${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.driver_ids (imile_code, allocated_at, status)
       values ($1, current_date, $2) returning id::text as id`,
    [imileCode, status],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture imile.driver_ids row');
  fixtureDriverIdIds.push(id);
  return { id, imileCode };
}

/** an ACTIVE assignment (assigned_to null) covering `coveringDate` — assigned_from is set well
 *  before it so the whole business day is inside the open window. */
async function createFixtureAssignment(driverIdRef: string, employeeId: string, assignedFromIso: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.driver_id_assignments (driver_id_ref, employee_id, assigned_from, assigned_to, assigned_by)
       values ($1, $2, $3, null, $4) returning id::text as id`,
    [driverIdRef, employeeId, assignedFromIso, ACTOR_UUID],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture imile.driver_id_assignments row');
  return id;
}

async function createFixtureShipment(driverCode: string, ofdAtIso: string, internalStatus = 'delivered'): Promise<string> {
  const trackingNo = `SHP-3130-${randomUUID()}`;
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.shipments (tracking_no, internal_status, ofd_at, closed_at, driver_code)
       values ($1, $2, $3, $3, $4) returning id::text as id`,
    [trackingNo, internalStatus, ofdAtIso, driverCode],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture imile.shipments row');
  fixtureShipmentIds.push(id);
  return trackingNo;
}

async function createFixtureCommissionRule(overrides?: {
  readonly tierFrom?: number;
  readonly tierTo?: number | null;
  readonly ratePerUnit?: string;
  readonly minDaily?: string;
  readonly validFrom?: string;
  readonly validTo?: string | null;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.commission_rules
        (entity_id, name, applies_to, client_id, tier_from, tier_to, rate_per_unit, min_daily, valid_from, valid_to)
       values ($1, $2, 'driver', null, $3, $4, $5, $6, $7, $8)
       returning id::text as id`,
    [
      entityId,
      `WBS 3.13 fixture rule ${randomUUID()}`,
      overrides?.tierFrom ?? 0,
      overrides?.tierTo ?? null,
      overrides?.ratePerUnit ?? RATE_PER_UNIT,
      overrides?.minDaily ?? '0',
      overrides?.validFrom ?? RULE_VALID_FROM,
      overrides?.validTo ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.commission_rules row');
  fixtureCommissionRuleIds.push(id);
  return id;
}

async function getCommissionDailyRow(id: string): Promise<
  | {
      delivered_count: number;
      failed_count: number;
      returned_count: number;
      gross_commission: string;
      status: string;
      driver_id_ref: string | null;
      source_snapshot: unknown;
      rule_snapshot: unknown;
      work_date: string;
    }
  | undefined
> {
  const result = await pool.query(
    `select delivered_count, failed_count, returned_count, gross_commission::text as gross_commission,
            status, driver_id_ref::text as driver_id_ref, source_snapshot, rule_snapshot,
            work_date::text as work_date
       from hr.commission_daily where id = $1`,
    [id],
  );
  return result.rows[0];
}

async function countCommissionDailyRows(employeeId: string, workDate: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from hr.commission_daily where employee_id = $1 and work_date = $2`,
    [employeeId, workDate],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function auditRowsForCorrelation(
  correlationId: string,
): Promise<Array<{ table_name: string; record_id: string | null; operation: string }>> {
  const result = await pool.query(
    `select table_name, record_id::text as record_id, operation
       from platform.audit_log where correlation_id = $1 and schema_name = 'hr' order by occurred_at`,
    [correlationId],
  );
  return result.rows;
}

async function verifyAttributionTrackingNos(fromDate: string, toDate: string): Promise<string[]> {
  const result: QueryResult<{ tracking_no: string }> = await pool.query(
    `select tracking_no from imile.verify_attribution($1, $2)`,
    [fromDate, toDate],
  );
  return result.rows.map((r) => r.tracking_no);
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`fixture platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  const entityBResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PDL'],
  );
  const entityBRow = entityBResult.rows[0];
  if (!entityBRow) throw new Error(`fixture platform.entities row not found for code 'PDL'`);
  entityBId = entityBRow.id;

  // D-183: no DELETE here — beforeAll only upserts.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [ACTOR_UUID, `_hr_calcdailycommission_${ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل اختبار حساب العمولة اليومية — WBS 3.13'],
  );
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'agent')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [OUTSIDER_ACTOR_UUID, `_hr_calcdailycommission_outsider_${OUTSIDER_ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل خارجي اختبار حساب العمولة — WBS 3.13'],
  );
  // fix round, finding 2a — an identity.users row with user_type 'internal' AND entity membership
  // below, but whose ctx.isInternal the caller sets to false when used (an entity-scoped actor
  // whose CALL carries isInternal: false, not the 'agent'/OUTSIDER_ACTOR_UUID shape which has NO
  // entity membership at all — fix round finding 6 corrected this comment's own mislabeling of a
  // user_type 'internal' row as "a portal/client-type actor").
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      NON_INTERNAL_WITH_ENTITY_ACTOR_UUID,
      `_hr_calcdailycommission_noninternal_${NON_INTERNAL_WITH_ENTITY_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل غير داخلي له نطاق كيان — WBS 3.13',
    ],
  );
  // fix round, finding 2b — a caller scoped to entity B, holding hr.commission.read_all.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      ENTITY_B_READ_ALL_ACTOR_UUID,
      `_hr_calcdailycommission_entitybreadall_${ENTITY_B_READ_ALL_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل كيان آخر يحمل صلاحية قراءة كل كشوف العمولة — WBS 3.13',
    ],
  );
  // the acting user needs an entity scope of exactly one to resolve entityId (cross-module
  // pattern, register-employee/assign-driver-id precedent) — deliberately absent for the outsider.
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
       on conflict do nothing`,
    [ACTOR_UUID, entityId],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
       on conflict do nothing`,
    [NON_INTERNAL_WITH_ENTITY_ACTOR_UUID, entityId],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2)
       on conflict do nothing`,
    [ENTITY_B_READ_ALL_ACTOR_UUID, entityBId],
  );
  await grantRole(ENTITY_B_READ_ALL_ACTOR_UUID, SALES_MGR_ROLE_CODE);
});

// Fixture-isolation fix (fix round, WBS 3.13 part 1): `hr.commission_rules` matching is scoped to
// entity_id + applies_to + tier + valid window ONLY — it is NOT employee-scoped. Every scenario in
// this file that calls createFixtureCommissionRule() with the SAME default tier window
// (tier_from 0, tier_to null, valid_from RULE_VALID_FROM, valid_to null) for the SAME entityId
// therefore accumulates overlapping rule rows across scenarios if they are only ever cleaned up in
// the shared `afterAll`, which correctly (per the brief's own default 2 — no invented tie-break)
// makes every LATER scenario's calculation hit AmbiguousCommissionRuleError instead of the single
// rule each scenario actually means to exercise. Fix round finding 3d added one describe block
// below that deliberately DOES exercise AmbiguousCommissionRuleError, in a single self-contained
// test — every OTHER scenario's own commission_rules fixture row(s) are still deleted immediately
// after that scenario finishes (in addition to the defence-in-depth sweep still present in the
// shared afterAll below) — this is a fixture-isolation fix only, no application/detection
// semantics are touched.
afterEach(async () => {
  if (fixtureCommissionRuleIds.length > 0) {
    await pool.query(`delete from hr.commission_rules where id = any($1::uuid[])`, [fixtureCommissionRuleIds]);
    fixtureCommissionRuleIds.length = 0;
  }
});

afterAll(async () => {
  if (fixtureCommissionDailyIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where id = any($1::uuid[])`, [fixtureCommissionDailyIds]);
  }
  // also sweep any commission_daily rows this suite's OWN employees produced but did not track by
  // id (e.g. a row inserted by the command under test itself, whose id we captured — kept here as
  // defence in depth for the employee-scoped rows).
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where employee_id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  if (fixtureShipmentIds.length > 0) {
    await pool.query(`delete from imile.shipments where id = any($1::uuid[])`, [fixtureShipmentIds]);
  }
  if (fixtureDriverIdIds.length > 0) {
    await pool.query(`delete from imile.driver_id_assignments where driver_id_ref = any($1::uuid[])`, [
      fixtureDriverIdIds,
    ]);
    await pool.query(`delete from imile.driver_ids where id = any($1::uuid[])`, [fixtureDriverIdIds]);
  }
  if (fixtureCommissionRuleIds.length > 0) {
    await pool.query(`delete from hr.commission_rules where id = any($1::uuid[])`, [fixtureCommissionRuleIds]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  // platform.audit_log is NEVER deleted (CLAUDE.md-wide discipline, every prior slice).
  for (const userId of [
    ACTOR_UUID,
    OUTSIDER_ACTOR_UUID,
    NON_INTERNAL_WITH_ENTITY_ACTOR_UUID,
    ENTITY_B_READ_ALL_ACTOR_UUID,
  ]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/hr/calculate-daily-commission — CalculateDailyCommissionInputSchema shape (brief Contract line)', () => {
  it('accepts { employeeId, workDate, correlationId } and carries no caller-supplied entityId', () => {
    const parsed = CalculateDailyCommissionInputSchema.parse({
      employeeId: randomUUID(),
      workDate: TODAY,
      correlationId: randomUUID(),
    });
    expect('entityId' in parsed).toBe(false);
  });

  it('rejects a non-date workDate', () => {
    const result = CalculateDailyCommissionInputSchema.safeParse({
      employeeId: randomUUID(),
      workDate: 'not-a-date',
      correlationId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });
});

// --- Scenario: A driver's delivered shipments for the day produce a calculated commission row ----

describe("Scenario: A driver's delivered shipments for the day produce a calculated commission row", () => {
  it('inserts one hr.commission_daily row (delivered_count 3, status "calculated", driver_id_ref set), gross_commission = 3 * rate_per_unit, source_snapshot/rule_snapshot populated, one audit row', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('main');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-01T00:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T02:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T03:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T04:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    const result = await calculateDailyCommission(ctx, { employeeId, workDate: TODAY, correlationId }, deps);
    fixtureCommissionDailyIds.push(result.commissionDailyId);

    expect(result.deliveredCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.returnedCount).toBe(0);

    const row = await getCommissionDailyRow(result.commissionDailyId);
    expect(row).toBeDefined();
    expect(row?.delivered_count).toBe(3);
    expect(row?.status).toBe('calculated');
    expect(row?.driver_id_ref).toBe(driverIdRef);
    // fix round, finding 3b: exact string assertion against numeric(14,3)'s real serialization
    // ('15.000', not a toBeCloseTo/Number() comparison a floating-point implementation would also
    // pass) — 3 * '5.000' = '15.000'.
    expect(row?.gross_commission).toBe('15.000');
    expect(row?.source_snapshot).toBeTruthy();
    expect(row?.rule_snapshot).toBeTruthy();

    const auditRows = await auditRowsForCorrelation(correlationId);
    const commissionAudit = auditRows.filter((r) => r.table_name === 'commission_daily');
    expect(commissionAudit).toHaveLength(1);
    expect(commissionAudit[0]?.operation).toBe('insert');
    expect(commissionAudit[0]?.record_id).toBe(result.commissionDailyId);

    // fix round, finding 3f: assert the audit row's own new_value reflects the real inserted
    // values (same pattern WBS 3.12's own audit assertions use — modules/imile/tests/
    // assign-driver-id/assign-driver-id.test.ts's own audit new_value assertion).
    const newValueResult: QueryResult<{ new_value: Record<string, unknown> }> = await pool.query(
      `select new_value from platform.audit_log where correlation_id = $1 and table_name = 'commission_daily'`,
      [correlationId],
    );
    const newValue = newValueResult.rows[0]?.new_value;
    expect(newValue).toMatchObject({
      employeeId,
      workDate: TODAY,
      driverIdRef,
      deliveredCount: 3,
      failedCount: 0,
      returnedCount: 0,
      grossCommission: '15.000',
      status: 'calculated',
    });
  });
});

// --- Scenario 1's own "or min_daily if greater" branch (fix round, finding 3a — this branch of the
// gross_commission formula was never exercised before: delivered_count * rate_per_unit < min_daily).

describe("Scenario 1's own gross_commission formula — the min_daily floor branch (fix round, finding 3a)", () => {
  it('delivered_count * rate_per_unit < min_daily -> gross_commission equals min_daily exactly', async () => {
    // rate_per_unit '1.000', min_daily '100.000': 2 deliveries * 1.000 = 2.000 < 100.000, so
    // gross_commission must be the floor, 100.000, not the tiered amount.
    await createFixtureCommissionRule({ ratePerUnit: '1.000', minDaily: '100.000' });
    const employeeId = await createFixtureEmployee('mindaily');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-01T00:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T02:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T03:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const result = await calculateDailyCommission(
      ctx,
      { employeeId, workDate: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCommissionDailyIds.push(result.commissionDailyId);

    expect(result.deliveredCount).toBe(2);
    expect(result.grossCommission).toBe('100.000');

    const row = await getCommissionDailyRow(result.commissionDailyId);
    expect(row?.gross_commission).toBe('100.000');
  });
});

// --- Scenario: A second calculation for the same employee and day is rejected ---------------------

describe('Scenario: A second calculation for the same employee and day is rejected', () => {
  it("fails with a mapped CommissionAlreadyCalculatedError (the DB's own unique (work_date, employee_id) violation, translated) and writes no new row", async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('dup');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-01T00:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T02:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    const first = await calculateDailyCommission(
      ctx,
      { employeeId, workDate: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCommissionDailyIds.push(first.commissionDailyId);

    await expect(
      calculateDailyCommission(ctx, { employeeId, workDate: TODAY, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(CommissionAlreadyCalculatedError);

    expect(await countCommissionDailyRows(employeeId, TODAY)).toBe(1);
  });
});

// --- Scenario: No applicable commission rule fails clearly -----------------------------------------

describe('Scenario: No applicable commission rule fails clearly', () => {
  it('fails with a mapped NoApplicableCommissionRuleError and writes no row', async () => {
    // Deliberately NO hr.commission_rules row covers NO_RULE_WORKDATE (well before RULE_VALID_FROM
    // used by every other scenario's own fixture rule).
    const employeeId = await createFixtureEmployee('norule');
    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    await expect(
      calculateDailyCommission(ctx, { employeeId, workDate: NO_RULE_WORKDATE, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(NoApplicableCommissionRuleError);

    expect(await countCommissionDailyRows(employeeId, NO_RULE_WORKDATE)).toBe(0);
  });
});

// --- Scenario: A shipment attributed via a stale direct driver_code join is never counted ---------

describe('Scenario: A shipment attributed via a stale direct driver_code join is never counted — only the assignment-table view is trusted', () => {
  it('deliveredCount only reflects genuinely assignment-attributed shipments; the stale-driver_id shipment is invisible via imile.shipments_attributed and appears in imile.verify_attribution() as unattributed', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('stale');
    const { id: driverIdRef, imileCode: genuineCode } = await createFixtureDriverId('assigned');
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-01T00:00:00.000Z');
    // two GENUINE shipments, correctly attributed via the active assignment.
    await createFixtureShipment(genuineCode, '2024-06-01T02:00:00.000Z');
    await createFixtureShipment(genuineCode, '2024-06-01T03:00:00.000Z');

    // a STALE driver_id: exists in imile.driver_ids, but has NO imile.driver_id_assignments row at
    // all (a lapsed or never-assigned code) — its shipment must never leak into anyone's count via a
    // direct driver_code join (brief's own INV-C4-1-equivalent for iMile attribution).
    const { imileCode: staleCode } = await createFixtureDriverId('available');
    const staleTrackingNo = await createFixtureShipment(staleCode, '2024-06-01T04:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const result = await calculateDailyCommission(
      ctx,
      { employeeId, workDate: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCommissionDailyIds.push(result.commissionDailyId);

    expect(result.deliveredCount).toBe(2); // NOT 3 — the stale shipment is excluded.
    expect(result.failedCount).toBe(0);
    expect(result.returnedCount).toBe(0);

    const row = await getCommissionDailyRow(result.commissionDailyId);
    expect(row?.delivered_count).toBe(2);

    // proves the stale shipment really is unattributed (invisible through shipments_attributed, same
    // as imile.verify_attribution() flags it) rather than silently miscounted elsewhere.
    const unattributed = await verifyAttributionTrackingNos(TODAY, TODAY);
    expect(unattributed).toContain(staleTrackingNo);
  });

  // fix round, finding 3c: the case above (an orphan driver_id with NO assignment row at all) does
  // not discriminate "attribution through the assignment table" from "a bug that joined driver_code
  // directly, ignoring the assignment window entirely" — a direct-join bug would ALSO exclude a
  // truly orphan code by coincidence (no employee owns it either way), and would also naturally
  // respect the SQL `ofd_at::date = workDate` filter if the stray shipment fell on a different
  // calendar day. The real discriminating case, named by the brief's own scenario title ("the
  // employee who currently holds that driver_id"), needs the mismatched shipment on the SAME
  // calendar day (workDate) as the genuine ones, but with ofd_at before the assignment's own
  // `assigned_from` timestamp — same driver_code, same day, but genuinely outside the assignment's
  // active window. A direct driver_code join (ignoring the time window) would still (wrongly) count
  // it; the correct, assignment-table-only join must not.
  it("a shipment on the employee's OWN driver_id/code, same workDate, but with ofd_at BEFORE the assignment's own assigned_from, is NOT counted (the real \"assignment table, not driver_code\" discriminator)", async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('window');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    // the assignment starts mid-day (04:00 UTC) on TODAY — a shipment earlier the SAME day is
    // outside the active window even though it carries the employee's own genuine driver_code.
    await createFixtureAssignment(driverIdRef, employeeId, '2024-06-01T04:00:00.000Z');
    // one genuine, in-window shipment (after assigned_from) — counted.
    await createFixtureShipment(imileCode, '2024-06-01T05:00:00.000Z');
    // one out-of-window shipment on the SAME driver_code and SAME calendar day, but BEFORE
    // assigned_from — must NOT be counted.
    await createFixtureShipment(imileCode, '2024-06-01T01:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const result = await calculateDailyCommission(
      ctx,
      { employeeId, workDate: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCommissionDailyIds.push(result.commissionDailyId);

    // only the in-window shipment counts — the out-of-window one, same day and same driver_code,
    // proves attribution truly respects the assignment's own time window, not merely driver_code.
    expect(result.deliveredCount).toBe(1);
  });
});

// --- part 2 round-1 finding 1 (real bug, now closed): the Kuwait business-day boundary ------------
// pg-backend's fix (../../infrastructure/calculate-daily-commission/repository.ts's own
// `BUSINESS_TIMEZONE = 'Asia/Kuwait'`, `(ofd_at AT TIME ZONE 'Asia/Kuwait')::date`) replaces a bare
// `ofd_at::date` cast that depended on the connecting session's own implicit TimeZone. This proves
// the fix against the ACTUAL midnight boundary: Asia/Kuwait is UTC+3 (no DST), so a shipment at
// 2024-05-31T22:00:00Z (UTC calendar day May 31) is already 2024-06-01T01:00 Kuwait-local — it must
// be counted under workDate '2024-06-01', not '2024-05-31'. Conversely a shipment at
// 2024-06-01T22:00:00Z (UTC calendar day June 1) is already 2024-06-02T01:00 Kuwait-local — it must
// NOT be counted under workDate '2024-06-01', it belongs to the FOLLOWING Kuwait business day
// (2024-06-02).
//
// Round-2 fix (this round, finding 1 of the review): the previous version of this test only
// asserted `deliveredCount === 1`, which BOTH the old buggy UTC-cast code and the Kuwait-explicit
// fix produce for this exact pair of shipments (a naive UTC ::date cast reads 2024-05-31T22:00:00Z
// as calendar day May 31, NOT June 1 — the previous comment's claim that a naive cast would count
// BOTH shipments as June 1 was factually wrong). The rewritten test below is a genuine two-sided
// proof: it asserts WHICH specific tracking number is counted for workDate 2024-06-01 (via
// source_snapshot.deliveredTrackingNos, proving the OTHER shipment was excluded, not merely that
// some count matched), and separately computes workDate 2024-06-02 and asserts the SECOND shipment
// lands there instead — a case only the Kuwait-explicit fix, not a naive UTC cast, gets right on
// both sides of the boundary.
describe('Part 2 round-1 finding 1 (real bug, now closed) — shipments are attributed to the correct Kuwait-local business day, not the raw UTC calendar date', () => {
  it("a shipment at 2024-05-31T22:00:00Z (UTC May 31, but 2024-06-01T01:00 Kuwait-local) is the ONLY one counted under workDate '2024-06-01' (proved by tracking number, not just count); a shipment at 2024-06-01T22:00:00Z (UTC June 1, but 2024-06-02T01:00 Kuwait-local) is instead the ONLY one counted under workDate '2024-06-02'", async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('kuwaitboundary');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    // assignment window covers both UTC calendar days involved, well clear of either boundary.
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-01T00:00:00.000Z');

    // Kuwait-local 2024-06-01T01:00 — belongs to workDate 2024-06-01's own Kuwait business day.
    const juneFirstTrackingNo = await createFixtureShipment(imileCode, '2024-05-31T22:00:00.000Z');
    // Kuwait-local 2024-06-02T01:00 — belongs to the NEXT Kuwait business day, 2024-06-02.
    const juneSecondTrackingNo = await createFixtureShipment(imileCode, '2024-06-01T22:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    const resultJune1 = await calculateDailyCommission(
      ctx,
      { employeeId, workDate: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCommissionDailyIds.push(resultJune1.commissionDailyId);

    expect(resultJune1.deliveredCount).toBe(1);
    const rowJune1 = await getCommissionDailyRow(resultJune1.commissionDailyId);
    expect((rowJune1?.source_snapshot as { deliveredTrackingNos: string[] } | undefined)?.deliveredTrackingNos).toEqual([
      juneFirstTrackingNo,
    ]);

    // the OTHER shipment must land on the FOLLOWING Kuwait business day, 2024-06-02 — proving the
    // fix respects the boundary on BOTH sides, not merely excluding one shipment by coincidence.
    const resultJune2 = await calculateDailyCommission(
      ctx,
      { employeeId, workDate: '2024-06-02', correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCommissionDailyIds.push(resultJune2.commissionDailyId);

    expect(resultJune2.deliveredCount).toBe(1);
    const rowJune2 = await getCommissionDailyRow(resultJune2.commissionDailyId);
    expect((rowJune2?.source_snapshot as { deliveredTrackingNos: string[] } | undefined)?.deliveredTrackingNos).toEqual([
      juneSecondTrackingNo,
    ]);
  });

  // part 2 round-1 finding 1's own second gap: getActiveDriverIdRef's Kuwait window
  // (../../infrastructure/calculate-daily-commission/repository.ts:173-181) had NO boundary test at
  // all. An assignment with `assigned_from` at 2024-05-31T21:30:00Z (Kuwait-local
  // 2024-06-01T00:30) is already active at Kuwait midnight for workDate 2024-06-01, even though its
  // raw UTC timestamp reads "May 31" on a naive read — driver_id_ref must still be set for
  // workDate 2024-06-01.
  it("an assignment whose assigned_from is 2024-05-31T21:30:00Z (Kuwait-local 2024-06-01T00:30, active at Kuwait midnight) sets driver_id_ref for workDate '2024-06-01', even though assigned_from reads UTC calendar day May 31", async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('kuwaitassignboundary');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    // Kuwait-local 2024-06-01T00:30 — already active at the START of the Kuwait business day
    // 2024-06-01, despite its own UTC timestamp reading "2024-05-31".
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-31T21:30:00.000Z');
    // one shipment safely inside 2024-06-01's own Kuwait business day, well clear of either
    // boundary — the point under test is driver_id_ref, not deliveredCount.
    await createFixtureShipment(imileCode, '2024-06-01T05:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const result = await calculateDailyCommission(
      ctx,
      { employeeId, workDate: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCommissionDailyIds.push(result.commissionDailyId);

    const row = await getCommissionDailyRow(result.commissionDailyId);
    expect(row?.driver_id_ref).toBe(driverIdRef);
  });
});

// --- Scenario: An outsider (non-internal) cannot trigger a calculation -----------------------------

describe('Scenario: An outsider (non-internal) cannot trigger a calculation', () => {
  it('the command is refused with EntityScopeAmbiguousError (outsiderCtx has NO identity.user_entities row — cardinality 0, fix round finding 3e: tightened from a bare rejects.toThrow() to the specific error class actually expected here) and no hr.commission_daily row is written', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('outsider');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-01T00:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T02:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    await expect(
      calculateDailyCommission(outsiderCtx, { employeeId, workDate: TODAY, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(EntityScopeAmbiguousError);

    expect(await countCommissionDailyRows(employeeId, TODAY)).toBe(0);
  });
});

// --- part 1's OWN round-2 finding 1: the cross-entity case pg-backend's fix (6c16c41) already
// closed — this is regression coverage of an already-merged fix, not part 2's own finding 1 (which
// is the Kuwait business-day boundary, covered in its own describe block above) ------------------

describe("Part 1's own round-2 finding 1 (already fixed, merged as 6c16c41) — a caller-supplied employeeId belonging to a DIFFERENT entity is refused", () => {
  it('an employee created under entity PDL, called with an actor scoped to entity PST, is refused with EmployeeNotInCallerEntityError and NO row is written', async () => {
    await createFixtureCommissionRule(); // under entityId (PST) — irrelevant here, the employee check fires first.
    // deliberately inserted directly under entityBId (PDL), NOT via createFixtureEmployee (which
    // always uses the module-level `entityId`, PST) — this is the cross-entity target.
    const otherEntityEmployeeResult: QueryResult<{ id: string }> = await pool.query(
      `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
         values ($1, $2, $3, current_date, 'active') returning id::text as id`,
      [entityBId, nextEmployeeCode(), 'موظف كيان آخر — WBS 3.13 finding 1'],
    );
    const otherEntityEmployeeId = otherEntityEmployeeResult.rows[0]?.id;
    if (!otherEntityEmployeeId) throw new Error('failed to insert cross-entity fixture hr.employees row');
    fixtureEmployeeIds.push(otherEntityEmployeeId);

    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    // ctx is scoped to entityId (PST) only — the employee above belongs to entityBId (PDL).
    await expect(
      calculateDailyCommission(
        ctx,
        { employeeId: otherEntityEmployeeId, workDate: TODAY, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(EmployeeNotInCallerEntityError);

    expect(await countCommissionDailyRows(otherEntityEmployeeId, TODAY)).toBe(0);
  });
});

// --- part 2 round-2 finding 2: the application layer's own ctx.isInternal gate, for a REAL
// entity-scoped actor

describe("Part 2 round-2 finding 2 — a non-internal actor WITH a real entity scope is refused by NotInternalActorError, TRANSLATING hr.commission_daily's own internal_write policy (not merely EntityScopeAmbiguousError, unlike outsiderCtx above)", () => {
  it('NON_INTERNAL_WITH_ENTITY_ACTOR_UUID (real identity.user_entities row, ctx.isInternal: false) is refused with NotInternalActorError and no row is written', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('noninternalwithentity');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-01T00:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T02:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const nonInternalWithEntityCtx = {
      userId: NON_INTERNAL_WITH_ENTITY_ACTOR_UUID,
      clientId: null,
      isInternal: false,
    };

    // resolveCallerEntityId succeeds here (unlike outsiderCtx) — the refusal comes from the
    // application layer's own explicit ctx.isInternal gate (part 2 round-2 finding 2's fix,
    // ../../application/calculate-daily-commission/calculate-daily-commission.ts step 1a, checked
    // AFTER resolveCallerEntityId succeeds but BEFORE any employee/shipment/rule read or the
    // INSERT), TRANSLATING hr.commission_daily's own `internal_write` INSERT/UPDATE policy
    // (migration 0027, `platform.is_internal() and entity_id = any(platform.allowed_entities())`)
    // into a typed error BEFORE the write is even attempted — no raw RLS SQLSTATE 42501 reaches the
    // caller anymore.
    await expect(
      calculateDailyCommission(
        nonInternalWithEntityCtx,
        { employeeId, workDate: TODAY, correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(NotInternalActorError);

    expect(await countCommissionDailyRows(employeeId, TODAY)).toBe(0);
  });
});

// --- part 2 round-2 finding 2 (own_commission clause): entity-scoped SELECT hides another
// entity's row ------------------------------------------------------------------------------------

describe("Part 2 round-2 finding 2 (own_commission clause) — own_commission's entity-scoped SELECT (migration 0027 item 2) hides an entity-A row from an entity-B hr.commission.read_all holder", () => {
  const APP_ROLE = process.env['PG_APP_USER'] ?? 'pgeos_app';

  interface AppRoleCtx {
    readonly userId: string | null;
    readonly clientId: string | null;
    readonly isInternal: boolean;
  }

  /** Same reproduction of withContext(ctx, fn)'s own GUC-setting contract as
   *  tests/isolation/tests/shipments-attributed-invoker-rls.test.ts's own `withAppRole` — needed
   *  here (rather than going through calculateDailyCommission) because this test proves a raw
   *  SELECT's own RLS visibility, not a write path. */
  async function withAppRole<T>(appCtx: AppRoleCtx, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
      host: process.env['PGHOST'] ?? 'localhost',
      port: Number(process.env['PGPORT'] ?? '5432'),
      user: APP_ROLE,
      database: process.env['PGDATABASE'] ?? 'pgeos',
    });
    await client.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [appCtx.userId]);
      await client.query("select set_config('app.client_id', $1, true)", [appCtx.clientId]);
      await client.query("select set_config('app.is_internal', $1, true)", [appCtx.isInternal ? 'true' : 'false']);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // original error still wins.
      }
      throw error;
    } finally {
      await client.end();
    }
  }

  it('an entity-B SALES_MGR (hr.commission.read_all holder) querying hr.commission_daily does NOT see an entity-A row that genuinely exists in the table', async () => {
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('entityaselect');
    const { id: driverIdRef, imileCode } = await createFixtureDriverId('assigned');
    await createFixtureAssignment(driverIdRef, employeeId, '2024-05-01T00:00:00.000Z');
    await createFixtureShipment(imileCode, '2024-06-01T02:00:00.000Z');

    const deps = createCalculateDailyCommissionDeps({ clock, ids });
    const entityARow = await calculateDailyCommission(
      ctx,
      { employeeId, workDate: TODAY, correlationId: nextCorrelationId() },
      deps,
    );
    fixtureCommissionDailyIds.push(entityARow.commissionDailyId);

    // vacuity guard: the row genuinely exists (admin pool bypasses RLS).
    const adminCheck: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where id = $1`,
      [entityARow.commissionDailyId],
    );
    expect(Number(adminCheck.rows[0]?.n ?? '0')).toBe(1);

    const entityBReadAllCtx: AppRoleCtx = {
      userId: ENTITY_B_READ_ALL_ACTOR_UUID,
      clientId: null,
      isInternal: true,
    };
    const result = await withAppRole(entityBReadAllCtx, (client) =>
      client.query<{ id: string }>(`select id from hr.commission_daily where id = $1`, [entityARow.commissionDailyId]),
    );
    expect(result.rows).toEqual([]);
  });

  // fix round, finding 5: the test above has NO positive control — it never proves the SALES_MGR
  // actor actually HOLDS hr.commission.read_all, nor that the same actor CAN see an entity-B row
  // (only entity-A rows were ever proven hidden). If the 13B seed granting that permission to
  // SALES_MGR ever changed, the test above could pass for the WRONG reason (the actor simply can't
  // read anything at all, not because entity-scoping specifically works). This test proves the
  // positive side: the grant is genuinely live (a direct query against identity's own permission
  // tables) AND the same actor CAN read an entity-B row that genuinely exists — own_commission's
  // `entity_id = any(platform.allowed_entities())` AND-condition (migration 0027 item 2) is what
  // scopes visibility, not a blanket refusal to read anything.
  it('positive control: the SALES_MGR actor genuinely HOLDS hr.commission.read_all (seed-granted, not assumed) AND CAN read an entity-B row that exists', async () => {
    const grantResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n
         from identity.user_roles ur
         join identity.roles r on r.id = ur.role_id
         join identity.role_permissions rp on rp.role_id = r.id
         join identity.permissions p on p.id = rp.permission_id
        where ur.user_id = $1 and r.code = $2 and p.code = 'hr.commission.read_all'`,
      [ENTITY_B_READ_ALL_ACTOR_UUID, SALES_MGR_ROLE_CODE],
    );
    expect(Number(grantResult.rows[0]?.n ?? '0')).toBeGreaterThan(0);

    // an entity-B commission_daily row, genuinely inserted under entityBId (not this suite's
    // module-level entityId/PST — createFixtureEmployee always uses PST).
    await createFixtureCommissionRule(); // under entityId (PST) — irrelevant to the entity-B insert below.
    const entityBEmployeeResult: QueryResult<{ id: string }> = await pool.query(
      `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
         values ($1, $2, $3, current_date, 'active') returning id::text as id`,
      [entityBId, nextEmployeeCode(), 'موظف كيان آخر — WBS 3.13 fix round finding 5'],
    );
    const entityBEmployeeId = entityBEmployeeResult.rows[0]?.id;
    if (!entityBEmployeeId) throw new Error('failed to insert entity-B fixture hr.employees row');
    fixtureEmployeeIds.push(entityBEmployeeId);

    const entityBRuleResult: QueryResult<{ id: string }> = await pool.query(
      `insert into hr.commission_rules
          (entity_id, name, applies_to, client_id, tier_from, tier_to, rate_per_unit, min_daily, valid_from, valid_to)
         values ($1, $2, 'driver', null, 0, null, $3, '0', $4, null)
         returning id::text as id`,
      [entityBId, `WBS 3.13 fixture rule entity-B ${randomUUID()}`, RATE_PER_UNIT, RULE_VALID_FROM],
    );
    const entityBRuleId = entityBRuleResult.rows[0]?.id;
    if (!entityBRuleId) throw new Error('failed to insert entity-B fixture hr.commission_rules row');
    fixtureCommissionRuleIds.push(entityBRuleId);

    const entityBCommissionDailyResult: QueryResult<{ id: string }> = await pool.query(
      `insert into hr.commission_daily
          (entity_id, work_date, employee_id, driver_id_ref, delivered_count, failed_count,
           returned_count, gross_commission, source_snapshot, rule_snapshot, status)
         values ($1, $2, $3, null, 1, 0, 0, '5.000', '{}'::jsonb, '{}'::jsonb, 'calculated')
         returning id::text as id`,
      [entityBId, TODAY, entityBEmployeeId],
    );
    const entityBCommissionDailyId = entityBCommissionDailyResult.rows[0]?.id;
    if (!entityBCommissionDailyId) throw new Error('failed to insert entity-B fixture hr.commission_daily row');
    fixtureCommissionDailyIds.push(entityBCommissionDailyId);

    const entityBReadAllCtx: AppRoleCtx = {
      userId: ENTITY_B_READ_ALL_ACTOR_UUID,
      clientId: null,
      isInternal: true,
    };
    const result = await withAppRole(entityBReadAllCtx, (client) =>
      client.query<{ id: string }>(`select id from hr.commission_daily where id = $1`, [entityBCommissionDailyId]),
    );
    expect(result.rows).toEqual([{ id: entityBCommissionDailyId }]);
  });
});

// --- Scenario: AmbiguousCommissionRuleError (fix round, finding 3d) -------------------------------

describe('Fix round, finding 3d — two overlapping hr.commission_rules rows for the same entity/tier fail with AmbiguousCommissionRuleError (brief default 2, no tie-break invented)', () => {
  it('two overlapping commission_rules rows for the same entity and tier window -> rejects with AmbiguousCommissionRuleError, no row written', async () => {
    await createFixtureCommissionRule(); // deliberately overlapping default tier windows.
    await createFixtureCommissionRule();
    const employeeId = await createFixtureEmployee('ambiguous');
    const deps = createCalculateDailyCommissionDeps({ clock, ids });

    await expect(
      calculateDailyCommission(ctx, { employeeId, workDate: TODAY, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(AmbiguousCommissionRuleError);

    expect(await countCommissionDailyRows(employeeId, TODAY)).toBe(0);
  });
});
