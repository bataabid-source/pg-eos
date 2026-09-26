// modules/hr/tests/dispute-commission/dispute-commission.test.ts — WBS 3.13 part 4.
//
// Integration tests, one per scenario in ./dispute-commission.feature, against the real database
// as pgeos_app (RLS genuinely enforced — every command call goes through withContext/
// withIdempotentContext, same discipline as modules/hr/tests/calculate-daily-commission/
// calculate-daily-commission.test.ts, this module's own nearest precedent).
//
// Sources: docs/notes/slice-briefs/_slice-3.13-part4.brief.md (Scenario/Contract/Deliver blocks,
// verbatim); database/schema/13-Schema-Additions.sql:364-389 (hr.commission_daily); 13B:4983-4988
// (platform.my_employee_id()); tasks/backlog/MIGRATION-REQUEST-3.md row 3 (the pending migration —
// see the RED note below).
//
// **GREEN, built (migration 0033 applied — round-5 fix-round update, was "RED, TWO LAYERS ...
// pending migration" through round 4; the migration has since applied and gone stable across 5
// review rounds):** modules/hr/domain/dispute-commission/**, modules/hr/application/
// dispute-commission/**, modules/hr/api/dispute-commission/**, packages/contracts/hr/
// dispute-commission.ts are built; migration 0033 (hr.guard_commission_daily_status() trigger,
// chk_commission_daily_status corrected to calculated|disputed|confirmed|paid, platform.thresholds
// seed hr.commission.dispute_window_hours = 48, database/migrations/0033_3_commission-daily-status-
// lifecycle.sql) is applied on pgeos_lane3. Any test below that is still red is called out
// individually as "red-pending-pg-backend's parallel fix" in this fix round's own report, never
// silently left unexplained.
//
// Surface this file pins (once GREEN and built):
//   modules/hr/domain/dispute-commission/{errors.ts,machine.ts,invariants.ts}
//     - DisputeWindowExpiredError (brief, Deliver).
//     - isWithinDisputeWindow(createdAt: Date, now: Date, thresholdHours: number): boolean
//       (this file's own property-test sibling, ./invariants.property.test.ts, exercises this pure
//       function directly; this integration file only proves the command's END-TO-END behaviour).
//   modules/hr/application/dispute-commission/index.ts (re-exports disputeCommission)
//     - disputeCommission(ctx, input, deps): Promise<DisputeCommissionResult>
//       -> { commissionDailyId, status: 'disputed' } (Contract line).
//   modules/hr/api/dispute-commission/composition.ts
//     - createDisputeCommissionDeps(overrides).
//
// DisputeCommissionInput (Contract line, brief): { commissionDailyId: uuid, disputeNote: string
// (min length 1), correlationId: uuid }.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only) plus a real
// identity.users row for the disputing driver's own actor (linked via identity.users.employee_id,
// 13B:4983-4988 platform.my_employee_id()), and hr.commission_daily fixture rows inserted directly
// (bypassing CalculateDailyCommission — this slice only exercises the status lifecycle around an
// already-calculated row, brief decision 6). PG_APP_USER=pgeos_app is REQUIRED to run this suite
// (every command call goes through withContext(ctx, fn) as pgeos_app, genuinely subject to RLS).
// D-183: a DELETE against the shared database is only allowed in this suite's own `afterAll`, never
// in `beforeAll` — `beforeAll` only ever upserts the fixture actor(s).
//
// A FixedClock at a date safely in the PAST relative to real wall-clock time (2024-06-01) is used
// throughout — a clock literal too close to real "now" caused a false failure in WBS 3.12's own
// suite when a DB trigger's own now() raced it (lesson recorded this session, repeated in every
// sibling suite's own header since).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The modules under test — built and GREEN (see file header for the RED→GREEN history).
import { disputeCommission } from '../../application/dispute-commission/index.js';
import { createDisputeCommissionDeps } from '../../api/dispute-commission/composition.js';
import {
  CannotDisputeAnotherEmployeesRowError,
  DisputeWindowExpiredError,
  IllegalTransitionError,
  StaleVersionError,
} from '../../domain/dispute-commission/errors.js';
// the package subpath export (@pg-eos/contracts/hr/dispute-commission), not a deep relative path —
// packages/contracts/hr/dispute-commission.ts is pg-backend's own file to author (brief Write ONLY
// line), not this test file's.
import { DisputeCommissionInputSchema } from '@pg-eos/contracts/hr/dispute-commission';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const DRIVER_ACTOR_UUID = '00000000-0000-4000-8000-0000003134a1';
const OTHER_DRIVER_ACTOR_UUID = '00000000-0000-4000-8000-0000003134a2';
// round-5 fix-round, finding 2 (pairs with pg-backend's own new SoD check on disputeCommission): an
// internal actor visible via hr.driver_commission.read_all (DEL_SUP — 13B:561), never linked to any
// employee, so any successful confirm/dispute it performs is genuinely the read_all path, not an
// own-row coincidence — same discipline as ../confirm-commission/confirm-commission.test.ts's own
// READ_ALL_ONLY_ACTOR_UUID/DEL_SUP_ACTOR_UUID actors.
const READ_ALL_INTERNAL_ACTOR_UUID = '00000000-0000-4000-8000-0000003134a3';
const DEL_SUP_ROLE_CODE = 'DEL_SUP';

// Safely in the past (lesson this session — see file header). 2024-06-01T06:00:00Z is 09:00
// Asia/Kuwait (UTC+3, no DST) — matches every sibling suite's own reference "now".
const NOW = new Date('2024-06-01T06:00:00.000Z');
const clock = new FixedClock(NOW);
const ids = new SequentialIdGenerator(3134);

const DISPUTE_WINDOW_THRESHOLD_KEY = 'hr.commission.dispute_window_hours';
const HOURS_TO_MS = 60 * 60 * 1000;

let entityId: string;
const fixtureEmployeeIds: string[] = [];
const fixtureCommissionDailyIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

// Migration 0029 (SCR-HR-EMP-01, doc 40 §C7) adds chk_employees_code_format on hr.employees:
// code ~ '^PG-[0-9]{4}$'. This suite's own fixture codes stay in the PG-7300-PG-7399 range
// (disjoint from every sibling suite's own range, see those files' own headers for the convention).
let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (300 + employeeCodeCounter++).toString();
  return `PG-7${suffix}`;
}

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

async function createFixtureEmployee(labelSuffix: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, 'active') returning id::text as id`,
    [entityId, nextEmployeeCode(), `سائق اختبار اعتراض العمولة — WBS 3.13 part 4 ${labelSuffix}`],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  return id;
}

/** a raw hr.commission_daily fixture row, inserted directly (bypassing CalculateDailyCommission —
 *  brief decision 6: this slice does not touch calculation, only the status lifecycle around an
 *  already-calculated row). `createdAt` is fully controlled so the 48-hour window boundary is
 *  tested deterministically against the FixedClock's own NOW, never real wall-clock time.
 *
 *  migration 0033 round-4 review finding 2: hr.guard_commission_daily_status()'s own trigger
 *  rejects an INSERT whose status is anything other than 'calculated' (an INSERT has no prior
 *  state for the transition-guard branch to run against). A fixture row that needs to START
 *  'disputed' is therefore built in TWO steps: INSERT as 'calculated' (always legal), then a bare
 *  UPDATE to 'disputed' (a legal calculated -> disputed transition, no permission gate on that
 *  edge) — same two-step pattern as ../confirm-commission/confirm-commission.test.ts's own
 *  createFixtureCommissionDaily (this file's own sibling), fixed here to match (round-5 fix-round:
 *  this file's own single-step INSERT-as-'disputed' variant was never actually exercised by any
 *  test in this file before this round, but would have failed the live trigger the first time it
 *  was).
 *
 *  round-5-fix-round-2 (finding 1, pre-migration review round 1 on migration 0035): once 0035 lands,
 *  hr.guard_commission_daily_status()'s new EXISTS check on the calculated -> disputed edge requires
 *  platform.current_user_id() to resolve to the ROW'S OWN employee's own linked user — a bare
 *  admin-pool UPDATE with no session actor set (app.user_id stays NULL) would then fail with
 *  insufficient_privilege, turning this fixture helper itself red. The one caller in this file that
 *  builds a row already 'disputed' (the IllegalTransitionError scenario) always links
 *  DRIVER_ACTOR_UUID to `employeeId` via setDisputingEmployee first — this helper now does that
 *  linking itself (idempotent if the caller already did it too) and runs the UPDATE inside a
 *  dedicated `pool.connect()` client with a TRANSACTION-LOCAL `set_config('app.user_id', ..., true)`
 *  scoped to DRIVER_ACTOR_UUID, so the write genuinely passes the coming check instead of merely
 *  bypassing it via the admin connection's RLS-exempt superuser — same discipline as
 *  packages/db/src/with-context.ts and this file's own WBS-3.13-part-5a test (below). */
async function createFixtureCommissionDaily(params: {
  readonly employeeId: string;
  readonly workDate: string;
  readonly createdAt: Date;
  readonly status?: 'calculated' | 'disputed';
  readonly disputeNote?: string;
  readonly disputedAt?: Date;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.commission_daily
        (entity_id, work_date, employee_id, source_snapshot, status, created_at)
       values ($1, $2, $3, '{}'::jsonb, 'calculated', $4)
       returning id::text as id`,
    [entityId, params.workDate, params.employeeId, params.createdAt.toISOString()],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.commission_daily row');
  fixtureCommissionDailyIds.push(id);

  if (params.status === 'disputed') {
    await setDisputingEmployee(params.employeeId);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [DRIVER_ACTOR_UUID]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      await client.query(
        `update hr.commission_daily set status = 'disputed', dispute_note = $1, disputed_at = $2 where id = $3`,
        [params.disputeNote ?? 'اعتراض اختباري', (params.disputedAt ?? params.createdAt).toISOString(), id],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  return id;
}

/** links DRIVER_ACTOR_UUID's own identity.users row to `employeeId` — own_commission's SELECT
 *  policy (migration 0027/0033) gates visibility on `employee_id = platform.my_employee_id()` (this
 *  actor holds no read_all-class permission), so every scenario that calls disputeCommission as
 *  DRIVER_ACTOR_UUID must link it to the SAME employee the fixture row belongs to BEFORE the call,
 *  or the row reads back invisible (null) and the command fails with StaleVersionError for the
 *  wrong reason (a pre-existing gap in this file, fixed here — same pattern as
 *  ../confirm-commission/confirm-commission.test.ts's own setDisputingEmployee). */
async function setDisputingEmployee(employeeId: string): Promise<void> {
  await pool.query(`update identity.users set employee_id = $1 where id = $2`, [employeeId, DRIVER_ACTOR_UUID]);
}

async function getCommissionDailyRow(id: string): Promise<
  | {
      status: string;
      dispute_note: string | null;
      disputed_at: string | null;
      version: number;
    }
  | undefined
> {
  const result = await pool.query(
    `select status, dispute_note, disputed_at::text as disputed_at, version
       from hr.commission_daily where id = $1`,
    [id],
  );
  return result.rows[0];
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

/** read live, never hardcoded (CLAUDE.md "No magic numbers") — this is the same
 *  platform.thresholds row the pending migration (MIGRATION-REQUEST-3.md row 3) seeds. Absence of
 *  this row is exactly the second RED layer this file's own header describes; once the migration
 *  is applied, this returns 48. */
async function getDisputeWindowHours(): Promise<number> {
  const result: QueryResult<{ value: string }> = await pool.query(
    `select value::text as value from platform.thresholds where key = $1`,
    [DISPUTE_WINDOW_THRESHOLD_KEY],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `platform.thresholds row '${DISPUTE_WINDOW_THRESHOLD_KEY}' not found — is the pending migration ` +
        '(MIGRATION-REQUEST-3.md row 3) applied? (expected RED until it is)',
    );
  }
  return Number(row.value);
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`fixture platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  // D-183: no DELETE here — beforeAll only upserts.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [DRIVER_ACTOR_UUID, `_hr_disputecommission_${DRIVER_ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل اختبار اعتراض العمولة — WBS 3.13 part 4'],
  );
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      OTHER_DRIVER_ACTOR_UUID,
      `_hr_disputecommission_other_${OTHER_DRIVER_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل اختبار اعتراض آخر — WBS 3.13 part 4',
    ],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [DRIVER_ACTOR_UUID, entityId],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [OTHER_DRIVER_ACTOR_UUID, entityId],
  );

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      READ_ALL_INTERNAL_ACTOR_UUID,
      `_hr_disputecommission_readall_${READ_ALL_INTERNAL_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل مشرف توصيل — رؤية كل عمولات السائقين — WBS 3.13 part 4',
    ],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [READ_ALL_INTERNAL_ACTOR_UUID, entityId],
  );
  await grantRole(READ_ALL_INTERNAL_ACTOR_UUID, DEL_SUP_ROLE_CODE);
});

afterAll(async () => {
  if (fixtureCommissionDailyIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where id = any($1::uuid[])`, [fixtureCommissionDailyIds]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where employee_id = any($1::uuid[])`, [fixtureEmployeeIds]);
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  // platform.audit_log is NEVER deleted (CLAUDE.md-wide discipline, every prior slice).
  for (const userId of [DRIVER_ACTOR_UUID, OTHER_DRIVER_ACTOR_UUID, READ_ALL_INTERNAL_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/hr/dispute-commission — DisputeCommissionInputSchema shape (brief Contract line)', () => {
  it('accepts { commissionDailyId, disputeNote, correlationId }', () => {
    const parsed = DisputeCommissionInputSchema.parse({
      commissionDailyId: randomUUID(),
      disputeNote: 'لست موافقاً على هذا الحساب',
      correlationId: randomUUID(),
    });
    expect(parsed.disputeNote.length).toBeGreaterThan(0);
  });

  it('rejects an empty disputeNote (brief: "string (min length 1)")', () => {
    const result = DisputeCommissionInputSchema.safeParse({
      commissionDailyId: randomUUID(),
      disputeNote: '',
      correlationId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });
});

// --- Scenario: A driver disputes their own calculated commission within the 48-hour window ------

describe('Scenario: A driver disputes their own calculated commission within the 48-hour window', () => {
  it('the row\'s status becomes "disputed", dispute_note and disputed_at are recorded, one audit row is written', async () => {
    const thresholdHours = await getDisputeWindowHours();
    const employeeId = await createFixtureEmployee('within-window');
    await setDisputingEmployee(employeeId);
    // created just under the threshold ago — safely within the window.
    const createdAt = new Date(NOW.getTime() - (thresholdHours - 1) * HOURS_TO_MS);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-30',
      createdAt,
    });

    const ctx = { userId: DRIVER_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createDisputeCommissionDeps({ clock, ids });
    const correlationId = nextCorrelationId();
    const disputeNote = 'العدد الفعلي للطلبات المسلَّمة أكبر مما هو مُسجَّل';

    const result = await disputeCommission(ctx, { commissionDailyId, disputeNote, correlationId }, deps);

    expect(result).toEqual({ commissionDailyId, status: 'disputed' });

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('disputed');
    expect(row?.dispute_note).toBe(disputeNote);
    expect(row?.disputed_at).not.toBeNull();

    const auditRows = await auditRowsForCorrelation(correlationId);
    const commissionAudit = auditRows.filter((r) => r.table_name === 'commission_daily');
    expect(commissionAudit).toHaveLength(1);
    expect(commissionAudit[0]?.operation).toBe('update');
    expect(commissionAudit[0]?.record_id).toBe(commissionDailyId);
  });
});

// --- Scenario: A dispute after the 48-hour window is rejected -----------------------------------

describe('Scenario: A dispute after the 48-hour window is rejected', () => {
  it('fails with a mapped DisputeWindowExpiredError and writes no row (status stays "calculated")', async () => {
    const thresholdHours = await getDisputeWindowHours();
    const employeeId = await createFixtureEmployee('past-window');
    await setDisputingEmployee(employeeId);
    // created just over the threshold ago — safely past the window.
    const createdAt = new Date(NOW.getTime() - (thresholdHours + 1) * HOURS_TO_MS);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-29',
      createdAt,
    });

    const ctx = { userId: DRIVER_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createDisputeCommissionDeps({ clock, ids });

    await expect(
      disputeCommission(
        ctx,
        { commissionDailyId, disputeNote: 'اعتراض متأخر', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(DisputeWindowExpiredError);

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('calculated');
    expect(row?.dispute_note).toBeNull();
  });
});

// --- round-5 fix round, finding 2: an internal read_all-only actor must not be able to dispute a
// DIFFERENT employee's row on that employee's behalf ---------------------------------------------

describe(
  'round-5 fix round, finding 2 (SECURITY, pairs with pg-backend\'s new SoD check): an internal ' +
    'actor visible via hr.driver_commission.read_all cannot disputeCommission a DIFFERENT ' +
    "employee's row",
  () => {
    it(
      'READ_ALL_INTERNAL_ACTOR_UUID (DEL_SUP, holds hr.driver_commission.read_all, never linked to ' +
        'any employee) attempting to dispute a DIFFERENT employee\'s calculated row is refused with ' +
        'the SPECIFIC typed CannotDisputeAnotherEmployeesRowError (pg-backend\'s own parallel fix, ' +
        'this same fix round, modules/hr/domain/dispute-commission/errors.ts — landed by the time ' +
        'this test ran), the row is left unchanged (status stays "calculated", dispute_note stays ' +
        'null)',
      async () => {
        const employeeId = await createFixtureEmployee('read-all-not-owner');
        const commissionDailyId = await createFixtureCommissionDaily({
          employeeId,
          workDate: '2024-05-22',
          createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
        });

        const readAllOnlyCtx = { userId: READ_ALL_INTERNAL_ACTOR_UUID, clientId: null, isInternal: true };
        const deps = createDisputeCommissionDeps({ clock, ids });

        await expect(
          disputeCommission(
            readAllOnlyCtx,
            { commissionDailyId, disputeNote: 'محاولة اعتراض نيابة عن سائق آخر', correlationId: nextCorrelationId() },
            deps,
          ),
        ).rejects.toBeInstanceOf(CannotDisputeAnotherEmployeesRowError);

        const row = await getCommissionDailyRow(commissionDailyId);
        expect(row?.status).toBe('calculated');
        expect(row?.dispute_note).toBeNull();
      },
    );
  },
);

// --- round-5 fix round, finding 6: StaleVersionError / IllegalTransitionError coverage — missing
// entirely before this round -----------------------------------------------------------------------

describe('round-5 fix round, finding 6: StaleVersionError — optimistic-lock conflict on disputeCommission', () => {
  it(
    'two concurrent disputeCommission calls against the SAME row: exactly one succeeds ' +
      '(version 1 -> 2), the other rejects with StaleVersionError, no silent overwrite — same ' +
      "race technique as modules/imile/tests/pull-shipments/pull-shipments.test.ts's own " +
      "StaleVersionError test",
    async () => {
      const employeeId = await createFixtureEmployee('stale-version-race');
      await setDisputingEmployee(employeeId);
      const commissionDailyId = await createFixtureCommissionDaily({
        employeeId,
        workDate: '2024-05-23',
        createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      });

      const ctx = { userId: DRIVER_ACTOR_UUID, clientId: null, isInternal: true };
      const depsA = createDisputeCommissionDeps({ clock, ids });
      const depsB = createDisputeCommissionDeps({ clock, ids });

      const results = await Promise.allSettled([
        disputeCommission(
          ctx,
          { commissionDailyId, disputeNote: 'محاولة أولى متزامنة', correlationId: nextCorrelationId() },
          depsA,
        ),
        disputeCommission(
          ctx,
          { commissionDailyId, disputeNote: 'محاولة ثانية متزامنة', correlationId: nextCorrelationId() },
          depsB,
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleVersionError);

      const row = await getCommissionDailyRow(commissionDailyId);
      expect(row?.status).toBe('disputed');
      expect(row?.version).toBe(2);
    },
  );
});

describe('round-5 fix round, finding 6: IllegalTransitionError — disputing an already-disputed row', () => {
  it('disputeCommission on a row already "disputed" fails with IllegalTransitionError, no row change', async () => {
    const employeeId = await createFixtureEmployee('illegal-transition');
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-24',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });

    const ctx = { userId: DRIVER_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createDisputeCommissionDeps({ clock, ids });

    await expect(
      disputeCommission(
        ctx,
        { commissionDailyId, disputeNote: 'اعتراض ثانٍ على صف معترَض عليه بالفعل', correlationId: nextCorrelationId() },
        deps,
      ),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('disputed');
  });
});

// --- WBS 3.13 part 5a (deferred finding from part 4's slice-close review round 2, no round 3 per
// REVIEW CAP — MASTER_BACKLOG / MIGRATION-REQUEST-3 row 4): the calculated -> disputed edge has NO
// db-level actor check today — migration 0033's own self-review EXISTS-check (lines 266-272 of
// database/migrations/0033_3_commission-daily-status-lifecycle.sql) only fires on the edge REACHING
// 'confirmed'. Only the application layer (dispute-commission.ts step 2b, isOwnRow) enforces "an
// actor may only dispute their own commission" (doc 10 §14 l.300) today. This test bypasses the
// application command entirely — a raw SQL UPDATE straight against the pool, as an actor who is
// NEITHER the row's own employee NOR linked to it — and proves the missing DB-level backstop
// (migration 0035, not yet written — this test is expected RED until it lands). Never touches or
// duplicates the existing app-layer CannotDisputeAnotherEmployeesRowError test above (lines 438-475
// of this file) — that one proves the application layer; this one proves the trigger itself.
//
// pre-migration review round 1 (FAIL, 7 findings), finding 6 fix-round-2 note: the ROLLBACK in
// `finally` below runs unconditionally, whether or not the trigger actually fired — so the
// after-UPDATE row-read below proves nothing about the trigger by itself (it would read back
// unchanged even if the UPDATE had silently succeeded and only the test's own ROLLBACK undid it).
// The one assertion that actually proves the trigger rejected the write is the SQLSTATE check
// (`updateError.code === '42501'`); the row-read afterwards is kept only as a same-transaction
// sanity check (the client saw its own uncommitted write, or lack of one, before rolling back), never
// cited as independent proof. Migration 0035 does not exist yet, so no specific Arabic message
// substring can be asserted here yet (coordinate wording once 0035 lands — pg-backend-core's own
// migration will cite "WBS 3.13 part 5a" in its errcode='insufficient_privilege' message per the
// build brief; a future round adds `message: expect.stringContaining('WBS 3.13 part 5a')` here). ---

describe(
  'WBS 3.13 part 5a (SECURITY, DB backstop): a raw SQL UPDATE straight against hr.commission_daily, ' +
    "bypassing DisputeCommission entirely, setting status to 'disputed' while the acting session " +
    "actor (platform.current_user_id()) is NOT the row's own employee's own linked user, must be " +
    'rejected by the trigger itself (migration 0035 — not yet applied, RED until it is)',
  () => {
    it(
      'READ_ALL_INTERNAL_ACTOR_UUID (DEL_SUP, holds hr.driver_commission.read_all, never linked to ' +
        "any employee) issuing `UPDATE hr.commission_daily SET status='disputed', ... WHERE id=$1 " +
        'AND version=$2` directly, against a fixture row owned by a DIFFERENT fixture employee, with ' +
        "the acting session actor set via the SAME app.user_id GUC withContext uses (never through " +
        'disputeCommission/isOwnRow), rejects at the trigger level (insufficient_privilege) — SQLSTATE ' +
        '42501 is the only claim this test proves (see file comment above on why the post-UPDATE row ' +
        'read is a sanity check only, not independent proof)',
      async () => {
        // A single fixture employee (brief step 1) — the row belongs to employeeOwner; the acting
        // actor (READ_ALL_INTERNAL_ACTOR_UUID) is linked to neither this nor any other employee.
        const employeeOwner = await createFixtureEmployee('db-backstop-owner');

        const commissionDailyId = await createFixtureCommissionDaily({
          employeeId: employeeOwner,
          workDate: '2024-05-25',
          createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
        });

        const beforeRow = await getCommissionDailyRow(commissionDailyId);
        expect(beforeRow?.status).toBe('calculated');
        const expectedVersion = beforeRow?.version;

        // Same session-GUC convention as withContext (packages/db/src/with-context.ts) and this
        // repo's own precedent for a raw-actor test (packages/db/tests/idempotency.test.ts:347-361)
        // — a dedicated client, BEGIN, set_config(..., true) (transaction-local), the raw UPDATE,
        // then ROLLBACK regardless of outcome so this fixture client never leaks a session GUC back
        // to the pool.
        const client = await pool.connect();
        let updateError: unknown;
        try {
          await client.query('begin');
          await client.query(`select set_config('app.user_id', $1, true)`, [READ_ALL_INTERNAL_ACTOR_UUID]);
          await client.query(`select set_config('app.is_internal', 'true', true)`);
          try {
            await client.query(
              `update hr.commission_daily
                  set status = 'disputed', dispute_note = $1, disputed_at = now(), version = version + 1
                where id = $2 and version = $3`,
              ['محاولة تحايل عبر UPDATE مباشر — WBS 3.13 part 5a', commissionDailyId, expectedVersion],
            );
          } catch (error) {
            updateError = error;
          }
        } finally {
          await client.query('rollback');
          client.release();
        }

        expect(updateError).toBeDefined();
        expect((updateError as { code?: string } | undefined)?.code).toBe('42501'); // insufficient_privilege

        // Sanity check only (same-transaction read, before the unconditional rollback above) — NOT
        // independent proof the trigger fired (see file comment above finding 6 fix-round-2 note).
        const afterRow = await getCommissionDailyRow(commissionDailyId);
        expect(afterRow?.status).toBe('calculated');
        expect(afterRow?.version).toBe(expectedVersion);
      },
    );
  },
);

// --- WBS 3.13 part 5a, pre-migration review round 1 finding 6 (SECURITY, new attack path found in
// review): the EXISTS check must bind to `old.employee_id`, not `new.employee_id` — an actor linked
// to employee X must not be able to UPDATE employee Y's row setting BOTH `employee_id = X` AND
// `status = 'disputed'` in the SAME statement and have the check read X's own linkage as if it were
// legitimate. This is a DIFFERENT attack from the test above (that one never touches employee_id at
// all). RED now for the SAME reason as above — no DB check exists yet, so this UPDATE currently
// succeeds outright. Once migration 0035 lands (binding to old.employee_id per finding 2), it must
// still reject with 42501 even though the statement's own new.employee_id would equal the acting
// actor's own linked employee. ---------------------------------------------------------------------

describe(
  'WBS 3.13 part 5a, finding 6 (SECURITY): a raw SQL UPDATE that reassigns employee_id to the ' +
    "ACTING actor's OWN employee in the SAME statement that sets status = 'disputed' on a DIFFERENT " +
    'employee\'s row must still be rejected (proves the check binds to old.employee_id, not ' +
    'new.employee_id — migration 0035 finding 2)',
  () => {
    it(
      'an actor linked to employee X, issuing `UPDATE hr.commission_daily SET status=\'disputed\', ' +
        "employee_id = X, ... WHERE id=$1` against a row OWNED by employee Y, is rejected at the " +
        'trigger level (insufficient_privilege) even though new.employee_id (X) equals the acting ' +
        "actor's own linked employee — SQLSTATE 42501 is the only claim this test proves",
      async () => {
        const employeeY = await createFixtureEmployee('db-backstop-owner-reassign-y');
        const employeeX = await createFixtureEmployee('db-backstop-actor-reassign-x');
        await setDisputingEmployee(employeeX); // DRIVER_ACTOR_UUID is now linked to employee X, not Y.

        const commissionDailyId = await createFixtureCommissionDaily({
          employeeId: employeeY,
          workDate: '2024-05-26',
          createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
        });

        const beforeRow = await getCommissionDailyRow(commissionDailyId);
        expect(beforeRow?.status).toBe('calculated');
        const expectedVersion = beforeRow?.version;

        const client = await pool.connect();
        let updateError: unknown;
        try {
          await client.query('begin');
          await client.query(`select set_config('app.user_id', $1, true)`, [DRIVER_ACTOR_UUID]);
          await client.query(`select set_config('app.is_internal', 'true', true)`);
          try {
            await client.query(
              `update hr.commission_daily
                  set status = 'disputed', employee_id = $1, dispute_note = $2, disputed_at = now(),
                      version = version + 1
                where id = $3 and version = $4`,
              [
                employeeX,
                'محاولة تحايل عبر إعادة تعيين employee_id — WBS 3.13 part 5a finding 6',
                commissionDailyId,
                expectedVersion,
              ],
            );
          } catch (error) {
            updateError = error;
          }
        } finally {
          await client.query('rollback');
          client.release();
        }

        expect(updateError).toBeDefined();
        expect((updateError as { code?: string } | undefined)?.code).toBe('42501'); // insufficient_privilege

        // Sanity check only (same-transaction read, before the unconditional rollback above) — NOT
        // independent proof the trigger fired.
        const afterRow = await getCommissionDailyRow(commissionDailyId);
        expect(afterRow?.status).toBe('calculated');
        expect(afterRow?.version).toBe(expectedVersion);
      },
    );
  },
);
