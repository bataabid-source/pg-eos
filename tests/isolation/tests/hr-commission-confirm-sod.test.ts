// tests/isolation/tests/hr-commission-confirm-sod.test.ts — Master security follow-up, WBS 3.13
// (tasks/MASTER_BACKLOG.md, "confirm-side `new.employee_id` exposure" row — the "3.13 part 5b
// addendum" migration 0035's own header names as OUT OF SCOPE and defers).
//
// WHAT THIS PROVES: database/migrations/0033_3_commission-daily-status-lifecycle.sql's
// hr.guard_commission_daily_status() confirm-side self-review EXISTS check (originally ~0033:266-272,
// restated verbatim, unchanged, at database/migrations/0035_3_commission-daily-dispute-sod.sql:
// 168-174) bound to `new.employee_id`, not `old.employee_id`:
//
//   if exists (
//     select 1 from identity.users u
//      where u.id = platform.current_user_id() and u.employee_id = new.employee_id
//   ) then raise exception ... 'insufficient_privilege';
//
// Migration 0035 already fixed the STRUCTURALLY IDENTICAL bug on the DISPUTE side (calculated ->
// disputed edge) by binding to `old.employee_id` instead (0035 finding 2, its own header item 2).
// The confirm side (disputed -> confirmed edge) still used `new.employee_id` — a single UPDATE that
// changes `employee_id` AND `status` to 'confirmed' in the SAME statement let the row's own
// disputing employee "confirm" (self-review) their own dispute, because by the time the EXISTS
// check ran, `new.employee_id` no longer named them. CLOSED by migration 0037
// (database/migrations/0037_M_commission-confirm-sod.sql) — the self-review EXISTS check now binds
// to `case when tg_op = 'UPDATE' then old.employee_id else new.employee_id end`
// (0037:159-166, pre-migration review finding 2), and a new, unconditional employee_id-immutability
// check (0037:56-59, finding 1) closes the underlying re-attribution gap on every UPDATE.
//
// Sources read (brief "Read ONLY", plus 0037 for this file's own post-fix citation update):
// database/migrations/0033_3_commission-daily-status-lifecycle.sql (the function, its self-review
// block ~0033:193-287); database/migrations/0035_3_commission-daily-dispute-sod.sql (the dispute-side
// fix, its own header + fix); database/migrations/0037_M_commission-confirm-sod.sql (the confirm-side
// fix this file now proves GREEN); modules/hr/tests/confirm-commission/confirm-commission.test.ts and
// modules/hr/tests/dispute-commission/dispute-commission.test.ts (fixture/session-actor-binding style,
// copied here, not imported cross-module — same convention every sibling suite already uses).
//
// PLACEMENT: tests/isolation/tests/ (outside the lane-3 `hr` module lock), the EXISTING
// `@pg-eos/isolation-tests` project — Master default (no new `tests/integration` workspace
// project; SoD/RLS DB-backstop coverage fits this project's own existing scope, same
// package.json/vitest.config.ts/tsconfig.json/tsconfig.test.json every sibling file here already
// shares, discovered via `pnpm --filter @pg-eos/isolation-tests test:isolation`). Originally
// drafted at `tests/integration/hr-commission-confirm-sod.test.ts` (a not-yet-scaffolded
// workspace project pg-tester cannot create — package.json/vitest.config.ts are outside pg-tester's
// WRITE SCOPE); moved here on the Master's own instruction once that scaffolding was declined.
//
// SQLSTATE: 42501 (insufficient_privilege) throughout — the SAME errcode 0037's own confirm-side
// self-review block (0037:165), 0037's own employee_id-immutability check (0037:58), and 0037's
// restated old.employee_id-bound dispute-side check (0037:78, verbatim from ~0035:90) all use.
//
// IMMUTABILITY FINDING (brief item (b), "decide from the 0033/0035 comments" — SUPERSEDED by the
// Master's own pre-migration review ruling on this file, doc 38 row 3.13): `employee_id` is a
// FROZEN SNAPSHOT — doc 38 row 3.13 attributes a commission_daily row to its own employee at
// calculation time; any later re-attribution belongs to a dedicated assignment table, never to a
// mutation of this column. The ruling is therefore UNCONDITIONAL — `employee_id` is immutable on
// EVERY UPDATE to hr.commission_daily, including one on a still-'calculated' row, not only once the
// row has left `'calculated'` (this file's own earlier, narrower default is withdrawn). CLOSED by
// migration 0037 (0037:56-59, finding 1) — scenarios (a) and (b) below (covering
// 'calculated'/'disputed'/'confirmed' alike) are GREEN.
//
// slice-close review round 1, finding 1: scenario (a)'s ONE-statement exploit (employee_id + status
// -> 'confirmed' together) is now caught by the employee_id-immutability check (0037:56, which runs
// BEFORE the self-review binding at 0037:159-163) — it therefore proves immutability, not the
// old.employee_id/new.employee_id binding fix. Scenario (a) is retitled accordingly, and a NEW
// scenario (a2) proves the self-review EXISTS check itself fires (its own specific message), the SAME
// actor confirming the SAME row WITHOUT touching employee_id — the CASE binding at 0037:162 is
// unreachable on UPDATE once employee_id is immutable (0037:56); kept as defense in depth, not
// independently testable.
//
// FIXTURE/RLS discipline copied from ../../modules/hr/tests/confirm-commission/
// confirm-commission.test.ts and ../../modules/hr/tests/dispute-commission/dispute-commission.test.ts:
// admin `pool` (PGUSER, bypasses RLS — fixture setup/teardown only) plus dedicated
// `pool.connect()` clients with a TRANSACTION-LOCAL `set_config('app.user_id', ..., true)` to
// reproduce the exact session-actor-binding withContext(ctx, fn) itself uses, so
// `platform.current_user_id()` genuinely resolves to the acting test actor inside the trigger. D-183:
// no DELETE outside this suite's own `afterAll`.
//
// Fixture UUID/employee-code ranges (disjoint from every sibling suite's own range, same convention):
// actors 00000000-0000-4000-8000-0000003137a*, employee codes PG-79xx.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// The row's own disputing driver — ALSO holds DEL_SUP (hr.commission.confirm), representing a real
// actor who is both a driver employee AND a delivery-supervisor role holder. This dual membership is
// what lets scenario (a2) reach the self-review EXISTS check at all: without hr.commission.confirm the
// permission check (0037:177, scoped to `old.status = 'disputed'`, which is exactly the edge every
// scenario here exercises) would reject the statement first, for an unrelated reason, and the
// self-review exposure this file targets would never be exercised.
const DRIVER_DELSUP_ACTOR_UUID = '00000000-0000-4000-8000-0000003137a1';
// A genuinely different DEL_SUP holder, never linked to any fixture employee — the positive control
// (brief item (c)).
const OTHER_DELSUP_ACTOR_UUID = '00000000-0000-4000-8000-0000003137a2';
const DEL_SUP_ROLE_CODE = 'DEL_SUP';

const NOW = new Date('2024-06-01T06:00:00.000Z');
const HOURS_TO_MS = 60 * 60 * 1000;

let entityId: string;
const fixtureEmployeeIds: string[] = [];
const fixtureCommissionDailyIds: string[] = [];

// Migration 0029 (SCR-HR-EMP-01): code ~ '^PG-[0-9]{4}$'. PG-7900..PG-7999 — disjoint from every
// sibling suite's own range (dispute-commission: 7300s, confirm-commission: 7500s).
let employeeCodeCounter = 0;
function nextEmployeeCode(): string {
  const suffix = (900 + employeeCodeCounter++).toString();
  return `PG-7${suffix}`;
}

async function grantRole(userId: string, roleCode: string): Promise<void> {
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [
    roleCode,
  ]);
  const roleId = roleResult.rows[0]?.id;
  if (!roleId) throw new Error(`identity.roles row not found for code ${roleCode}`);
  await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2) on conflict do nothing`, [
    userId,
    roleId,
  ]);
}

async function createFixtureEmployee(labelSuffix: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into hr.employees (entity_id, code, name_ar, hire_date, status)
       values ($1, $2, $3, current_date, 'active') returning id::text as id`,
    [entityId, nextEmployeeCode(), `سائق اختبار SoD الاعتماد — Master security follow-up ${labelSuffix}`],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert fixture hr.employees row');
  fixtureEmployeeIds.push(id);
  return id;
}

/** links `actorUserId`'s own identity.users row to `employeeId`. */
async function linkActorToEmployee(actorUserId: string, employeeId: string): Promise<void> {
  await pool.query(`update identity.users set employee_id = $1 where id = $2`, [employeeId, actorUserId]);
}

/** a raw hr.commission_daily fixture row: INSERT as 'calculated' (the only legal INSERT status,
 *  originally 0033 round-4 finding 2), then, if `disputed` is requested, a same-transaction-actor
 *  UPDATE to 'disputed' — the row's OWN employee's linked actor must be the one performing that
 *  transition (the old.employee_id-bound check on the calculated -> disputed edge, originally
 *  migration 0035, restated verbatim at 0037:72-80), scoped via a dedicated client +
 *  transaction-local `app.user_id`, same pattern as ../../modules/hr/tests/dispute-commission/
 *  dispute-commission.test.ts's own createFixtureCommissionDaily. */
async function createFixtureCommissionDaily(params: {
  readonly employeeId: string;
  readonly workDate: string;
  readonly createdAt: Date;
  readonly disputingActorUserId?: string;
  readonly status?: 'calculated' | 'disputed';
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
    const disputingActorUserId = params.disputingActorUserId;
    if (!disputingActorUserId) {
      throw new Error('createFixtureCommissionDaily: disputingActorUserId is required for status "disputed"');
    }
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [disputingActorUserId]);
      await client.query(`select set_config('app.is_internal', 'true', true)`);
      await client.query(
        `update hr.commission_daily set status = 'disputed', dispute_note = $1, disputed_at = $2 where id = $3`,
        ['اعتراض اختباري — Master security follow-up', params.createdAt.toISOString(), id],
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

async function getCommissionDailyRow(id: string): Promise<
  | {
      status: string;
      employee_id: string;
      confirmed_by: string | null;
      version: number;
    }
  | undefined
> {
  const result = await pool.query(
    `select status, employee_id::text as employee_id, confirmed_by::text as confirmed_by, version
       from hr.commission_daily where id = $1`,
    [id],
  );
  return result.rows[0];
}

/** runs `sql` as `actorUserId` inside a dedicated client, transaction-local `app.user_id`/
 *  `app.is_internal` (the same GUCs withContext(ctx, fn) itself sets, packages/db/src/
 *  with-context.ts) — always ROLLBACK afterwards, whether the statement raised or not, so this
 *  fixture connection never leaks a session GUC back to the pool and no committed write survives
 *  a rejected attempt for the wrong reason. Returns the caught error, if any (undefined if the
 *  statement ran without throwing). Used by every EXPLOIT/immutability scenario below, where the
 *  only claim under test is whether the statement raises, never the row's committed end-state. */
async function runAsActor(
  actorUserId: string,
  sql: string,
  values: readonly unknown[],
): Promise<unknown> {
  const client = await pool.connect();
  let caught: unknown;
  try {
    await client.query('begin');
    await client.query(`select set_config('app.user_id', $1, true)`, [actorUserId]);
    await client.query(`select set_config('app.is_internal', 'true', true)`);
    try {
      await client.query(sql, values as unknown[]);
    } catch (error) {
      caught = error;
    }
  } finally {
    await client.query('rollback');
    client.release();
  }
  return caught;
}

/** same session-GUC setup as `runAsActor`, but COMMITs on success (ROLLBACK only if the statement
 *  raised) — needed by the positive-control scenario (c) below, which must prove the write
 *  genuinely persisted, not merely that it ran without throwing inside a transaction that is then
 *  discarded regardless of outcome. */
async function runAsActorCommitting(
  actorUserId: string,
  sql: string,
  values: readonly unknown[],
): Promise<unknown> {
  const client = await pool.connect();
  let caught: unknown;
  try {
    await client.query('begin');
    await client.query(`select set_config('app.user_id', $1, true)`, [actorUserId]);
    await client.query(`select set_config('app.is_internal', 'true', true)`);
    try {
      await client.query(sql, values as unknown[]);
      await client.query('commit');
    } catch (error) {
      caught = error;
      await client.query('rollback');
    }
  } finally {
    client.release();
  }
  return caught;
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
    [
      DRIVER_DELSUP_ACTOR_UUID,
      `_hr_confirmsod_driverdelsup_${DRIVER_DELSUP_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'سائق يحمل صلاحية مشرف التوصيل أيضاً — Master security follow-up',
    ],
  );
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type, employee_id)
       values ($1, $2, $3, 'internal', null)
       on conflict (id) do update set email = excluded.email, full_name_ar = excluded.full_name_ar`,
    [
      OTHER_DELSUP_ACTOR_UUID,
      `_hr_confirmsod_otherdelsup_${OTHER_DELSUP_ACTOR_UUID}_${randomUUID()}@test.invalid`,
      'مشرف توصيل آخر — ضبط إيجابي — Master security follow-up',
    ],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [DRIVER_DELSUP_ACTOR_UUID, entityId],
  );
  await pool.query(
    `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict do nothing`,
    [OTHER_DELSUP_ACTOR_UUID, entityId],
  );
  await grantRole(DRIVER_DELSUP_ACTOR_UUID, DEL_SUP_ROLE_CODE);
  await grantRole(OTHER_DELSUP_ACTOR_UUID, DEL_SUP_ROLE_CODE);
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
  for (const userId of [DRIVER_DELSUP_ACTOR_UUID, OTHER_DELSUP_ACTOR_UUID]) {
    await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_roles where user_id = $1`, [userId]);
    await pool.query(`delete from identity.user_entities where user_id = $1`, [userId]);
    await pool.query(`delete from identity.users where id = $1`, [userId]);
  }
  await pool.end();
});

// --- (a) employee_id + status -> 'confirmed' in ONE statement is caught by the employee_id
// immutability check (0037:56) — proves immutability, NOT the self-review binding (see (a2) below,
// slice-close review round 1 finding 1) -----------------------------------------------------------

describe(
  'SECURITY / IMMUTABILITY (Master backlog, "confirm-side new.employee_id exposure" — closed by ' +
    'migration 0037): a single UPDATE that reassigns employee_id AND sets status = \'confirmed\' in ' +
    "the SAME statement is rejected by the employee_id-immutability check (0037:56) before the " +
    'self-review binding (0037:159-163) ever runs',
  () => {
    it(
      'DRIVER_DELSUP_ACTOR_UUID (linked to employeeY, the row\'s own disputing employee, and ALSO ' +
        'holding hr.commission.confirm via DEL_SUP) issuing `UPDATE ... SET status=\'confirmed\', ' +
        "employee_id = employeeX, confirmed_by = self ... WHERE id=$1` against employeeY's own " +
        'disputed row is rejected at the trigger level with insufficient_privilege (SQLSTATE 42501) ' +
        "and the employee_id-immutability message",
      async () => {
        const employeeY = await createFixtureEmployee('self-confirm-owner-y');
        const employeeX = await createFixtureEmployee('self-confirm-decoy-x');
        await linkActorToEmployee(DRIVER_DELSUP_ACTOR_UUID, employeeY);

        const commissionDailyId = await createFixtureCommissionDaily({
          employeeId: employeeY,
          workDate: '2024-05-21',
          createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
          status: 'disputed',
          disputingActorUserId: DRIVER_DELSUP_ACTOR_UUID,
        });

        const beforeRow = await getCommissionDailyRow(commissionDailyId);
        expect(beforeRow?.status).toBe('disputed');
        const expectedVersion = beforeRow?.version;

        const updateError = await runAsActor(
          DRIVER_DELSUP_ACTOR_UUID,
          `update hr.commission_daily
              set status = 'confirmed', employee_id = $1, confirmed_by = $2, confirmed_at = now(),
                  version = version + 1
            where id = $3 and version = $4`,
          [employeeX, DRIVER_DELSUP_ACTOR_UUID, commissionDailyId, expectedVersion],
        );

        expect(updateError).toBeDefined();
        expect((updateError as { code?: string } | undefined)?.code).toBe('42501'); // insufficient_privilege
        expect((updateError as { message?: string } | undefined)?.message).toEqual(
          expect.stringContaining('employee_id غير قابل للتعديل'),
        ); // 0037:57 — the immutability check, not the self-review binding.

        // sanity check only — read through the admin `pool` AFTER runAsActor's own unconditional
        // rollback has already completed (a separate query on a separate, later connection, not a
        // same-transaction read) — not independent proof by itself, see the assertions above.
        const afterRow = await getCommissionDailyRow(commissionDailyId);
        expect(afterRow?.status).toBe('disputed');
        expect(afterRow?.employee_id).toBe(employeeY);
        expect(afterRow?.version).toBe(expectedVersion);
      },
    );
  },
);

// --- (a2) slice-close review round 1, finding 1: proves the confirm-side self-review EXISTS check
// itself fires (0037:159-163) — the SAME actor, confirming the SAME row, WITHOUT touching employee_id,
// so the immutability check above never fires and the write genuinely reaches the self-review EXISTS
// check. Slice-close review round 2, finding 2: the CASE binding at 0037:162 is unreachable on UPDATE
// once employee_id is immutable (0037:56); kept as defense in depth, not independently testable. ----

describe(
  'SECURITY: the confirm-side self-review EXISTS check itself (0037:159-163) fires when the same ' +
    'actor confirms their own disputed row without touching employee_id — never touches ' +
    'employee_id, so the employee_id-immutability check never fires either',
  () => {
    it(
      'DRIVER_DELSUP_ACTOR_UUID (linked to employeeY, holding hr.commission.confirm via DEL_SUP) ' +
        "confirming employeeY's OWN disputed row, WITHOUT changing employee_id, is rejected with " +
        'insufficient_privilege (SQLSTATE 42501) and the self-review message',
      async () => {
        const employeeY = await createFixtureEmployee('self-confirm-no-reassign-owner-y');
        await linkActorToEmployee(DRIVER_DELSUP_ACTOR_UUID, employeeY);

        const commissionDailyId = await createFixtureCommissionDaily({
          employeeId: employeeY,
          workDate: '2024-05-29',
          createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
          status: 'disputed',
          disputingActorUserId: DRIVER_DELSUP_ACTOR_UUID,
        });

        const beforeRow = await getCommissionDailyRow(commissionDailyId);
        expect(beforeRow?.status).toBe('disputed');
        const expectedVersion = beforeRow?.version;

        const updateError = await runAsActor(
          DRIVER_DELSUP_ACTOR_UUID,
          `update hr.commission_daily
              set status = 'confirmed', confirmed_by = $1, confirmed_at = now(), version = version + 1
            where id = $2 and version = $3`,
          [DRIVER_DELSUP_ACTOR_UUID, commissionDailyId, expectedVersion],
        );

        expect(updateError).toBeDefined();
        expect((updateError as { code?: string } | undefined)?.code).toBe('42501'); // insufficient_privilege
        expect((updateError as { message?: string } | undefined)?.message).toEqual(
          expect.stringContaining('اعتماد اعتراضه بنفسه'),
        ); // 0037:164 — the self-review EXISTS check, bound to old.employee_id.

        // sanity check only — read through the admin `pool` AFTER runAsActor's own unconditional
        // rollback has already completed (a separate query on a separate, later connection, not a
        // same-transaction read).
        const afterRow = await getCommissionDailyRow(commissionDailyId);
        expect(afterRow?.status).toBe('disputed');
        expect(afterRow?.employee_id).toBe(employeeY);
        expect(afterRow?.version).toBe(expectedVersion);
      },
    );
  },
);

// --- (b) employee_id immutability on EVERY UPDATE (doc 38 row 3.13 ruling, see file header) ------

describe(
  'employee_id immutability (doc 38 row 3.13 pre-migration review ruling: a frozen snapshot, ' +
    're-attribution belongs to a dedicated assignment table, never a mutation of this column) — ' +
    'employee_id must not be reassignable by ANY UPDATE, on ANY status, even one that makes no ' +
    'status change at all — CLOSED by migration 0037 (0037:56-59)',
  () => {
    it(
      'a bare UPDATE that changes ONLY employee_id (no status change) on a still-CALCULATED row is ' +
        'rejected with insufficient_privilege (SQLSTATE 42501) and the employee_id-immutability message',
      async () => {
        const employeeY = await createFixtureEmployee('immutable-calculated-owner-y');
        const employeeX = await createFixtureEmployee('immutable-calculated-decoy-x');

        const commissionDailyId = await createFixtureCommissionDaily({
          employeeId: employeeY,
          workDate: '2024-05-08',
          createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
          status: 'calculated',
        });

        const beforeRow = await getCommissionDailyRow(commissionDailyId);
        expect(beforeRow?.status).toBe('calculated');
        const expectedVersion = beforeRow?.version;

        // admin pool directly — the trigger is a BEFORE trigger on the table, not an RLS policy, so
        // it fires regardless of which role performs the write; no session actor is needed to prove
        // an unconditional immutability check.
        let updateError: unknown;
        try {
          await pool.query(
            `update hr.commission_daily set employee_id = $1, version = version + 1 where id = $2 and version = $3`,
            [employeeX, commissionDailyId, expectedVersion],
          );
        } catch (error) {
          updateError = error;
        }

        expect(updateError).toBeDefined();
        expect((updateError as { code?: string } | undefined)?.code).toBe('42501'); // insufficient_privilege
        expect((updateError as { message?: string } | undefined)?.message).toEqual(
          expect.stringContaining('employee_id غير قابل للتعديل'),
        ); // 0037:57

        const afterRow = await getCommissionDailyRow(commissionDailyId);
        expect(afterRow?.employee_id).toBe(employeeY);
      },
    );

    it(
      'a bare UPDATE that changes ONLY employee_id (no status change) on a DISPUTED row is rejected ' +
        'with insufficient_privilege (SQLSTATE 42501) and the employee_id-immutability message',
      async () => {
        const employeeY = await createFixtureEmployee('immutable-disputed-owner-y');
        const employeeX = await createFixtureEmployee('immutable-disputed-decoy-x');
        await linkActorToEmployee(DRIVER_DELSUP_ACTOR_UUID, employeeY);

        const commissionDailyId = await createFixtureCommissionDaily({
          employeeId: employeeY,
          workDate: '2024-05-27',
          createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
          status: 'disputed',
          disputingActorUserId: DRIVER_DELSUP_ACTOR_UUID,
        });

        const beforeRow = await getCommissionDailyRow(commissionDailyId);
        const expectedVersion = beforeRow?.version;

        // admin pool directly — the trigger is a BEFORE trigger on the table, not an RLS policy, so
        // it fires regardless of which role performs the write; no session actor is needed to prove
        // an unconditional immutability check.
        let updateError: unknown;
        try {
          await pool.query(
            `update hr.commission_daily set employee_id = $1, version = version + 1 where id = $2 and version = $3`,
            [employeeX, commissionDailyId, expectedVersion],
          );
        } catch (error) {
          updateError = error;
        }

        expect(updateError).toBeDefined();
        expect((updateError as { code?: string } | undefined)?.code).toBe('42501'); // insufficient_privilege
        expect((updateError as { message?: string } | undefined)?.message).toEqual(
          expect.stringContaining('employee_id غير قابل للتعديل'),
        ); // 0037:57

        const afterRow = await getCommissionDailyRow(commissionDailyId);
        expect(afterRow?.employee_id).toBe(employeeY);
      },
    );

    it(
      'a bare UPDATE that changes ONLY employee_id (no status change) on an already-CONFIRMED row ' +
        'is rejected with insufficient_privilege (SQLSTATE 42501) and the employee_id-immutability ' +
        'message',
      async () => {
        const employeeY = await createFixtureEmployee('immutable-confirmed-owner-y');
        const employeeX = await createFixtureEmployee('immutable-confirmed-decoy-x');

        const commissionDailyId = await createFixtureCommissionDaily({
          employeeId: employeeY,
          workDate: '2024-05-07',
          createdAt: new Date(NOW.getTime() - 100 * HOURS_TO_MS),
          status: 'calculated',
        });
        // the window-expiry auto-confirm path (the one edge the guard exempts from requiring a
        // confirmer) — admin pool, matching every sibling suite's own auto-confirm fixture pattern.
        await pool.query(
          `update hr.commission_daily
              set status = 'confirmed', confirmed_at = now(), payroll_period = $1, version = version + 1
            where id = $2`,
          ['2024-05-01', commissionDailyId],
        );

        const beforeRow = await getCommissionDailyRow(commissionDailyId);
        expect(beforeRow?.status).toBe('confirmed');
        const expectedVersion = beforeRow?.version;

        let updateError: unknown;
        try {
          await pool.query(
            `update hr.commission_daily set employee_id = $1, version = version + 1 where id = $2 and version = $3`,
            [employeeX, commissionDailyId, expectedVersion],
          );
        } catch (error) {
          updateError = error;
        }

        expect(updateError).toBeDefined();
        expect((updateError as { code?: string } | undefined)?.code).toBe('42501'); // insufficient_privilege
        expect((updateError as { message?: string } | undefined)?.message).toEqual(
          expect.stringContaining('employee_id غير قابل للتعديل'),
        ); // 0037:57

        const afterRow = await getCommissionDailyRow(commissionDailyId);
        expect(afterRow?.employee_id).toBe(employeeY);
      },
    );
  },
);

// --- (c) positive control: a legitimate confirm by a genuinely different DEL_SUP actor, no
// employee_id tampering, must still succeed both before and after the fix -----------------------

describe(
  'positive control: a legitimate confirm by a DIFFERENT DEL_SUP actor (never linked to the row\'s ' +
    'own employee, no employee_id tampering) still succeeds — proves the fix above does not break ' +
    'the ordinary confirm path',
  () => {
    it('OTHER_DELSUP_ACTOR_UUID confirms employeeY\'s disputed row without touching employee_id — succeeds', async () => {
      const employeeY = await createFixtureEmployee('positive-control-owner-y');
      await linkActorToEmployee(DRIVER_DELSUP_ACTOR_UUID, employeeY);

      const commissionDailyId = await createFixtureCommissionDaily({
        employeeId: employeeY,
        workDate: '2024-05-28',
        createdAt: new Date(NOW.getTime() - 10 * HOURS_TO_MS),
        status: 'disputed',
        disputingActorUserId: DRIVER_DELSUP_ACTOR_UUID,
      });

      const beforeRow = await getCommissionDailyRow(commissionDailyId);
      const expectedVersion = beforeRow?.version;

      const updateError = await runAsActorCommitting(
        OTHER_DELSUP_ACTOR_UUID,
        `update hr.commission_daily
            set status = 'confirmed', confirmed_by = $1, confirmed_at = now(), version = version + 1
          where id = $2 and version = $3`,
        [OTHER_DELSUP_ACTOR_UUID, commissionDailyId, expectedVersion],
      );

      expect(updateError).toBeUndefined();

      const afterRow = await getCommissionDailyRow(commissionDailyId);
      expect(afterRow?.status).toBe('confirmed');
      expect(afterRow?.employee_id).toBe(employeeY);
      expect(afterRow?.confirmed_by).toBe(OTHER_DELSUP_ACTOR_UUID);
    });
  },
);
