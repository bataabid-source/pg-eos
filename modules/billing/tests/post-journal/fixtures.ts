// modules/billing/tests/post-journal/fixtures.ts — WBS 4.20 (lane 2). Test-only helper shared by
// ./post-journal.test.ts and ./handlers.test.ts (not a test file itself: no *.test.ts suffix).
//
// Every row it creates is this run's OWN synthetic fixture on the pilot chart (D-127): a synthetic
// fiscal year strictly after any year another file already used (never 2026, never current_date),
// its own accounting periods, its own GL accounts and actors, and its own platform.counters 'JE' rows
// (01:1591 seeds counters only for entities that existed when 01 was applied — the design says a
// fixture seeds its own). `cleanup()` is the only place anything is deleted: the file's OWN tracked
// rows, in one admin transaction under session_replication_role = replica (D-183: afterAll of the
// suite's own test project only; platform.outbox / platform.audit_log are never touched).

import { randomInt, randomUUID } from 'node:crypto';

import type { Pool, QueryResult } from 'pg';

const SYNTHETIC_YEAR_FLOOR = 1899;
const SYNTHETIC_YEAR_CUTOFF = '1950-01-01';
const FY_LENGTH_DAYS = 800;
const FY_YEAR_STEP = 3; // an 800-day fiscal year spans up to three calendar years.
const PERIOD_LENGTH_DAYS = 14;
const PERIOD_GAP_DAYS = 2;
const JE_DOC_TYPE = 'JE';
const JE_COUNTER_PERIOD = 'ALL';
const JE_COUNTER_PADDING = 5;
const ACCOUNT_CODE_SEGMENT_MAX = { seg2: 100, seg3: 1000 };

export type Fixtures = {
  readonly entityId: string; // 'PST'
  readonly entityCode: string;
  readonly outsiderEntityId: string; // 'PCC'
  readonly fiscalYearStart: string;
  /** Scoped to the pilot entity only. */
  readonly posterId: string;
  /** Scoped to the outsider entity only. */
  readonly outsiderId: string;
  /** Scoped to the pilot entity, holds NO role (the non-CFO actor of the role-gate scenarios). */
  readonly plainId: string;
  /** Scoped to BOTH entities (for the "account of another entity" scenario). */
  readonly bothId: string;
  readonly accounts: {
    readonly debit: string; // pilot, asset, postable
    readonly credit: string; // pilot, expense, postable
    readonly revenue: string; // pilot, revenue, postable
    readonly unpostable: string; // pilot, is_postable = false
    readonly foreign: string; // outsider entity, postable
  };
  nextPeriod(): Promise<{ id: string; startDate: string; endDate: string }>;
  /** Admin-pool status advance open -> closed [-> locked], version + 1 per edge (the 4.19 pattern). */
  setPeriodStatus(periodId: string, target: 'closed' | 'locked'): Promise<void>;
  trackEntry(entryId: string): void;
  ctx(userId: string): { userId: string; clientId: null; isInternal: true };
  jeCounterPrefix(forEntityId: string): Promise<string>;
  cleanup(): Promise<void>;
};

/** The adjust route's body: a post body without `entryType` (the adjustment type is implied). */
export function adjustBody(postBody: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(postBody).filter(([key]) => key !== 'entryType'));
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function digits(width: number, max: number): string {
  return String(randomInt(0, max)).padStart(width, '0');
}

export async function createFixtures(pool: Pool, opts: { readonly tag: string; readonly fileNo: string }): Promise<Fixtures> {
  const posterId = `00000000-0000-4000-8000-00000420${opts.fileNo}01`;
  const outsiderId = `00000000-0000-4000-8000-00000420${opts.fileNo}02`;
  const bothId = `00000000-0000-4000-8000-00000420${opts.fileNo}03`;
  const plainId = `00000000-0000-4000-8000-00000420${opts.fileNo}04`;
  const actorIds = [posterId, outsiderId, bothId, plainId];
  const CFO_ROLE_CODE = 'CFO'; // doc 38 row 4.20 Owner = CFO; identity.roles seeded by 01.

  const entities = await pool.query<{ id: string; code: string }>(`select id, code from platform.entities where code in ('PST','PCC')`);
  const pst = entities.rows.find((row) => row.code === 'PST');
  const pcc = entities.rows.find((row) => row.code === 'PCC');
  if (!pst || !pcc) throw new Error("platform.entities rows for codes 'PST' and 'PCC' not found");

  for (const entity of [pst, pcc]) {
    await pool.query(
      `insert into platform.counters (entity_id, doc_type, period, prefix, padding) values ($1, $2, $3, $4, $5) on conflict do nothing`,
      [entity.id, JE_DOC_TYPE, JE_COUNTER_PERIOD, `${entity.code}-${JE_DOC_TYPE}-`, JE_COUNTER_PADDING],
    );
  }

  const createActor = async (userId: string, entityIds: readonly string[]): Promise<void> => {
    await pool.query(
      `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
       on conflict (id) do update set email = excluded.email`,
      [userId, `_je_fixture_${userId}_${randomUUID()}@test.invalid`, `ممثل اختبار محرك الترحيل — WBS 4.20 ${opts.tag}`],
    );
    for (const entityId of entityIds) {
      await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict (user_id, entity_id) do nothing`, [userId, entityId]);
    }
  };
  await createActor(posterId, [pst.id]);
  await createActor(outsiderId, [pcc.id]);
  await createActor(bothId, [pst.id, pcc.id]);
  await createActor(plainId, [pst.id]);
  // Post / reverse / adjust are CFO-gated (platform.my_roles()): every actor except plainId holds CFO.
  const roleResult: QueryResult<{ id: string }> = await pool.query(`select id from identity.roles where code = $1`, [CFO_ROLE_CODE]);
  const cfoRoleId = roleResult.rows[0]?.id;
  if (!cfoRoleId) throw new Error(`identity.roles row not found for code '${CFO_ROLE_CODE}'`);
  for (const userId of [posterId, outsiderId, bothId]) {
    await pool.query(`insert into identity.user_roles (user_id, role_id) values ($1, $2) on conflict do nothing`, [userId, cfoRoleId]);
  }

  const yearResult: QueryResult<{ year: number }> = await pool.query(
    `select coalesce(max(extract(year from end_date))::int, $2) + 1 as year
       from billing.fiscal_years where entity_id = $1::uuid and end_date < $3::date`,
    [pst.id, SYNTHETIC_YEAR_FLOOR, SYNTHETIC_YEAR_CUTOFF],
  );
  const firstYear = yearResult.rows[0]?.year;
  if (firstYear === undefined) throw new Error('synthetic year query returned no row');
  // A parallel test file may pick the same year: on the no-overlap exclusion (23P01) take the next year.
  const EXCLUSION_VIOLATION = '23P01';
  const MAX_YEAR_ATTEMPTS = 20;
  let fiscalYearStart = '';
  let fiscalYearId = '';
  for (let attempt = 0; attempt < MAX_YEAR_ATTEMPTS && fiscalYearId === ''; attempt += 1) {
    const start = `${firstYear + attempt * FY_YEAR_STEP}-01-01`;
    try {
      const fiscalYear = await pool.query<{ id: string }>(
        `insert into billing.fiscal_years (entity_id, start_date, end_date) values ($1, $2, $3) returning id`,
        [pst.id, start, addDays(start, FY_LENGTH_DAYS - 1)],
      );
      fiscalYearStart = start;
      fiscalYearId = fiscalYear.rows[0]?.id ?? '';
    } catch (error) {
      if ((error as { code?: string }).code !== EXCLUSION_VIOLATION) throw error;
    }
  }
  if (fiscalYearId === '') throw new Error('fixture billing.fiscal_years insert found no free synthetic year');

  const accountIds: string[] = [];
  const insertAccount = async (forEntityId: string, accountType: string, isPostable: boolean): Promise<string> => {
    const code = `9-${digits(2, ACCOUNT_CODE_SEGMENT_MAX.seg2)}-${digits(3, ACCOUNT_CODE_SEGMENT_MAX.seg3)}-${digits(3, ACCOUNT_CODE_SEGMENT_MAX.seg3)}`;
    const result = await pool.query<{ id: string }>(
      `insert into billing.gl_accounts (entity_id, code, name_ar, account_type, is_postable) values ($1, $2, $3, $4, $5) returning id`,
      [forEntityId, code, `حساب اختبار محرك الترحيل — WBS 4.20 ${opts.tag}`, accountType, isPostable],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('fixture billing.gl_accounts insert returned no id');
    accountIds.push(id);
    return id;
  };
  const accounts = {
    debit: await insertAccount(pst.id, 'asset', true),
    credit: await insertAccount(pst.id, 'expense', true),
    revenue: await insertAccount(pst.id, 'revenue', true),
    unpostable: await insertAccount(pst.id, 'expense', false),
    foreign: await insertAccount(pcc.id, 'expense', true),
  };

  const periodIds: string[] = [];
  const entryIds: string[] = [];
  let offset = 0;

  return {
    entityId: pst.id,
    entityCode: pst.code,
    outsiderEntityId: pcc.id,
    fiscalYearStart,
    posterId,
    outsiderId,
    plainId,
    bothId,
    accounts,
    async nextPeriod() {
      const startDate = addDays(fiscalYearStart, offset);
      const endDate = addDays(fiscalYearStart, offset + PERIOD_LENGTH_DAYS - 1);
      offset += PERIOD_LENGTH_DAYS + PERIOD_GAP_DAYS;
      const result = await pool.query<{ id: string }>(
        `insert into billing.accounting_periods (entity_id, fiscal_year_id, start_date, end_date) values ($1, $2, $3, $4) returning id`,
        [pst.id, fiscalYearId, startDate, endDate],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('fixture billing.accounting_periods insert returned no id');
      periodIds.push(id);
      return { id, startDate, endDate };
    },
    async setPeriodStatus(periodId, target) {
      await pool.query(`update billing.accounting_periods set status = 'closed', version = version + 1 where id = $1`, [periodId]);
      if (target === 'locked') {
        await pool.query(`update billing.accounting_periods set status = 'locked', version = version + 1 where id = $1`, [periodId]);
      }
    },
    trackEntry(entryId) {
      entryIds.push(entryId);
    },
    ctx(userId) {
      return { userId, clientId: null, isInternal: true };
    },
    async jeCounterPrefix(forEntityId) {
      const result = await pool.query<{ prefix: string }>(`select prefix from platform.counters where entity_id = $1 and doc_type = $2 and period = $3`, [
        forEntityId,
        JE_DOC_TYPE,
        JE_COUNTER_PERIOD,
      ]);
      const prefix = result.rows[0]?.prefix;
      if (prefix === undefined) throw new Error('platform.counters JE row not found');
      return prefix;
    },
    async cleanup() {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`set local session_replication_role = replica`);
        if (entryIds.length > 0) {
          await client.query(`delete from billing.journal_lines where entry_id = any($1::uuid[])`, [entryIds]);
          await client.query(`delete from billing.journal_entries where id = any($1::uuid[])`, [entryIds]);
        }
        if (periodIds.length > 0) await client.query(`delete from billing.accounting_periods where id = any($1::uuid[])`, [periodIds]);
        await client.query(`delete from billing.fiscal_years where id = $1`, [fiscalYearId]);
        await client.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [accountIds]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error; // a genuine cleanup failure must be visible.
      } finally {
        client.release();
      }
      await pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [actorIds]);
      await pool.query(`delete from identity.user_roles where user_id = any($1::uuid[])`, [actorIds]);
      await pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [actorIds]);
      await pool.query(`delete from identity.users where id = any($1::uuid[])`, [actorIds]);
    },
  };
}
