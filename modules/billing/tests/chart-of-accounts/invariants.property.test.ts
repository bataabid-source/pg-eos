// modules/billing/tests/chart-of-accounts/invariants.property.test.ts — WBS 4.1a (lane 2).
//
// Property test (fast-check): for every generated string, the domain-level account-code format
// check and the database CHECK constraint on billing.gl_accounts.code agree (accept iff accept).
// This is the slice brief's own invariant statement verbatim: "for every generated string, the
// domain format check and the DB CHECK agree (accept <=> accept)."
//
// The CHECK constraint on `billing.gl_accounts.code` lands in this slice's own migration
// (0028_2_chart-of-accounts.sql) — this file proves the domain-level `isValidAccountCode` and that
// DB CHECK agree on every generated input.
//
// Domain surface this slice expects pg-backend to add (see also ./chart-of-accounts.test.ts):
//   modules/billing/domain/chart-of-accounts/invariants.ts
//     - `isValidAccountCode(code: string): boolean` — true iff `code` matches X-XX-XXX-XXX with
//       its first segment in 1-9 (SCR-ACC-01 #1). Pure: no I/O, no Date, no Math.random().
//     - `accountClassFromCode(code: string): number`
//     - `ALLOWED_ACCOUNT_TYPES: readonly string[]`
//   modules/billing/domain/chart-of-accounts/errors.ts
//     - `InvalidAccountCodeError`

import { Pool } from 'pg';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isValidAccountCode } from '../../domain/chart-of-accounts/invariants.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

let entityId: string;
const NAME_AR = 'حساب اختبار خاصية دليل الحسابات — WBS 4.1a';
const VALID_ACCOUNT_TYPE = 'asset';
const insertedIds: string[] = [];

// True iff the DB CHECK on billing.gl_accounts.code accepts `code` — proven by actually attempting
// the insert (inside a rolled-back-on-cleanup row we track and delete), never by reading the
// constraint definition. A SQLSTATE 23514 (check_violation) means the DB rejected the shape; a
// SQLSTATE 23505 (unique_violation, a code collision between fast-check runs) is treated as
// "the CHECK itself did not reject it" — it is a different constraint entirely.
async function dbAcceptsCode(code: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `insert into billing.gl_accounts (entity_id, code, name_ar, account_type)
       values ($1, $2, $3, $4) returning id`,
      [entityId, code, NAME_AR, VALID_ACCOUNT_TYPE],
    );
    const id = (result.rows[0] as { id: string } | undefined)?.id;
    if (id) insertedIds.push(id);
    return true;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === '23514') return false; // check_violation — the format/class CHECK rejected it.
    if (pgError.code === '23505') return true; // unique_violation — a different constraint, not the shape CHECK.
    throw error;
  }
}

// Well-formed X-XX-XXX-XXX strings with class 1-9 — the domain SHOULD accept every one of these.
const wellFormedCodeArb = fc
  .tuple(
    fc.integer({ min: 1, max: 9 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 0, max: 999 }),
  )
  .map(
    ([cls, seg2, seg3, seg4]) =>
      `${cls}-${String(seg2).padStart(2, '0')}-${String(seg3).padStart(3, '0')}-${String(seg4).padStart(3, '0')}`,
  );

// Arbitrary strings, including malformed shapes, class-0/10+ segments, wrong separators, etc.
const arbitraryCodeArb = fc.oneof(
  wellFormedCodeArb,
  fc.string({ maxLength: 20 }),
  fc
    .tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 9999 }))
    .map(([cls, seg2, seg3, seg4]) => `${cls}-${seg2}-${seg3}-${seg4}`),
);

beforeAll(async () => {
  const entityResult = await pool.query<{ id: string }>(`select id from platform.entities where code = $1`, ['PST']);
  const row = entityResult.rows[0];
  if (!row) throw new Error(`platform.entities row not found for code 'PST'`);
  entityId = row.id;
});

afterAll(async () => {
  if (insertedIds.length > 0) {
    await pool.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [insertedIds]);
  }
  await pool.end();
});

describe('isValidAccountCode agrees with the database CHECK constraint (accept <=> accept)', () => {
  it('a well-formed X-XX-XXX-XXX code with class 1-9 is accepted by BOTH the domain check and the DB CHECK', async () => {
    await fc.assert(
      fc.asyncProperty(wellFormedCodeArb, async (code) => {
        expect(isValidAccountCode(code)).toBe(true);
        expect(await dbAcceptsCode(code)).toBe(true);
      }),
      { numRuns: 25 },
    );
  });

  it('for any generated code shape, the domain check and the DB CHECK agree on accept/reject', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryCodeArb, async (code) => {
        const domainAccepts = isValidAccountCode(code);
        const dbAccepts = await dbAcceptsCode(code);
        expect(dbAccepts).toBe(domainAccepts);
      }),
      { numRuns: 40 },
    );
  });
});
