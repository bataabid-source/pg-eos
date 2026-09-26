// modules/billing/tests/dimensions/dimensions.test.ts — WBS 4.1b PART 1 (lane 2).
//
// Integration tests against `billing.dimension_types` ONLY (SCR-ACC-01 #9, part 1 half) — no
// `billing.line_dimensions`, no journal_entries/journal_lines fixture, no value_ref, no
// dimension_type_id-tagging scenario. Scope ruling (brief): a `line_dimensions` row without a
// value column is a half-record; that table and every value concept moves to part 2. No
// application command, no api/ handler exists for this slice yet — this test file exercises the
// domain+contract+DB layers directly. Per the brief's "RLS design note": `dimension_types` is
// entity-scoped (pattern (1), `entity_id` hard column) and only requires the caller be an internal
// user scoped to the row's entity (`platform.allowed_entities()`) — no special permission grant
// needed (unlike 4.1a's `gl_accounts` `reference_write` wall).
//
// STATUS: `database/migrations/0030_2_dimensions.sql` is APPLIED. Every test in this file is
// GREEN against the real, live `billing.dimension_types` table — no assumption, no RED. (History:
// before the migration landed, every test here was expected RED for "relation ... does not exist"
// / "column ... does not exist"; that phase is over.)
//
// LIVE SCHEMA (Schema design — part 1, brief; column list fixed at the pre-migration pg-reviewer
// review, migration 0030_2_dimensions.sql):
//   billing.dimension_types (
//     id uuid pk, entity_id uuid not null references platform.entities(id),
//     code text not null, name_ar text not null, name_en text,
//     is_active boolean not null default true, version int not null default 1,
//     kind text not null check (kind in ('list','reference')),
//     source_table text,  -- nullable; kind='reference' => not null and in the closed whitelist;
//                         -- kind='list' => must be null
//     unique (entity_id, code)
//   )   -- entity_scope RLS (NOT reference_write — avoids 4.1a's permission-gap wall)
//
// Domain surface (see also ./invariants.property.test.ts) — pg-backend landed this; it is GREEN
// and correct:
//   modules/billing/domain/dimensions/invariants.ts
//     - `isValidDimensionTypeKindSourcePair(kind: 'list' | 'reference', sourceTable: string | null): boolean`
//     - `assertValidDimensionTypeKindSourcePair(kind: 'list' | 'reference', sourceTable: string | null): void`
//       — throws InvalidDimensionTypeKindSourcePairError
//     - `DIMENSION_SOURCE_TABLES` — the closed whitelist constant (readonly string[])
//   modules/billing/domain/dimensions/errors.ts
//     - `InvalidDimensionTypeKindSourcePairError`
//   NOTE: `isKnownDimensionType` / `assertKnownDimensionType` / `UnknownDimensionTypeError` from
//   the pre-rescope draft are DROPPED — that concept only made sense checking a
//   line_dimensions.dimension_type_id against a known set (part 2's job, once line_dimensions
//   exists). Part 1 has no caller ever needing to check "is this id a known dimension type" in
//   isolation; confirmed removed from the domain surface.
//   This file is GREEN end to end: domain layer, contract, and the live DB schema all agree.
//
// RLS pattern: admin pool (PGUSER, bypasses RLS) for fixture setup/teardown and the "insert
// directly, skipping any application layer, to prove the DB CHECK/constraint fires on its own"
// scenarios (precedent: modules/billing/tests/chart-of-accounts/chart-of-accounts.test.ts).
// `withContext(ctx, fn)` (precedent: modules/billing/tests/record-billable-event/
// record-billable-event.test.ts) for the RLS scenario.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';
import { withContext } from '@pg-eos/db';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// Admin pool (PGUSER, bypasses RLS) — fixture setup/teardown and direct-insert proof scenarios.
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals --------------------------------------------------------------------------------

const NAME_AR = 'نوع بُعد اختبار — WBS 4.1b';
const CHECK_VIOLATION = '23514'; // Postgres SQLSTATE for check_violation.
const UNIQUE_VIOLATION = '23505';
const RLS_POLICY_VIOLATION = '42501'; // insufficient_privilege — INSERT blocked by a WITH CHECK RLS policy.

const OWNER_ACTOR_UUID = '00000000-0000-4000-8000-0000000411b1';
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000411b3'; // no user_entities row for `entityId`.

// Closed source_table whitelist (brief, verbatim) — used to prove the "accepted" half of the
// reference-kind scenario; a value NOT in this list proves the "rejected" half.
const WHITELISTED_SOURCE_TABLE = 'sales.accounts';
const UNWHITELISTED_SOURCE_TABLE = 'not_a_real_schema.not_a_real_table';

let entityId: string;
let outsiderEntityId: string;

const fixtureDimensionTypeIds: string[] = [];

/** Walks `error`'s own cause chain for a Postgres error with the given SQLSTATE — same discipline
 *  as ../../infrastructure/record-billable-event/repository.ts's own findRaisedException. Returns
 *  the MATCHING error in the chain (never drizzle's own outer "Failed query: ..." wrapper). */
function findRaisedException(error: unknown, sqlstate: string): Error | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (code === sqlstate) {
      return current;
    }
    current = current.cause;
  }

  return undefined;
}

function ctxFor(userId: string): WithContextCtx {
  return { userId, clientId: null, isInternal: true };
}

function uniqueCode(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

async function insertDimensionType(input: {
  entityIdValue: string;
  code: string;
  kind: 'list' | 'reference';
  sourceTable?: string | null;
  isActive?: boolean;
}): Promise<QueryResult<{ id: string }>> {
  return pool.query(
    `insert into billing.dimension_types (entity_id, code, name_ar, kind, source_table, is_active)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      input.entityIdValue,
      input.code,
      NAME_AR,
      input.kind,
      input.sourceTable ?? null,
      input.isActive ?? true,
    ],
  );
}

async function insertDimensionTypeExpectingSuccess(input: {
  entityIdValue: string;
  code: string;
  kind: 'list' | 'reference';
  sourceTable?: string | null;
}): Promise<string> {
  const result = await insertDimensionType(input);
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.dimension_types insert returned no id');
  fixtureDimensionTypeIds.push(row.id);
  return row.id;
}

async function createFixtureActor(userId: string, entityIds: readonly string[]): Promise<void> {
  // No delete here (round-2 review finding 10): a DELETE outside afterAll is forbidden (D-183).
  // OWNER_ACTOR_UUID / OUTSIDER_ACTOR_UUID are fixed literals, so instead of delete-then-insert this
  // is an idempotent upsert (`on conflict ... do nothing`/`do update`) — self-healing even if a
  // prior run crashed mid-test and left a row behind before its own afterAll could run, with no
  // window where the row is briefly absent.
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
     on conflict (id) do update set email = excluded.email`,
    [userId, `_dim_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار الأبعاد — WBS 4.1b'],
  );
  for (const eid of entityIds) {
    await pool.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict (user_id, entity_id) do nothing`,
      [userId, eid],
    );
  }
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code = $1`,
    ['PST'],
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  const otherEntityResult: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where id <> $1 limit 1`,
    [entityId],
  );
  const otherEntityRow = otherEntityResult.rows[0];
  if (!otherEntityRow) throw new Error('expected at least 2 rows in platform.entities (per-entity fixture)');
  outsiderEntityId = otherEntityRow.id;
});

afterAll(async () => {
  // Best-effort, per fixture group (round-2 review finding 10): this must run to completion (and
  // must reach pool.end()) even if an earlier `it` in this file threw mid-run, and one stubborn row
  // must not block cleanup of the rest — style matches tests/isolation/tests/rls-matrix.test.ts's
  // own afterAll.
  try {
    if (fixtureDimensionTypeIds.length > 0) {
      await pool.query(`delete from billing.dimension_types where id = any($1::uuid[])`, [fixtureDimensionTypeIds]);
    }
  } catch {
    // Best-effort only — this database is a throwaway fixture.
  }

  try {
    await pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [
      [OWNER_ACTOR_UUID, OUTSIDER_ACTOR_UUID],
    ]);
  } catch {
    // Best-effort only.
  }

  try {
    await pool.query(`delete from identity.users where id = any($1::uuid[])`, [
      [OWNER_ACTOR_UUID, OUTSIDER_ACTOR_UUID],
    ]);
  } catch {
    // Best-effort only.
  } finally {
    await pool.end();
  }
});

// --- Scenario: A new dimension type is added as a data row — no DDL runs (zero migration) ------

describe('Scenario: A new dimension type is added as a data row — no DDL runs (zero migration)', () => {
  it('both rows exist as plain data, distinguished only by their code', async () => {
    const codeOne = uniqueCode('cost_center');
    const codeTwo = uniqueCode('project');

    const idOne = await insertDimensionTypeExpectingSuccess({ entityIdValue: entityId, code: codeOne, kind: 'list' });
    const idTwo = await insertDimensionTypeExpectingSuccess({ entityIdValue: entityId, code: codeTwo, kind: 'list' });

    expect(idOne).not.toBe(idTwo);

    const result: QueryResult<{ code: string }> = await pool.query(
      `select code from billing.dimension_types where id = any($1::uuid[]) order by code`,
      [[idOne, idTwo]],
    );
    expect(result.rows.map((row) => row.code).sort()).toEqual([codeOne, codeTwo].sort());
  });
});

// --- Scenario: A dimension type of kind "reference" requires a source_table from the closed whitelist ---

describe('Scenario: A dimension type of kind "reference" requires a source_table from the closed whitelist', () => {
  it('the insert succeeds when source_table is a whitelisted value', async () => {
    const id = await insertDimensionTypeExpectingSuccess({
      entityIdValue: entityId,
      code: uniqueCode('reference_ok'),
      kind: 'reference',
      sourceTable: WHITELISTED_SOURCE_TABLE,
    });
    const result: QueryResult<{ source_table: string }> = await pool.query(
      `select source_table from billing.dimension_types where id = $1`,
      [id],
    );
    expect(result.rows[0]?.source_table).toBe(WHITELISTED_SOURCE_TABLE);
  });

  it('the insert is rejected when kind = reference and source_table is null', async () => {
    await expect(
      insertDimensionType({
        entityIdValue: entityId,
        code: uniqueCode('reference_null'),
        kind: 'reference',
        sourceTable: null,
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

// --- Scenario: A dimension type of kind "list" must not carry a source_table ---

describe('Scenario: A dimension type of kind "list" must not carry a source_table', () => {
  it('the insert is rejected by the database CHECK constraint', async () => {
    await expect(
      insertDimensionType({
        entityIdValue: entityId,
        code: uniqueCode('list_with_source'),
        kind: 'list',
        sourceTable: WHITELISTED_SOURCE_TABLE,
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

// --- Scenario: An unknown/unwhitelisted source_table is rejected by the database CHECK ---

describe('Scenario: An unknown/unwhitelisted source_table is rejected by the database CHECK', () => {
  it('the insert is rejected by the database CHECK constraint', async () => {
    await expect(
      insertDimensionType({
        entityIdValue: entityId,
        code: uniqueCode('unwhitelisted'),
        kind: 'reference',
        sourceTable: UNWHITELISTED_SOURCE_TABLE,
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

// --- Scenario: The same code may exist once per entity and never twice in one entity ---

describe('Scenario: The same code may exist once per entity and never twice in one entity (unique (entity_id, code))', () => {
  it('a second row for the SAME entity with the SAME code is rejected; the SAME code for a DIFFERENT entity succeeds', async () => {
    const code = uniqueCode('dup_code');
    await insertDimensionTypeExpectingSuccess({ entityIdValue: entityId, code, kind: 'list' });

    await expect(
      insertDimensionType({ entityIdValue: entityId, code, kind: 'list' }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    const otherEntityRowId = await insertDimensionTypeExpectingSuccess({
      entityIdValue: outsiderEntityId,
      code,
      kind: 'list',
    });
    expect(otherEntityRowId).toBeTruthy();
  });
});

// --- Scenario: RLS — a caller scoped to another entity cannot read or write this entity's dimension_types rows ---
// "write" here covers all three write verbs `pgeos_app` holds on this table (migration
// 0030_2_dimensions.sql grants select/insert/update/delete): INSERT is proven rejected outright by
// the RLS policy (42501, WITH CHECK fails outright); UPDATE and DELETE are proven to affect ZERO
// rows — not to raise 42501 — because the entity_scope policy's USING clause filters the row out of
// the outsider's visible rowset entirely, so there is nothing FOR the UPDATE/DELETE's WHERE clause
// to match in the first place (empirically confirmed, not assumed). An admin-pool read after each
// confirms the row is completely unchanged.

describe("Scenario: RLS — a caller scoped to another entity cannot read or write this entity's dimension_types rows", () => {
  it('zero rows are returned to the outsider, and the outsider\'s insert is rejected by the RLS policy', async () => {
    await createFixtureActor(OWNER_ACTOR_UUID, [entityId]);
    await createFixtureActor(OUTSIDER_ACTOR_UUID, [outsiderEntityId]);

    const dimensionTypeId = await insertDimensionTypeExpectingSuccess({
      entityIdValue: entityId,
      code: uniqueCode('rls'),
      kind: 'list',
    });

    // The owner, scoped to `entityId`, sees the row through the RLS-governed app pool.
    const ownerVisible = await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(
        sql`select id from billing.dimension_types where id = ${dimensionTypeId}`,
      );
    });
    expect(ownerVisible.rows.length).toBeGreaterThan(0);

    // The outsider, scoped only to a DIFFERENT entity, sees zero rows.
    const outsiderDimensionTypes = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute<{ id: string }>(sql`select id from billing.dimension_types where id = ${dimensionTypeId}`);
    });
    expect(outsiderDimensionTypes.rows.length).toBe(0);

    // The outsider's own INSERT for the pilot entity's dimension_types is rejected by RLS.
    // Drizzle wraps the underlying pg driver error in its own `DrizzleQueryError`; the real
    // SQLSTATE lives on `.cause` (walked here the same way
    // ../../infrastructure/record-billable-event/repository.ts's `findRaisedException` walks the
    // `.cause` chain), never on the outer wrapper itself.
    let rlsRejection: unknown;
    try {
      await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) => {
        return tx.execute(
          sql`insert into billing.dimension_types (entity_id, code, name_ar, kind, is_active)
              values (${entityId}, ${uniqueCode('rls_blocked')}, ${NAME_AR}, 'list', true)`,
        );
      });
    } catch (error) {
      rlsRejection = error;
    }

    expect(rlsRejection).toBeInstanceOf(Error);
    expect(findRaisedException(rlsRejection, RLS_POLICY_VIOLATION)).toBeDefined();

    // The outsider's UPDATE on the pilot entity's own row affects 0 rows — RLS filters the row out
    // of the outsider's visible rowset before the WHERE clause ever gets a chance to match it, so
    // there is nothing to raise 42501 about; it is simply a no-op UPDATE.
    const outsiderUpdateResult = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute(
        sql`update billing.dimension_types set name_en = 'outsider-write-attempt' where id = ${dimensionTypeId}`,
      );
    });
    expect(outsiderUpdateResult.rowCount ?? 0).toBe(0);

    // Confirmed via the admin pool (bypasses RLS): the row is completely unchanged.
    const afterUpdate: QueryResult<{ name_en: string | null }> = await pool.query(
      `select name_en from billing.dimension_types where id = $1`,
      [dimensionTypeId],
    );
    expect(afterUpdate.rows[0]?.name_en).toBeNull();

    // The outsider's DELETE on the pilot entity's own row likewise affects 0 rows for the same
    // reason: the row is invisible to the outsider under entity_scope, so there is nothing FOR the
    // DELETE to remove.
    const outsiderDeleteResult = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) => {
      return tx.execute(sql`delete from billing.dimension_types where id = ${dimensionTypeId}`);
    });
    expect(outsiderDeleteResult.rowCount ?? 0).toBe(0);

    // Confirmed via the admin pool: the row still exists, unchanged.
    const afterDelete: QueryResult<{ id: string }> = await pool.query(
      `select id from billing.dimension_types where id = $1`,
      [dimensionTypeId],
    );
    expect(afterDelete.rows.length).toBe(1);
  });
});
