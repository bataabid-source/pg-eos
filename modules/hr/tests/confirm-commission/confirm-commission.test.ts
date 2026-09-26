// modules/hr/tests/confirm-commission/confirm-commission.test.ts — WBS 3.13 part 4.
//
// Integration tests, one per scenario in ./confirm-commission.feature, against the real database
// as pgeos_app (RLS genuinely enforced — every command call goes through withContext/
// withIdempotentContext, same discipline as modules/hr/tests/calculate-daily-commission/
// calculate-daily-commission.test.ts and ../dispute-commission/dispute-commission.test.ts, this
// module's own two nearest precedents).
//
// Sources: docs/notes/slice-briefs/_slice-3.13-part4.brief.md (Scenario/Contract/Deliver blocks,
// verbatim, decisions 2/3/5); database/schema/13-Schema-Additions.sql:364-389 (hr.commission_daily);
// 13B:4983-4988 (platform.my_employee_id()); 13B:561 (DEL_SUP role code); database/migrations/
// 0033_3_commission-daily-status-lifecycle.sql (the migration — applied, see below).
//
// **GREEN, built (migration 0033 applied — round-5 fix-round update, was "RED, TWO LAYERS ...
// pending migration" through round 4; the migration has since applied and gone stable across 5
// review rounds):** modules/hr/domain/confirm-commission/**, modules/hr/application/
// confirm-commission/**, modules/hr/api/confirm-commission/**, packages/contracts/hr/
// confirm-commission.ts are built; migration 0033 (hr.guard_commission_daily_status() trigger —
// including its own SoD/session-actor-binding/hr.commission.confirm checks — and the corrected
// chk_commission_daily_status, database/migrations/0033_3_commission-daily-status-lifecycle.sql) is
// applied on pgeos_lane3. Any test below that is still red is called out individually as
// "red-pending-pg-backend's parallel fix" in this fix round's own report, never silently left
// unexplained.
//
// Surface this file pins (once GREEN and built):
//   modules/hr/domain/confirm-commission/errors.ts
//     - SelfReviewNotAllowedError, DisputeWindowStillOpenError (brief, Deliver).
//   modules/hr/application/confirm-commission/index.ts (re-exports confirmCommission)
//     - confirmCommission(ctx, input, deps): Promise<ConfirmCommissionResult>
//       -> { commissionDailyId, status: 'confirmed', payrollPeriod } (Contract line).
//   modules/hr/api/confirm-commission/composition.ts
//     - createConfirmCommissionDeps(overrides).
//
// ConfirmCommissionInput (Contract line, brief): { commissionDailyId: uuid, correlationId: uuid }.
//
// Fixture/RLS pattern: admin pool (PGUSER, bypasses RLS — fixture setup/teardown only); a real
// identity.users row for the disputing driver (linked via employee_id, 13B:4983-4988
// platform.my_employee_id()) and a real identity.users row for the DEL_SUP actor, holding the
// DEL_SUP role (13B:561) so it is seed-granted the `hr.commission.confirm` PERMISSION
// (SCR-HR-COMM-01, migration 0033, D-190) — the SoD write-authority mechanism for resolving a
// dispute is this PERMISSION, checked via `platform.has_perm('hr.commission.confirm')`, NOT a
// role-code check (the DEL_SUP-role-code interim design was superseded before ever applying to any
// shared database — see migration 0033's own header item (6)); hr.commission_daily fixture rows
// inserted directly (brief decision 6 — this slice does not touch calculation). PG_APP_USER=
// pgeos_app is REQUIRED (every command call goes through withContext(ctx, fn) as pgeos_app,
// genuinely subject to RLS). D-183: a DELETE against the shared database is only allowed in this
// suite's own `afterAll`, never in `beforeAll`.
//
// A FixedClock at 2024-06-01 (safely in the PAST relative to real wall-clock time) is used
// throughout — same lesson recorded in every sibling suite's own header this session.

import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The modules under test — built and GREEN (see file header for the RED→GREEN history).
import { confirmCommission } from '../../application/confirm-commission/index.js';
import { createConfirmCommissionDeps } from '../../api/confirm-commission/composition.js';
import {
  SelfReviewNotAllowedError,
  DisputeWindowStillOpenError,
  ConfirmPermissionRequiredError,
  IllegalTransitionError,
  StaleVersionError,
} from '../../domain/confirm-commission/errors.js';
// the package subpath export (@pg-eos/contracts/hr/confirm-commission), not a deep relative path —
// packages/contracts/hr/confirm-commission.ts is pg-backend's own file to author (brief Write ONLY
// line), not this test file's.
import { ConfirmCommissionInputSchema } from '@pg-eos/contracts/hr/confirm-commission';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const DISPUTING_DRIVER_ACTOR_UUID = '00000000-0000-4000-8000-0000003135a1';
const DEL_SUP_ACTOR_UUID = '00000000-0000-4000-8000-0000003135a2';
// SCR-HR-COMM-01 (migration 0033, D-190): holds hr.driver_commission.read_all (visibility) but NOT
// hr.commission.confirm (the write authority for resolving a dispute) — SALES_MGR is seeded with
// exactly this split by 0033's own two role_permissions inserts (read_all: DEL_SUP/SALES_MGR/CFO/GM;
// confirm: DEL_SUP only). Never linked to any employee (no self-review overlap possible).
const READ_ALL_ONLY_ACTOR_UUID = '00000000-0000-4000-8000-0000003135a3';
const DEL_SUP_ROLE_CODE = 'DEL_SUP';
const SALES_MGR_ROLE_CODE = 'SALES_MGR';
// named constants (per the Master's instruction) — every assertion below reads the permission code
// through these, never a repeated literal string.
const DRIVER_COMMISSION_READ_ALL_PERMISSION_CODE = 'hr.driver_commission.read_all';
const COMMISSION_CONFIRM_PERMISSION_CODE = 'hr.commission.confirm';

const NOW = new Date('2024-06-01T06:00:00.000Z');
const clock = new FixedClock(NOW);
const ids = new SequentialIdGenerator(3135);

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

// Migration 0029 (SCR-HR-EMP-01, doc 40 §C7) adds chk_employees_code_format on hr.employees:
// code ~ '^PG-[0-9]{4}$'. This suite's own fixture codes stay in the PG-7500-PG-7599 range
// (disjoint from every sibling suite's own range, see those files' own headers for the convention).
let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (500 + employeeCodeCounter++).toString();
  return `PG-7${suffix}`;
}

async function createFixtureEmployee(labelSuffix: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, 'active') returning id::text as id`,
    [entityId, nextEmployeeCode(), `سائق اختبار تأكيد العمولة — WBS 3.13 part 4 ${labelSuffix}`],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  return id;
}

// migration 0033 round-4 review finding 2: hr.guard_commission_daily_status()'s own trigger now
// rejects an INSERT whose status is anything other than 'calculated' (an INSERT has no prior state
// for the transition-guard branch above it to run against, so before this fix an INSERT could skip
// straight to 'disputed'/'confirmed'/'paid' with no check ever firing). A fixture row that needs to
// START 'disputed' is therefore built in TWO steps: INSERT as 'calculated' (always legal), then a
// bare UPDATE to 'disputed' (a legal calculated -> disputed transition, no permission gate on that
// edge — the guard's own `hr.commission.confirm` check only fires on disputed -> confirmed).
async function createFixtureCommissionDaily(params: {
  readonly employeeId: string;
  readonly workDate: string;
  readonly createdAt: Date;
  readonly status: 'calculated' | 'disputed';
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
    await pool.query(
      `update hr.commission_daily set status = 'disputed', dispute_note = $1, disputed_at = $2 where id = $3`,
      [
        params.disputeNote ?? 'اعتراض اختباري',
        (params.disputedAt ?? params.createdAt).toISOString(),
        id,
      ],
    );
  }

  return id;
}

async function getCommissionDailyRow(id: string): Promise<
  | {
      status: string;
      confirmed_by: string | null;
      confirmed_at: string | null;
      payroll_period: string | null;
      work_date: string;
      version: number;
    }
  | undefined
> {
  const result = await pool.query(
    `select status, confirmed_by::text as confirmed_by, confirmed_at::text as confirmed_at,
            payroll_period::text as payroll_period, work_date::text as work_date, version
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

async function getDisputeWindowHours(): Promise<number> {
  const result: QueryResult<{ value: string }> = await pool.query(
    `select value::text as value from platform.thresholds where key = $1`,
    [DISPUTE_WINDOW_THRESHOLD_KEY],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `platform.thresholds row '${DISPUTE_WINDOW_THRESHOLD_KEY}' not found — is the pending migration ` +
        '(tasks/backlog/MIGRATION-REQUEST-3.md row 3) applied? (expected RED until it is)',
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

  // D-183: no DELETE here — beforeAll only upserts. `employee_id` is set AFTER the fixture
  // employee exists (each test creates its own disputing employee) — see setDisputingEmployee below.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      DISPUTING_DRIVER_ACTOR_UUID,
      `_hr_confirmcommission_driver_${DISPUTING_DRIVER_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل السائق المعترض — WBS 3.13 part 4',
    ],
  );
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [DEL_SUP_ACTOR_UUID, `_hr_confirmcommission_delsup_${DEL_SUP_ACTOR_UUID}_${randomUUID()}@test.invalid`, 'ممثل مشرف التوصيل — WBS 3.13 part 4'],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [DISPUTING_DRIVER_ACTOR_UUID, entityId],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [DEL_SUP_ACTOR_UUID, entityId],
  );
  await grantRole(DEL_SUP_ACTOR_UUID, DEL_SUP_ROLE_CODE);

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      READ_ALL_ONLY_ACTOR_UUID,
      `_hr_confirmcommission_readallonly_${READ_ALL_ONLY_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'ممثل يحمل رؤية عمولات السائقين بلا صلاحية الاعتماد — WBS 3.13 part 4',
    ],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [READ_ALL_ONLY_ACTOR_UUID, entityId],
  );
  await grantRole(READ_ALL_ONLY_ACTOR_UUID, SALES_MGR_ROLE_CODE);
});

const APP_ROLE = process.env['PG_APP_USER'] ?? 'pgeos_app';

interface AppRoleCtx {
  readonly userId: string | null;
  readonly clientId: string | null;
  readonly isInternal: boolean;
}

/** Same reproduction of withContext(ctx, fn)'s own GUC-setting contract as
 *  modules/hr/tests/calculate-daily-commission/calculate-daily-commission.test.ts's own
 *  `withAppRole` (MASTER_BACKLOG 3.13 part 2 item 5) and
 *  tests/isolation/tests/shipments-attributed-invoker-rls.test.ts's own — needed here (rather than
 *  going through confirmCommission) because the visibility test below proves a raw SELECT's own
 *  RLS behaviour directly, not a command's end-to-end write path. */
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

/** links DISPUTING_DRIVER_ACTOR_UUID's own identity.users row to `employeeId` — the SoD check
 *  (platform.my_employee_id(), 13B:4983-4988) resolves the acting user's employee through exactly
 *  this column. Reset to null in `afterEach`-equivalent per-test cleanup is unnecessary here since
 *  each test uses its OWN fresh employeeId and re-points this same actor row to it (the actor
 *  itself is shared, its `employee_id` is simply repointed per scenario — no two scenarios in this
 *  file run concurrently). */
async function setDisputingEmployee(employeeId: string): Promise<void> {
  await pool.query(`update identity.users set employee_id = $1 where id = $2`, [
    employeeId,
    DISPUTING_DRIVER_ACTOR_UUID,
  ]);
}

afterAll(async () => {
  if (fixtureCommissionDailyIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where id = any($1::uuid[])`, [fixtureCommissionDailyIds]);
  }
  if (fixtureEmployeeIds.length > 0) {
    await pool.query(`delete from hr.commission_daily where employee_id = any($1::uuid[])`, [fixtureEmployeeIds]);
    await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [fixtureEmployeeIds]);
  }
  // platform.audit_log is NEVER deleted (CLAUDE.md-wide discipline, every prior slice).
  for (const userId of [DISPUTING_DRIVER_ACTOR_UUID, DEL_SUP_ACTOR_UUID, READ_ALL_ONLY_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- contract stub (package subpath import) -------------------------------------------------

describe('@pg-eos/contracts/hr/confirm-commission — ConfirmCommissionInputSchema shape (brief Contract line)', () => {
  it('accepts { commissionDailyId, correlationId }', () => {
    const parsed = ConfirmCommissionInputSchema.parse({
      commissionDailyId: randomUUID(),
      correlationId: randomUUID(),
    });
    expect(parsed.commissionDailyId).toEqual(expect.any(String));
  });

  it('rejects a non-uuid commissionDailyId', () => {
    const result = ConfirmCommissionInputSchema.safeParse({
      commissionDailyId: 'not-a-uuid',
      correlationId: randomUUID(),
    });
    expect(result.success).toBe(false);
  });
});

// --- Scenario: A DEL_SUP actor resolves a dispute by confirming it -------------------------------

describe('Scenario: A DEL_SUP actor resolves a dispute by confirming it', () => {
  it('the row\'s status becomes "confirmed", confirmed_by/confirmed_at are recorded, payroll_period is set to the work_date\'s own month, one audit row is written', async () => {
    const employeeId = await createFixtureEmployee('delsup-resolves');
    await setDisputingEmployee(employeeId);
    const workDate = '2024-05-15';
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate,
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });

    const delSupCtx = { userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createConfirmCommissionDeps({ clock, ids });
    const correlationId = nextCorrelationId();

    const result = await confirmCommission(delSupCtx, { commissionDailyId, correlationId }, deps);

    expect(result.commissionDailyId).toBe(commissionDailyId);
    expect(result.status).toBe('confirmed');
    expect(result.payrollPeriod).toBe('2024-05-01'); // date_trunc('month', work_date) of 2024-05-15.

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmed_by).toBe(DEL_SUP_ACTOR_UUID);
    expect(row?.confirmed_at).not.toBeNull();
    expect(row?.payroll_period).toBe('2024-05-01');

    const auditRows = await auditRowsForCorrelation(correlationId);
    const commissionAudit = auditRows.filter((r) => r.table_name === 'commission_daily');
    expect(commissionAudit).toHaveLength(1);
    expect(commissionAudit[0]?.operation).toBe('update');
    expect(commissionAudit[0]?.record_id).toBe(commissionDailyId);
  });
});

// --- Scenario: The disputing driver cannot confirm their own dispute (SoD) -----------------------

describe('Scenario: The disputing driver cannot confirm their own dispute (SoD)', () => {
  it('the APPLICATION layer refuses with SelfReviewNotAllowedError and writes no row', async () => {
    const employeeId = await createFixtureEmployee('self-review-app');
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-16',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });

    const drivingCtx = { userId: DISPUTING_DRIVER_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createConfirmCommissionDeps({ clock, ids });

    await expect(
      confirmCommission(drivingCtx, { commissionDailyId, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(SelfReviewNotAllowedError);

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('disputed');
    expect(row?.confirmed_by).toBeNull();
  });

  // brief Scenario, own parenthetical: "both the application-level check and, if bypassed,
  // hr.guard_commission_daily_status()'s own trigger check must independently refuse this" — this
  // second test bypasses the APPLICATION LAYER only (never RLS or the session-actor-binding check,
  // both of which are real, load-bearing controls of their own) to prove the DB-level guard
  // trigger's OWN self-review EXISTS check is a REAL, independent backstop, not merely documented.
  //
  // round-5 fix round, finding 3 (test correctness — this test previously proved nothing): running
  // this UPDATE through the raw ADMIN pool (no app.user_id GUC set at all) means
  // platform.current_user_id() resolves to NULL — the trigger's own session-actor-binding check
  // (migration 0033: "new.confirmed_by يجب أن يطابق هوية الجلسة الفعلية") fires FIRST and refuses
  // the write for THAT reason (confirmed_by = a real UUID, distinct from NULL), before the
  // self-review EXISTS check underneath it ever runs — deleting the actual self-review logic would
  // have left the old version of this test passing for the WRONG reason. Fixed: run the UPDATE
  // through `withAppRole` (this file's own established helper, used elsewhere in this file for
  // exactly this "prove a raw SQL statement's own RLS/trigger behaviour, not a command's end-to-end
  // path" purpose) scoped to DISPUTING_DRIVER_ACTOR_UUID, with `confirmed_by` set to that SAME
  // driver's own user id — so the session-actor-binding check passes (confirmed_by ===
  // current_user_id()) and the write genuinely reaches, and is refused BY, the self-review EXISTS
  // check itself. Asserts the trigger's own SPECIFIC self-review message and SQLSTATE
  // (`insufficient_privilege`, migration 0033 line ~260-262), not a generic `.rejects.toThrow()`.
  it("the DB-level guard trigger's OWN self-review EXISTS check refuses a bare SQL UPDATE — via the disputing driver's own session, confirmed_by set to that SAME driver's own user id — with its specific message and SQLSTATE (defense in depth, independent of the application layer)", async () => {
    const employeeId = await createFixtureEmployee('self-review-db');
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-17',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });

    const disputingDriverCtx: AppRoleCtx = {
      userId: DISPUTING_DRIVER_ACTOR_UUID,
      clientId: null,
      isInternal: true,
    };

    await expect(
      withAppRole(disputingDriverCtx, (client) =>
        client.query(
          `update hr.commission_daily
              set status = 'confirmed', confirmed_by = $1, confirmed_at = now(), version = version + 1
            where id = $2`,
          [DISPUTING_DRIVER_ACTOR_UUID, commissionDailyId],
        ),
      ),
    ).rejects.toMatchObject({
      code: '42501', // insufficient_privilege (SQLSTATE) — migration 0033's own errcode for this branch.
      message: expect.stringContaining('لا يجوز للسائق اعتماد اعتراضه بنفسه'),
    });

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('disputed');
    expect(row?.confirmed_by).toBeNull();
  });
});

// --- Scenario: A calculated row past its dispute window can be confirmed directly ----------------

describe('Scenario: A calculated row past its dispute window can be confirmed directly (the auto-confirm path, invoked here as an explicit call, not yet scheduled)', () => {
  it('the row\'s status becomes "confirmed" directly from "calculated" (skipping "disputed"), payroll_period is set', async () => {
    const thresholdHours = await getDisputeWindowHours();
    const employeeId = await createFixtureEmployee('auto-confirm');
    await setDisputingEmployee(employeeId);
    const workDate = '2024-05-10';
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate,
      createdAt: new Date(NOW.getTime() - (thresholdHours + 1) * HOURS_TO_MS),
      status: 'calculated',
    });

    const delSupCtx = { userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createConfirmCommissionDeps({ clock, ids });

    const result = await confirmCommission(
      delSupCtx,
      { commissionDailyId, correlationId: nextCorrelationId() },
      deps,
    );

    expect(result.status).toBe('confirmed');
    expect(result.payrollPeriod).toBe('2024-05-01');

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('confirmed');
    expect(row?.payroll_period).toBe('2024-05-01');
  });
});

// --- Scenario: A calculated row still inside its dispute window cannot be confirmed yet ----------

describe('Scenario: A calculated row still inside its dispute window cannot be confirmed yet', () => {
  it('fails with a mapped DisputeWindowStillOpenError and writes no row', async () => {
    const thresholdHours = await getDisputeWindowHours();
    const employeeId = await createFixtureEmployee('still-open');
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-31',
      createdAt: new Date(NOW.getTime() - (thresholdHours - 1) * HOURS_TO_MS),
      status: 'calculated',
    });

    const delSupCtx = { userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createConfirmCommissionDeps({ clock, ids });

    await expect(
      confirmCommission(delSupCtx, { commissionDailyId, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(DisputeWindowStillOpenError);

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('calculated');
    expect(row?.confirmed_by).toBeNull();
  });
});

// --- SCR-HR-COMM-01 (migration 0033, D-190) — hr.driver_commission.read_all is VISIBILITY only,
// hr.commission.confirm is the real write authority for resolving a dispute ----------------------

describe('SCR-HR-COMM-01 — a hr.driver_commission.read_all holder WITHOUT hr.commission.confirm cannot resolve a dispute', () => {
  it('positive control: READ_ALL_ONLY_ACTOR_UUID genuinely holds DRIVER_COMMISSION_READ_ALL_PERMISSION_CODE but NOT COMMISSION_CONFIRM_PERMISSION_CODE (seed-granted, not assumed)', async () => {
    const grantResult: QueryResult<{ holds_read_all: boolean; holds_confirm: boolean }> = await pool.query(
      `select
         bool_or(p.code = $2) as holds_read_all,
         bool_or(p.code = $3) as holds_confirm
       from identity.user_roles ur
       join identity.roles r on r.id = ur.role_id
       join identity.role_permissions rp on rp.role_id = r.id
       join identity.permissions p on p.id = rp.permission_id
       where ur.user_id = $1`,
      [READ_ALL_ONLY_ACTOR_UUID, DRIVER_COMMISSION_READ_ALL_PERMISSION_CODE, COMMISSION_CONFIRM_PERMISSION_CODE],
    );
    expect(grantResult.rows[0]?.holds_read_all).toBe(true);
    expect(grantResult.rows[0]?.holds_confirm).toBe(false);
  });

  // round-5 fix round, finding 4: this comment previously said "the application has no permission
  // check" — corrected. modules/hr/application/confirm-commission/confirm-commission.ts step 3b now
  // DOES check `hr.commission.confirm` at the application layer (deps.repo.hasConfirmPermission,
  // scoped to exactly the disputed->confirmed edge via the shared machine's
  // stateHasTag(row.status, COMMISSION_DAILY_TAGS.REQUIRES_CONFIRM_PERMISSION) — round-1 slice-close
  // review finding 1, no if/switch on the status string) and throws the typed
  // ConfirmPermissionRequiredError BEFORE the write ever reaches
  // hr.guard_commission_daily_status()'s own DB-level backstop (migration 0033). This test now
  // pins that specific class — the application command's own permission check is what a caller
  // genuinely observes.
  it('resolving a DISPUTED row via confirmCommission() is refused with the SPECIFIC typed ConfirmPermissionRequiredError, no write', async () => {
    const employeeId = await createFixtureEmployee('read-all-no-confirm');
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-18',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });

    const readAllOnlyCtx = { userId: READ_ALL_ONLY_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createConfirmCommissionDeps({ clock, ids });

    await expect(
      confirmCommission(readAllOnlyCtx, { commissionDailyId, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(ConfirmPermissionRequiredError);

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('disputed');
    expect(row?.confirmed_by).toBeNull();
  });

  // round-5 fix round, finding 4 (SECURITY — the previous mutation-proof substitute above did not
  // prove the TRIGGER's own independent enforcement, only the application layer's, since the
  // application-layer check above now refuses first): this test bypasses confirmCommission()
  // ENTIRELY — a raw `withAppRole` UPDATE, scoped to READ_ALL_ONLY_ACTOR_UUID (genuinely holds
  // DRIVER_COMMISSION_READ_ALL_PERMISSION_CODE and passes `internal_update`'s own is_internal+
  // entity_scope checks, but does NOT hold COMMISSION_CONFIRM_PERMISSION_CODE — see the positive
  // control test above) — attempting `disputed -> confirmed` directly against
  // hr.commission_daily with a real `confirmed_by` (its own user id, so the session-actor-binding
  // check passes and the write genuinely reaches the `hr.commission.confirm` branch). Proves the DB
  // backstop (migration 0033 line 273) is independently load-bearing, REGARDLESS of the application
  // layer — replaces the previous mutation-proof-by-grant test (round-5 finding 5: that test's
  // inline DELETE violated D-183 and, if PGDATABASE ever silently fell back to the shared `pgeos`,
  // would have granted a real write permission to a shared SALES_MGR role for the duration of the
  // test; this raw-UPDATE trigger test proves the identical causal claim — that
  // COMMISSION_CONFIRM_PERMISSION_CODE is the deciding variable — without ever granting anything).
  it("the DB-level guard trigger's OWN hr.commission.confirm permission check independently refuses a bare SQL UPDATE from a read_all-only actor (defense in depth, regardless of the application layer) — specific message and SQLSTATE", async () => {
    const employeeId = await createFixtureEmployee('read-all-trigger-backstop');
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-19',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });

    const readAllOnlyCtx: AppRoleCtx = { userId: READ_ALL_ONLY_ACTOR_UUID, clientId: null, isInternal: true };

    await expect(
      withAppRole(readAllOnlyCtx, (client) =>
        client.query(
          `update hr.commission_daily
              set status = 'confirmed', confirmed_by = $1, confirmed_at = now(), version = version + 1
            where id = $2`,
          [READ_ALL_ONLY_ACTOR_UUID, commissionDailyId],
        ),
      ),
    ).rejects.toMatchObject({
      code: '42501', // insufficient_privilege (SQLSTATE) — migration 0033's own errcode for this branch.
      message: expect.stringContaining('حل اعتراض عمولة يتطلب صلاحية hr.commission.confirm'),
    });

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('disputed');
    expect(row?.confirmed_by).toBeNull();
  });
});

describe("SCR-HR-COMM-01 — DEL_SUP (hr.driver_commission.read_all holder) can see another driver's hr.commission_daily row directly", () => {
  it('a raw SELECT as DEL_SUP_ACTOR_UUID sees a commission_daily row owned by a DIFFERENT employee — the whole point of the new permission', async () => {
    const employeeId = await createFixtureEmployee('visibility-other-driver');
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-19',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'calculated',
    });

    // vacuity guard: the row genuinely exists (admin pool bypasses RLS).
    const adminCheck: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from hr.commission_daily where id = $1`,
      [commissionDailyId],
    );
    expect(Number(adminCheck.rows[0]?.n ?? '0')).toBe(1);

    // DEL_SUP_ACTOR_UUID's own employee_id is always null (never linked to any fixture employee in
    // this file) — this is not an own-row read, it is genuinely the read_all branch of own_commission.
    const result = await withAppRole({ userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true }, (client) =>
      client.query<{ id: string }>(`select id from hr.commission_daily where id = $1`, [commissionDailyId]),
    );
    expect(result.rows).toEqual([{ id: commissionDailyId }]);
  });
});

// --- migration 0033 round-5 review finding 1 — confirmed_by is IMMUTABLE once a row is 'confirmed' -

describe("confirmed_by is IMMUTABLE once a row reaches 'confirmed' (migration 0033 round-5 review finding 1)", () => {
  it('a legitimately confirmed row\'s confirmed_by cannot be reassigned by a later bare SQL UPDATE, even to another real actor, even though the row is now visible/writable via the admin connection', async () => {
    const employeeId = await createFixtureEmployee('immutable-confirmed-by');
    await setDisputingEmployee(employeeId);
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-20',
      createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
      status: 'disputed',
    });

    const delSupCtx = { userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createConfirmCommissionDeps({ clock, ids });
    await confirmCommission(delSupCtx, { commissionDailyId, correlationId: nextCorrelationId() }, deps);

    const confirmedRow = await getCommissionDailyRow(commissionDailyId);
    expect(confirmedRow?.status).toBe('confirmed');
    expect(confirmedRow?.confirmed_by).toBe(DEL_SUP_ACTOR_UUID);

    await expect(
      pool.query(`update hr.commission_daily set confirmed_by = $1, version = version + 1 where id = $2`, [
        DISPUTING_DRIVER_ACTOR_UUID,
        commissionDailyId,
      ]),
    ).rejects.toThrow();

    const afterAttempt = await getCommissionDailyRow(commissionDailyId);
    expect(afterAttempt?.confirmed_by).toBe(DEL_SUP_ACTOR_UUID);
  });
});

// --- migration 0033 round-5 review finding 2 — an already-auto-confirmed row (NULL confirmed_by)
// still allows an UPDATE that leaves confirmed_by untouched -----------------------------------------

describe('an already-auto-confirmed row (status=confirmed, confirmed_by IS NULL) still allows an UPDATE that never touches confirmed_by (migration 0033 round-5 review finding 2)', () => {
  it('updating payroll_period on an already-auto-confirmed, NULL-confirmed_by row succeeds and leaves confirmed_by null', async () => {
    const employeeId = await createFixtureEmployee('null-confirmed-by-update');
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-05',
      createdAt: new Date(NOW.getTime() - 100 * HOURS_TO_MS),
      status: 'calculated',
    });

    // the window-expiry auto-confirm path, exercised directly via bare SQL — confirmed_by stays
    // NULL, the one exempted edge (migration 0033: UPDATE, FROM 'calculated', TO 'confirmed').
    await pool.query(
      `update hr.commission_daily
          set status = 'confirmed', confirmed_at = now(), payroll_period = $1, version = version + 1
        where id = $2`,
      ['2024-05-01', commissionDailyId],
    );

    const autoConfirmedRow = await getCommissionDailyRow(commissionDailyId);
    expect(autoConfirmedRow?.status).toBe('confirmed');
    expect(autoConfirmedRow?.confirmed_by).toBeNull();

    // a later UPDATE that touches a DIFFERENT column only — confirmed_by is never referenced in
    // this statement's SET clause, so it stays null -> null (not distinct) and must NOT be caught by
    // the immutability check above (round-5 finding 2's own root cause).
    await expect(
      pool.query(`update hr.commission_daily set payroll_period = $1, version = version + 1 where id = $2`, [
        '2024-06-01',
        commissionDailyId,
      ]),
    ).resolves.toBeDefined();

    const afterUpdate = await getCommissionDailyRow(commissionDailyId);
    expect(afterUpdate?.confirmed_by).toBeNull();
    expect(afterUpdate?.payroll_period).toBe('2024-06-01');
  });
});

// --- round-5 fix round, finding 6: StaleVersionError / IllegalTransitionError coverage — missing
// entirely before this round -----------------------------------------------------------------------

describe('round-5 fix round, finding 6: StaleVersionError — optimistic-lock conflict on confirmCommission', () => {
  it(
    'two concurrent confirmCommission calls against the SAME disputed row: exactly one succeeds ' +
      '(version 1 -> 2), the other rejects with StaleVersionError, no silent overwrite — same race ' +
      "technique as modules/imile/tests/pull-shipments/pull-shipments.test.ts's own StaleVersionError test",
    async () => {
      const employeeId = await createFixtureEmployee('stale-version-race');
      await setDisputingEmployee(employeeId);
      const commissionDailyId = await createFixtureCommissionDaily({
        employeeId,
        workDate: '2024-05-23',
        createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
        status: 'disputed',
      });

      const delSupCtx = { userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true };
      const depsA = createConfirmCommissionDeps({ clock, ids });
      const depsB = createConfirmCommissionDeps({ clock, ids });

      const results = await Promise.allSettled([
        confirmCommission(delSupCtx, { commissionDailyId, correlationId: nextCorrelationId() }, depsA),
        confirmCommission(delSupCtx, { commissionDailyId, correlationId: nextCorrelationId() }, depsB),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaleVersionError);

      const row = await getCommissionDailyRow(commissionDailyId);
      expect(row?.status).toBe('confirmed');
      expect(row?.version).toBe(2);
    },
  );
});

describe('round-5 fix round, finding 6: IllegalTransitionError — confirming an already-confirmed row', () => {
  it('confirmCommission on a row already "confirmed" fails with IllegalTransitionError, no row change', async () => {
    const employeeId = await createFixtureEmployee('illegal-transition');
    const commissionDailyId = await createFixtureCommissionDaily({
      employeeId,
      workDate: '2024-05-06',
      createdAt: new Date(NOW.getTime() - 100 * HOURS_TO_MS),
      status: 'calculated',
    });

    // window-expiry auto-confirm path via bare SQL — an already-confirmed row, confirmed_by null
    // (the one exempted edge, migration 0033), needed as the starting fixture state here.
    await pool.query(
      `update hr.commission_daily
          set status = 'confirmed', confirmed_at = now(), payroll_period = $1, version = version + 1
        where id = $2`,
      ['2024-05-01', commissionDailyId],
    );

    const delSupCtx = { userId: DEL_SUP_ACTOR_UUID, clientId: null, isInternal: true };
    const deps = createConfirmCommissionDeps({ clock, ids });

    await expect(
      confirmCommission(delSupCtx, { commissionDailyId, correlationId: nextCorrelationId() }, deps),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    const row = await getCommissionDailyRow(commissionDailyId);
    expect(row?.status).toBe('confirmed');
    expect(row?.confirmed_by).toBeNull();
  });
});
