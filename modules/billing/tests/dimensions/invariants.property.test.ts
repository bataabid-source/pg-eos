// modules/billing/tests/dimensions/invariants.property.test.ts — WBS 4.1b PART 1 (lane 2).
//
// Property test (fast-check): for any generated (kind, source_table) pair, the domain-level
// pre-check and the database CHECK constraint on billing.dimension_types agree (accept iff
// accept) on the kind/source_table pairing rule (D-190 hybrid design; Schema design — part 1,
// brief). This REPLACES the pre-rescope draft's `isKnownDimensionType`/DB-FK-on-line_dimensions
// property — that concept only made sense once `billing.line_dimensions` exists (part 2's job).
//
// STATUS: `database/migrations/0030_2_dimensions.sql` is APPLIED. `modules/billing/domain/
// dimensions/invariants.ts` exports `isValidDimensionTypeKindSourcePair` with the exact
// name/signature below, and the live `billing.dimension_types` table carries `kind` /
// `source_table` with the matching CHECK constraint — every property run is GREEN. (History:
// before the migration landed, this file was expected RED for SQLSTATE 42P01, "relation ... does
// not exist"; that phase is over.)
//
// Domain surface — pg-backend landed this; it is GREEN and correct:
//   modules/billing/domain/dimensions/invariants.ts
//     - `isValidDimensionTypeKindSourcePair(kind: 'list' | 'reference', sourceTable: string | null): boolean`
//       — true iff the (kind, sourceTable) pairing satisfies the Schema design — part 1 rule:
//       kind='reference' => sourceTable is non-null AND a member of DIMENSION_SOURCE_TABLES;
//       kind='list' => sourceTable is null. Pure: no I/O, no Date, no Math.random(), same
//       discipline as modules/billing/domain/chart-of-accounts/invariants.ts's own
//       isValidAccountCode.
//     - `assertValidDimensionTypeKindSourcePair(kind: 'list' | 'reference', sourceTable: string | null): void`
//       — throws `InvalidDimensionTypeKindSourcePairError` iff
//       `!isValidDimensionTypeKindSourcePair(...)`.
//     - `DIMENSION_SOURCE_TABLES: readonly string[]` — the closed whitelist constant, verbatim
//       from the brief: sales.accounts, partners.partners, hr.employees, tms.vehicles,
//       wms.warehouses, platform.sites, imile.shipments, platform.entities.
//   modules/billing/domain/dimensions/errors.ts
//     - `InvalidDimensionTypeKindSourcePairError`
//
// The DB side of the agreement is proven by actually attempting the insert against
// billing.dimension_types and reading the CHECK-violation SQLSTATE (23514) — same style as
// modules/billing/tests/chart-of-accounts/invariants.property.test.ts.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DIMENSION_SOURCE_TABLES,
  isValidDimensionTypeKindSourcePair,
} from '../../domain/dimensions/invariants.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const NAME_AR = 'نوع بُعد اختبار الخاصية — WBS 4.1b';
const CHECK_VIOLATION = '23514';

let entityId: string;
const insertedDimensionTypeIds: string[] = [];

beforeAll(async () => {
  const entityResult = await pool.query<{ id: string }>(`select id from platform.entities where code = $1`, ['PST']);
  const row = entityResult.rows[0];
  if (!row) throw new Error(`platform.entities row not found for code 'PST'`);
  entityId = row.id;
});

afterAll(async () => {
  // Best-effort cleanup: this must run to completion (and not throw) even if an earlier `it` in
  // this file threw mid-run, so one stubborn row never blocks cleanup of the rest, or blocks
  // pool.end() from running (round-2 review finding 10; style matches
  // tests/isolation/tests/rls-matrix.test.ts's own afterAll).
  try {
    if (insertedDimensionTypeIds.length > 0) {
      await pool.query(`delete from billing.dimension_types where id = any($1::uuid[])`, [insertedDimensionTypeIds]);
    }
  } catch {
    // Best-effort only — this database is a throwaway fixture; a single stubborn row must not
    // fail the suite or skip pool.end() below.
  } finally {
    await pool.end();
  }
});

// True iff the DB CHECK on billing.dimension_types (kind, source_table) accepts the pair —
// proven by actually attempting the insert. Every code is a fresh randomUUID(), so the
// (entity_id, code) unique constraint can never fill up across fast-check runs — there is no need
// to delete inside the test body; every row inserted here is tracked in insertedDimensionTypeIds
// and removed once, in afterAll (round-2 review finding 10: an in-test DELETE outside afterAll is
// forbidden, D-183, and was based on an incorrect premise here in any case).
async function dbAcceptsKindSourcePair(kind: 'list' | 'reference', sourceTable: string | null): Promise<boolean> {
  try {
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.dimension_types (entity_id, code, name_ar, kind, source_table)
       values ($1, $2, $3, $4, $5) returning id`,
      [entityId, `_dimprop_${randomUUID()}`, NAME_AR, kind, sourceTable],
    );
    const id = result.rows[0]?.id;
    if (id) {
      insertedDimensionTypeIds.push(id);
    }
    return true;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === CHECK_VIOLATION) return false; // the kind/source_table CHECK rejected it.
    throw error;
  }
}

describe('isValidDimensionTypeKindSourcePair agrees with the DB CHECK on dimension_types (accept <=> accept)', () => {
  it('for any generated (kind, source_table) pair, the domain check and the DB CHECK agree on accept/reject', async () => {
    const kindArb = fc.constantFrom<'list' | 'reference'>('list', 'reference');
    const sourceTableArb = fc.oneof(
      fc.constant(null),
      fc.constantFrom(...DIMENSION_SOURCE_TABLES),
      fc.string({ minLength: 1 }).filter((value) => !DIMENSION_SOURCE_TABLES.includes(value)),
    );

    await fc.assert(
      fc.asyncProperty(kindArb, sourceTableArb, async (kind, sourceTable) => {
        const domainAccepts = isValidDimensionTypeKindSourcePair(kind, sourceTable);
        const dbAccepts = await dbAcceptsKindSourcePair(kind, sourceTable);
        expect(dbAccepts).toBe(domainAccepts);
      }),
      { numRuns: 30 },
    );
  });

  // Round-2 review finding 8: this must prove EVERY one of the 8 whitelisted values is accepted,
  // not a random sample drawn WITH replacement (fc.constantFrom + numRuns = 8 gives only a ~0.24%
  // chance all 8 distinct values are even drawn once — it does not prove "every"). it.each runs
  // one case per whitelisted value, unconditionally, so all 8 are actually exercised.
  it.each(DIMENSION_SOURCE_TABLES)(
    'source_table = %s is accepted for kind = reference by BOTH the domain check and the DB',
    async (sourceTable) => {
      expect(isValidDimensionTypeKindSourcePair('reference', sourceTable)).toBe(true);
      expect(await dbAcceptsKindSourcePair('reference', sourceTable)).toBe(true);
    },
  );
});
