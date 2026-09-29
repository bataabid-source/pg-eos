// modules/billing/tests/dimensions/line-dimensions.test.ts — WBS 4.1b PART 2 (lane 2).
//
// Pre-build review round 1 — FAIL (fix round, REVIEW CAP one round). This file was rewritten to
// pin the brief's "Lane defaults after pre-build review round 1" section (R1-R4, C1-C10) exactly:
//
// R1 (finding 1): there is NO declarative composite FK on `line_dimensions.value_id`. A single
//   constraint trigger, `billing.assert_dimension_value()`, validates BOTH kinds:
//     - list kind: a row exists in `billing.dimension_values` with the SAME `dimension_type_id`
//       AND `is_active = true` (a deactivated value's row still exists but is REJECTED, which an
//       FK alone could never express — the reason R1 replaces the part-1 brief's "declarative FK,
//       no trigger" wording; the Master takes the FK-vs-trigger wording question, D-190 row 9).
//     - reference kind: the row exists in the type's own whitelisted `source_table` and, where
//       that source has its own `entity_id` column, belongs to the line's own entity (precedent
//       style `billing.reject_holding_invoice`).
// R2 (finding 2, RLS): TWO real, declarative composite FKs — `dimension_values (entity_id,
//   dimension_type_id) -> dimension_types (entity_id, id)` and `line_dimensions (entity_id,
//   dimension_type_id) -> dimension_types (entity_id, id)` (needs `unique (entity_id, id)` on
//   `dimension_types`, no new column) — a value or a tag can never use a dimension TYPE that
//   belongs to a different entity, closing the cross-entity leak an entity-blind value/type lookup
//   would otherwise allow.
// R3: no role gate on create/deactivate (part-1 precedent: entity_scope RLS only) — the outsider
//   tests below prove RLS alone is the wall, not a permission code.
// R4: no uniqueness on (journal_line_id, dimension_type_id) — every test below that inserts a NEW
//   tag uses ITS OWN fresh journal line (freshLine()), never a shared one two tests both write to.
// C1-C10 (migration constraints) this file's own assertions are pinned against:
//   C3: a MISSING value (list: wrong/absent (type,value) pair; reference: absent from the source
//       table) -> SQLSTATE 23503. An INACTIVE value, or an entity mismatch raised by a TRIGGER
//       (reference-kind source row belongs to a different entity) -> SQLSTATE 23514. R2's
//       declarative composite FKs raise their native 23503. The
//       entity-deriving trigger's own mismatch (line_dimensions.entity_id != the journal entry's
//       own entity_id) -> SQLSTATE 23514 too.
//   C4: `line_dimensions` grant is SELECT, INSERT ONLY (+ explicit REVOKE UPDATE/DELETE/TRUNCATE)
//       -> SQLSTATE 42501 (insufficient_privilege) for any UPDATE/DELETE attempt, regardless of RLS
//       visibility. `dimension_values` grant is SELECT, INSERT, UPDATE (is_active, version) only,
//       no DELETE.
//   C5: no cascade on any FK — deleting a `journal_lines` row that is tagged is REFUSED (23503,
//       foreign_key_violation, restrict), the tag itself untouched (Scenario new below).
//   C7: `dimension_values.version int not null default 1`, `unique (entity_id, dimension_type_id,
//       code)` — a deactivated value KEEPS its code (brief default), so the SAME code is still
//       rejected after deactivation; a DIFFERENT dimension_type_id frees the code. NO `version` and
//       NO `created_at` column on `line_dimensions` (round-1 finding 17 — the part-1 draft of this
//       file wrongly assumed one; removed).
//   C10: the application (not the database) writes the `platform.audit_log` row, in the SAME
//       transaction as the `platform.outbox` write — this file never touches `platform.audit_log`
//       directly, only reads it to count rows for a given correlation id.
//
// Fixture discipline (round-1 findings 16, 18, 19):
//   - every journal entry this file creates carries TWO balanced lines (one debit, one credit, same
//     amount) — forward-compatible with WBS 4.20's own balance-at-commit trigger, not yet built.
//   - the "outsider" entity is picked by a FIXED code ('PCC'), never `limit 1` (unordered, flaky).
//   - every NEW tag uses a FRESH journal line (freshLine()) — R4.
//
// Integration tests against the real database as pgeos_app (application-layer commands and every
// RLS/grant scenario) plus the admin pool (PGUSER, bypasses RLS — fixture setup/teardown and every
// "prove the DB constraint/trigger fires on its own, independent of any role" scenario). One
// describe per ./line-dimensions.feature Scenario, title matching EXACTLY.
//
// STATUS: RED. `database/migrations/0038_2_line-dimensions.sql` does not exist yet — every scenario
// below fails with SQLSTATE 42P01 (undefined_table) until it lands.
// `modules/billing/application/dimensions/{create-dimension-value,deactivate-dimension-value,
// index}.ts`, `modules/billing/api/dimensions/composition.ts` and the `machine.ts`/`invariants.ts`/
// `errors.ts` additions do not exist either — the imports below fail to resolve (MODULE_NOT_FOUND)
// until pg-builder writes them. Both failure modes are RED "for the right reason": missing schema /
// missing module, never a syntax error in this file.
//
// Application surface this file assumes (does not exist yet — RED; naming follows the golden
// slice's own convention, modules/wms/application/receive-inbound/*):
//   modules/billing/application/dimensions/index.ts
//     - createDimensionValue(ctx, input, deps): { id, version }
//       input: { entityId, dimensionTypeId, code, name, correlationId, idem? }
//       writes 'billing.dimension_value.created' (packages/events/catalog.ts:117) to the outbox,
//       aggregate_type 'billing.dimension_values', aggregate_id = the new value's id.
//     - deactivateDimensionValue(ctx, input, deps): { version }
//       input: { dimensionValueId, expectedVersion, correlationId, idem? }
//       writes 'billing.dimension_value.deactivated' (packages/events/catalog.ts:118), same
//       aggregate_type, aggregate_id = dimensionValueId.
//   modules/billing/domain/dimensions/errors.ts (extends part 1's existing file)
//     - StaleVersionError — exposes `.expectedVersion` and `.actualVersion` (round-1 finding 12).
//     - DimensionValueNotFoundError — exposes `.dimensionValueId` (round-1 finding 12).
//   modules/billing/domain/dimensions/invariants.ts (extends part 1's existing file)
//     - DIMENSION_SOURCE_TABLES (part 1, unchanged) and a NEW `DIMENSION_SOURCE_TABLES_WITH_ENTITY_ID`
//       (round-1 finding 3 — "must come from a domain constant, not a hand label"): the 4-member
//       subset (hr.employees, tms.vehicles, wms.warehouses, platform.sites) C2 names as "with
//       entity_id".
//   modules/billing/api/dimensions/composition.ts
//     - createDimensionsDeps({ clock }): deps object the two commands above accept.
// Per the brief's own RLS design note (R3), no role gate is assumed on either command.

import { createHash, randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';
import { withContext, IdempotencyConflictError, type IdempotencyInput } from '@pg-eos/db';
import { FixedClock } from '@pg-eos/domain-kit';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

// The modules under test — do not exist yet (RED, see header).
import { createDimensionValue, deactivateDimensionValue } from '../../application/dimensions/index.js';
import { createDimensionsDeps } from '../../api/dimensions/composition.js';
import { StaleVersionError, DimensionValueNotFoundError } from '../../domain/dimensions/errors.js';
import { DIMENSION_SOURCE_TABLES, DIMENSION_SOURCE_TABLES_WITH_ENTITY_ID } from '../../domain/dimensions/invariants.js';

// Admin pool (PGUSER, bypasses RLS) — fixture setup/teardown, and every "the database rejects/
// accepts this regardless of role" constraint/trigger proof.
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// --- literals (round-1 finding 11: pinned SQLSTATEs, per C3/C4/C5) -------------------------------

// C3: a missing/undefined (type,value) pair (list) or an absent source-table row (reference).
// ALSO the SQLSTATE of a genuine Postgres foreign_key_violation — R2's two composite FKs (a value
// or a tag using a dimension TYPE from a different entity) and C5's delete-restrict both raise this
// same, structurally distinct, real declarative FK violation.
const MISSING_OR_FK_VIOLATION = '23503';
// C3: an INACTIVE value (list), or ANY entity mismatch the assert_dimension_value() trigger itself
// raises (reference-kind source row belongs to a different entity) — as well as the
// entity-deriving trigger's own line_dimensions.entity_id mismatch.
const INACTIVE_OR_TRIGGER_ENTITY_MISMATCH = '23514';
// C4: line_dimensions UPDATE/DELETE (explicit REVOKE) and every RLS WITH CHECK failure alike.
const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';

const GL_ACCOUNT_TYPE = 'expense';
const SALES_ACCOUNT_TYPE = 'client';
const PARTNER_TYPE = 'vendor';
const VEHICLE_TYPE = 'van';
const SITE_KIND = 'office';

const OWNER_ACTOR_UUID = '00000000-0000-4000-8000-0000000411d1';
const OUTSIDER_ACTOR_UUID = '00000000-0000-4000-8000-0000000411d3'; // no user_entities row for entityId.

const CREATED_EVENT_TYPE = 'billing.dimension_value.created'; // packages/events/catalog.ts:117.
const DEACTIVATED_EVENT_TYPE = 'billing.dimension_value.deactivated'; // packages/events/catalog.ts:118.
const AGGREGATE_TYPE = 'billing.dimension_values';

const clock = new FixedClock(new Date('2026-09-27T00:00:00.000Z'));
const deps = createDimensionsDeps({ clock });

let entityId: string; // code 'PST'.
let outsiderEntityId: string; // code 'PCC' — round-1 finding 18: fixed code, never `limit 1`.

let glAccountId: string;

let listTypeId: string;
let otherListTypeId: string; // a SECOND list-kind type, for the mismatched-(type,value) proof.
let outsiderListTypeId: string; // list-kind type belonging to outsiderEntityId — R2 proof.
const referenceTypeIds: Record<string, string> = {}; // sourceTable -> dimension_type id, entity = entityId.

interface SourceFixture {
  readonly sameEntityRowId: string; // a real row "belonging" to entityId (or entity-agnostic).
  readonly otherRowId: string; // a real row belonging to outsiderEntityId (or a second entity-agnostic row).
}
const sourceFixtures: Record<string, SourceFixture> = {};

const insertedDimensionValueIds: string[] = [];
const insertedLineDimensionIds: string[] = [];
const insertedDimensionTypeIds: string[] = [];
const insertedJournalLineIds: string[] = [];
const insertedJournalEntryIds: string[] = [];
const insertedGlAccountIds: string[] = [];
const insertedWarehouseIds: string[] = [];
const insertedSalesAccountIds: string[] = [];
const insertedPartnerIds: string[] = [];
const insertedHrEmployeeIds: string[] = [];
const insertedVehicleIds: string[] = [];
const insertedSiteIds: string[] = [];
const insertedShipmentIds: string[] = [];
const usedCorrelationIds = new Set<string>();

/** Walks `error`'s own cause chain for a Postgres error with the given SQLSTATE — same discipline
 *  as ../dimensions/dimensions.test.ts's own findRaisedException. */
function findRaisedException(error: unknown, sqlstate: string): Error | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? (current as { code?: unknown }).code : undefined;
    if (code === sqlstate) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function ctxFor(userId: string): WithContextCtx {
  return { userId, clientId: null, isInternal: true };
}

function freshCode(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function freshDocNo(prefix: string): string {
  return `${prefix}-TEST-${randomUUID().slice(0, 8)}`;
}

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
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

/** sha256 hex of the canonical JSON body, endpoint 'billing.dimensions.<command>', successStatus
 *  200 — same shape convention as modules/wms/tests/receive-inbound/receive-inbound.test.ts's own
 *  idemFor. */
function idemFor(endpoint: string, key: string, body: unknown): IdempotencyInput {
  return {
    key,
    endpoint: `billing.dimensions.${endpoint}`,
    requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    entityId: null,
    successStatus: 200,
  };
}

async function createFixtureActor(userId: string, entityIds: readonly string[]): Promise<void> {
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')
     on conflict (id) do update set email = excluded.email`,
    [userId, `_linedim_fixture_${userId}_${randomUUID()}@test.invalid`, 'ممثل اختبار أبعاد السطر — WBS 4.1b part 2'],
  );
  for (const eid of entityIds) {
    await pool.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2) on conflict (user_id, entity_id) do nothing`,
      [userId, eid],
    );
  }
}

async function insertDimensionType(input: {
  entityIdValue: string;
  kind: 'list' | 'reference';
  sourceTable?: string | null;
}): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.dimension_types (entity_id, code, name_ar, kind, source_table)
     values ($1, $2, $3, $4, $5) returning id`,
    [input.entityIdValue, freshCode('dimtype'), 'نوع بُعد اختبار سطر — WBS 4.1b part 2', input.kind, input.sourceTable ?? null],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.dimension_types insert returned no id');
  insertedDimensionTypeIds.push(row.id);
  return row.id;
}

async function insertGlAccount(forEntityId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.gl_accounts (entity_id, code, name_ar, account_type) values ($1, $2, $3, $4) returning id`,
    [forEntityId, freshGlAccountCode(), 'حساب اختبار أبعاد السطر — WBS 4.1b part 2', GL_ACCOUNT_TYPE],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.gl_accounts insert returned no row');
  insertedGlAccountIds.push(row.id);
  return row.id;
}

/** A real journal entry with TWO BALANCED lines (one debit, one credit, same amount — round-1
 *  finding 16, forward-compatible with WBS 4.20's own balance-at-commit trigger). Returns the
 *  DEBIT line's id — the one every scenario below tags. Every call is a FRESH entry/pair of lines
 *  (round-1 finding 19 / R4) — no test shares a journal line with another. */
async function freshLine(): Promise<string> {
  // WBS 4.20 (0041): entry_type is NOT NULL and balance is enforced at COMMIT, so the entry and its
  // two lines are written in ONE transaction. 'accrual' = a non-manual type (no approval needed);
  // posted_at stays null (UNPOSTED) so 0041's posted-immutability triggers do not pre-empt the
  // FK / period behaviour the scenarios below exercise.
  const client = await pool.connect();
  try {
    await client.query('begin');
    const entryResult: QueryResult<{ id: string }> = await client.query(
      `insert into billing.journal_entries (entity_id, doc_no, entry_date, description, entry_type)
       values ($1, $2, current_date, $3, 'accrual') returning id`,
      [entityId, freshDocNo('JE'), 'قيد اختبار أبعاد السطر — WBS 4.1b part 2'],
    );
    const entryRow = entryResult.rows[0];
    if (!entryRow) throw new Error('fixture billing.journal_entries insert returned no row');

    const linesResult: QueryResult<{ id: string; debit: string }> = await client.query(
      `insert into billing.journal_lines (entry_id, account_id, debit, credit)
       values ($1, $2, 100.000, 0), ($1, $2, 0, 100.000) returning id, debit::text as debit`,
      [entryRow.id, glAccountId],
    );
    await client.query('commit');
    insertedJournalEntryIds.push(entryRow.id);
    const debitRow = linesResult.rows.find((row) => Number(row.debit) > 0);
    if (!debitRow || linesResult.rows.length !== 2) throw new Error('fixture billing.journal_lines insert did not return two lines');
    for (const row of linesResult.rows) insertedJournalLineIds.push(row.id);
    return debitRow.id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function insertDimensionValueFixture(input: {
  entityIdValue: string;
  dimensionTypeIdValue: string;
  isActive?: boolean;
}): Promise<{ id: string; version: number }> {
  const result: QueryResult<{ id: string; version: number }> = await pool.query(
    `insert into billing.dimension_values (entity_id, dimension_type_id, code, name, is_active)
     values ($1, $2, $3, $4, $5) returning id, version`,
    [input.entityIdValue, input.dimensionTypeIdValue, freshCode('val'), 'قيمة بُعد اختبار — WBS 4.1b part 2', input.isActive ?? true],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.dimension_values insert returned no row');
  insertedDimensionValueIds.push(row.id);
  return row;
}

/** Insert a billing.line_dimensions row as a REAL pgeos_app session scoped to `actorId` (the
 *  realistic path — no application command exists for tagging a line in this slice, brief §Contract
 *  design: only create/deactivate-dimension-value are registered routes). */
async function tagLineAsApp(
  actorId: string,
  input: { journalLineId: string; entityIdValue: string; dimensionTypeIdValue: string; valueId: string },
): Promise<string> {
  const result = await withContext(ctxFor(actorId), async (tx: NodePgDatabase) => {
    return tx.execute<{ id: string }>(
      sql`insert into billing.line_dimensions (journal_line_id, entity_id, dimension_type_id, value_id)
          values (${input.journalLineId}, ${input.entityIdValue}, ${input.dimensionTypeIdValue}, ${input.valueId})
          returning id`,
    );
  });
  const id = (result.rows[0] as { id: string } | undefined)?.id;
  if (!id) throw new Error('tagLineAsApp insert returned no id');
  insertedLineDimensionIds.push(id);
  return id;
}

/** Insert a billing.line_dimensions row through the admin pool — used ONLY for the "the database
 *  itself rejects/accepts this, independent of role" constraint/trigger proofs. */
async function tagLineAsAdmin(input: {
  journalLineId: string;
  entityIdValue: string;
  dimensionTypeIdValue: string;
  valueId: string;
}): Promise<QueryResult<{ id: string }>> {
  return pool.query(
    `insert into billing.line_dimensions (journal_line_id, entity_id, dimension_type_id, value_id)
     values ($1, $2, $3, $4) returning id`,
    [input.journalLineId, input.entityIdValue, input.dimensionTypeIdValue, input.valueId],
  );
}

async function countLineDimensionsForValue(valueId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from billing.line_dimensions where value_id = $1`,
    [valueId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** round-1 finding 7: exact event_type + aggregate_id, never just "a row exists". */
async function outboxRowsForCorrelationAndType(
  correlationId: string,
  eventType: string,
): Promise<Array<{ id: string; aggregate_id: string; aggregate_type: string }>> {
  const result: QueryResult<{ id: string; aggregate_id: string; aggregate_type: string }> = await pool.query(
    `select id::text as id, aggregate_id::text as aggregate_id, aggregate_type
       from platform.outbox where correlation_id = $1 and event_type = $2`,
    [correlationId, eventType],
  );
  return result.rows;
}

async function outboxCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.outbox where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function auditCountForCorrelation(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/** round-1 finding 7: every SUCCESSFUL write asserts the exact event_type and aggregate_id — never
 *  just "one outbox row exists". */
async function assertOutboxEvent(correlationId: string, eventType: string, aggregateId: string): Promise<void> {
  const rows = await outboxRowsForCorrelationAndType(correlationId, eventType);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.aggregate_id).toBe(aggregateId);
  expect(rows[0]?.aggregate_type).toBe(AGGREGATE_TYPE);
}

/** round-1 finding 7: every FAILURE path asserts NOTHING was written — zero outbox, zero audit. */
async function assertNoWriteForCorrelation(correlationId: string): Promise<void> {
  expect(await outboxCountForCorrelation(correlationId)).toBe(0);
  expect(await auditCountForCorrelation(correlationId)).toBe(0);
}

async function getDimensionValue(id: string): Promise<{ is_active: boolean; version: number }> {
  const result: QueryResult<{ is_active: boolean; version: number }> = await pool.query(
    `select is_active, version from billing.dimension_values where id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no billing.dimension_values row for id ${id}`);
  return row;
}

// --- 8-whitelist source-table fixtures (round-1 finding 3) ----------------------------------------

/** chk_employees_code_format (0029_M_hr-employee-checks.sql:36) requires `^PG-[0-9]{4}$`
 *  (pre-build round-2 finding 1). This file owns the PG-8xxx block (PG-5xxx/6xxx imile, PG-71xx/
 *  72xx hr are taken); a collision on the unique code is retried with a fresh number. */
const EMPLOYEE_CODE_BLOCK_START = 8000;
const EMPLOYEE_CODE_BLOCK_SIZE = 1000;
const EMPLOYEE_CODE_ATTEMPTS = 20;

async function insertHrEmployee(forEntityId: string): Promise<string> {
  for (let attempt = 0; attempt < EMPLOYEE_CODE_ATTEMPTS; attempt += 1) {
    const code = `PG-${EMPLOYEE_CODE_BLOCK_START + randomInt(0, EMPLOYEE_CODE_BLOCK_SIZE)}`;
    try {
      const result: QueryResult<{ id: string }> = await pool.query(
        `insert into hr.employees (entity_id, code, name_ar, hire_date) values ($1, $2, $3, current_date) returning id`,
        [forEntityId, code, 'موظف اختبار أبعاد السطر'],
      );
      const id = (result.rows[0] as { id: string }).id;
      insertedHrEmployeeIds.push(id);
      return id;
    } catch (error: unknown) {
      if (!findRaisedException(error, UNIQUE_VIOLATION)) throw error;
    }
  }
  throw new Error('fixture hr.employees: no free PG-8xxx code after retries');
}

async function insertTmsVehicle(forEntityId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into tms.vehicles (entity_id, plate_no, vehicle_type) values ($1, $2, $3) returning id`,
    [forEntityId, freshCode('plate'), VEHICLE_TYPE],
  );
  const id = (result.rows[0] as { id: string }).id;
  insertedVehicleIds.push(id);
  return id;
}

async function insertWmsWarehouse(forEntityId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into wms.warehouses (entity_id, code, name_ar) values ($1, $2, $3) returning id`,
    [forEntityId, freshCode('wh'), 'مستودع اختبار أبعاد السطر'],
  );
  const id = (result.rows[0] as { id: string }).id;
  insertedWarehouseIds.push(id);
  return id;
}

async function insertPlatformSite(forEntityId: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into platform.sites (entity_id, kind, name_ar) values ($1, $2, $3) returning id`,
    [forEntityId, SITE_KIND, 'موقع اختبار أبعاد السطر'],
  );
  const id = (result.rows[0] as { id: string }).id;
  insertedSiteIds.push(id);
  return id;
}

async function insertSalesAccountFixture(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, $3) returning id`,
    [freshCode('acct'), 'حساب مبيعات اختبار أبعاد السطر', SALES_ACCOUNT_TYPE],
  );
  const id = (result.rows[0] as { id: string }).id;
  insertedSalesAccountIds.push(id);
  return id;
}

async function insertPartnerFixture(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into partners.partners (code, name_ar, partner_type) values ($1, $2, $3) returning id`,
    [freshCode('partner'), 'شريك اختبار أبعاد السطر', PARTNER_TYPE],
  );
  const id = (result.rows[0] as { id: string }).id;
  insertedPartnerIds.push(id);
  return id;
}

async function insertImileShipmentFixture(): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into imile.shipments (tracking_no) values ($1) returning id`,
    [freshCode('trk')],
  );
  const id = (result.rows[0] as { id: string }).id;
  insertedShipmentIds.push(id);
  return id;
}

beforeAll(async () => {
  const entityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PST']);
  const entityRow = entityResult.rows[0];
  if (!entityRow) throw new Error(`platform.entities row not found for code 'PST'`);
  entityId = entityRow.id;

  // Round-1 finding 18: a FIXED code, never `limit 1` (unordered, flaky).
  const outsiderEntityResult: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = $1`, ['PCC']);
  const outsiderEntityRow = outsiderEntityResult.rows[0];
  if (!outsiderEntityRow) throw new Error(`platform.entities row not found for code 'PCC'`);
  outsiderEntityId = outsiderEntityRow.id;

  await createFixtureActor(OWNER_ACTOR_UUID, [entityId]);
  await createFixtureActor(OUTSIDER_ACTOR_UUID, [outsiderEntityId]);

  glAccountId = await insertGlAccount(entityId);

  listTypeId = await insertDimensionType({ entityIdValue: entityId, kind: 'list' });
  otherListTypeId = await insertDimensionType({ entityIdValue: entityId, kind: 'list' });
  outsiderListTypeId = await insertDimensionType({ entityIdValue: outsiderEntityId, kind: 'list' });

  for (const sourceTable of DIMENSION_SOURCE_TABLES) {
    referenceTypeIds[sourceTable] = await insertDimensionType({ entityIdValue: entityId, kind: 'reference', sourceTable });
  }

  sourceFixtures['hr.employees'] = { sameEntityRowId: await insertHrEmployee(entityId), otherRowId: await insertHrEmployee(outsiderEntityId) };
  sourceFixtures['tms.vehicles'] = { sameEntityRowId: await insertTmsVehicle(entityId), otherRowId: await insertTmsVehicle(outsiderEntityId) };
  sourceFixtures['wms.warehouses'] = { sameEntityRowId: await insertWmsWarehouse(entityId), otherRowId: await insertWmsWarehouse(outsiderEntityId) };
  sourceFixtures['platform.sites'] = { sameEntityRowId: await insertPlatformSite(entityId), otherRowId: await insertPlatformSite(outsiderEntityId) };
  sourceFixtures['sales.accounts'] = { sameEntityRowId: await insertSalesAccountFixture(), otherRowId: await insertSalesAccountFixture() };
  sourceFixtures['partners.partners'] = { sameEntityRowId: await insertPartnerFixture(), otherRowId: await insertPartnerFixture() };
  sourceFixtures['imile.shipments'] = { sameEntityRowId: await insertImileShipmentFixture(), otherRowId: await insertImileShipmentFixture() };
  sourceFixtures['platform.entities'] = { sameEntityRowId: entityId, otherRowId: outsiderEntityId };

  // Confirm withContext genuinely connects as pgeos_app before trusting any RLS/grant assertion in
  // this file (same discipline as ../gl-account-change-requests/gl-account-change-requests.test.ts
  // finding 9(f)).
  const currentUserResult = await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx: NodePgDatabase) =>
    tx.execute<{ current_user: string }>(sql`select current_user`),
  );
  expect(currentUserResult.rows[0]?.['current_user']).toBe('pgeos_app');
});

afterAll(async () => {
  // Close review round 1 finding 5 (nit): a cleanup failure must be VISIBLE — collected here and
  // rethrown as one aggregate error after every attempt has run (never a silent empty catch that
  // could hide a real fixture leak behind a passing test run).
  const cleanupErrors: unknown[] = [];
  const cleanup = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };

  await cleanup(async () => {
    if (insertedLineDimensionIds.length > 0) {
      await pool.query(`delete from billing.line_dimensions where id = any($1::uuid[])`, [insertedLineDimensionIds]);
    }
  });
  await cleanup(async () => {
    if (insertedDimensionValueIds.length > 0) {
      await pool.query(`delete from billing.dimension_values where id = any($1::uuid[])`, [insertedDimensionValueIds]);
    }
  });
  await cleanup(async () => {
    if (insertedDimensionTypeIds.length > 0) {
      await pool.query(`delete from billing.dimension_types where id = any($1::uuid[])`, [insertedDimensionTypeIds]);
    }
  });
  await cleanup(async () => {
    // 0041: deleting this file's OWN tracked lines/entries under session_replication_role = replica
    // (4.19 precedent) so balance-at-commit does not fire on a lines-then-entry delete.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local session_replication_role = replica`);
      if (insertedJournalLineIds.length > 0) {
        await client.query(`delete from billing.journal_lines where id = any($1::uuid[])`, [insertedJournalLineIds]);
      }
      if (insertedJournalEntryIds.length > 0) {
        await client.query(`delete from billing.journal_entries where id = any($1::uuid[])`, [insertedJournalEntryIds]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    if (insertedGlAccountIds.length > 0) {
      await pool.query(`delete from billing.gl_accounts where id = any($1::uuid[])`, [insertedGlAccountIds]);
    }
  });
  await cleanup(async () => {
    if (insertedWarehouseIds.length > 0) await pool.query(`delete from wms.warehouses where id = any($1::uuid[])`, [insertedWarehouseIds]);
    if (insertedSalesAccountIds.length > 0) await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [insertedSalesAccountIds]);
    if (insertedPartnerIds.length > 0) await pool.query(`delete from partners.partners where id = any($1::uuid[])`, [insertedPartnerIds]);
    if (insertedHrEmployeeIds.length > 0) await pool.query(`delete from hr.employees where id = any($1::uuid[])`, [insertedHrEmployeeIds]);
    if (insertedVehicleIds.length > 0) await pool.query(`delete from tms.vehicles where id = any($1::uuid[])`, [insertedVehicleIds]);
    if (insertedSiteIds.length > 0) await pool.query(`delete from platform.sites where id = any($1::uuid[])`, [insertedSiteIds]);
    if (insertedShipmentIds.length > 0) await pool.query(`delete from imile.shipments where id = any($1::uuid[])`, [insertedShipmentIds]);
  });
  await cleanup(async () => {
    await pool.query(`delete from platform.idempotency_keys where user_id = any($1::uuid[])`, [[OWNER_ACTOR_UUID, OUTSIDER_ACTOR_UUID]]);
    await pool.query(`delete from identity.user_entities where user_id = any($1::uuid[])`, [[OWNER_ACTOR_UUID, OUTSIDER_ACTOR_UUID]]);
    await pool.query(`delete from identity.users where id = any($1::uuid[])`, [[OWNER_ACTOR_UUID, OUTSIDER_ACTOR_UUID]]);
  });
  // platform.outbox / platform.audit_log rows are NEVER deleted (append-only ledgers, C10).
  await pool.end();

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `line-dimensions.test.ts afterAll: ${cleanupErrors.length} cleanup step(s) failed — see errors above`,
    );
  }
});

// --- Scenario: A list-kind value is created per entity and tagged on a journal line ---------------

describe('Scenario: A list-kind value is created per entity and tagged on a journal line', () => {
  it('the insert succeeds and the tag is visible against that journal line; one billing.dimension_value.created outbox row', async () => {
    const correlationId = nextCorrelationId();
    const created = await createDimensionValue(
      ctxFor(OWNER_ACTOR_UUID),
      { entityId, dimensionTypeId: listTypeId, code: freshCode('cc'), name: 'مركز تكلفة اختبار', correlationId },
      deps,
    );
    insertedDimensionValueIds.push(created.id); // close review round 1 finding 5.
    expect(created.version).toBe(1);
    const stored = await getDimensionValue(created.id);
    expect(stored.is_active).toBe(true);
    expect(stored.version).toBe(1);
    await assertOutboxEvent(correlationId, CREATED_EVENT_TYPE, created.id);

    const line = await freshLine();
    await tagLineAsApp(OWNER_ACTOR_UUID, { journalLineId: line, entityIdValue: entityId, dimensionTypeIdValue: listTypeId, valueId: created.id });

    expect(await countLineDimensionsForValue(created.id)).toBe(1);
  });
});

// --- Scenario: A line tagged with a value that does not exist for its dimension type is rejected ---

describe('Scenario: A line tagged with a value that does not exist for its dimension type is rejected by the database', () => {
  it('a value id that is not any real row is rejected (23503, missing value)', async () => {
    const line = await freshLine();
    const bogusValueId = randomUUID();
    await expect(
      tagLineAsAdmin({ journalLineId: line, entityIdValue: entityId, dimensionTypeIdValue: listTypeId, valueId: bogusValueId }),
    ).rejects.toMatchObject({ code: MISSING_OR_FK_VIOLATION });
    expect(await countLineDimensionsForValue(bogusValueId)).toBe(0);
  });

  it('a REAL dimension_values row that belongs to a DIFFERENT dimension type is also rejected (23503 — the composite pair must match)', async () => {
    const line = await freshLine();
    const valueUnderOtherType = await insertDimensionValueFixture({ entityIdValue: entityId, dimensionTypeIdValue: otherListTypeId });
    await expect(
      tagLineAsAdmin({
        journalLineId: line,
        entityIdValue: entityId,
        dimensionTypeIdValue: listTypeId, // WRONG type for this value's own dimension_type_id.
        valueId: valueUnderOtherType.id,
      }),
    ).rejects.toMatchObject({ code: MISSING_OR_FK_VIOLATION });
    expect(await countLineDimensionsForValue(valueUnderOtherType.id)).toBe(0);
  });
});

// --- Scenario: A reference-kind value must exist in the type's source table and belong to the ------
// --- line's entity (round-1 finding 3: exhaustive over the full 8-table whitelist) -------------------

describe("Scenario: A reference-kind value must exist in the type's source table and belong to the line's entity", () => {
  it.each(DIMENSION_SOURCE_TABLES)('source_table = %s: a random uuid (no real row) is rejected (23503)', async (sourceTable) => {
    const line = await freshLine();
    await expect(
      tagLineAsAdmin({ journalLineId: line, entityIdValue: entityId, dimensionTypeIdValue: referenceTypeIds[sourceTable] as string, valueId: randomUUID() }),
    ).rejects.toMatchObject({ code: MISSING_OR_FK_VIOLATION });
  });

  it.each(DIMENSION_SOURCE_TABLES)('source_table = %s: a real row is accepted', async (sourceTable) => {
    const line = await freshLine();
    const fixture = sourceFixtures[sourceTable] as SourceFixture;
    const id = (
      await tagLineAsAdmin({
        journalLineId: line,
        entityIdValue: entityId,
        dimensionTypeIdValue: referenceTypeIds[sourceTable] as string,
        valueId: fixture.sameEntityRowId,
      })
    ).rows[0]?.id;
    if (!id) throw new Error(`expected insert to return an id for ${sourceTable}`);
    insertedLineDimensionIds.push(id);
  });

  it.each(DIMENSION_SOURCE_TABLES_WITH_ENTITY_ID)(
    'source_table = %s (has entity_id): a real row belonging to a DIFFERENT entity is rejected (23514)',
    async (sourceTable) => {
      const line = await freshLine();
      const fixture = sourceFixtures[sourceTable] as SourceFixture;
      await expect(
        tagLineAsAdmin({
          journalLineId: line,
          entityIdValue: entityId,
          dimensionTypeIdValue: referenceTypeIds[sourceTable] as string,
          valueId: fixture.otherRowId,
        }),
      ).rejects.toMatchObject({ code: INACTIVE_OR_TRIGGER_ENTITY_MISMATCH });
    },
  );

  const noEntitySourceTables = DIMENSION_SOURCE_TABLES.filter((t) => !DIMENSION_SOURCE_TABLES_WITH_ENTITY_ID.includes(t));
  it.each(noEntitySourceTables)(
    'source_table = %s (no entity_id): a SECOND real row is likewise accepted (the source has no entity to scope against)',
    async (sourceTable) => {
      const line = await freshLine();
      const fixture = sourceFixtures[sourceTable] as SourceFixture;
      const id = (
        await tagLineAsAdmin({
          journalLineId: line,
          entityIdValue: entityId,
          dimensionTypeIdValue: referenceTypeIds[sourceTable] as string,
          valueId: fixture.otherRowId,
        })
      ).rows[0]?.id;
      if (!id) throw new Error(`expected insert to return an id for ${sourceTable}`);
      insertedLineDimensionIds.push(id);
    },
  );

  // Round-1 finding 5: app-role (pgeos_app) positives — proves billing.assert_dimension_value()
  // (a SECURITY DEFINER constraint trigger, C1) genuinely fires under a real, RLS-governed session,
  // not only under the admin/superuser pool used everywhere else in this describe block.
  it('app-role (pgeos_app): a real sales.accounts row is accepted when tagged by a genuine entity-scoped caller', async () => {
    const line = await freshLine();
    const fixture = sourceFixtures['sales.accounts'] as SourceFixture;
    await tagLineAsApp(OWNER_ACTOR_UUID, {
      journalLineId: line,
      entityIdValue: entityId,
      dimensionTypeIdValue: referenceTypeIds['sales.accounts'] as string,
      valueId: fixture.sameEntityRowId,
    });
    expect(await countLineDimensionsForValue(fixture.sameEntityRowId)).toBeGreaterThan(0);
  });

  it('app-role (pgeos_app): a real SAME-entity wms.warehouses row is accepted when tagged by a genuine entity-scoped caller', async () => {
    const line = await freshLine();
    const fixture = sourceFixtures['wms.warehouses'] as SourceFixture;
    await tagLineAsApp(OWNER_ACTOR_UUID, {
      journalLineId: line,
      entityIdValue: entityId,
      dimensionTypeIdValue: referenceTypeIds['wms.warehouses'] as string,
      valueId: fixture.sameEntityRowId,
    });
  });
});

// --- Scenario: A deactivated value cannot be tagged on a new line; existing tags stay --------------

describe('Scenario: A deactivated value cannot be tagged on a new line; existing tags stay', () => {
  it('deactivating a value blocks a NEW tag (23514, inactive) but leaves the existing tag from before deactivation unchanged', async () => {
    const correlationId = nextCorrelationId();
    const created = await createDimensionValue(
      ctxFor(OWNER_ACTOR_UUID),
      { entityId, dimensionTypeId: listTypeId, code: freshCode('cc'), name: 'مركز تكلفة سيُلغى تفعيله', correlationId },
      deps,
    );
    insertedDimensionValueIds.push(created.id); // close review round 1 finding 5.

    const firstLine = await freshLine();
    const existingTagId = await tagLineAsApp(OWNER_ACTOR_UUID, {
      journalLineId: firstLine,
      entityIdValue: entityId,
      dimensionTypeIdValue: listTypeId,
      valueId: created.id,
    });

    const deactivateCorrelationId = nextCorrelationId();
    const deactivated = await deactivateDimensionValue(
      ctxFor(OWNER_ACTOR_UUID),
      { dimensionValueId: created.id, expectedVersion: created.version, correlationId: deactivateCorrelationId },
      deps,
    );
    expect(deactivated.version).toBe(created.version + 1);
    const stored = await getDimensionValue(created.id);
    expect(stored.is_active).toBe(false);
    expect(stored.version).toBe(deactivated.version);
    await assertOutboxEvent(deactivateCorrelationId, DEACTIVATED_EVENT_TYPE, created.id);

    // A second, FRESH journal line (R4) — the SAME (now inactive) value id may not tag it.
    const secondLine = await freshLine();
    await expect(
      tagLineAsAdmin({ journalLineId: secondLine, entityIdValue: entityId, dimensionTypeIdValue: listTypeId, valueId: created.id }),
    ).rejects.toMatchObject({ code: INACTIVE_OR_TRIGGER_ENTITY_MISMATCH });

    // The existing tag (inserted BEFORE deactivation) is completely unaffected — append-only.
    const stillThereResult: QueryResult<{ id: string }> = await pool.query(`select id from billing.line_dimensions where id = $1`, [existingTagId]);
    expect(stillThereResult.rows).toHaveLength(1);
    expect(await countLineDimensionsForValue(created.id)).toBe(1); // only the pre-deactivation tag.
  });
});

// --- Scenario: line_dimensions is append-only — UPDATE and DELETE are refused for the app role ------

describe('Scenario: line_dimensions is append-only — UPDATE and DELETE are refused for the app role', () => {
  it('UPDATE and DELETE are both refused by a permission error (42501), and the row is confirmed unchanged', async () => {
    const line = await freshLine();
    const value = await insertDimensionValueFixture({ entityIdValue: entityId, dimensionTypeIdValue: listTypeId });
    const rowId = await tagLineAsApp(OWNER_ACTOR_UUID, { journalLineId: line, entityIdValue: entityId, dimensionTypeIdValue: listTypeId, valueId: value.id });

    let updateRejection: unknown;
    try {
      await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(sql`update billing.line_dimensions set value_id = ${randomUUID()} where id = ${rowId}`),
      );
    } catch (error) {
      updateRejection = error;
    }
    expect(findRaisedException(updateRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    let deleteRejection: unknown;
    try {
      await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(sql`delete from billing.line_dimensions where id = ${rowId}`),
      );
    } catch (error) {
      deleteRejection = error;
    }
    expect(findRaisedException(deleteRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    const afterResult: QueryResult<{ value_id: string }> = await pool.query(`select value_id from billing.line_dimensions where id = $1`, [rowId]);
    expect(afterResult.rows[0]?.value_id).toBe(value.id);
  });
});

// --- Pre-build round-2 finding 4: C4 grants on dimension_values (orphan protection under R1) -------
// With no FK on line_dimensions.value_id (R1), the app role's missing DELETE, and UPDATE limited to
// (is_active, version), are what keep every list-kind tag pointing at the value it was made with.

describe('Scenario: A dimension value cannot be deleted, and its code, type and entity cannot be changed, by the app role', () => {
  it.each(['code', 'dimension_type_id', 'entity_id'] as const)(
    'dimension_values: UPDATE of %s is refused for the app role (42501); the row is unchanged',
    async (column) => {
      const value = await insertDimensionValueFixture({ entityIdValue: entityId, dimensionTypeIdValue: listTypeId });
      const before: QueryResult<{ code: string; dimension_type_id: string; entity_id: string }> = await pool.query(
        `select code, dimension_type_id::text as dimension_type_id, entity_id::text as entity_id from billing.dimension_values where id = $1`,
        [value.id],
      );
      const replacement = column === 'code' ? freshCode('val') : column === 'dimension_type_id' ? otherListTypeId : outsiderEntityId;

      let rejection: unknown;
      try {
        await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx: NodePgDatabase) =>
          tx.execute(sql`update billing.dimension_values set ${sql.identifier(column)} = ${replacement} where id = ${value.id}`),
        );
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

      const after: QueryResult<{ code: string; dimension_type_id: string; entity_id: string }> = await pool.query(
        `select code, dimension_type_id::text as dimension_type_id, entity_id::text as entity_id from billing.dimension_values where id = $1`,
        [value.id],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    },
  );

  it('dimension_values: DELETE is refused for the app role (42501); a tagged value and its tag both stay', async () => {
    const value = await insertDimensionValueFixture({ entityIdValue: entityId, dimensionTypeIdValue: listTypeId });
    const line = await freshLine();
    await tagLineAsApp(OWNER_ACTOR_UUID, { journalLineId: line, entityIdValue: entityId, dimensionTypeIdValue: listTypeId, valueId: value.id });

    let rejection: unknown;
    try {
      await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(sql`delete from billing.dimension_values where id = ${value.id}`),
      );
    } catch (error) {
      rejection = error;
    }
    expect(findRaisedException(rejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    const stillThere: QueryResult<{ id: string }> = await pool.query(`select id from billing.dimension_values where id = $1`, [value.id]);
    expect(stillThere.rows).toHaveLength(1);
    expect(await countLineDimensionsForValue(value.id)).toBe(1);
  });
});

// --- Scenario: line_dimensions.entity_id must equal the entity of its journal entry -----------------

describe('Scenario: line_dimensions.entity_id must equal the entity of its journal entry', () => {
  it('a mismatched entity_id is rejected (23514); the correctly-matching entity_id succeeds (positive control)', async () => {
    const value = await insertDimensionValueFixture({ entityIdValue: entityId, dimensionTypeIdValue: listTypeId });

    // Pre-build round-2 finding 2: ONLY the entity-deriving trigger may be able to fail here. The
    // tag names entity PCC, PCC's own list type and an ACTIVE PCC value under that type — so R2's
    // (entity_id, dimension_type_id) FK and assert_dimension_value() both pass — while the journal
    // line belongs (via journal_entries) to PST. Were the R2 FK violated instead, Postgres's
    // RI_ConstraintTrigger_* would fire first and raise 23503, masking the trigger under test.
    const outsiderValue = await insertDimensionValueFixture({ entityIdValue: outsiderEntityId, dimensionTypeIdValue: outsiderListTypeId });
    const lineForMismatch = await freshLine();
    await expect(
      tagLineAsAdmin({
        journalLineId: lineForMismatch, // belongs (via journal_entries) to `entityId`.
        entityIdValue: outsiderEntityId, // WRONG — does not match the journal line's own entity.
        dimensionTypeIdValue: outsiderListTypeId,
        valueId: outsiderValue.id,
      }),
    ).rejects.toMatchObject({ code: INACTIVE_OR_TRIGGER_ENTITY_MISMATCH });
    expect(await countLineDimensionsForValue(outsiderValue.id)).toBe(0);

    const lineForPositiveControl = await freshLine();
    const id = (
      await tagLineAsAdmin({ journalLineId: lineForPositiveControl, entityIdValue: entityId, dimensionTypeIdValue: listTypeId, valueId: value.id })
    ).rows[0]?.id;
    if (!id) throw new Error('expected the positive-control insert to return an id');
    insertedLineDimensionIds.push(id);
  });
});

// --- Scenario R2: entity-matching composite FKs (round-1 finding 2) --------------------------------

describe("Scenario: R2 — a value or a tag can never use a dimension type from a DIFFERENT entity (composite FK, 23503)", () => {
  it('creating a dimension_values row whose dimension_type_id belongs to a DIFFERENT entity is rejected (23503)', async () => {
    await expect(
      pool.query(
        `insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4)`,
        [entityId, outsiderListTypeId, freshCode('cc'), 'قيمة عبر كيانات — يجب رفضها'],
      ),
    ).rejects.toMatchObject({ code: MISSING_OR_FK_VIOLATION });
  });

  it("tagging the pilot's own line with another entity's dimension type is rejected (23503)", async () => {
    // Pre-build round-2 finding 3: a REAL, ACTIVE value of the outsider's type, so
    // assert_dimension_value() passes (value exists under that type, active) and the entity
    // trigger passes (entity_id = the line's own entity) — only R2's line_dimensions FK
    // (entity_id, dimension_type_id) -> dimension_types (entity_id, id) can refuse this row.
    const outsiderValue = await insertDimensionValueFixture({ entityIdValue: outsiderEntityId, dimensionTypeIdValue: outsiderListTypeId });
    const line = await freshLine();
    await expect(
      tagLineAsAdmin({ journalLineId: line, entityIdValue: entityId, dimensionTypeIdValue: outsiderListTypeId, valueId: outsiderValue.id }),
    ).rejects.toMatchObject({ code: MISSING_OR_FK_VIOLATION });
    expect(await countLineDimensionsForValue(outsiderValue.id)).toBe(0);
  });
});

// --- Scenario (new, round-1 finding 9): C5 — no cascade, a tagged journal_lines row cannot be -------
// --- deleted ------------------------------------------------------------------------------------------

describe('Scenario: deleting a tagged journal_lines row is refused (no cascade, C5)', () => {
  it('admin DELETE of a tagged journal_lines row fails with 23503, and the tag is still present afterwards', async () => {
    const line = await freshLine();
    const value = await insertDimensionValueFixture({ entityIdValue: entityId, dimensionTypeIdValue: listTypeId });
    const tagId = await tagLineAsApp(OWNER_ACTOR_UUID, { journalLineId: line, entityIdValue: entityId, dimensionTypeIdValue: listTypeId, valueId: value.id });

    await expect(pool.query(`delete from billing.journal_lines where id = $1`, [line])).rejects.toMatchObject({
      code: MISSING_OR_FK_VIOLATION,
    });

    const stillThereResult: QueryResult<{ id: string }> = await pool.query(`select id from billing.line_dimensions where id = $1`, [tagId]);
    expect(stillThereResult.rows).toHaveLength(1);
  });
});

// --- Scenario (new, round-1 finding 8): dimension_values.code uniqueness (C7) -----------------------

describe('Scenario: dimension_values.code is unique per (entity_id, dimension_type_id) (C7); a deactivated value keeps its code', () => {
  it('a second row for the SAME entity+type with the SAME code is rejected (23505)', async () => {
    const code = freshCode('dup');
    const first: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4) returning id`,
      [entityId, listTypeId, code, 'قيمة أصلية — تكرار الكود'],
    );
    insertedDimensionValueIds.push((first.rows[0] as { id: string }).id); // close review round 1 finding 5.
    await expect(
      pool.query(`insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4)`, [
        entityId,
        listTypeId,
        code,
        'قيمة مكررة — يجب رفضها',
      ]),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('the SAME code is STILL rejected after the first row is deactivated (a deactivated value keeps its code)', async () => {
    const code = freshCode('dup');
    const first: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4) returning id`,
      [entityId, listTypeId, code, 'قيمة أصلية — سيُلغى تفعيلها'],
    );
    const firstId = (first.rows[0] as { id: string }).id;
    insertedDimensionValueIds.push(firstId); // close review round 1 finding 5.
    await pool.query(`update billing.dimension_values set is_active = false where id = $1`, [firstId]);

    await expect(
      pool.query(`insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4)`, [
        entityId,
        listTypeId,
        code, // SAME code as the now-inactive row.
        'قيمة جديدة بنفس الكود — يجب رفضها',
      ]),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('the SAME code under a DIFFERENT dimension_type_id is accepted', async () => {
    const code = freshCode('dup');
    const first: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4) returning id`,
      [entityId, listTypeId, code, 'قيمة أصلية — نوع أول'],
    );
    insertedDimensionValueIds.push((first.rows[0] as { id: string }).id); // close review round 1 finding 5.
    const second: QueryResult<{ id: string }> = await pool.query(
      `insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4) returning id`,
      [entityId, otherListTypeId, code, 'قيمة أخرى — نوع مختلف، نفس الكود'],
    );
    const secondId = (second.rows[0] as { id: string } | undefined)?.id;
    if (secondId) insertedDimensionValueIds.push(secondId); // close review round 1 finding 5.
    expect(secondId).toBeTruthy();
  });
});

// --- Scenario: Stale version is rejected; idempotent replay returns the first result; one outbox ---
// --- + one audit row per write -----------------------------------------------------------------------

describe(
  'Scenario: Stale version is rejected; idempotent replay returns the first result; one outbox + one audit row per write',
  () => {
    it('CreateDimensionValue: one outbox + one audit row (exact event_type/aggregate_id); replay returns the same result without re-running; a mismatched body (different code) is an idempotency conflict', async () => {
      const idemKey = `create-${randomUUID()}`;
      const correlationId = nextCorrelationId();
      const body = { entityId, dimensionTypeId: listTypeId, code: freshCode('cc'), name: 'مركز تكلفة — تكرار', correlationId };

      const first = await createDimensionValue(ctxFor(OWNER_ACTOR_UUID), { ...body, idem: idemFor('create', idemKey, body) }, deps);
      insertedDimensionValueIds.push(first.id); // close review round 1 finding 5.
      await assertOutboxEvent(correlationId, CREATED_EVENT_TYPE, first.id);
      expect(await auditCountForCorrelation(correlationId)).toBe(1);

      const second = await createDimensionValue(ctxFor(OWNER_ACTOR_UUID), { ...body, idem: idemFor('create', idemKey, body) }, deps);
      expect(second).toEqual(first);
      await assertOutboxEvent(correlationId, CREATED_EVENT_TYPE, first.id);
      expect(await auditCountForCorrelation(correlationId)).toBe(1);

      // Round-1 finding 15: exactly one dimension_values row for (entity, type, code) — the replay
      // never inserted a second one.
      const countResult: QueryResult<{ n: string }> = await pool.query(
        `select count(*)::text as n from billing.dimension_values where entity_id = $1 and dimension_type_id = $2 and code = $3`,
        [entityId, listTypeId, body.code],
      );
      expect(Number(countResult.rows[0]?.n ?? '0')).toBe(1);

      // Round-1 finding 15: the "different body" changes `code` too — a genuinely different create
      // request, not merely a different correlationId.
      const differentBody = { ...body, code: freshCode('cc'), correlationId: nextCorrelationId() };
      await expect(
        createDimensionValue(ctxFor(OWNER_ACTOR_UUID), { ...differentBody, idem: idemFor('create', idemKey, differentBody) }, deps),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('DeactivateDimensionValue: a stale expectedVersion is rejected (StaleVersionError exposes expectedVersion/actualVersion) and the value is left unchanged, zero outbox/audit rows', async () => {
      const created = await createDimensionValue(
        ctxFor(OWNER_ACTOR_UUID),
        { entityId, dimensionTypeId: listTypeId, code: freshCode('cc'), name: 'مركز تكلفة — إصدار قديم', correlationId: nextCorrelationId() },
        deps,
      );
      insertedDimensionValueIds.push(created.id); // close review round 1 finding 5.
      const staleVersion = created.version + 999;
      const correlationId = nextCorrelationId();

      let caught: unknown;
      try {
        await deactivateDimensionValue(ctxFor(OWNER_ACTOR_UUID), { dimensionValueId: created.id, expectedVersion: staleVersion, correlationId }, deps);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StaleVersionError);
      const staleError = caught as StaleVersionError;
      expect(staleError.expectedVersion).toBe(staleVersion);
      expect(staleError.actualVersion).toBe(created.version);

      const stored = await getDimensionValue(created.id);
      expect(stored.is_active).toBe(true);
      expect(stored.version).toBe(created.version);
      await assertNoWriteForCorrelation(correlationId);
    });

    it('DeactivateDimensionValue: correct version deactivates exactly once (version == created.version + 1, stored == returned); one outbox + one audit row; replay returns the same result without deactivating twice', async () => {
      const created = await createDimensionValue(
        ctxFor(OWNER_ACTOR_UUID),
        { entityId, dimensionTypeId: listTypeId, code: freshCode('cc'), name: 'مركز تكلفة — سيُلغى تفعيله بنجاح', correlationId: nextCorrelationId() },
        deps,
      );
      insertedDimensionValueIds.push(created.id); // close review round 1 finding 5.

      const idemKey = `deactivate-${randomUUID()}`;
      const correlationId = nextCorrelationId();
      const body = { dimensionValueId: created.id, expectedVersion: created.version, correlationId };

      const first = await deactivateDimensionValue(ctxFor(OWNER_ACTOR_UUID), { ...body, idem: idemFor('deactivate', idemKey, body) }, deps);
      expect(first.version).toBe(created.version + 1);
      await assertOutboxEvent(correlationId, DEACTIVATED_EVENT_TYPE, created.id);
      expect(await auditCountForCorrelation(correlationId)).toBe(1);
      const afterFirst = await getDimensionValue(created.id);
      expect(afterFirst.is_active).toBe(false);
      expect(afterFirst.version).toBe(first.version);

      // Same key, same body — including the SAME (now stale) expectedVersion. Replay must NOT
      // re-run the command (it would otherwise hit StaleVersionError against the bumped row).
      const second = await deactivateDimensionValue(ctxFor(OWNER_ACTOR_UUID), { ...body, idem: idemFor('deactivate', idemKey, body) }, deps);
      expect(second).toEqual(first);
      const afterSecond = await getDimensionValue(created.id);
      expect(afterSecond.version).toBe(afterFirst.version); // bumped exactly once.
      await assertOutboxEvent(correlationId, DEACTIVATED_EVENT_TYPE, created.id);
      expect(await auditCountForCorrelation(correlationId)).toBe(1);
    });

    it('DeactivateDimensionValue: an unknown dimensionValueId is rejected as not found (DimensionValueNotFoundError exposes the id), zero outbox/audit rows', async () => {
      const unknownId = randomUUID();
      const correlationId = nextCorrelationId();
      let caught: unknown;
      try {
        await deactivateDimensionValue(ctxFor(OWNER_ACTOR_UUID), { dimensionValueId: unknownId, expectedVersion: 1, correlationId }, deps);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DimensionValueNotFoundError);
      expect((caught as DimensionValueNotFoundError).dimensionValueId).toBe(unknownId);
      await assertNoWriteForCorrelation(correlationId);
    });

    // Round-1 finding 6: outsider tests.
    it('DeactivateDimensionValue by an OUTSIDER on a PILOT-entity value -> DimensionValueNotFoundError (RLS hides the row), value unchanged, zero outbox/audit rows', async () => {
      const created = await createDimensionValue(
        ctxFor(OWNER_ACTOR_UUID),
        { entityId, dimensionTypeId: listTypeId, code: freshCode('cc'), name: 'مركز تكلفة — يستهدفه الغريب', correlationId: nextCorrelationId() },
        deps,
      );
      insertedDimensionValueIds.push(created.id); // close review round 1 finding 5.
      const correlationId = nextCorrelationId();

      let caught: unknown;
      try {
        await deactivateDimensionValue(ctxFor(OUTSIDER_ACTOR_UUID), { dimensionValueId: created.id, expectedVersion: created.version, correlationId }, deps);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DimensionValueNotFoundError);

      const stored = await getDimensionValue(created.id);
      expect(stored.is_active).toBe(true);
      expect(stored.version).toBe(created.version);
      await assertNoWriteForCorrelation(correlationId);
    });

    it('CreateDimensionValue by an OUTSIDER for the PILOT entity -> 42501 in the cause chain, no row, no outbox, no audit', async () => {
      const code = freshCode('cc');
      const correlationId = nextCorrelationId();

      let caught: unknown;
      try {
        await createDimensionValue(ctxFor(OUTSIDER_ACTOR_UUID), { entityId, dimensionTypeId: listTypeId, code, name: 'مركز تكلفة — من الغريب', correlationId }, deps);
      } catch (error) {
        caught = error;
      }
      expect(findRaisedException(caught, INSUFFICIENT_PRIVILEGE)).toBeDefined();

      const countResult: QueryResult<{ n: string }> = await pool.query(
        `select count(*)::text as n from billing.dimension_values where entity_id = $1 and dimension_type_id = $2 and code = $3`,
        [entityId, listTypeId, code],
      );
      expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
      await assertNoWriteForCorrelation(correlationId);
    });
  },
);

// --- Pre-build round-2 finding 11: C1 and C5 pinned in the catalog ---------------------------------
// The app-role positives above would also pass under SECURITY INVOKER (the owner can see its own
// rows), so the trigger shape and the no-cascade rule are asserted where they live: pg_catalog.

// pg_trigger.tgtype bits (src/include/catalog/pg_trigger.h): ROW 1 · BEFORE 2 · INSERT 4 · DELETE 8 ·
// UPDATE 16 · TRUNCATE 32 · INSTEAD 64. AFTER INSERT OR UPDATE FOR EACH ROW = 1 | 4 | 16.
const TGTYPE_AFTER_INSERT_OR_UPDATE_ROW = 21;
const FK_ACTION_CASCADE = 'c';
const VALIDATING_TRIGGER_TABLE_COUNT_MIN = 2; // assert_dimension_value() + the entity-deriving trigger.
// Close review round 1 finding 7 (nit): the EXACT setting (0038's own migration text and pg_proc
// self-check both use this literal), not merely "starts with search_path=" — verified live against
// pgeos_lane2: `select proconfig from pg_proc where proname = 'assert_dimension_value'` returns
// `{"search_path=pg_catalog, pg_temp"}`.
const EXPECTED_SEARCH_PATH_SETTING = 'search_path=pg_catalog, pg_temp';

describe('Scenario: The validating triggers are SECURITY DEFINER constraint triggers and no foreign key cascades (C1, C5)', () => {
  it('every user trigger on billing.line_dimensions is a non-deferrable AFTER INSERT OR UPDATE row constraint trigger whose function is SECURITY DEFINER with a pinned search_path', async () => {
    const result: QueryResult<{
      tgname: string;
      is_constraint: boolean;
      tgdeferrable: boolean;
      tgtype: number;
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }> = await pool.query(
      `select t.tgname, t.tgconstraint <> 0 as is_constraint, t.tgdeferrable, t.tgtype::int as tgtype,
              p.proname, p.prosecdef, p.proconfig
         from pg_trigger t
         join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'billing.line_dimensions'::regclass and not t.tgisinternal`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(VALIDATING_TRIGGER_TABLE_COUNT_MIN);
    expect(result.rows.map((row) => row.proname)).toContain('assert_dimension_value');
    for (const row of result.rows) {
      expect(row.is_constraint).toBe(true);
      expect(row.tgdeferrable).toBe(false);
      expect(row.tgtype).toBe(TGTYPE_AFTER_INSERT_OR_UPDATE_ROW);
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig ?? []).toContain(EXPECTED_SEARCH_PATH_SETTING);
    }
  });

  it('no foreign key on billing.line_dimensions or billing.dimension_values cascades on delete', async () => {
    const result: QueryResult<{ conname: string; confdeltype: string }> = await pool.query(
      `select conname, confdeltype::text as confdeltype from pg_constraint
        where contype = 'f' and conrelid in ('billing.line_dimensions'::regclass, 'billing.dimension_values'::regclass)`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.confdeltype).not.toBe(FK_ACTION_CASCADE);
  });
});

// --- Scenario (new, close review round 1 finding 2, F2): billing.dimension_types is column-limited -
// --- for the app role (orphan protection) -------------------------------------------------------------
// Every other column pgeos_app could freely UPDATE (part 1's own blanket grant) risks orphaning
// line_dimensions.value_id / dimension_values rows validated against this type's OWN kind/
// source_table/entity_id at tag time — R1's trigger has no way to re-validate a tag retroactively if
// the type it was tagged under later changes shape underneath it. Confirmed first (F2 investigation):
// no part-1 test (./dimensions.test.ts et al.) updates kind/source_table/entity_id as the app role —
// the only UPDATE there (dimensions.test.ts's own RLS scenario, an OUTSIDER's rejected attempt) sets
// name_en, which stays writable (0030_2_dimensions.sql's own column list: id, entity_id, code,
// name_ar, name_en, is_active, version, kind, source_table — no renamed column, allowed list matches
// as given).

describe('Scenario: billing.dimension_types is column-limited for the app role — kind/source_table/entity_id are immutable, name_ar stays writable', () => {
  it.each(['kind', 'source_table'] as const)(
    'UPDATE of %s is refused for the app role (42501); the row is unchanged',
    async (column) => {
      const typeId = await insertDimensionType({ entityIdValue: entityId, kind: 'list' });
      const before: QueryResult<{ kind: string; source_table: string | null }> = await pool.query(
        `select kind, source_table from billing.dimension_types where id = $1`,
        [typeId],
      );
      const replacement = column === 'kind' ? 'reference' : 'sales.accounts';

      let rejection: unknown;
      try {
        await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx: NodePgDatabase) =>
          tx.execute(sql`update billing.dimension_types set ${sql.identifier(column)} = ${replacement} where id = ${typeId}`),
        );
      } catch (error) {
        rejection = error;
      }
      expect(findRaisedException(rejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

      const after: QueryResult<{ kind: string; source_table: string | null }> = await pool.query(
        `select kind, source_table from billing.dimension_types where id = $1`,
        [typeId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    },
  );

  it('UPDATE of name_ar succeeds for the app role (positive control)', async () => {
    const typeId = await insertDimensionType({ entityIdValue: entityId, kind: 'list' });
    const newNameAr = 'اسم مُحدَّث — اختبار F2';
    await withContext(ctxFor(OWNER_ACTOR_UUID), async (tx: NodePgDatabase) =>
      tx.execute(sql`update billing.dimension_types set name_ar = ${newNameAr} where id = ${typeId}`),
    );
    const after: QueryResult<{ name_ar: string }> = await pool.query(
      `select name_ar from billing.dimension_types where id = $1`,
      [typeId],
    );
    expect(after.rows[0]?.name_ar).toBe(newNameAr);
  });
});

// --- Scenario (new, close review round 1 finding 4, F4): a dimension_values row can only reference --
// --- a list-kind dimension type ------------------------------------------------------------------------
// Currently NOTHING stops billing.dimension_values.dimension_type_id from naming a REFERENCE-kind
// type (R2's own composite FK only checks entity_id, never kind) — an orphan-shape gap: a
// reference-kind type's "values" would never be reachable through billing.assert_dimension_value()'s
// own list-kind branch (which requires kind = 'list' at the type before it ever looks at
// dimension_values), so such a row could only ever sit unused, undetectable by any tag. F4 pins the
// same SQLSTATE the reference-kind entity-mismatch case uses (23514) since it is, structurally,
// another "the referenced type's own real shape is wrong for how this row wants to use it" rejection
// — never a NEW, invented code.

describe('Scenario: a dimension_values row can only reference a list-kind dimension type (F4)', () => {
  it('an admin insert of a dimension_values row whose dimension_type_id is a REFERENCE-kind type is rejected (23514), no row written', async () => {
    const referenceTypeId = referenceTypeIds['sales.accounts'] as string;
    const code = freshCode('badval');

    // Captured manually (not `.rejects....`) so that if the insert unexpectedly SUCCEEDS while this
    // test is still RED (the gap this scenario proves exists), the row is tracked for cleanup —
    // never an orphan left behind by a test that is, for now, expected to fail.
    let insertResult: QueryResult<{ id: string }> | undefined;
    let rejection: unknown;
    try {
      insertResult = await pool.query(
        `insert into billing.dimension_values (entity_id, dimension_type_id, code, name) values ($1, $2, $3, $4) returning id`,
        [entityId, referenceTypeId, code, 'قيمة تحت نوع مرجعي — يجب رفضها'],
      );
    } catch (error) {
      rejection = error;
    }
    if (insertResult?.rows[0]?.id) insertedDimensionValueIds.push(insertResult.rows[0].id);
    expect(rejection).toMatchObject({ code: INACTIVE_OR_TRIGGER_ENTITY_MISMATCH });

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from billing.dimension_values where entity_id = $1 and dimension_type_id = $2 and code = $3`,
      [entityId, referenceTypeId, code],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
  });

  it('CreateDimensionValue rejects a reference-kind dimensionTypeId (23514 in the cause chain), zero outbox/audit rows', async () => {
    const referenceTypeId = referenceTypeIds['sales.accounts'] as string;
    const code = freshCode('badval');
    const correlationId = nextCorrelationId();

    let caught: unknown;
    try {
      // Captured (not asserted-through) so a row created while this test is still RED (the gap it
      // proves exists) is tracked for cleanup — never an orphan.
      const created = await createDimensionValue(
        ctxFor(OWNER_ACTOR_UUID),
        { entityId, dimensionTypeId: referenceTypeId, code, name: 'قيمة عبر الأمر — يجب رفضها', correlationId },
        deps,
      );
      insertedDimensionValueIds.push(created.id);
    } catch (error) {
      caught = error;
    }
    expect(findRaisedException(caught, INACTIVE_OR_TRIGGER_ENTITY_MISMATCH)).toBeDefined();

    const countResult: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from billing.dimension_values where entity_id = $1 and dimension_type_id = $2 and code = $3`,
      [entityId, referenceTypeId, code],
    );
    expect(Number(countResult.rows[0]?.n ?? '0')).toBe(0);
    await assertNoWriteForCorrelation(correlationId);
  });
});

// --- Scenario (new, close review round 1 finding 1, F1, blocking — RLS): cross-entity trigger error -
// --- messages never name the OTHER entity's id ----------------------------------------------------------
// Both validating constraint triggers currently interpolate the OTHER entity's real id into their
// raised message (v_value_entity / v_source_entity in billing.assert_dimension_value(),
// v_entry_entity in billing.assert_line_dimension_entity()) — a caller who is NOT scoped to that
// entity, and who RLS otherwise hides every row of that entity from, would still learn its real id
// straight out of a 23514 error message. The fix must name only new.entity_id (the CALLER's own,
// already-known value) in every message. Asserted via the raised exception's own `message` (walked
// through the drizzle/withContext cause chain via findRaisedException, and directly on the raw `pg`
// driver error for the admin-pool case) — and its `detail`/`hint` fields too, since `raise exception
// using errcode, message` could in principle also populate those.

function assertNoEntityIdLeak(raised: { message?: string; detail?: string; hint?: string } | undefined, leakedEntityId: string): void {
  expect(raised).toBeDefined();
  expect(raised?.message ?? '').not.toContain(leakedEntityId);
  expect(raised?.detail ?? '').not.toContain(leakedEntityId);
  expect(raised?.hint ?? '').not.toContain(leakedEntityId);
}

describe("Scenario: F1 — cross-entity trigger error messages never name the other entity's id", () => {
  it("a PCC-scoped caller tags a PST journal line with PCC's own type+value (entity-deriving trigger case) — the 23514 message never names the PST entity id", async () => {
    const outsiderValue = await insertDimensionValueFixture({ entityIdValue: outsiderEntityId, dimensionTypeIdValue: outsiderListTypeId });
    const pstLine = await freshLine(); // belongs to `entityId` (PST) via its journal entry.

    let caught: unknown;
    try {
      await tagLineAsApp(OUTSIDER_ACTOR_UUID, {
        journalLineId: pstLine,
        entityIdValue: outsiderEntityId, // PCC — the OUTSIDER's own scope, and the type/value's own entity.
        dimensionTypeIdValue: outsiderListTypeId,
        valueId: outsiderValue.id,
      });
    } catch (error) {
      caught = error;
    }
    const raised = findRaisedException(caught, INACTIVE_OR_TRIGGER_ENTITY_MISMATCH);
    assertNoEntityIdLeak(raised, entityId); // PST's real id must never appear.
    expect(await countLineDimensionsForValue(outsiderValue.id)).toBe(0);
  });

  it("a reference-kind tag naming another entity's wms.warehouses row is rejected (23514) and the message never names that row's entity id", async () => {
    const line = await freshLine();
    const fixture = sourceFixtures['wms.warehouses'] as SourceFixture;

    let caught: unknown;
    try {
      await tagLineAsAdmin({
        journalLineId: line,
        entityIdValue: entityId,
        dimensionTypeIdValue: referenceTypeIds['wms.warehouses'] as string,
        valueId: fixture.otherRowId,
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe(INACTIVE_OR_TRIGGER_ENTITY_MISMATCH);
    assertNoEntityIdLeak(caught as { message?: string; detail?: string; hint?: string } | undefined, outsiderEntityId); // PCC's real id (the warehouse's own entity) must never appear.
  });
});

// --- Scenario: RLS — a caller scoped to another entity cannot see or tag this entity's values -------

describe("Scenario: RLS — a caller scoped to another entity cannot see or tag this entity's values", () => {
  it('zero dimension_values rows and zero line_dimensions rows are visible to the outsider; both INSERT attempts are rejected by RLS (42501)', async () => {
    const value = await insertDimensionValueFixture({ entityIdValue: entityId, dimensionTypeIdValue: listTypeId });
    const line = await freshLine();
    const taggedLineId = await tagLineAsApp(OWNER_ACTOR_UUID, { journalLineId: line, entityIdValue: entityId, dimensionTypeIdValue: listTypeId, valueId: value.id });

    const outsiderValues = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) =>
      tx.execute<{ id: string }>(sql`select id from billing.dimension_values where id = ${value.id}`),
    );
    expect(outsiderValues.rows).toHaveLength(0);

    const outsiderLineDimensions = await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) =>
      tx.execute<{ id: string }>(sql`select id from billing.line_dimensions where id = ${taggedLineId}`),
    );
    expect(outsiderLineDimensions.rows).toHaveLength(0);

    let valueInsertRejection: unknown;
    try {
      await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(
          sql`insert into billing.dimension_values (entity_id, dimension_type_id, code, name)
              values (${entityId}, ${listTypeId}, ${freshCode('rls')}, ${'قيمة رفضتها RLS'})`,
        ),
      );
    } catch (error) {
      valueInsertRejection = error;
    }
    expect(findRaisedException(valueInsertRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();

    const otherLine = await freshLine();
    let tagInsertRejection: unknown;
    try {
      await withContext(ctxFor(OUTSIDER_ACTOR_UUID), async (tx: NodePgDatabase) =>
        tx.execute(
          sql`insert into billing.line_dimensions (journal_line_id, entity_id, dimension_type_id, value_id)
              values (${otherLine}, ${entityId}, ${listTypeId}, ${value.id})`,
        ),
      );
    } catch (error) {
      tagInsertRejection = error;
    }
    expect(findRaisedException(tagInsertRejection, INSUFFICIENT_PRIVILEGE)).toBeDefined();
  });
});
