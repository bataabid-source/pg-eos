// modules/billing/tests/dimensions/line-dimensions.property.integration.test.ts — WBS 4.1b PART 2 (lane 2).
//
// Pre-build review round 1 fixes applied (finding 4): wording corrected to match the actual
// mechanism (R1 — a single trigger validates BOTH kinds, no declarative FK on value_id; R2 — the
// two entity-matching composite FKs on dimension_values/line_dimensions are the SEPARATE,
// additional integrity layer this property does not itself re-test, see ./line-dimensions.test.ts's
// own "R2" describe block for that); 3 cases added ("list: value under a DIFFERENT type", "list:
// value is INACTIVE", "list: value belongs to a DIFFERENT entity"); `valueIsActive` added to the
// `isAcceptableDimensionValueTag` oracle's own input shape; the DB-outcome catch is narrowed to the
// two SQLSTATEs C3 actually names (23503 missing, 23514 inactive/entity-mismatch) — any OTHER error
// code is a genuine bug and is rethrown, never silently swallowed as "false".
//
// Property test (fast-check): for any generated (kind, value-existence, active-flag, entity-match)
// combination, the database's own accept/reject decision on a billing.line_dimensions insert
// agrees with the domain-level oracle for the D-190 hybrid design rule (brief §Property test,
// verbatim): "the DB accepts a tag iff the value exists for that type (list: in dimension_values;
// reference: in the source table, same entity when the source has one)."
//
// Expected domain surface — modules/billing/domain/dimensions/invariants.ts (extends part 1's
// existing file, which already exports isValidDimensionTypeKindSourcePair /
// assertValidDimensionTypeKindSourcePair / DIMENSION_SOURCE_TABLES — untouched by this part):
//   - `isAcceptableDimensionValueTag(input: { readonly kind: 'list' | 'reference';
//       readonly valueExistsForType: boolean; readonly valueIsActive: boolean;
//       readonly sourceHasEntityId: boolean; readonly belongsToLineEntity: boolean }): boolean`
//     — true iff:
//       !valueExistsForType                              => false (C3: missing, 23503).
//       valueExistsForType && !valueIsActive              => false (C3: inactive, 23514).
//       kind = 'reference' && sourceHasEntityId
//         && !belongsToLineEntity                          => false (C3: entity mismatch, 23514).
//       otherwise                                          => true.
//     Pure: no I/O, no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS) — same discipline as
//     ./invariants.ts's own isValidDimensionTypeKindSourcePair (part 1).
//   - a NEW `DIMENSION_SOURCE_TABLES_WITH_ENTITY_ID` (see ./line-dimensions.test.ts's own header)
//     is NOT used by this file directly — only 2 of the 8 whitelisted tables are exercised here
//     (sales.accounts, wms.warehouses), enough to prove the oracle/DB agreement on both the
//     "sourceHasEntityId=false" and "=true" branches; the exhaustive all-8-table sweep lives in
//     ./line-dimensions.test.ts's own it.each block (round-1 finding 3).
//
// Each of the 10 cases below is a REAL, deterministic database setup (not free-form random
// generation over an infinite domain) — same "enumerate every meaningful case, run every one, never
// rely on random sampling to happen to cover it" discipline as
// ../dimensions/invariants.property.integration.test.ts's own it.each whitelist-exhaustiveness fix
// (round-2 review finding 8 there). it.each runs every one of the 10 cases
// exactly once; the fast-check block then samples the same cases (fc.constantFrom samples WITH
// replacement, so it is an additional randomised pass, not the exhaustiveness guarantee).

import { randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isAcceptableDimensionValueTag } from '../../domain/dimensions/invariants.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const GL_ACCOUNT_TYPE = 'expense';
const SALES_ACCOUNT_TYPE = 'client';

// Round-1 finding 11: narrow the catch to exactly the two SQLSTATEs C3 names — any other code is a
// genuine, unexpected failure and must NOT be silently interpreted as "the DB rejected the tag".
const MISSING_VALUE = '23503';
const INACTIVE_OR_ENTITY_MISMATCH = '23514';
type RejectCode = typeof MISSING_VALUE | typeof INACTIVE_OR_ENTITY_MISMATCH;

let entityId: string;
let outsiderEntityId: string; // fixed code 'PCC' (round-1 finding 18 discipline, applied here too).
let glAccountId: string;

let listTypeId: string;
let otherListTypeId: string; // round-1 finding 4: "list: value under a DIFFERENT type".
let outsiderListTypeId: string; // round-1 finding 4: "list: value belongs to a DIFFERENT entity".
let referenceTypeNoEntityId: string; // source_table = sales.accounts (no entity_id column).
let referenceTypeWithEntityId: string; // source_table = wms.warehouses (has entity_id).

let realListValueId: string; // exists for listTypeId, active.
let valueUnderOtherType: string; // exists, but for otherListTypeId, not listTypeId.
let outsiderListValueId: string; // exists for outsiderListTypeId (a DIFFERENT entity's own type).
let realSalesAccountId: string; // exists in sales.accounts.
let realWarehouseSameEntityId: string; // exists in wms.warehouses, entity_id = entityId.
let realWarehouseOtherEntityId: string; // exists in wms.warehouses, entity_id = outsiderEntityId.

const insertedLineDimensionIds: string[] = [];
const insertedDimensionValueIds: string[] = [];
const insertedDimensionTypeIds: string[] = [];
const insertedJournalLineIds: string[] = [];
const insertedJournalEntryIds: string[] = [];
const insertedGlAccountIds: string[] = [];
const insertedWarehouseIds: string[] = [];
const insertedSalesAccountIds: string[] = [];

function freshCode(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function freshDocNo(prefix: string): string {
  return `${prefix}-PROP-${randomUUID().slice(0, 8)}`;
}

/** A syntactically valid billing.gl_accounts.code — chk_gl_accounts_code_format (migration
 *  0028_2_chart-of-accounts.sql) requires `^[1-9]-[0-9]{2}-[0-9]{3}-[0-9]{3}$`; class 9, random
 *  segments (never a fixed counter shared with another test file's own class-6/7/8 block). */
function freshGlAccountCode(): string {
  const seg2 = String(randomInt(0, 100)).padStart(2, '0');
  const seg3a = String(randomInt(0, 1000)).padStart(3, '0');
  const seg3b = String(randomInt(0, 1000)).padStart(3, '0');
  return `9-${seg2}-${seg3a}-${seg3b}`;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PST']);
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  // Round-1 finding 18: a FIXED code, never `limit 1`.
  const outsiderEntityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PCC']);
  const outsiderEntityRow = outsiderEntityResult.rows[0];
  if (!outsiderEntityRow) throw new Error(`platform.entities row not found for code 'PCC'`);
  outsiderEntityId = outsiderEntityRow.id;

  const glAccountResult: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
    [entityId, freshGlAccountCode(), 'حساب اختبار خاصية أبعاد السطر', GL_ACCOUNT_TYPE],
  );
  glAccountId = (glAccountResult.rows[0] as { id: string }).id;
  insertedGlAccountIds.push(glAccountId);


  async function insertDimensionType(forEntityId: string, kind: 'list' | 'reference', sourceTable: string | null): Promise<string> {
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.dimension_types (entity_id, code, name_ar, kind, source_table) values ($1, $2, $3, $4, $5) returning id`,
      [forEntityId, freshCode('dimtype'), 'نوع بُعد اختبار الخاصية', kind, sourceTable],
    );
    const row = result.rows[0];
    if (!row) throw new Error('fixture billing.dimension_types insert returned no row');
    insertedDimensionTypeIds.push(row.id);
    return row.id;
  }

  listTypeId = await insertDimensionType(entityId, 'list', null);
  otherListTypeId = await insertDimensionType(entityId, 'list', null);
  outsiderListTypeId = await insertDimensionType(outsiderEntityId, 'list', null);
  referenceTypeNoEntityId = await insertDimensionType(entityId, 'reference', 'sales.accounts');
  referenceTypeWithEntityId = await insertDimensionType(entityId, 'reference', 'wms.warehouses');

  async function insertValue(forEntityId: string, dimensionTypeId: string): Promise<string> {
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4) returning id`,
      [forEntityId, dimensionTypeId, freshCode('val'), 'قيمة اختبار الخاصية'],
    );
    const row = result.rows[0];
    if (!row) throw new Error('fixture billing.dimension_values insert returned no row');
    insertedDimensionValueIds.push(row.id);
    return row.id;
  }

  realListValueId = await insertValue(entityId, listTypeId);
  valueUnderOtherType = await insertValue(entityId, otherListTypeId);
  outsiderListValueId = await insertValue(outsiderEntityId, outsiderListTypeId);

  const salesAccountResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, $3) returning id`,
    [freshCode('acct'), 'حساب مبيعات اختبار الخاصية', SALES_ACCOUNT_TYPE],
  );
  realSalesAccountId = (salesAccountResult.rows[0] as { id: string }).id;
  insertedSalesAccountIds.push(realSalesAccountId);

  const warehouseSameResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [entityId, freshCode('wh'), 'مستودع اختبار الخاصية (نفس الكيان)'],
  );
  realWarehouseSameEntityId = (warehouseSameResult.rows[0] as { id: string }).id;
  insertedWarehouseIds.push(realWarehouseSameEntityId);

  const warehouseOtherResult: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [outsiderEntityId, freshCode('wh'), 'مستودع اختبار الخاصية (كيان آخر)'],
  );
  realWarehouseOtherEntityId = (warehouseOtherResult.rows[0] as { id: string }).id;
  insertedWarehouseIds.push(realWarehouseOtherEntityId);
});

afterAll(async () => {
  // Close review round 1 finding 5 (nit): collected and rethrown as one aggregate error after every
  // attempt has run — never a silent empty catch.
  const cleanupErrors: unknown[] = [];
  const cleanup = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  await cleanup(async () => {
    if (insertedLineDimensionIds.length > 0) await pool.query(`delete from billing.line_dimensions where id = any($1::uuid[])`, [insertedLineDimensionIds]);
  });
  await cleanup(async () => {
    if (insertedDimensionValueIds.length > 0) await pool.query(`delete from billing.dimension_values where id = any($1::uuid[])`, [insertedDimensionValueIds]);
    if (insertedDimensionTypeIds.length > 0) await pool.query(`delete from billing.dimension_types where id = any($1::uuid[])`, [insertedDimensionTypeIds]);
  });
  await cleanup(async () => {
    if (insertedJournalLineIds.length > 0) await pool.query(`delete from billing.journal_lines where id = any($1::uuid[])`, [insertedJournalLineIds]);
    if (insertedJournalEntryIds.length > 0) await pool.query(`delete from billing.journal_entries where id = any($1::uuid[])`, [insertedJournalEntryIds]);
    if (insertedGlAccountIds.length > 0) await pool.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [insertedGlAccountIds]);
  });
  await cleanup(async () => {
    if (insertedWarehouseIds.length > 0) await pool.query(`delete from wms.warehouses where id = any($1::uuid[])`, [insertedWarehouseIds]);
    if (insertedSalesAccountIds.length > 0) await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [insertedSalesAccountIds]);
  });
  await pool.end();

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `line-dimensions.property.integration.test.ts afterAll: ${cleanupErrors.length} cleanup step(s) failed — see errors above`,
    );
  }
});

interface Case {
  readonly name: string;
  readonly kind: 'list' | 'reference';
  readonly dimensionTypeId: () => string;
  readonly valueId: () => string;
  /** true iff this case needs a FRESH, dedicated inactive dimension_values row per run — built
   *  lazily via freshInactiveListValue() below (never reuses one row across cases/fast-check
   *  runs). When true, `valueId()` itself is unused (a `never`-reached placeholder). */
  readonly needsFreshInactiveValue?: boolean;
  readonly valueExistsForType: boolean;
  readonly valueIsActive: boolean;
  readonly sourceHasEntityId: boolean;
  readonly belongsToLineEntity: boolean;
  /** The SQLSTATE the DB must raise for this case (C3), or null when the tag is accepted. */
  readonly rejectCode: RejectCode | null;
}

/** Every case is a REAL database setup; `expected` (the domain oracle) and `dbAccepts` (the actual
 *  insert outcome) are computed independently and compared — never one derived from the other. */
function buildCases(): readonly Case[] {
  return [
    { name: 'list: value exists for this type, active', kind: 'list', dimensionTypeId: () => listTypeId, valueId: () => realListValueId, valueExistsForType: true, valueIsActive: true, sourceHasEntityId: false, belongsToLineEntity: true, rejectCode: null },
    { name: 'list: value does not exist at all', kind: 'list', dimensionTypeId: () => listTypeId, valueId: () => randomUUID(), valueExistsForType: false, valueIsActive: true, sourceHasEntityId: false, belongsToLineEntity: true, rejectCode: MISSING_VALUE },
    // Round-1 finding 4 additions:
    { name: 'list: value exists under a DIFFERENT type (mismatched pair)', kind: 'list', dimensionTypeId: () => listTypeId, valueId: () => valueUnderOtherType, valueExistsForType: false, valueIsActive: true, sourceHasEntityId: false, belongsToLineEntity: true, rejectCode: MISSING_VALUE },
    { name: 'list: another entity\'s value (of its own type) tagged under the pilot\'s type — type mismatch', kind: 'list', dimensionTypeId: () => listTypeId, valueId: () => outsiderListValueId, valueExistsForType: false, valueIsActive: true, sourceHasEntityId: false, belongsToLineEntity: true, rejectCode: MISSING_VALUE },
    { name: 'list: value is INACTIVE', kind: 'list', dimensionTypeId: () => listTypeId, valueId: () => '', needsFreshInactiveValue: true, valueExistsForType: true, valueIsActive: false, sourceHasEntityId: false, belongsToLineEntity: true, rejectCode: INACTIVE_OR_ENTITY_MISMATCH },
    { name: 'reference (no entity_id source): value exists', kind: 'reference', dimensionTypeId: () => referenceTypeNoEntityId, valueId: () => realSalesAccountId, valueExistsForType: true, valueIsActive: true, sourceHasEntityId: false, belongsToLineEntity: true, rejectCode: null },
    { name: 'reference (no entity_id source): value does not exist', kind: 'reference', dimensionTypeId: () => referenceTypeNoEntityId, valueId: () => randomUUID(), valueExistsForType: false, valueIsActive: true, sourceHasEntityId: false, belongsToLineEntity: true, rejectCode: MISSING_VALUE },
    { name: 'reference (entity_id source): value exists, SAME entity', kind: 'reference', dimensionTypeId: () => referenceTypeWithEntityId, valueId: () => realWarehouseSameEntityId, valueExistsForType: true, valueIsActive: true, sourceHasEntityId: true, belongsToLineEntity: true, rejectCode: null },
    { name: 'reference (entity_id source): value exists, DIFFERENT entity', kind: 'reference', dimensionTypeId: () => referenceTypeWithEntityId, valueId: () => realWarehouseOtherEntityId, valueExistsForType: true, valueIsActive: true, sourceHasEntityId: true, belongsToLineEntity: false, rejectCode: INACTIVE_OR_ENTITY_MISMATCH },
    { name: 'reference (entity_id source): value does not exist at all', kind: 'reference', dimensionTypeId: () => referenceTypeWithEntityId, valueId: () => randomUUID(), valueExistsForType: false, valueIsActive: true, sourceHasEntityId: true, belongsToLineEntity: false, rejectCode: MISSING_VALUE },
  ];
}

/** A value id created fresh, INACTIVE, under `listTypeId` — built lazily (not in beforeAll) so
 *  every fast-check run gets its own independent inactive fixture row, never sharing one across
 *  cases. Used whenever a Case sets `needsFreshInactiveValue: true` above. */
async function freshInactiveListValue(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.dimension_values (entity_id, dimension_type_id, code, name, is_active) values ($1, $2, $3, $4, false) returning id`,
    [entityId, listTypeId, freshCode('inactive'), 'قيمة معطّلة اختبار الخاصية'],
  );
  const id = (result.rows[0] as { id: string }).id;
  insertedDimensionValueIds.push(id);
  return id;
}

/** A FRESH journal entry with two balanced lines written by ONE statement (pre-build round-2
 *  findings 7 and 8: balanced at every commit for WBS 4.20; a fresh line per tag, R4). Returns the
 *  debit line's id. */
async function freshBalancedLine(): Promise<string> {
  const entryResult: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.journal_entries (entity_id, doc_no, entry_date, description) values ($1, $2, current_date, $3) returning id`,
    [entityId, freshDocNo('JE'), 'قيد اختبار خاصية أبعاد السطر'],
  );
  const entryId = (entryResult.rows[0] as { id: string }).id;
  insertedJournalEntryIds.push(entryId);
  const linesResult: QueryResult<{ id: string; debit: string }> = await pool.query(
    `insert into billing.journal_lines (entry_id, account_id, debit, credit)
     values ($1, $2, 50.000, 0), ($1, $2, 0, 50.000) returning id, debit::text as debit`,
    [entryId, glAccountId],
  );
  for (const row of linesResult.rows) insertedJournalLineIds.push(row.id);
  const debitRow = linesResult.rows.find((row) => Number(row.debit) > 0);
  if (!debitRow || linesResult.rows.length !== 2) throw new Error('fixture billing.journal_lines insert did not return two lines');
  return debitRow.id;
}

/** True iff the admin-pool insert into billing.line_dimensions for this (dimensionTypeId, valueId)
 *  pair succeeds — the real, authoritative DB verdict. Round-1 finding 11: the catch is narrowed to
 *  the two SQLSTATEs C3 actually names; any OTHER error is a genuine bug and is rethrown. */
interface DbVerdict {
  readonly accepted: boolean;
  readonly rejectedWith: RejectCode | null;
}

async function dbAcceptsTag(dimensionTypeId: string, valueId: string): Promise<DbVerdict> {
  const journalLineId = await freshBalancedLine();
  try {
    const result: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.line_dimensions (journal_line_id, entity_id, dimension_type_id, value_id)
       values ($1, $2, $3, $4) returning id`,
      [journalLineId, entityId, dimensionTypeId, valueId],
    );
    const id = result.rows[0]?.id;
    if (id) insertedLineDimensionIds.push(id);
    return { accepted: true, rejectedWith: null };
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === MISSING_VALUE || pgError.code === INACTIVE_OR_ENTITY_MISMATCH) {
      return { accepted: false, rejectedWith: pgError.code };
    }
    throw error;
  }
}

/** Pre-build round-2 finding 10: a rejection is checked for its REASON (the SQLSTATE the case's
 *  own C3 branch names), never only for "rejected". */
async function assertCaseAgrees(testCase: Case, valueId: string): Promise<void> {
  const expected = isAcceptableDimensionValueTag({
    kind: testCase.kind,
    valueExistsForType: testCase.valueExistsForType,
    valueIsActive: testCase.valueIsActive,
    sourceHasEntityId: testCase.sourceHasEntityId,
    belongsToLineEntity: testCase.belongsToLineEntity,
  });
  const verdict = await dbAcceptsTag(testCase.dimensionTypeId(), valueId);
  expect(verdict.accepted).toBe(expected);
  expect(verdict.rejectedWith).toBe(testCase.rejectCode);
}

describe('isAcceptableDimensionValueTag agrees with the DB on every meaningful (kind, existence, active, entity-match) case', () => {
  it.each(buildCases().map((c) => c.name))(
    'case "%s": the domain oracle and the DB verdict agree',
    async (name) => {
      const testCase = buildCases().find((c) => c.name === name);
      if (!testCase) throw new Error(`unknown case ${name}`);

      const valueId = testCase.needsFreshInactiveValue ? await freshInactiveListValue() : testCase.valueId();

      await assertCaseAgrees(testCase, valueId);
    },
  );

  // fast-check samples the SAME cases via fc.constantFrom (with replacement — it.each above is what
  // guarantees every case runs; this is the property-testing pass the brief names: "for any
  // generated types/values/lines, the DB accepts a tag iff the value exists for that type").
  it('fast-check: for every generated case, the domain oracle and the DB verdict agree', async () => {
    const cases = buildCases();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...cases.map((c) => c.name)), async (name) => {
        const testCase = cases.find((c) => c.name === name);
        if (!testCase) throw new Error(`unknown case ${name}`);
        const valueId = testCase.needsFreshInactiveValue ? await freshInactiveListValue() : testCase.valueId();
        await assertCaseAgrees(testCase, valueId);
      }),
      { numRuns: cases.length },
    );
  });
});
