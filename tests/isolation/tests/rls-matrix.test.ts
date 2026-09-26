// tests/isolation/tests/rls-matrix.test.ts — Master task P5 (pg-tester).
//
// A CATALOG-DRIVEN RLS matrix: unlike tests/isolation/tests/app-role-rls.test.ts (whose
// ENTITY_SCOPE_POLICY_COUNT is a hand-maintained number that drifts every time a lane adds a
// table), every table this file asserts on is enumerated LIVE from pg_catalog — never a
// hard-coded list — so a newly added entity_id-bearing table is picked up automatically on the
// next run, with no test-file edit required.
//
// SCOPE — "operational schemas": the fourteen business schemas doc 40 Part F row G7 names
// ("Operational table for G7 means any base table in the fourteen business schemas…") — copied
// verbatim from database/schema/guards.sql's own G7 query and from
// tests/isolation/tests/client-isolation.test.ts / app-role-rls.test.ts's own FOURTEEN_SCHEMAS
// constant, not invented here.
//
// TABLE ENUMERATION — "every table … that carries entity_id": relkind in ('r','p') (an ordinary
// table or a partitioned PARENT — guards.sql's own G7 comment: "a partitioned PARENT is a base
// table for this purpose"), excluding relispartition (a partition CHILD is not itself counted as
// a separate base table — verified live: every platform.audit_log_* partition already carries its
// own entity_scope policy AND its own relrowsecurity=true, mirroring the parent's, so testing the
// parent once is not a coverage gap; the separate "no entity_id table lacks RLS" meta-check below
// deliberately does NOT exclude partitions, matching G7's own raw query bit-for-bit, as an
// independent safety net).
//
// CHECK (1) — relrowsecurity is true: G7's own condition, re-derived independently in TypeScript
// rather than re-using guards.sql (guards.sql is schema, out of this slice's write scope).
//
// CHECK (2) — an entity_scope policy exists with USING and WITH CHECK both referencing
// platform.allowed_entities(). VERIFIED LIVE (this session, against a fresh apply.sh run) that 10
// of the 79 audited tables carry NO policy literally named `entity_scope` at all:
//   - 8 are "reference/lookup" tables (billing.gl_accounts, catalog.services, hr.org_units,
//     hr.teams, platform.counters, platform.document_templates, platform.settings,
//     wms.warehouses) governed instead by `reference_read`/`reference_write`
//     (platform.is_internal()-gated) — entity_id is carried but is not itself the access-control
//     boundary for these. This is NOT a newly-discovered gap: database/schema/guards.sql's own G7
//     comment documents that an earlier, broader version of G7 DID flag "a table with entity_id
//     but no entity_scope policy at all" and that check was DELIBERATELY REMOVED — "D-133 لا
//     يطلبها، وتُبلِّغ عن 9 جداول مرجعية/ذات سياسة خاصة بتصميم 13B نفسه" ("D-133 does not ask for
//     it, and it flags 9 reference/specially-designed tables by 13B's own design"). This matrix
//     respects that prior, already-recorded decision rather than silently resurrecting a
//     previously-rejected check as new red failures.
//   - hr.commission_daily is governed solely by `own_commission` (permission or the caller's own
//     employee_id) — a commission-ownership design, not an entity boundary.
//   - platform.idempotency_keys is governed by `idem_entity_scope` (restrictive: null-or-entity)
//     PLUS `idem_own` (the caller must own the key) — a distinct, deliberate two-policy design.
// These 10 tables get CHECK (1) (RLS enabled) unconditionally, and an ALTERNATIVE, still
// non-vacuous, CHECK (2) proving their documented real policy names exist (never invented — every
// name and predicate fragment below was read live via pg_policy in this session), instead of the
// entity_scope assertion. They are excluded from the generic behavioral CHECK (3): their access
// control is not a plain entity boundary, so the generic entity-A/entity-B seeding proof below
// does not apply to them by construction, not because seeding failed.
//
// CHECK (3) — behavioral: an admin-seeded row under entity B is invisible to a pgeos_app caller
// scoped to entity A (plus a positive control: an admin-seeded entity-A row IS visible — without
// it, "zero rows" could just as well mean "this session sees nothing at all", the same vacuity
// concern app-role-rls.test.ts's own SCR-RLS-03 fix documents at length). Seeding is fully
// GENERIC: for every table not covered by an entity-scope name exception above, this file
// introspects pg_catalog for every NOT NULL, no-default, non-generated column, resolves a single-
// column foreign key by SELECTing an EXISTING row from the referenced table (never fabricating
// reference/business data — if the referenced table has no row, or the foreign key is composite,
// or the table has no single-column primary key, or a column's type is not one this file knows a
// safe generic value for, seeding is impossible) and falls back to a type-keyed generic literal for
// every non-FK column (uuid -> random uuid, text -> a prefixed random string truncated to the
// column's max length, boolean -> false, numeric -> 1, date/timestamp -> now, array -> empty,
// jsonb -> '{}'). Where a generic INSERT genuinely fails (a CHECK constraint this file cannot know
// the business meaning of, an empty reference table, a composite key, an unsupported type), the
// table is listed, with the database's own rejection reason, in SEEDING_EXCEPTIONS — visible via
// its own it.each below, never silently dropped.
//
// GATED CONTEXT SELECTION — 7 of the entity_scope tables require `platform.is_internal()` in
// addition to the entity match (SCR-RLS-01 Option B, migration 0003, D-002 — the same 7
// app-role-rls.test.ts's IS_INTERNAL_GATED_ENTITY_SCOPE_COUNT names). This file reads each table's
// OWN entity_scope USING clause live and only sets isInternal:true when that table's own predicate
// actually requires it — never a hard-coded table list — so the choice is correct for both gated
// and ungated tables without needing to special-case the `reference_read` overlap (verified live:
// `reference_read`'s predicate is `platform.is_internal()` ALONE, with no entity restriction; using
// isInternal:false for an ungated entity_scope table makes that OR-leg inert, so the boundary this
// file proves is entity_scope's own, not confused by an unrelated reference-table policy).
//
// A DEFECT THIS FILE INTENTIONALLY DOES NOT SUPPRESS: hr.sales_commission_events is not one of the
// 79 audited tables (it carries no entity_id), so it never appears here — mentioned only because
// its own restrictive own_sales_commission policy was examined while mapping every distinct policy
// name in the fourteen schemas, for context in this file's own design notes, not as a finding of
// this matrix.
//
// If seeding succeeds for a table but the behavioral proof itself goes red (either control fails),
// this file does NOT reclassify that table into SEEDING_EXCEPTIONS after the fact — per this
// task's own instruction, a real gap is left red and reported, never quietly re-routed around.
//
// VIEW security_invoker MATRIX (Master addition, same task, same commit) — RULING CORRECTED, see
// below. A second, independent catalog-driven matrix in this same file, one it.each case per view
// (relkind = 'v') in the same fourteen operational schemas.
//
// RULE — D-133 (migration 0007_M_pgeos-app-role-entity-scope.sql:12-17, "LEAN DESIGN"): views are
// NOT rewritten. Rather than granting/revoking per-view privilege case by case, 0007 grants
// pgeos_app NO privilege at all on any view, full stop, and the guard (guards.sql G7, extended)
// only flags a view lacking security_invoker=true WHEN pgeos_app still holds a privilege on it —
// "a view without security_invoker=true is not itself a defect this migration is asked to fix"
// (0007:16-17, quoted verbatim). An earlier version of this file's own comment asked for EVERY view
// to carry security_invoker=true (or an exception with a citation), which contradicted this
// already-approved D-133 design — a view pgeos_app cannot touch bypasses nothing regardless of its
// own reloptions. Corrected here: for each view, IF pgeos_app holds ANY privilege on it
// (`has_table_privilege`), THEN `reloptions` must contain `security_invoker=true`; a view with no
// pgeos_app privilege passes outright, and the it.each CASE NAME itself says so ("… — not granted —
// D-133"), so a reader of the test report sees the reason without opening this file.
// VIEW_INVOKER_EXCEPTIONS (the earlier, now-superseded design) is removed — no longer needed: this
// rule needs no per-view exception list at all. VERIFIED LIVE (this session): of 16 views in the
// fourteen schemas, only `wms.space_dashboard` carries a pgeos_app privilege, and it already has
// `security_invoker=true` (migration 0012_M_space-dashboard-invoker-grant.sql) — every other view
// (including `wms.client_space_overview`, which is not granted to pgeos_app either, despite
// carrying the option itself for its own, separate reason —
// database/schema/13B-Schema-Reference-Consolidation.sql:4669-4670) passes as "not granted". All 16
// cases are green under this corrected rule. The G19 proposal this earlier ruling would have
// implied (a new guard requiring security_invoker on every view unconditionally) is WITHDRAWN — G7
// (extended, D-133) already covers the real risk.

import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

// Same PG* convention and defaults as app-role-rls.test.ts / client-isolation.test.ts.
const PGHOST = process.env['PGHOST'] ?? 'localhost';
const PGPORT = process.env['PGPORT'] ?? '5432';
const PGDATABASE = process.env['PGDATABASE'] ?? 'pgeos';
const SUPERUSER = process.env['PGUSER'] ?? 'postgres';
const SUPERUSER_PASSWORD = process.env['PGPASSWORD'];

const SUPERUSER_CONNECTION = {
  host: PGHOST,
  port: Number(PGPORT),
  user: SUPERUSER,
  password: SUPERUSER_PASSWORD,
  database: PGDATABASE,
};

// D-133's own fixed runtime role name — copied verbatim from app-role-rls.test.ts, not guessed.
// No password field — local pg_hba is `trust`, same accepted portability boundary that file documents.
const APP_ROLE = 'pgeos_app';
const APP_ROLE_CONNECTION = {
  host: PGHOST,
  port: Number(PGPORT),
  user: APP_ROLE,
  database: PGDATABASE,
};

// doc 40 Part F row G7's own schema list — copied verbatim from guards.sql / the two existing
// isolation spec files, never reordered or invented here.
const FOURTEEN_SCHEMAS = [
  'platform', 'identity', 'catalog', 'sales', 'wms', 'tms', 'cc',
  'billing', 'hr', 'partners', 'admin', 'housing', 'imile', 'governance',
] as const;

interface AppRoleCtx {
  readonly userId: string | null;
  readonly clientId: string | null;
  readonly isInternal: boolean;
}

/**
 * Opens ONE dedicated `pgeos_app` connection, sets with-context.ts's three GUCs inside a
 * transaction, runs `fn`, commits on success / rolls back and re-throws on failure, and always
 * closes the connection. Reproduced verbatim from app-role-rls.test.ts's own `withAppRole` (see
 * that file's header for why this is a reproduction, not a shared import: this suite needs its own
 * dedicated pgeos_app connections alongside a separate superuser admin connection, the same
 * two-identity requirement that file documents at length).
 */
async function withAppRole<T>(ctx: AppRoleCtx, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(APP_ROLE_CONNECTION);
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [ctx.userId]);
    await client.query("select set_config('app.client_id', $1, true)", [ctx.clientId]);
    await client.query("select set_config('app.is_internal', $1, true)", [
      ctx.isInternal ? 'true' : 'false',
    ]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Original error still wins.
    }
    throw error;
  } finally {
    await client.end();
  }
}

/** SQLSTATE 42501 — insufficient_privilege. Quoted, not invented — same idiom as the two existing
 *  isolation spec files' own INSUFFICIENT_PRIVILEGE_SQLSTATE. */
function sqlStateOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

async function resolveEntityId(admin: Client, code: string): Promise<string> {
  const result = await admin.query<{ id: string }>(
    'select id from platform.entities where code = $1',
    [code],
  );
  const [row] = result.rows;
  if (!row) {
    throw new Error(`platform.entities lookup for code ${code} returned no row`);
  }
  return row.id;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Table enumeration — pure pg_catalog, no hard-coded table names.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface TableRef {
  readonly schema: string;
  readonly table: string;
  readonly qualifiedName: string;
}

async function fetchEntityIdTables(admin: Client): Promise<TableRef[]> {
  const result = await admin.query<{ schema_name: string; table_name: string }>(
    `select n.nspname as schema_name, c.relname as table_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid
      where c.relkind in ('r','p')
        and not c.relispartition
        and a.attname = 'entity_id'
        and not a.attisdropped
        and a.attnum > 0
        and n.nspname = any($1::text[])
      order by 1, 2`,
    [FOURTEEN_SCHEMAS as unknown as string[]],
  );
  return result.rows.map((row) => ({
    schema: row.schema_name,
    table: row.table_name,
    qualifiedName: `${row.schema_name}.${row.table_name}`,
  }));
}

async function fetchRelRowSecurity(admin: Client, schema: string, table: string): Promise<boolean> {
  const result = await admin.query<{ relrowsecurity: boolean }>(
    'select relrowsecurity from pg_class where oid = $1::regclass',
    [`${schema}.${table}`],
  );
  return result.rows[0]?.relrowsecurity ?? false;
}

interface PolicyShape {
  readonly qual: string | null;
  readonly withcheck: string | null;
}

async function fetchPolicy(
  admin: Client,
  schema: string,
  table: string,
  polname: string,
): Promise<PolicyShape | null> {
  const result = await admin.query<PolicyShape>(
    `select pg_get_expr(p.polqual, p.polrelid) as qual,
            pg_get_expr(p.polwithcheck, p.polrelid) as withcheck
       from pg_policy p
      where p.polrelid = $1::regclass and p.polname = $2`,
    [`${schema}.${table}`, polname],
  );
  return result.rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Named entity-scope exceptions — verified live (see header), never invented.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface NamedScopeException {
  readonly reason: string;
  readonly expectedPolicyNames: readonly string[];
}

const REFERENCE_TABLE_REASON =
  'reference/lookup table (13B design; guards.sql G7 comment, D-133) — governed by ' +
  'reference_read/reference_write (platform.is_internal()), not a policy named entity_scope';
const REFERENCE_TABLE_POLICY_NAMES: readonly string[] = ['reference_read', 'reference_write'];
const REFERENCE_TABLE_NAMES: readonly string[] = [
  'billing.gl_accounts',
  'catalog.services',
  'hr.org_units',
  'hr.teams',
  'platform.counters',
  'platform.document_templates',
  'platform.settings',
  'wms.warehouses',
];

const NAMED_ENTITY_SCOPE_EXCEPTIONS_ENTRIES: ReadonlyArray<readonly [string, NamedScopeException]> = [
  ...REFERENCE_TABLE_NAMES.map(
    (qualifiedName): readonly [string, NamedScopeException] => [
      qualifiedName,
      { reason: REFERENCE_TABLE_REASON, expectedPolicyNames: REFERENCE_TABLE_POLICY_NAMES },
    ],
  ),
  [
    'hr.commission_daily',
    {
      reason:
        "governed by own_commission (platform.has_perm('hr.commission.read_all') or the caller's " +
        'own employee_id) — a commission-ownership design, not a policy named entity_scope',
      expectedPolicyNames: ['own_commission'],
    },
  ],
  [
    'platform.idempotency_keys',
    {
      reason:
        'governed by idem_entity_scope (restrictive: entity_id is null or in allowed_entities()) ' +
        'plus idem_own (the caller must own the key) — not a policy named entity_scope',
      expectedPolicyNames: ['idem_entity_scope', 'idem_own'],
    },
  ],
];

const NAMED_ENTITY_SCOPE_EXCEPTIONS: ReadonlyMap<string, NamedScopeException> = new Map(
  NAMED_ENTITY_SCOPE_EXCEPTIONS_ENTRIES,
);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Generic, catalog-driven seeding — see header for exactly what "generic" means here.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ColumnInfo {
  readonly columnName: string;
  readonly isNullable: boolean;
  readonly hasDefault: boolean;
  readonly dataType: string;
  readonly characterMaximumLength: number | null;
  readonly isGenerated: boolean;
  readonly isIdentity: boolean;
}

interface ForeignKeyInfo {
  readonly columns: readonly string[];
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

async function fetchSinglePrimaryKeyColumn(
  admin: Client,
  schema: string,
  table: string,
): Promise<string | null> {
  const result = await admin.query<{ attname: string }>(
    `select att.attname
       from pg_constraint con
       join unnest(con.conkey) as k(attnum) on true
       join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
      where con.contype = 'p' and con.conrelid = $1::regclass`,
    [`${schema}.${table}`],
  );
  if (result.rows.length !== 1) {
    return null;
  }
  return result.rows[0]?.attname ?? null;
}

async function fetchColumns(admin: Client, schema: string, table: string): Promise<ColumnInfo[]> {
  const basic = await admin.query<{
    column_name: string;
    is_nullable: string;
    column_default: string | null;
    data_type: string;
    character_maximum_length: number | null;
  }>(
    `select column_name, is_nullable, column_default, data_type, character_maximum_length
       from information_schema.columns
      where table_schema = $1 and table_name = $2
      order by ordinal_position`,
    [schema, table],
  );

  const flags = await admin.query<{ attname: string; attgenerated: string; attidentity: string }>(
    `select attname, attgenerated, attidentity
       from pg_attribute
      where attrelid = $1::regclass and attnum > 0 and not attisdropped`,
    [`${schema}.${table}`],
  );
  const flagByName = new Map(flags.rows.map((row) => [row.attname, row]));

  return basic.rows.map((row) => {
    const flag = flagByName.get(row.column_name);
    return {
      columnName: row.column_name,
      isNullable: row.is_nullable === 'YES',
      hasDefault: row.column_default !== null,
      dataType: row.data_type,
      characterMaximumLength: row.character_maximum_length,
      isGenerated: flag ? flag.attgenerated !== '' : false,
      isIdentity: flag ? flag.attidentity !== '' : false,
    };
  });
}

async function attnamesForNums(
  admin: Client,
  relOid: string,
  nums: readonly number[],
): Promise<string[]> {
  const result = await admin.query<{ attnum: number; attname: string }>(
    'select attnum, attname from pg_attribute where attrelid = $1::regclass and attnum = any($2::smallint[])',
    [relOid, nums as unknown as number[]],
  );
  const byNum = new Map(result.rows.map((row) => [row.attnum, row.attname]));
  return nums.map((n) => byNum.get(n) ?? `#${n}`);
}

async function fetchForeignKeys(
  admin: Client,
  schema: string,
  table: string,
): Promise<Map<string, ForeignKeyInfo>> {
  const constraints = await admin.query<{
    conkey: number[];
    confkey: number[];
    ref_schema: string;
    ref_table: string;
  }>(
    `select con.conkey, con.confkey, nsp2.nspname as ref_schema, cls2.relname as ref_table
       from pg_constraint con
       join pg_class cls2 on cls2.oid = con.confrelid
       join pg_namespace nsp2 on nsp2.oid = cls2.relnamespace
      where con.contype = 'f' and con.conrelid = $1::regclass`,
    [`${schema}.${table}`],
  );

  const map = new Map<string, ForeignKeyInfo>();
  for (const row of constraints.rows) {
    const localNames = await attnamesForNums(admin, `${schema}.${table}`, row.conkey);
    const refOid = `${row.ref_schema}.${row.ref_table}`;
    const refNames = await attnamesForNums(admin, refOid, row.confkey);
    const info: ForeignKeyInfo = {
      columns: localNames,
      refSchema: row.ref_schema,
      refTable: row.ref_table,
      refColumns: refNames,
    };
    for (const col of localNames) {
      map.set(col, info);
    }
  }
  return map;
}

type GenericValueResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

async function genericValueForColumn(
  admin: Client,
  tableLabel: string,
  col: ColumnInfo,
  fk: ForeignKeyInfo | undefined,
): Promise<GenericValueResult> {
  if (fk) {
    if (fk.columns.length !== 1) {
      return {
        ok: false,
        reason: `column ${col.columnName} is part of a composite foreign key (${fk.columns.join(', ')}) — not resolvable generically`,
      };
    }
    const refColumn = fk.refColumns[0];
    if (!refColumn) {
      return { ok: false, reason: `column ${col.columnName}: foreign key metadata is missing a referenced column` };
    }
    const refResult = await admin.query<Record<string, unknown>>(
      `select "${refColumn}" as v from "${fk.refSchema}"."${fk.refTable}" limit 1`,
    );
    const [refRow] = refResult.rows;
    if (!refRow) {
      return {
        ok: false,
        reason: `foreign key column ${col.columnName} references ${fk.refSchema}.${fk.refTable}, which has no existing row`,
      };
    }
    return { ok: true, value: refRow['v'] };
  }

  switch (col.dataType) {
    case 'uuid':
      return { ok: true, value: randomUUID() };
    case 'boolean':
      return { ok: true, value: false };
    case 'integer':
    case 'smallint':
    case 'bigint':
    case 'numeric':
    case 'real':
    case 'double precision':
      return { ok: true, value: 1 };
    case 'date':
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return { ok: true, value: new Date() };
    case 'text':
    case 'character varying':
    case 'character': {
      let generated = `${tableLabel}-${col.columnName}-${randomUUID()}`;
      if (col.characterMaximumLength !== null && generated.length > col.characterMaximumLength) {
        generated = randomUUID().slice(0, col.characterMaximumLength);
      }
      return { ok: true, value: generated };
    }
    case 'jsonb':
    case 'json':
      return { ok: true, value: '{}' };
    case 'ARRAY':
      return { ok: true, value: [] };
    default:
      return { ok: false, reason: `unsupported column type ${col.dataType} for column ${col.columnName}` };
  }
}

type RowBuildResult =
  | { readonly ok: true; readonly columns: readonly string[]; readonly values: readonly unknown[] }
  | { readonly ok: false; readonly reason: string };

async function buildGenericRow(
  admin: Client,
  tableLabel: string,
  pkColumn: string,
  entityId: string,
  columns: readonly ColumnInfo[],
  fkMap: ReadonlyMap<string, ForeignKeyInfo>,
): Promise<RowBuildResult> {
  const insertColumns: string[] = [];
  const values: unknown[] = [];

  for (const col of columns) {
    if (col.columnName === pkColumn) {
      continue;
    }
    // entity_id is this file's own deliberate test dimension — always set explicitly, even on the
    // (rare) table where the column itself is nullable (e.g. platform.outbox), so the A/B rows are
    // never accidentally indistinguishable.
    if (col.columnName === 'entity_id') {
      insertColumns.push(col.columnName);
      values.push(entityId);
      continue;
    }
    if (col.isNullable || col.hasDefault || col.isGenerated || col.isIdentity) {
      continue;
    }

    const generic = await genericValueForColumn(admin, tableLabel, col, fkMap.get(col.columnName));
    if (!generic.ok) {
      return { ok: false, reason: generic.reason };
    }
    insertColumns.push(col.columnName);
    values.push(generic.value);
  }

  return { ok: true, columns: insertColumns, values };
}

type InsertResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: string };

async function tryInsertRow(
  admin: Client,
  schema: string,
  table: string,
  pkColumn: string,
  columns: readonly string[],
  values: readonly unknown[],
): Promise<InsertResult> {
  const columnList = columns.map((c) => `"${c}"`).join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `insert into "${schema}"."${table}" (${columnList}) values (${placeholders}) returning "${pkColumn}" as id`;
  try {
    const result = await admin.query<{ id: string }>(insertSql, values as unknown[]);
    const [row] = result.rows;
    if (!row) {
      return { ok: false, reason: 'insert returned no row' };
    }
    return { ok: true, id: String(row.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `insert failed (${sqlStateOf(error) ?? 'unknown sqlstate'}): ${message.slice(0, 160)}`,
    };
  }
}

type Classification =
  | {
      readonly seedable: true;
      readonly pkColumn: string;
      readonly entityARowId: string;
      readonly entityBRowId: string;
      readonly gated: boolean;
    }
  | { readonly seedable: false; readonly reason: string };

async function classifyTable(
  admin: Client,
  ref: TableRef,
  entityAId: string,
  entityBId: string,
): Promise<Classification> {
  const pkColumn = await fetchSinglePrimaryKeyColumn(admin, ref.schema, ref.table);
  if (!pkColumn) {
    return {
      seedable: false,
      reason:
        'no single-column primary key found (composite or missing) — a generic fixture cannot capture one id to reference',
    };
  }

  const columns = await fetchColumns(admin, ref.schema, ref.table);
  const fkMap = await fetchForeignKeys(admin, ref.schema, ref.table);

  const builtA = await buildGenericRow(admin, ref.table, pkColumn, entityAId, columns, fkMap);
  if (!builtA.ok) {
    return { seedable: false, reason: builtA.reason };
  }
  const builtB = await buildGenericRow(admin, ref.table, pkColumn, entityBId, columns, fkMap);
  if (!builtB.ok) {
    return { seedable: false, reason: builtB.reason };
  }

  const insertedA = await tryInsertRow(admin, ref.schema, ref.table, pkColumn, builtA.columns, builtA.values);
  if (!insertedA.ok) {
    return { seedable: false, reason: insertedA.reason };
  }
  const insertedB = await tryInsertRow(admin, ref.schema, ref.table, pkColumn, builtB.columns, builtB.values);
  if (!insertedB.ok) {
    return { seedable: false, reason: insertedB.reason };
  }

  const policy = await fetchPolicy(admin, ref.schema, ref.table, 'entity_scope');
  const gated = policy?.qual?.includes('platform.is_internal()') ?? false;

  return {
    seedable: true,
    pkColumn,
    entityARowId: insertedA.id,
    entityBRowId: insertedB.id,
    gated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Module-level setup — must complete BEFORE describe/it.each are called, since the table list and
// its classification decide which it.each cases even exist (vitest collects describe.each/it.each
// bodies at import time). Top-level await is already an established idiom in this package (see
// client-isolation.test.ts's own dynamic `@pg-eos/db` import).
// ─────────────────────────────────────────────────────────────────────────────────────────────

const admin = new Client(SUPERUSER_CONNECTION);
await admin.connect();

const AUDITED_TABLES = await fetchEntityIdTables(admin);

if (AUDITED_TABLES.length === 0) {
  throw new Error(
    'vacuity guard: zero tables with entity_id found across the fourteen business schemas — the RLS matrix would be empty',
  );
}

const entityAId = await resolveEntityId(admin, 'PST');
const entityBId = await resolveEntityId(admin, 'PDL');

// A single shared, internal reader with identity.user_entities access to entity A only — reused
// across every table's behavioral check (allowed_entities() depends only on this user's own
// user_entities rows, never on the is_internal GUC, so the SAME reader is valid for both gated and
// ungated tables; see the header's "GATED CONTEXT SELECTION" note).
const readerEmail = `rls-matrix-test-reader-${randomUUID()}@example.invalid`;
const readerInsert = await admin.query<{ id: string }>(
  `insert into identity.users (email, full_name_ar, user_type) values ($1, $2, 'internal') returning id`,
  [readerEmail, 'قارئ اختبار مصفوفة RLS (WBS P5)'],
);
const readerRow = readerInsert.rows[0];
if (!readerRow) {
  throw new Error('failed to seed the shared identity.users reader fixture for the RLS matrix');
}
const readerId = readerRow.id;
await admin.query('insert into identity.user_entities (user_id, entity_id) values ($1, $2)', [
  readerId,
  entityAId,
]);

// Every fixture row this file inserts, in insertion order, for teardown — NOT because the
// database itself is not thrown away (it is — the caller drops it after this run), but because
// database/schema/guards.sql's own G1–G13 guards are run against the SAME database afterwards
// (`pnpm guards:run`), and a raw generic INSERT bypassing the application layer can trip a guard
// that expects a companion row a real write path would also create — verified live: seeding
// platform.outbox directly (no matching platform.audit_log row, same correlation_id) trips G9
// ("outbox events without a matching audit row", doc 40 Part F / R-02) until the fixture row is
// removed again. Deleting in REVERSE of insertion order is FK-safe for this file's own rows: a
// later-processed table's generic foreign-key resolution can only ever point at an EARLIER-
// processed table's row (or genuine pre-existing seed data), never the reverse, so nothing later
// still references a row this teardown is about to delete.
interface InsertedFixture {
  readonly schema: string;
  readonly table: string;
  readonly pkColumn: string;
  readonly ids: readonly string[];
}
const insertedFixtures: InsertedFixture[] = [];

const classifications = new Map<string, Classification>();
for (const ref of AUDITED_TABLES) {
  if (NAMED_ENTITY_SCOPE_EXCEPTIONS.has(ref.qualifiedName)) {
    continue;
  }
  // Sequential by design: one admin connection, one table at a time, mirroring the existing
  // isolation suites' own sequential fixture style.
  const classification = await classifyTable(admin, ref, entityAId, entityBId);
  classifications.set(ref.qualifiedName, classification);
  if (classification.seedable) {
    insertedFixtures.push({
      schema: ref.schema,
      table: ref.table,
      pkColumn: classification.pkColumn,
      ids: [classification.entityARowId, classification.entityBRowId],
    });
  }
}

const SEEDING_EXCEPTIONS: ReadonlyArray<{ readonly table: string; readonly reason: string }> = [
  ...classifications.entries(),
]
  .filter((entry): entry is [string, { seedable: false; reason: string }] => entry[1].seedable === false)
  .map(([table, classification]) => ({ table, reason: classification.reason }));

afterAll(async () => {
  // Reverse insertion order — see insertedFixtures' own comment above for why this is FK-safe.
  for (const fixture of [...insertedFixtures].reverse()) {
    try {
      await admin.query(
        `delete from "${fixture.schema}"."${fixture.table}" where "${fixture.pkColumn}" = any($1)`,
        [fixture.ids],
      );
    } catch {
      // Best-effort — a single stubborn row (e.g. an FK this file did not itself create) must not
      // stop the rest of teardown from running, and must not fail the suite: this database is a
      // throwaway fixture the caller drops after this run either way.
    }
  }

  try {
    await admin.query('delete from identity.user_entities where user_id = $1', [readerId]);
    await admin.query('delete from identity.users where id = $1', [readerId]);
  } catch {
    // Best-effort only, same rationale as above.
  } finally {
    await admin.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The matrix itself — one named case per table.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('RLS matrix — catalog-driven, one case per entity_id-bearing table', () => {
  it.each(AUDITED_TABLES)('$qualifiedName', async (ref) => {
    // (1) RLS is enabled — unconditional, no exceptions.
    const relrowsecurity = await fetchRelRowSecurity(admin, ref.schema, ref.table);
    expect(relrowsecurity, `${ref.qualifiedName}: relrowsecurity must be true`).toBe(true);

    const namedException = NAMED_ENTITY_SCOPE_EXCEPTIONS.get(ref.qualifiedName);
    if (namedException) {
      // (2), alternative form — this table's real, verified alternative scoping policy exists.
      for (const polname of namedException.expectedPolicyNames) {
        const policy = await fetchPolicy(admin, ref.schema, ref.table, polname);
        expect(
          policy,
          `${ref.qualifiedName}: expected alternative policy "${polname}" not found (${namedException.reason})`,
        ).not.toBeNull();
      }
      // No entity_scope behavioral proof for these tables — see header.
      return;
    }

    // (2) — a policy literally named entity_scope, USING and WITH CHECK both referencing
    // platform.allowed_entities().
    const policy = await fetchPolicy(admin, ref.schema, ref.table, 'entity_scope');
    expect(policy, `${ref.qualifiedName}: no entity_scope policy found`).not.toBeNull();
    expect(policy?.qual, `${ref.qualifiedName}: entity_scope USING clause is missing`).not.toBeNull();
    expect(
      policy?.qual,
      `${ref.qualifiedName}: entity_scope USING does not reference platform.allowed_entities()`,
    ).toMatch(/platform\.allowed_entities\(\)/);
    expect(policy?.withcheck, `${ref.qualifiedName}: entity_scope WITH CHECK is missing`).not.toBeNull();
    expect(
      policy?.withcheck,
      `${ref.qualifiedName}: entity_scope WITH CHECK does not reference platform.allowed_entities()`,
    ).toMatch(/platform\.allowed_entities\(\)/);

    // (3) — behavioral, only where a generic fixture row could be constructed (SEEDING_EXCEPTIONS
    // below lists every table for which it could not, with the database's own reason).
    const classification = classifications.get(ref.qualifiedName);
    if (!classification) {
      throw new Error(`${ref.qualifiedName}: was never classified — a bug in this file's own setup`);
    }
    if (!classification.seedable) {
      return;
    }

    const ctx: AppRoleCtx = { userId: readerId, clientId: null, isInternal: classification.gated };
    const selectSql = `select "${classification.pkColumn}" as id from "${ref.schema}"."${ref.table}" where "${classification.pkColumn}" = $1`;

    const ownRow: QueryResult<{ id: string }> = await withAppRole(ctx, (client) =>
      client.query<{ id: string }>(selectSql, [classification.entityARowId]),
    );
    expect(
      ownRow.rows.map((row) => row.id),
      `${ref.qualifiedName}: an admin-seeded entity-A row was NOT visible to a pgeos_app caller scoped to entity A (positive control — without this, "zero rows" below would be meaningless)`,
    ).toEqual([classification.entityARowId]);

    const otherRow: QueryResult<{ id: string }> = await withAppRole(ctx, (client) =>
      client.query<{ id: string }>(selectSql, [classification.entityBRowId]),
    );
    expect(
      otherRow.rows,
      `${ref.qualifiedName}: an admin-seeded entity-B row WAS visible to a pgeos_app caller scoped to entity A — RLS entity-isolation gap`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Independent safety net — mirrors G7's own raw query bit-for-bit (relkind in ('r','p'), including
// partitions), so a bug in THIS FILE's own TypeScript-side enumeration (e.g. the relispartition
// exclusion above) can never hide a genuinely RLS-less table.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('no entity_id-bearing table in the fourteen business schemas lacks RLS', () => {
  it('a direct catalog query (independent of this file\'s own it.each enumeration) returns zero rows', async () => {
    const result = await admin.query<{ schema_name: string; table_name: string }>(
      `select n.nspname as schema_name, c.relname as table_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
        where c.relkind in ('r','p')
          and a.attname = 'entity_id'
          and not a.attisdropped
          and a.attnum > 0
          and n.nspname = any($1::text[])
          and not c.relrowsecurity
        order by 1, 2`,
      [FOURTEEN_SCHEMAS as unknown as string[]],
    );
    expect(result.rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SEEDING_EXCEPTIONS — visible, never silent. One named case per exception, so the table and the
// database's own rejection reason both show up directly in the test report.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('SEEDING_EXCEPTIONS — a generic fixture row could not be constructed (checks (1)(2) still apply above; (3) does not)', () => {
  it.each(SEEDING_EXCEPTIONS)('$table — $reason', ({ reason }) => {
    expect(reason.length).toBeGreaterThan(0);
  });

  it('every non-named-exception audited table is classified as seedable XOR listed in SEEDING_EXCEPTIONS', () => {
    const exceptionTableNames = new Set(SEEDING_EXCEPTIONS.map((entry) => entry.table));
    expect(exceptionTableNames.size, 'SEEDING_EXCEPTIONS lists a table more than once').toBe(
      SEEDING_EXCEPTIONS.length,
    );

    for (const ref of AUDITED_TABLES) {
      if (NAMED_ENTITY_SCOPE_EXCEPTIONS.has(ref.qualifiedName)) {
        continue;
      }
      const classification = classifications.get(ref.qualifiedName);
      expect(classification, `${ref.qualifiedName} was never classified`).toBeDefined();
      const isException = exceptionTableNames.has(ref.qualifiedName);
      const isSeedable = classification?.seedable === true;
      expect(
        isException,
        `${ref.qualifiedName}: SEEDING_EXCEPTIONS membership disagrees with its own classification`,
      ).toBe(!isSeedable);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// NAMED_ENTITY_SCOPE_EXCEPTIONS — visible the same way.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('NAMED_ENTITY_SCOPE_EXCEPTIONS — no policy literally named entity_scope (see header for why)', () => {
  it.each(NAMED_ENTITY_SCOPE_EXCEPTIONS_ENTRIES)('%s', (table, exception) => {
    expect(exception.reason.length).toBeGreaterThan(0);
    expect(exception.expectedPolicyNames.length).toBeGreaterThan(0);
    expect(AUDITED_TABLES.some((ref) => ref.qualifiedName === table), `${table} is not one of the audited entity_id tables`).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VIEW security_invoker MATRIX — Master addition (same task, same commit), RULING CORRECTED. See
// the file header's own "VIEW security_invoker MATRIX" section for the D-133 citation and the full
// rationale for this shape.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface ViewRef {
  readonly schema: string;
  readonly view: string;
  readonly qualifiedName: string;
}

async function fetchViews(admin: Client): Promise<ViewRef[]> {
  const result = await admin.query<{ schema_name: string; view_name: string }>(
    `select n.nspname as schema_name, c.relname as view_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'v'
        and n.nspname = any($1::text[])
      order by 1, 2`,
    [FOURTEEN_SCHEMAS as unknown as string[]],
  );
  return result.rows.map((row) => ({
    schema: row.schema_name,
    view: row.view_name,
    qualifiedName: `${row.schema_name}.${row.view_name}`,
  }));
}

async function fetchPgeosAppGranted(admin: Client, qualifiedName: string): Promise<boolean> {
  const result = await admin.query<{ granted: boolean }>(
    "select has_table_privilege('pgeos_app', $1::regclass, 'SELECT,INSERT,UPDATE,DELETE') as granted",
    [qualifiedName],
  );
  return result.rows[0]?.granted ?? false;
}

interface ViewAuditCase extends ViewRef {
  // The it.each case NAME itself states the D-133 outcome (Master directive), computed here (once,
  // before the it.each cases are generated) rather than only inside the assertion message — the
  // it() body below still re-queries has_table_privilege live for the actual assertion, this is
  // display-only.
  readonly caseName: string;
}

const AUDITED_VIEWS_RAW = await fetchViews(admin);

if (AUDITED_VIEWS_RAW.length === 0) {
  throw new Error(
    'vacuity guard: zero views found across the fourteen business schemas — the view security_invoker matrix would be empty',
  );
}

const AUDITED_VIEWS: ViewAuditCase[] = [];
for (const view of AUDITED_VIEWS_RAW) {
  const granted = await fetchPgeosAppGranted(admin, view.qualifiedName);
  AUDITED_VIEWS.push({
    ...view,
    caseName: granted ? view.qualifiedName : `${view.qualifiedName} — not granted — D-133`,
  });
}

// D-133 (migration 0007_M_pgeos-app-role-entity-scope.sql:12-17, LEAN DESIGN): views are NOT
// rewritten. The risk this matrix guards against is only a PRIVILEGE granted to pgeos_app on an
// owner-rights view (one without security_invoker=true) — a view pgeos_app cannot touch at all
// bypasses nothing, regardless of its own reloptions. guards.sql's own G7 (extended, D-133) already
// covers exactly this at the SQL level; this is that same rule's TypeScript-side, catalog-driven,
// one-case-per-view counterpart.
describe('view security_invoker matrix — catalog-driven, one case per view (D-133)', () => {
  it.each(AUDITED_VIEWS)('$caseName', async (view) => {
    const granted = await fetchPgeosAppGranted(admin, view.qualifiedName);

    if (!granted) {
      // D-133: pgeos_app holds no privilege on this view at all, so its own security_invoker
      // setting is irrelevant to RLS — nothing to bypass through a role that cannot query it.
      expect(granted).toBe(false);
      return;
    }

    const reloptionsResult = await admin.query<{ reloptions: string[] | null }>(
      'select reloptions from pg_class where oid = $1::regclass',
      [view.qualifiedName],
    );
    const reloptions = reloptionsResult.rows[0]?.reloptions ?? [];
    const hasInvoker = reloptions.includes('security_invoker=true');

    expect(
      hasInvoker,
      `${view.qualifiedName}: pgeos_app holds a privilege on this view but it lacks security_invoker=true — a real RLS bypass (D-133)`,
    ).toBe(true);
  });
});
