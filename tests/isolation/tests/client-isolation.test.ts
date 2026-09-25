// tests/isolation/tests/client-isolation.test.ts — WBS 0.18 (pg-tester).
//
// Proves the executable half of tests/isolation/client-isolation.feature: doc 40 Part F row G7
// ("every operational table in the fourteen business schemas has RLS enabled" — 0 rows) and row
// G14 ("client A requests client B's ids directly" — 0 rows, no error). Runner name is fixed by
// doc 40 Part F: `pnpm test:isolation`. RLS itself (the policies under test) is delivered by
// database/schema/01-Data-Model.sql:1433-1486 and 13B-Schema-Reference-Consolidation.sql, AS
// AMENDED by database/migrations/0003_M_rls-scr-01-02.sql (D-002, docs/DECISION_LOG.md — GM-
// approved and applied 2026-09-23) — nothing here is schema; this file is the permanent,
// re-runnable proof that those policies hold against a live Postgres instance, in the same spirit
// as modules/platform/tests/integration/schema-invariants.test.ts.
//
// CONCURRENT RUNS (review round 3, FIX 4): two invocations of this suite against the SAME database
// (e.g. two worktrees' `pnpm guards:run` running at once) SERIALIZE rather than race — `beforeAll`
// takes a session-level `pg_advisory_lock` (see `ADVISORY_LOCK_NAME`, below) before doing anything
// destructive, and `afterAll` releases it. The second run simply waits for the first run's full
// lifecycle (sweep → seed → tests → teardown) to finish before starting its own, instead of one
// run's sweep deleting the other's live fixture rows or one run's `resetRole()` terminating the
// other's connections. See `ADVISORY_LOCK_NAME`'s own comment for the full rationale and the
// precedent this failure mode has in CHANGELOG 0.12.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE PROVISIONS ITS OWN ROLE (the single most important thing to understand here)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `withContext` (packages/db/src/with-context.ts) sets three session GUCs
// (app.user_id / app.client_id / app.is_internal) that the RLS policies read back through
// platform.current_user_id() / platform.current_client_id() / platform.is_internal(). But GUCs are
// advisory data — RLS *evaluation* only happens for a role that is subject to RLS at all. Postgres
// superusers unconditionally bypass every RLS policy on every table, full stop, regardless of any
// GUC or even of `force row level security` (13B:3047-3061 — FORCE only binds the table OWNER,
// never a superuser). `packages/db/src/client.ts` connects as `PGUSER` defaulting to `postgres`,
// a superuser, in local dev — documented there as a KNOWN, CURRENTLY-ACCEPTED GAP. If this test
// simply called `withContext` as delivered, every "zero rows" assertion below would pass for the
// wrong reason (superuser sees nothing is filtered because it isn't even trying to filter, OR more
// precisely: it would return unfiltered rows, but if it accidentally matched zero by coincidence of
// which id was queried, that would still not be evidence of RLS working) — the test would be
// asserting nothing about the schema at all.
//
// There is also no production non-superuser application role defined anywhere in
// database/schema/*.sql yet (confirmed: zero `create role` statements there) — creating one with a
// correctly scoped, permanent GRANT policy is real deployment/security design work for WBS 0.5/0.6,
// out of scope for this slice (CLAUDE.md · AGENT CONSTRAINTS, G-01: never invent a table, column,
// or — by the same logic — a production role, outside docs 01/13/13B/019/40).
//
// So this file provisions its OWN throwaway, non-superuser, `NOBYPASSRLS` login role
// (`pgeos_rls_isolation_test`) as test-fixture code, entirely under `tests/`, scoped to exactly the
// five client-scoped tables the acceptance criterion is about, and drops it again in teardown. That
// role — not `postgres` — is what `withContext` connects as for every scoped query in this file
// (achieved by setting `PGUSER`/`PGPASSWORD` before `@pg-eos/db` is ever imported — see "ordering
// matters" below). The very first scenario proved (deliberately, before anything else) is that this
// actually took: current_user is the test role, and neither `pg_user.usesuper` nor
// `pg_roles.rolbypassrls` is true for it. Every other assertion in this file is meaningless unless
// that one passes first.
//
// Seeding and cleanup, by contrast, deliberately go through a SEPARATE superuser `pg.Client` — they
// need to bypass RLS to write fixture rows for both clients before either client's context exists.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ORDERING — why PGUSER/PGPASSWORD are mutated at module top level, before any import of @pg-eos/db
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `packages/db/src/client.ts` builds its `Pool` at MODULE LOAD time from `process.env['PGUSER']`
// (and pg's own default password resolution falls back to `process.env['PGPASSWORD']` when the pg
// `Pool` config omits a `password` key, which client.ts's config does). The pool then connects
// lazily on first `pool.connect()` (inside `withContext`), so creating the role in `beforeAll` is
// still in time — but the env vars themselves MUST be set, and `@pg-eos/db` MUST be imported,
// before any other code path could trigger that module's evaluation. Static imports run before
// nested test scaffolding, so `@pg-eos/db` is imported dynamically, after the mutation, right here
// at the top of the file.

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';

// Captured from process.env BEFORE the two mutation lines below overwrite PGUSER/PGPASSWORD. Both
// PGUSER and PGPASSWORD are captured as their own named consts — not just read inline into
// SUPERUSER_CONNECTION — for two reasons found in review round 2:
//   (FINDING B) `new Client(config)` resolves a MISSING `password` key from `process.env.PGPASSWORD`
//   lazily, at `new Client(...)` construction time, not from whatever the env held when the config
//   object literal was written (pg's ConnectionParameters#val — node_modules/pg/lib/
//   connection-parameters.js). Constructing `superuser` after the PGUSER/PGPASSWORD mutation lines
//   below, with `password` omitted from SUPERUSER_CONNECTION, silently authenticated the "superuser"
//   client as the ROLE's own randomUUID() password — invisible under local `trust` (which never
//   checks the password at all), but broken on any scram host, exactly the portability case this
//   fixture exists to cover. Fixed by capturing ORIGINAL_PGPASSWORD up front and both passing it
//   explicitly into SUPERUSER_CONNECTION AND constructing `superuser` immediately below, before the
//   mutation lines run — correct regardless of pg's truthy/falsy fallback quirk for an empty value.
//   (FINDING G) `afterAll` restores both to these originals, so a second spec file added later to
//   this package (vitest reuses one worker process per package, so `process.env` survives module
//   isolation between files) never inherits PGUSER pointed at a role this file's own afterAll has
//   already dropped.
const ORIGINAL_PGUSER = process.env['PGUSER'];
const ORIGINAL_PGPASSWORD = process.env['PGPASSWORD'];
// Fix round 1, WBS 0.6a part 2 (D-133): packages/db/src/client.ts now prefers PG_APP_USER over
// PGUSER (the binding design), so under CI (PG_APP_USER=pgeos_app) this file's PGUSER-only
// mutation below no longer points the dynamically-imported '@pg-eos/db' pool at this file's own
// throwaway ROLE — it kept reading PG_APP_USER=pgeos_app instead. Captured/restored the same way
// as ORIGINAL_PGUSER/ORIGINAL_PGPASSWORD above.
const ORIGINAL_PG_APP_USER = process.env['PG_APP_USER'];

// Same PG* convention and defaults as packages/db/src/client.ts and
// modules/platform/tests/integration/schema-invariants.test.ts.
const SUPERUSER_CONNECTION = {
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: ORIGINAL_PGUSER ?? 'postgres',
  password: ORIGINAL_PGPASSWORD,
  database: process.env['PGDATABASE'] ?? 'pgeos',
};

// Constructed HERE, immediately, still using the original PGUSER/PGPASSWORD — before the mutation
// lines below ever run. See FINDING B in the header comment above.
const superuser = new Client(SUPERUSER_CONNECTION);

// Fixed name per the brief — not randomized, so a previous run's leftover role (if teardown was
// ever interrupted, e.g. by a killed process) is always found and reset by the NEXT run's
// beforeAll, rather than accumulating orphan roles under random names.
const ROLE = 'pgeos_rls_isolation_test';
// Generated at runtime, never committed. The local pg_hba is `trust` (does not check the password
// at all), so this only matters for portability to a scram host, per the brief.
const ROLE_PASSWORD = randomUUID();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FIX 4 (review round 3) — a session-level advisory lock so concurrent runs SERIALIZE instead of
// destroying each other's fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `sweepLeftoverFixtureRows()` unconditionally deletes EVERY `rls-isolation-test-%` row, and `ROLE`
// above is a single fixed, shared name — so two `pnpm guards:run`/`pnpm test:isolation` invocations
// against the SAME Docker database (this machine can have up to three lanes' worktrees, per
// CLAUDE.md · PARALLEL LANES, each pointed at the same local docker-compose Postgres) would
// otherwise race: run B's `beforeAll` sweep could delete run A's still-live fixture rows, and run
// B's `resetRole()` would `pg_terminate_backend` run A's own connections mid-test. This repo
// already has a precedent for exactly this failure shape: CHANGELOG 0.12, where a concurrent
// worktree's pre-seeded rows were destructively deleted by a sibling run.
//
// `ADVISORY_LOCK_NAME` is a fixed, documented string — not a bare numeric literal (CLAUDE.md ·
// AGENT CONSTRAINTS: no magic numbers) — turned into the actual `pg_advisory_lock`/
// `pg_advisory_unlock` bigint key via Postgres's own `hashtext(...)`, the SAME idiom already used
// in this codebase for an unrelated lock (database/schema/13B-Schema-Reference-Consolidation.sql:
// 243, `pg_advisory_xact_lock(hashtext('platform.audit_log'))`) — this is not a new locking idiom,
// just this suite's own key applied to it. The string is distinct from that one, so the two never
// collide. `beforeAll` acquires this SESSION-level lock (not the xact-scoped variant 13B uses,
// since this suite's critical section spans the whole file, not one transaction) on the superuser
// connection as its very first statement, before the sweep; `afterAll` releases it explicitly with
// `pg_advisory_unlock` as late as the still-open superuser connection allows (see that hook's own
// comment for exactly why it cannot be the textually last statement) — and, as a defensive
// backstop only, Postgres itself auto-releases any session-level advisory lock when the holding
// connection ends, so a run that crashes before reaching its own `afterAll` can never leave the
// lock permanently held either.
const ADVISORY_LOCK_NAME = 'pgeos-rls-isolation-test-suite-fixture-lock';

process.env['PGUSER'] = ROLE;
process.env['PGPASSWORD'] = ROLE_PASSWORD;
process.env['PG_APP_USER'] = ROLE;

// Dynamic, and AFTER the mutation above — see "ORDERING" header comment.
const { withContext } = await import('@pg-eos/db');

/** Reads the first row of a QueryResult, or throws — every query below expects at least one row.
 *  `what` names the query that produced `result`, so a failure says which call site is empty
 *  instead of a single interchangeable message repeated at ~10 call sites (review round 2, finding
 *  H) — `rowIdFor` already got this right; `firstRow` now matches it. */
function firstRow<T extends QueryResultRow>(result: QueryResult<T>, what: string): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`${what}: query returned no rows where at least one was expected`);
  }
  return row;
}

/**
 * PostgreSQL SQLSTATE 23514 — check_violation (PostgreSQL docs, Appendix A, Class 23). What
 * `identity.enforce_client_users_hold_no_entities()` (SCR-RLS-01 Option C) raises via `raise
 * exception using errcode = 'check_violation'` when a `user_type = 'client'` row would hold an
 * `identity.user_entities` row. Quoted here, not invented — matches the SQLSTATE naming convention
 * `packages/identity/tests/rbac-sod.test.ts` already uses for its own FOREIGN_KEY_VIOLATION_SQLSTATE.
 */
const CHECK_VIOLATION_SQLSTATE = '23514';

/** The SQLSTATE carried by `error`, or undefined if `error` is not an `Error` with a `code` — the
 *  same `'code' in error` narrowing idiom `packages/identity/tests/rbac-sod.test.ts` uses (its
 *  `sqlStatesIn`), simplified here to a single error rather than a `cause`-chain: the superuser
 *  fixture client (`pg.Client#query`) throws pg's own `DatabaseError` directly, never wrapped by
 *  drizzle, so there is no chain to walk. */
function sqlStateOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/** One seeded client's row ids, keyed by the fully-qualified table name (see TABLES below). */
interface ClientFixture {
  readonly clientId: string;
  readonly rowIdByTable: ReadonlyMap<string, string>;
}

/**
 * The five client-scoped tables from the brief's fixture table, in FK-safe delete order (skus,
 * invoices, delivery_tasks, outbound_orders, accounts — reversed here for insert order, since
 * outbound_orders/delivery_tasks/invoices/skus all FK to sales.accounts.id via client_id).
 */
const TABLES = [
  'sales.accounts',
  'wms.outbound_orders',
  'tms.delivery_tasks',
  'billing.invoices',
  'wms.skus',
] as const;

type TableName = (typeof TABLES)[number];

/** select ... where id = $1, one query builder per table — table names are fixed literals, never interpolated from a variable. */
const SELECT_BY_ID: Readonly<Record<TableName, (id: string) => ReturnType<typeof sql>>> = {
  'sales.accounts': (id) => sql`select id from sales.accounts where id = ${id}`,
  'wms.outbound_orders': (id) => sql`select id from wms.outbound_orders where id = ${id}`,
  'tms.delivery_tasks': (id) => sql`select id from tms.delivery_tasks where id = ${id}`,
  'billing.invoices': (id) => sql`select id from billing.invoices where id = ${id}`,
  'wms.skus': (id) => sql`select id from wms.skus where id = ${id}`,
};

function rowIdFor(fixture: ClientFixture, table: TableName): string {
  const id = fixture.rowIdByTable.get(table);
  if (!id) {
    throw new Error(`fixture has no seeded row id for ${table}`);
  }
  return id;
}

/** select id from <table> where id = <the other client's row id>, via withContext, as ctx. */
async function selectById(
  ctx: WithContextCtx,
  table: TableName,
  id: string,
): Promise<QueryResult<{ id: string }>> {
  return withContext(ctx, (tx) => tx.execute<{ id: string }>(SELECT_BY_ID[table](id)));
}

/** True once `pgeos_rls_isolation_test` exists in pg_roles — guards the reset steps that would
 *  otherwise error against a role that was never created (e.g. the very first run on a fresh DB). */
async function roleExists(): Promise<boolean> {
  const result = await superuser.query<{ exists: boolean }>(
    'select exists(select 1 from pg_roles where rolname = $1) as exists',
    [ROLE],
  );
  return firstRow(result, `role existence check for ${ROLE}`).exists;
}

/**
 * Terminates any open backends for the role, drops everything it owns, then drops the role itself
 * — idempotent and safe whether or not the role currently exists, so it works both as "clean slate
 * before create" in beforeAll and as teardown in afterAll. `ROLE` is the fixed constant above, never
 * derived from external input, so interpolating it into DDL text (identifiers cannot be
 * parameterized by the pg driver) is safe by construction — not a SQL-injection-shaped value.
 */
async function resetRole(): Promise<void> {
  if (await roleExists()) {
    await superuser.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where usename = $1 and pid <> pg_backend_pid()',
      [ROLE],
    );
    await superuser.query(`drop owned by ${ROLE}`);
  }
  await superuser.query(`drop role if exists ${ROLE}`);
}

async function resolveEntityId(code: string): Promise<string> {
  const result = await superuser.query<{ id: string }>(
    'select id from platform.entities where code = $1',
    [code],
  );
  return firstRow(result, `platform.entities lookup for code ${code}`).id;
}

async function resolveWarehouseId(code: string): Promise<string> {
  const result = await superuser.query<{ id: string }>(
    'select id from wms.warehouses where code = $1',
    [code],
  );
  return firstRow(result, `wms.warehouses lookup for code ${code}`).id;
}

interface EntityIds {
  readonly outboundOrderEntityId: string;
  readonly deliveryTaskEntityId: string;
  readonly invoiceEntityId: string;
  readonly warehouseId: string;
}

/**
 * Inserts one row per table in TABLES for a single client, all via the superuser fixture client
 * (bypasses RLS to write — no client context exists yet at seed time). Every unique column
 * (account code, doc_no, sku code) is suffixed with randomUUID() so repeated runs never COLLIDE —
 * but uniqueness alone does NOT stop rows from ACCUMULATING if a run is killed before its own
 * afterAll gets to run. Confirmed in practice (review round 2, finding C): `pnpm test` under turbo
 * killed this suite mid-run when a sibling package failed, `afterAll` never ran, and two
 * sales.accounts rows (plus their children) were still in the database afterwards. The fixed
 * `rls-isolation-test-` code prefix used below exists so `sweepLeftoverFixtureRows()` in `beforeAll`
 * can find and remove exactly those leftovers by prefix — not by a remembered id from a run whose
 * process no longer exists — every time this suite starts, not only after a suspected interruption.
 */
async function seedClient(label: 'A' | 'B', entities: EntityIds): Promise<ClientFixture> {
  const account = await superuser.query<{ id: string }>(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`rls-isolation-test-${label}-${randomUUID()}`, `عميل اختبار عزل البيانات ${label}`],
  );
  const clientId = firstRow(account, `insert sales.accounts for client ${label}`).id;

  const outboundOrder = await superuser.query<{ id: string }>(
    `insert into wms.outbound_orders (entity_id, doc_no, client_id, warehouse_id)
     values ($1, $2, $3, $4) returning id`,
    [entities.outboundOrderEntityId, `RLS-${randomUUID()}`, clientId, entities.warehouseId],
  );

  const deliveryTask = await superuser.query<{ id: string }>(
    `insert into tms.delivery_tasks (entity_id, doc_no, client_id)
     values ($1, $2, $3) returning id`,
    [entities.deliveryTaskEntityId, `RLS-${randomUUID()}`, clientId],
  );

  // doc_no left NULL, status left at its default 'draft' — the doc_no_only_when_approved check
  // constraint (billing.invoices) forbids a doc_no while status is draft/review (brief, verified
  // live 2026-09-23).
  const invoice = await superuser.query<{ id: string }>(
    `insert into billing.invoices (entity_id, client_id) values ($1, $2) returning id`,
    [entities.invoiceEntityId, clientId],
  );

  const sku = await superuser.query<{ id: string }>(
    `insert into wms.skus (client_id, code, name_ar) values ($1, $2, $3) returning id`,
    [clientId, `RLS-${randomUUID()}`, `صنف اختبار عزل البيانات ${label}`],
  );

  return {
    clientId,
    rowIdByTable: new Map<TableName, string>([
      ['sales.accounts', clientId],
      ['wms.outbound_orders', firstRow(outboundOrder, `insert wms.outbound_orders for client ${label}`).id],
      ['tms.delivery_tasks', firstRow(deliveryTask, `insert tms.delivery_tasks for client ${label}`).id],
      ['billing.invoices', firstRow(invoice, `insert billing.invoices for client ${label}`).id],
      ['wms.skus', firstRow(sku, `insert wms.skus for client ${label}`).id],
    ]),
  };
}

/**
 * Deletes any rows a PREVIOUS run of this suite left behind because its own `afterAll` never got to
 * run — e.g. the whole process killed mid-suite (review round 2, finding C: confirmed in practice
 * under `turbo run test` when a sibling package failed). Every fixture row this suite creates is
 * named with the fixed `rls-isolation-test-` prefix (`sales.accounts.code`, and — since the
 * SCR-RLS-01 fixture below — `identity.users.email`), so this sweep finds and removes them by
 * prefix, not by a remembered id from a run whose process no longer exists. Runs unconditionally at
 * the START of every `beforeAll`, not only when an interruption is suspected: it is a no-op (and
 * cheap) on a clean database, so there is no "was the previous run interrupted" branch to get wrong.
 */
async function sweepLeftoverFixtureRows(): Promise<void> {
  await superuser.query(
    `delete from wms.skus where client_id in (select id from sales.accounts where code like 'rls-isolation-test-%')`,
  );
  await superuser.query(
    `delete from billing.invoices where client_id in (select id from sales.accounts where code like 'rls-isolation-test-%')`,
  );
  await superuser.query(
    `delete from tms.delivery_tasks where client_id in (select id from sales.accounts where code like 'rls-isolation-test-%')`,
  );
  await superuser.query(
    `delete from wms.outbound_orders where client_id in (select id from sales.accounts where code like 'rls-isolation-test-%')`,
  );
  await superuser.query(`delete from sales.accounts where code like 'rls-isolation-test-%'`);
  await superuser.query(
    `delete from identity.user_entities where user_id in (select id from identity.users where email like 'rls-isolation-test-%')`,
  );
  await superuser.query(`delete from identity.users where email like 'rls-isolation-test-%'`);
}

/** Deletes one client's fixture rows in FK order: skus, invoices, delivery_tasks, outbound_orders,
 *  then accounts — per the brief. Each statement runs even if an earlier one in THIS call already
 *  found nothing (idempotent — safe to call again if a previous teardown was interrupted). */
async function deleteClientRows(fixture: ClientFixture): Promise<void> {
  await superuser.query('delete from wms.skus where client_id = $1', [fixture.clientId]);
  await superuser.query('delete from billing.invoices where client_id = $1', [fixture.clientId]);
  await superuser.query('delete from tms.delivery_tasks where client_id = $1', [fixture.clientId]);
  await superuser.query('delete from wms.outbound_orders where client_id = $1', [
    fixture.clientId,
  ]);
  await superuser.query('delete from sales.accounts where id = $1', [fixture.clientId]);
}

let clientA: ClientFixture;
let clientB: ClientFixture;
let ctxA: WithContextCtx;
let ctxB: WithContextCtx;
let ctxInternal: WithContextCtx;
// Populated in beforeAll, read by the SCR-RLS-01 describe block at the bottom of this file, which
// needs invoiceEntityId to give its dual-role fixture user identity.user_entities access to the
// SAME entity as the seeded invoices.
let entities: EntityIds;

beforeAll(async () => {
  await superuser.connect();
  // FIX 4 — acquired FIRST, before the sweep: see the ADVISORY_LOCK_NAME comment above for why. A
  // concurrent run blocks here (pg_advisory_lock, not the `_try_` variant — this run is meant to
  // WAIT its turn, not fail) until the holder of the lock finishes its own afterAll and releases
  // it, rather than the two runs' sweeps/resets racing each other's live fixtures.
  await superuser.query('select pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK_NAME]);
  await sweepLeftoverFixtureRows();
  await resetRole();
  await superuser.query(`create role ${ROLE} login nobypassrls password '${ROLE_PASSWORD}'`);
  await superuser.query(`grant usage on schema sales, wms, tms, billing to ${ROLE}`);
  await superuser.query(
    `grant select on sales.accounts, wms.outbound_orders, wms.skus, tms.delivery_tasks, billing.invoices to ${ROLE}`,
  );
  // Beyond the brief's literal grant list: the "entity_scope does not leak" scenario below calls
  // platform.allowed_entities() directly inside withContext(ctxA, ...) (the brief's own scenario 6
  // requires this). Even though that function is `security definer` (evaluates
  // identity.user_entities as its owner, not the caller), a role still needs schema USAGE just to
  // resolve the schema-qualified name `platform.allowed_entities()` at all — confirmed live: with
  // only the four grants above, calling it raised `permission denied for schema platform` (42501).
  // `platform.entities`/`platform.current_*()` are never read directly by this role either way; no
  // SELECT grant on any platform table is added, only USAGE on the schema, so the fixture stays
  // read-only and scoped to exactly what scenario 6 needs.
  await superuser.query(`grant usage on schema platform to ${ROLE}`);

  // SCR-RLS-02 (b)/(c): the fixture role also needs SELECT on the platform.audit_log PARENT
  // (relkind 'p') only — never on any of its five leaf partitions (audit_log_2026_09 etc.), so
  // Option A's fix for the "reads through the parent bypass every partition's policy" defect is
  // exercised exactly the way docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md §3
  // reproduced the defect: a role that can reach the parent but never the leaves.
  await superuser.query(`grant select on platform.audit_log to ${ROLE}`);

  entities = {
    outboundOrderEntityId: await resolveEntityId('PST'),
    deliveryTaskEntityId: await resolveEntityId('PDL'),
    invoiceEntityId: await resolveEntityId('PCC'),
    warehouseId: await resolveWarehouseId('WH1'),
  };

  clientA = await seedClient('A', entities);
  clientB = await seedClient('B', entities);

  // userId is deliberately null (not a real identity.user_entities-linked user) for both portal
  // contexts — see the "entity_scope does not leak" scenario: platform.allowed_entities() reads
  // identity.user_entities by platform.current_user_id(), and a null user_id has no rows there
  // either way, so the entity_scope permissive leg is guaranteed false and cannot accidentally
  // paper over a broken client_portal_scope policy.
  ctxA = { userId: null, clientId: clientA.clientId, isInternal: false };
  ctxB = { userId: null, clientId: clientB.clientId, isInternal: false };
  ctxInternal = { userId: null, clientId: null, isInternal: true };
});

afterAll(async () => {
  // Exception-safe: a failure deleting client A's rows must not skip deleting client B's rows, and
  // neither failure may skip dropping the role — otherwise a single mid-test failure would leave
  // fixture rows and/or the role behind for the next run, or leave the role's backend connections
  // open for THIS run's own superuser client to hang on `drop owned by` in the next invocation.
  try {
    try {
      if (clientA) {
        await deleteClientRows(clientA);
      }
    } finally {
      if (clientB) {
        await deleteClientRows(clientB);
      }
    }
  } finally {
    try {
      // withContext's pool is not exported from @pg-eos/db (only `withContext` and `db` are — see
      // packages/db/index.ts), so it cannot be `.end()`-ed from here. Terminating the role's
      // backends via the superuser connection is what lets `drop role` below succeed even if a
      // pooled connection under that role is still technically open.
      await resetRole();
    } finally {
      try {
        // FIX 4 — the OUTERMOST finally of this hook that still has a live connection to release
        // the lock with: `pg_advisory_unlock` is a query, so it must run BEFORE `superuser.end()`
        // closes the very connection that holds the lock — it cannot be the textually last
        // statement in this hook (that is the env-var restore below, which touches no connection
        // at all). Wrapped in its own try/finally so a failure here still lets `superuser.end()`
        // and the env restore run; and even if THIS statement itself never runs (e.g. the process
        // is killed first), Postgres auto-releases a session-level advisory lock the moment its
        // holding connection ends — see the ADVISORY_LOCK_NAME comment above for that backstop.
        await superuser.query('select pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_NAME]);
      } finally {
        try {
          await superuser.end();
        } finally {
          // Restore process.env to what it was before this file mutated it (see FINDING G, header
          // comment near ORIGINAL_PGUSER/ORIGINAL_PGPASSWORD above). vitest reuses one worker
          // process per package, so `process.env` survives module-registry isolation between spec
          // files — a second file added later to this package must not inherit PGUSER pointed at a
          // role this afterAll just dropped. `delete` rather than assigning `undefined`, because
          // `process.env[key] = undefined` coerces to the literal string "undefined" in Node, which
          // would be worse than never having mutated it.
          if (ORIGINAL_PGUSER === undefined) {
            delete process.env['PGUSER'];
          } else {
            process.env['PGUSER'] = ORIGINAL_PGUSER;
          }
          if (ORIGINAL_PGPASSWORD === undefined) {
            delete process.env['PGPASSWORD'];
          } else {
            process.env['PGPASSWORD'] = ORIGINAL_PGPASSWORD;
          }
          if (ORIGINAL_PG_APP_USER === undefined) {
            delete process.env['PG_APP_USER'];
          } else {
            process.env['PG_APP_USER'] = ORIGINAL_PG_APP_USER;
          }
        }
      }
    }
  }
});

describe('Guard-of-the-guard — RLS has teeth for this session (must pass before anything else means anything)', () => {
  it('current_user is the test role, and neither usesuper nor rolbypassrls is true for it', async () => {
    // A `type` alias, not an `interface` — deliberately: `tx.execute<TRow>()` constrains TRow to
    // `Record<string, unknown>`, and only object *type* literals get TypeScript's implicit
    // index-signature comparability against that constraint; a same-shaped `interface` does not
    // and fails TS2344 here.
    type WhoAmIRow = {
      readonly whoami: string;
      readonly is_super: boolean;
      readonly bypass_rls: boolean;
    };

    const result = await withContext(ctxInternal, (tx) =>
      tx.execute<WhoAmIRow>(sql`
        select
          current_user as whoami,
          (select usesuper from pg_user where usename = current_user) as is_super,
          (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls
      `),
    );
    const row = firstRow(result, 'whoami / pg_user.usesuper / pg_roles.rolbypassrls query');

    expect(row.whoami).toBe(ROLE);
    expect(row.is_super).toBe(false);
    expect(row.bypass_rls).toBe(false);
  });
});

describe('G7 — every operational table in the fourteen business schemas has RLS enabled', () => {
  // SCR-RLS-02 Option B (docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md §5):
  // widens G7's own query from `t.relkind = 'r'` to `t.relkind in ('r','p')` — everything else is
  // unchanged, verbatim against what the Master is putting in database/schema/guards.sql. G7's
  // ORIGINAL `relkind = 'r'` filter made a partitioned PARENT (relkind 'p') invisible to the guard,
  // which is exactly how `platform.audit_log` — RLS disabled, zero policies on the parent itself —
  // passed G7 = 0 while every read through it bypassed all five leaf partitions' policies (SCR-RLS-
  // 02 §1-§3). Before migration 0003 (D-002) applied Option A, `platform.audit_log` (relkind 'p')
  // had relrowsecurity = false and appeared in this widened query's result, where the narrower
  // `relkind = 'r'` query never saw it at all. Since 0003, the parent itself carries RLS and an
  // entity_scope policy (proved directly below and in the SCR-RLS-02 (c) describe block at the end
  // of this file), so this query is expected to return zero rows on an ordinary, healthy database.
  it("the G7 query (SCR-RLS-02 Option B: relkind in ('r','p') — database/schema/guards.sql, doc 40 Part F row G7) returns zero rows", async () => {
    const result = await withContext(ctxInternal, (tx) =>
      tx.execute(sql`
        select 'G7' as guard, n.nspname as schema_name, t.relname as table_name
        from pg_class t
        join pg_namespace n on n.oid = t.relnamespace
        where t.relkind in ('r','p')
          and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc',
                            'billing','hr','partners','admin','housing','imile','governance')
          and not t.relrowsecurity
        order by 1, 2
      `),
    );

    expect(result.rows).toEqual([]);
  });
});

describe.each(TABLES)('positive control — %s', (table) => {
  it("client A selecting its own row by id returns exactly 1 row", async () => {
    const result = await selectById(ctxA, table, rowIdFor(clientA, table));
    expect(result.rows).toHaveLength(1);
  });
});

describe.each(TABLES)('ID tampering — %s (doc 40 Part F G14)', (table) => {
  it("client A substituting client B's id returns zero rows, and the query does not throw", async () => {
    let thrown: unknown = null;
    let result: QueryResult<{ id: string }> | undefined;

    try {
      result = await selectById(ctxA, table, rowIdFor(clientB, table));
    } catch (error) {
      thrown = error;
    }

    // Both halves of the G14 pass condition, asserted together: "0 rows" alone would also be true
    // of a rejected promise whose .rows was never reached, so the resolution is checked explicitly.
    expect(thrown).toBeNull();
    expect(result?.rows).toEqual([]);
  });
});

describe('Symmetry — reversed roles, on billing.invoices and wms.skus', () => {
  it.each(['billing.invoices', 'wms.skus'] as const)(
    "client B selecting client A's row from %s by id returns zero rows, with no error",
    async (table) => {
      let thrown: unknown = null;
      let result: QueryResult<{ id: string }> | undefined;

      try {
        result = await selectById(ctxB, table, rowIdFor(clientA, table));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeNull();
      expect(result?.rows).toEqual([]);
    },
  );

  it.each(['billing.invoices', 'wms.skus'] as const)(
    "client B's own positive control on %s still returns exactly 1 row (order is not the reason)",
    async (table) => {
      const result = await selectById(ctxB, table, rowIdFor(clientB, table));
      expect(result.rows).toHaveLength(1);
    },
  );
});

describe('entity_scope does not leak the client boundary', () => {
  it("platform.allowed_entities() is empty inside client A's portal context, so the entity_scope OR-leg is always false for this user", async () => {
    // wms.outbound_orders, tms.delivery_tasks and billing.invoices each carry an entity_scope
    // policy (FOR ALL, permissive) in addition to client_portal_scope (FOR SELECT, permissive) —
    // database/schema/01-Data-Model.sql:1445-1479. Permissive policies are OR-ed together. Before
    // migration 0003 (D-002), entity_scope's predicate was `entity_id = any(allowed_entities())`
    // alone, with no gate on platform.is_internal() — so a client A user who held ANY
    // identity.user_entities row would have had entity_scope grant visibility into rows
    // client_portal_scope alone would deny, silently defeating client isolation for any user who
    // was both a portal user and held entity access (this is SCR-RLS-01, reproduced and fixed by
    // Option B — see the describe blocks below). Since 0003, entity_scope also requires
    // platform.is_internal(), so that OR-leg is now structurally inert for every portal user
    // (is_internal() = false) regardless of identity.user_entities membership — proved directly by
    // the SCR-RLS-01 dual-role-user block below, which deliberately grants ctxA's user real entity
    // access to show Option B holds even then. This scenario's own ctxA.userId is null (never
    // linked in identity.user_entities either way), which is a SEPARATE, narrower reason the OR-leg
    // is inert for these specific contexts — this assertion proves that narrower fact holds for the
    // contexts every assertion above this line relies on, not just assumed.
    const result = await withContext(ctxA, (tx) =>
      tx.execute<{ allowed: readonly string[] }>(
        sql`select platform.allowed_entities() as allowed`,
      ),
    );

    expect(firstRow(result, "platform.allowed_entities() call inside client A's portal context").allowed).toEqual(
      [],
    );
  });
});

describe('An internal context is not "deny all" — it discriminates on client identity', () => {
  // SCR-RLS-03 (docs/notes/SCR-RLS-03-client-portal-scope-internal-bypass.md, D-181, migration
  // 0025_M_client-portal-scope-internal-bypass.sql) — Master ruling: this scenario's assertion is
  // unchanged (an internal user DOES see both clients' rows), but its fixture was wrong. The shared
  // `ctxInternal` used elsewhere in this file has `userId: null`, so `platform.allowed_entities()`
  // was always empty for it — the "sees both" result before 0025 came ONLY from
  // client_portal_scope's `is_internal()` OR-leg (the exact SCR-RLS-03 hole), not from any genuine
  // entity access, and 0025 closes that leg for internal sessions. Fixed here with a REAL
  // identity.users row (user_type = 'internal') holding identity.user_entities access to
  // `entities.invoiceEntityId` (PCC) — the same entity BOTH client A's and client B's
  // billing.invoices rows were seeded against (`seedClient`, above), so entity_scope's own
  // `entity_id = any(allowed_entities())` leg now legitimately covers both rows for this user. Same
  // idiom as the entity-A user in tests/isolation/tests/app-role-rls.test.ts and this file's own
  // "positive control — an internal user with real entity access" fixture above.
  const internalUserEmail = `rls-isolation-test-internal-deny-all-${randomUUID()}@example.invalid`;
  let internalUserId: string | undefined;

  beforeAll(async () => {
    const user = await superuser.query<{ id: string }>(
      `insert into identity.users (email, full_name_ar, user_type) values ($1, $2, 'internal') returning id`,
      [internalUserEmail, 'مستخدم اختبار داخلي بصلاحية كيان (ليس رفض كل شيء)'],
    );
    internalUserId = firstRow(
      user,
      'insert identity.users fixture for the "not deny all" internal-context test',
    ).id;

    await superuser.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [
      internalUserId,
      entities.invoiceEntityId,
    ]);
  });

  afterAll(async () => {
    if (internalUserId) {
      await superuser.query('delete from identity.user_entities where user_id = $1', [internalUserId]);
      await superuser.query('delete from identity.users where id = $1', [internalUserId]);
    }
  });

  it('an internal context sees both billing.invoices rows for client A and client B', async () => {
    if (!internalUserId) {
      throw new Error('internalUserId was not seeded — beforeAll must have failed');
    }
    const ctx: WithContextCtx = { userId: internalUserId, clientId: null, isInternal: true };

    const result = await withContext(ctx, (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from billing.invoices where id in (${rowIdFor(clientA, 'billing.invoices')}, ${rowIdFor(clientB, 'billing.invoices')})`,
      ),
    );

    const ids = result.rows.map((row) => row.id).sort();
    expect(ids).toEqual(
      [rowIdFor(clientA, 'billing.invoices'), rowIdFor(clientB, 'billing.invoices')].sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SCR-RLS-01 — entity_scope OR-defeated client_portal_scope for a dual-role user
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Full write-up, options and reproduction SQL: docs/notes/SCR-RLS-01-entity-scope-defeats-client-
// isolation.md. Read that file first — this comment only summarizes it.
//
// STATUS: GM/system-owner APPROVED Options B + C (docs/notes/SCR-RLS-01-...md §4, recorded as D-002
// in docs/DECISION_LOG.md). Migration `database/migrations/0003_M_rls-scr-01-02.sql` applied Options
// B + C on 2026-09-23 and IS applied to this database — this block is now an ordinary requirement
// suite, not a known-defect pin:
//   - Option B: `entity_scope` on the seven affected tables is now
//     `for all using (platform.is_internal() and entity_id = any(platform.allowed_entities()))` —
//     the permissive OR-leg is inert for every portal user (`is_internal() = false`), independent of
//     whether that user holds an identity.user_entities row at all. Verified live against pg_policy
//     for all seven tables in the "SCR-RLS-01 Option B — policy shape proof" block below.
//   - Option C: trigger function `identity.enforce_client_users_hold_no_entities()` makes a
//     `user_type = 'client'` row and an `identity.user_entities` row for that user mutually
//     exclusive at the database level (see the "SCR-RLS-01 Option C" describe block below).
//
// Every assertion ABOVE this block deliberately used a portal context whose userId was `null` (see
// the "entity_scope does not leak" describe block), so `platform.allowed_entities()` was guaranteed
// empty and the entity_scope permissive leg was inert. That was NOT a loophole in this suite — it
// is the honest boundary of what the schema guaranteed before this SCR. This block removes that
// precondition: it seeds a REAL identity.users portal row for client A that ALSO holds an
// identity.user_entities row for the SAME entities as the seeded rows below, to prove Option B holds
// on its own merits — EVEN IF Option C's trigger were somehow bypassed — not merely because C now
// makes the dual role impossible to construct through the front door. See "WHY THE FIXTURE BYPASSES
// TRIGGERS", below, for how the dual-role user is still constructed even with C in place.
//
// SCOPE — three of the seven affected tables get BEHAVIORAL coverage (review round 3,
// Master-verified against live pg_policy): the Master confirmed the same permissive
// `allowed_entities()` OR permissive `current_client_id()` composition — before 0003 — on ALL of
// billing.invoices · tms.delivery_tasks · wms.outbound_orders · wms.occupancy_snapshots ·
// wms.space_allocations · wms.space_reservations · wms.work_orders. Only the first three already
// have seeded fixture rows and a SELECT_BY_ID builder in this file (TABLES, above) —
// SCR_RLS_01_TABLES below runs both behavioral tests in this block against exactly those three. The
// remaining four (wms.occupancy_snapshots, wms.space_allocations, wms.space_reservations,
// wms.work_orders) are outside this slice's fixture surface (their own required-column shapes were
// never verified against the live schema for this brief) and adding invented fixtures for them would
// violate CLAUDE.md · AGENT CONSTRAINTS ("never fabricate a number, name, or decision") — but all
// seven, including these four, get SHAPE coverage (no fixture rows needed) from the
// "SCR-RLS-01 Option B — policy shape proof" describe.each block immediately below, which proves via
// pg_policy that Option B's exact predicate landed on every one of the seven, not just the three this
// file seeds behavioral fixtures for.
//
// Each table's fixture row was seeded (seedClient, above) against a specific entity — outbound
// orders against PST, delivery tasks against PDL, invoices against PCC — so the dual-role user
// below is granted identity.user_entities access to all three entities, putting entity_scope's OR
// leg in play for all three tables, not only billing.invoices.
//
// The requirement below is the SAME, unmodified assertion as every positive G14 case above
// (`expect(result.rows).toEqual([])`) — no longer wrapped in `it.fails`. It is green since migration
// 0003 applied Option B on 2026-09-23, with no test change made on that day.

/**
 * All seven tables migration 0003 (D-002, SCR-RLS-01 Option B) rewrote `entity_scope` on — see the
 * SCOPE paragraph above for which three of these also get behavioral fixture coverage. This block
 * proves the policy SHAPE for all seven directly against pg_policy, via the superuser client, with
 * no fixture rows — the same technique this file already uses for platform.audit_log (last describe
 * block below). polqual strings below are quoted verbatim from a live `pg_get_expr(polqual,
 * polrelid)` read against the applied migration, not invented.
 */
const SCR_RLS_01_ALL_SEVEN_TABLES = [
  'billing.invoices',
  'tms.delivery_tasks',
  'wms.outbound_orders',
  'wms.occupancy_snapshots',
  'wms.space_allocations',
  'wms.space_reservations',
  'wms.work_orders',
] as const;

interface PolicyShapeRow {
  readonly polpermissive: boolean;
  readonly cmd: string;
  readonly qual: string;
}

describe.each(SCR_RLS_01_ALL_SEVEN_TABLES)(
  'SCR-RLS-01 Option B — policy shape proof (no fixture rows) — %s',
  (table) => {
    it('entity_scope is permissive, FOR ALL, with exactly the Option B predicate', async () => {
      const result = await superuser.query<PolicyShapeRow>(
        `select polpermissive, polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
           from pg_policy
          where polrelid = $1::regclass and polname = 'entity_scope'`,
        [table],
      );

      expect(result.rows).toHaveLength(1);
      const row = firstRow(result, `pg_policy entity_scope shape lookup for ${table}`);
      expect(row.polpermissive).toBe(true);
      expect(row.cmd).toBe('*');
      expect(row.qual).toBe(
        '(platform.is_internal() AND (entity_id = ANY (platform.allowed_entities())))',
      );
    });

    // SCR-RLS-03 (docs/notes/SCR-RLS-03-client-portal-scope-internal-bypass.md, D-181, migration
    // 0025_M_client-portal-scope-internal-bypass.sql): the OLD predicate below
    // (`is_internal() OR client_id = current_client_id()`) is exactly the composition hole SCR-RLS-03
    // reproduced — permissive policies OR together, so `is_internal()` alone satisfied
    // client_portal_scope for SELECT and entity_scope's own entity restriction was never consulted
    // for reads. Migration 0025 rewrites exactly these seven tables' client_portal_scope to
    // `NOT platform.is_internal() AND client_id = platform.current_client_id()` (the mirror of Option
    // B), so the two policies address disjoint populations for BOTH commands, not only INSERT/UPDATE.
    // This test now proves that shape, not the old (already wrong) "untouched by Option B" claim.
    it('client_portal_scope excludes internal sessions — SCR-RLS-03', async () => {
      const result = await superuser.query<PolicyShapeRow>(
        `select polpermissive, polcmd::text as cmd, pg_get_expr(polqual, polrelid) as qual
           from pg_policy
          where polrelid = $1::regclass and polname = 'client_portal_scope'`,
        [table],
      );

      expect(result.rows).toHaveLength(1);
      const row = firstRow(result, `pg_policy client_portal_scope shape lookup for ${table}`);
      expect(row.polpermissive).toBe(true);
      expect(row.cmd).toBe('r');
      expect(row.qual).toBe(
        '((NOT platform.is_internal()) AND (client_id = platform.current_client_id()))',
      );
    });
  },
);

describe("SCR-RLS-01 — entity_scope must not OR-defeat client_portal_scope for a dual-role user", () => {
  // Three of the seven affected tables — see the SCOPE paragraph in the header comment above for
  // why exactly these three and not all seven.
  const SCR_RLS_01_TABLES = ['billing.invoices', 'tms.delivery_tasks', 'wms.outbound_orders'] as const;

  // Prefixed the same way as every other fixture row in this file (see sweepLeftoverFixtureRows),
  // so an interrupted run's leftover user/user_entities rows are found and removed by prefix on the
  // NEXT run, and suffixed with randomUUID() so concurrent/repeated runs never collide.
  const dualRoleUserEmail = `rls-isolation-test-dual-role-${randomUUID()}@example.invalid`;
  let dualRoleUserId: string | undefined;

  // A SEPARATE, legitimately-constructed internal user for the Option B positive control (b) below
  // — `user_type = 'internal'` holding a genuine identity.user_entities row, exactly the shape
  // Option C continues to permit. No session_replication_role bypass needed for this one.
  const internalUserEmail = `rls-isolation-test-internal-${randomUUID()}@example.invalid`;
  let internalUserId: string | undefined;

  beforeAll(async () => {
    // Live columns of identity.users (verified 2026-09-23, per the brief this review round quotes):
    // id, email (not null), full_name_ar (not null), full_name_en, phone, employee_id, user_type
    // (not null, default 'internal'), client_id, is_active (not null, default true), last_login_at,
    // created_at. user_type = 'client' + client_id = client A's account id is exactly the shape a
    // real client-portal user would have.
    const user = await superuser.query<{ id: string }>(
      `insert into identity.users (email, full_name_ar, user_type, client_id)
       values ($1, $2, 'client', $3) returning id`,
      [dualRoleUserEmail, 'مستخدم اختبار SCR-RLS-01 (دور مزدوج)', clientA.clientId],
    );
    dualRoleUserId = firstRow(user, 'insert identity.users dual-role SCR-RLS-01 fixture').id;

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // WHY THE FIXTURE BYPASSES TRIGGERS FOR THIS INSERT ONLY
    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Once Option C's trigger (`user_entities_reject_client_user`, BEFORE INSERT OR UPDATE OF
    // user_id ON identity.user_entities), created by migration 0003 (D-002) and live on this
    // database since 2026-09-23, a PLAIN insert of a user_entities row for a `user_type = 'client'`
    // user — exactly what this fixture needs — is itself REJECTED (SQLSTATE 23514; see the
    // "SCR-RLS-01 Option C" describe block below, which asserts exactly that rejection). But the
    // requirement under test here is Option B, and it must hold independently of Option C — "even if
    // C were bypassed" — not merely because C makes the dual role unconstructable through the front
    // door. `session_replication_role = replica` disables ORIGIN-mode triggers (both this one and,
    // incidentally, FK constraint triggers) for the duration of this session; it does not, and
    // cannot, disable RLS itself, which is exactly what Option B is under test. The referenced ids
    // (dualRoleUserId, each entityId) are real, already-inserted rows either way, so the FK trigger's
    // absence changes nothing about the data's validity — only the now-existing enforcement trigger
    // is being deliberately bypassed here, as the fixture-construction mechanism. Wrapped in
    // try/finally so a failure mid-loop can never leave this superuser SESSION (shared by every other
    // query in this file via `superuser`) permanently in replica mode.
    await superuser.query('set session_replication_role = replica');
    try {
      // The SAME three entities the fixture rows in SCR_RLS_01_TABLES were seeded against
      // (entities.invoiceEntityId/PCC, entities.deliveryTaskEntityId/PDL,
      // entities.outboundOrderEntityId/PST — resolved once in the top-level beforeAll) — this is
      // what makes platform.allowed_entities() non-empty for this user for all three tables under
      // test, so the entity_scope OR-leg is in play for each of them, not only billing.invoices.
      for (const entityId of [
        entities.invoiceEntityId,
        entities.deliveryTaskEntityId,
        entities.outboundOrderEntityId,
      ]) {
        await superuser.query(
          `insert into identity.user_entities (user_id, entity_id) values ($1, $2)`,
          [dualRoleUserId, entityId],
        );
      }
    } finally {
      await superuser.query('set session_replication_role = origin');
    }

    // Positive control (b) fixture — a LEGITIMATE internal user + user_entities row, no bypass.
    const internalUser = await superuser.query<{ id: string }>(
      `insert into identity.users (email, full_name_ar, user_type) values ($1, $2, 'internal') returning id`,
      [internalUserEmail, 'مستخدم اختبار SCR-RLS-01 (داخلي بصلاحية كيان)'],
    );
    internalUserId = firstRow(
      internalUser,
      'insert identity.users internal SCR-RLS-01 positive-control fixture',
    ).id;
    await superuser.query(
      `insert into identity.user_entities (user_id, entity_id) values ($1, $2)`,
      [internalUserId, entities.invoiceEntityId],
    );
  });

  afterAll(async () => {
    // user_entities first, then users — FK order, and idempotent/safe even if beforeAll partially
    // failed (mirrors deleteClientRows's own ordering comment above).
    try {
      if (dualRoleUserId) {
        await superuser.query('delete from identity.user_entities where user_id = $1', [dualRoleUserId]);
        await superuser.query('delete from identity.users where id = $1', [dualRoleUserId]);
      }
    } finally {
      if (internalUserId) {
        await superuser.query('delete from identity.user_entities where user_id = $1', [internalUserId]);
        await superuser.query('delete from identity.users where id = $1', [internalUserId]);
      }
    }
  });

  function dualRoleCtx(): WithContextCtx {
    if (!dualRoleUserId) {
      throw new Error('dualRoleUserId was not seeded — beforeAll must have failed');
    }
    return { userId: dualRoleUserId, clientId: clientA.clientId, isInternal: false };
  }

  describe.each(SCR_RLS_01_TABLES)('%s', (table) => {
    it(
      `client A's portal user, who ALSO holds identity.user_entities access to this row's entity, gets zero rows from client B's row on direct ID substitution`,
      async () => {
        const result = await selectById(dualRoleCtx(), table, rowIdFor(clientB, table));

        expect(result.rows).toEqual([]);
      },
    );

    // Positive control (a) — client_portal_scope leg must still work for the dual-role user's OWN
    // client's row, both before and after migration 0003: Option B only narrows entity_scope's
    // OR-leg, it does not touch client_portal_scope at all.
    it(
      `the dual-role user's OWN client-A row in this table still returns exactly 1 row (client_portal_scope leg is unaffected by Option B)`,
      async () => {
        const result = await selectById(dualRoleCtx(), table, rowIdFor(clientA, table));

        expect(result.rows).toHaveLength(1);
      },
    );
  });

  // Positive control (b) — an INTERNAL user with real entity access must still see across clients
  // via entity_scope, both before and after migration 0003: Option B only ADDS
  // `platform.is_internal()` to entity_scope's predicate; it does not remove `entity_id = any(...)`,
  // and this user genuinely has `is_internal = true`.
  describe('positive control — an internal user with real entity access (entity_scope leg)', () => {
    it("selects client B's billing.invoices row by id and gets exactly 1 row", async () => {
      if (!internalUserId) {
        throw new Error('internalUserId was not seeded — beforeAll must have failed');
      }
      const ctx: WithContextCtx = { userId: internalUserId, clientId: null, isInternal: true };

      const result = await selectById(ctx, 'billing.invoices', rowIdFor(clientB, 'billing.invoices'));

      expect(result.rows).toHaveLength(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SCR-RLS-01 Option C — client users cannot hold entity access
// ─────────────────────────────────────────────────────────────────────────────────────────────
// docs/notes/SCR-RLS-01-entity-scope-defeats-client-isolation.md §4, Option C: a trigger making
// `user_type = 'client'` and an `identity.user_entities` row for that user mutually exclusive.
// Migration 0003 (D-002) created `identity.enforce_client_users_hold_no_entities()` and its two
// triggers (`user_entities_reject_client_user` / `users_reject_client_with_entities`) on this
// database on 2026-09-23; both inserts/updates below are now rejected, as asserted.
describe('SCR-RLS-01 Option C — identity.enforce_client_users_hold_no_entities()', () => {
  it("inserting identity.user_entities for a user with user_type = 'client' is rejected with SQLSTATE 23514 (check_violation)", async () => {
    const email = `rls-isolation-test-optionc-insert-${randomUUID()}@example.invalid`;
    const user = await superuser.query<{ id: string }>(
      `insert into identity.users (email, full_name_ar, user_type, client_id)
       values ($1, $2, 'client', $3) returning id`,
      [email, 'مستخدم اختبار SCR-RLS-01 Option C (إدراج)', clientA.clientId],
    );
    const userId = firstRow(user, 'insert identity.users Option C insert-path fixture').id;

    try {
      let thrown: unknown = null;
      try {
        await superuser.query(
          `insert into identity.user_entities (user_id, entity_id) values ($1, $2)`,
          [userId, entities.invoiceEntityId],
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).not.toBeNull();
      expect(sqlStateOf(thrown)).toBe(CHECK_VIOLATION_SQLSTATE);
    } finally {
      // Idempotent/safe whether or not the insert above actually took (today, RED, it does) — see
      // deleteClientRows's own comment above for the same pattern.
      await superuser.query('delete from identity.user_entities where user_id = $1', [userId]);
      await superuser.query('delete from identity.users where id = $1', [userId]);
    }
  });

  it("updating a user who holds a user_entities row to user_type = 'client' is rejected with SQLSTATE 23514 (check_violation)", async () => {
    const email = `rls-isolation-test-optionc-update-${randomUUID()}@example.invalid`;
    const user = await superuser.query<{ id: string }>(
      `insert into identity.users (email, full_name_ar, user_type, client_id)
       values ($1, $2, 'internal', $3) returning id`,
      [email, 'مستخدم اختبار SCR-RLS-01 Option C (تحديث)', clientA.clientId],
    );
    const userId = firstRow(user, 'insert identity.users Option C update-path fixture').id;

    try {
      // Legitimate while user_type is still 'internal' — Option C's trigger only rejects a
      // user_entities row for a user whose user_type is ALREADY 'client' at insert time.
      await superuser.query(
        `insert into identity.user_entities (user_id, entity_id) values ($1, $2)`,
        [userId, entities.invoiceEntityId],
      );

      let thrown: unknown = null;
      try {
        await superuser.query(`update identity.users set user_type = 'client' where id = $1`, [userId]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).not.toBeNull();
      expect(sqlStateOf(thrown)).toBe(CHECK_VIOLATION_SQLSTATE);
    } finally {
      await superuser.query('delete from identity.user_entities where user_id = $1', [userId]);
      await superuser.query('delete from identity.users where id = $1', [userId]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SCR-RLS-02 — platform.audit_log's partitioned parent has no RLS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md. The G7 test above already
// covers Option B (the widened guard query itself). This block covers Options A (RLS + policy on
// the parent) and the read-bypass Option A closes. Before migration 0003 (D-002), the parent had
// `relrowsecurity = false` and zero policies of its own, so every read through it was unfiltered.
// Since 0003 (applied 2026-09-23), the parent carries RLS and an entity_scope policy — proved
// directly by the assertions below.
describe('SCR-RLS-02 — platform.audit_log partitioned parent has RLS (Option A, migration 0003) and reads through it are scoped', () => {
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // WHY THIS BLOCK SEEDS ITS OWN AUDIT ROW
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // The vacuity guard inside the test below (`preconditionCount < 1`) used to be satisfied only by
  // ACCIDENT — by rows left behind by modules/platform/tests/integration/schema-invariants.test.ts
  // (WBS 0.9) from a PREVIOUS run against the same database. Nothing in the schema writes audit
  // rows automatically: the only audit-log trigger is `trg_audit_hash_chain` (BEFORE INSERT on
  // platform.audit_log and its partitions, database/schema/13B-Schema-Reference-Consolidation.sql:
  // 260-261), which stamps prev_hash/row_hash on a row already being inserted — nothing calls it on
  // its own. On a FRESH database (`apply.sh --recreate`, then a single run of this suite, no other
  // suite ever having run), this suite's own seeding produces zero rows with entity_id is not null,
  // so the vacuity guard threw and the whole test failed for a reason that had nothing to do with
  // RLS: the test was silently order-dependent on database HISTORY, not on the schema under test.
  //
  // Fixed by seeding ONE audited row through the superuser client here, scoped to this describe
  // block only. Same column list and shape as modules/platform/tests/integration/schema-invariants
  // .test.ts:97-102 (this repo's own precedent for a hand-inserted platform.audit_log row) — only
  // `table_name` differs ('_rls_isolation_fixture', not that other suite's '_test_fixture'), so this
  // row is unambiguously identifiable as this suite's own fixture data, and `entity_id` is
  // `entities.invoiceEntityId` (PCC — resolved once, top-level beforeAll) so it satisfies the exact
  // predicate (`entity_id is not null`) the test below queries. The vacuity guard itself is left
  // exactly as it was — it is now guaranteed to pass, and stays in place as a regression guard for
  // the day this insert silently stops working.
  // `occurred_at` is captured as TEXT (`::text`), not as node-postgres's parsed `Date`, and
  // compared back with an explicit `::timestamptz` cast in the teardown query below — not out of
  // caution, but because the `Date` round-trip is provably lossy here: `platform.audit_log.
  // occurred_at` is `timestamptz` (microsecond precision — confirmed live: e.g.
  // `2026-09-23 03:12:51.999516+03`), while JS `Date` only carries millisecond precision. Reading
  // the column back as a `Date` and feeding it straight into `occurred_at = $2` in the delete below
  // silently truncated the fractional seconds, so the WHERE clause's equality leg never matched the
  // real row and every run's supposedly chain-safe tail delete quietly deleted 0 rows — confirmed by
  // running the suite three times against a fresh database and finding all three fixture rows still
  // present afterwards. Casting to `text` at the SQL boundary preserves the value Postgres itself
  // printed, so the round-trip back through `::timestamptz` reconstructs the identical instant.
  let fixtureRowId: string | undefined;
  let fixtureOccurredAt: string | undefined;

  beforeAll(async () => {
    const inserted = await superuser.query<{ id: string; occurred_at: string }>(
      `insert into platform.audit_log
         (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation)
       values (now(), null, 'system', $1, 'platform', '_rls_isolation_fixture', $2, 'insert')
       returning id, occurred_at::text as occurred_at`,
      [entities.invoiceEntityId, randomUUID()],
    );
    const row = firstRow(inserted, 'insert platform.audit_log SCR-RLS-02 fixture row');
    fixtureRowId = row.id;
    fixtureOccurredAt = row.occurred_at;
  });

  afterAll(async () => {
    if (!fixtureRowId || !fixtureOccurredAt) {
      // beforeAll itself must have failed — nothing to clean up.
      return;
    }
    // Chain-safe teardown only. `platform.verify_audit_chain()` (G8) orders by `chain_seq` (the
    // gapless counter the trigger assigns under the advisory lock — SCR-AUDIT-01 §7.1) and checks
    // each row's prev_hash against the PREVIOUS row's row_hash, and reports any chain_seq gap —
    // deleting the TAIL row is chain-safe (the next writer reuses its number), deleting a MIDDLE
    // row leaves a gap and breaks the next row's prev_hash link. Delete this fixture row only if it
    // is STILL the tail (no row with a strictly greater chain_seq exists). If some other row was
    // appended after it before teardown ran (a concurrent process, or another test inserting more
    // audit rows), 0 rows are deleted here ON PURPOSE and the fixture row is left in place — it is
    // a validly chained row, clearly marked as fixture data via `table_name =
    // '_rls_isolation_fixture'`. Deliberately NOT added to sweepLeftoverFixtureRows (see that
    // function's own scope comment): a prefix sweep against platform.audit_log could delete a
    // MIDDLE row on some later run and break G8, which this targeted tail-only delete cannot.
    //
    // ONE transaction on a DEDICATED client, holding the trigger's own advisory lock (SCR-AUDIT-01
    // §7.1, pg-reviewer finding 12): `begin; select pg_advisory_xact_lock(hashtext(
    // 'platform.audit_log')); delete … ; commit;`. platform.audit_hash_chain() takes the same
    // transaction-scoped lock before it reads the chain head, so while this transaction holds it no
    // concurrent writer can read this fixture row as the head (and chain onto it) between the
    // tail check and the delete; a writer that was already waiting reads the head only after this
    // commit, when the row is gone. The lock is released by commit/rollback, never held across
    // statements outside this block. A dedicated client, not `superuser`, so the transaction never
    // shares a session with the suite-wide session-level advisory lock or any other fixture query.
    // Rollback on any error (so the lock and the aborted transaction never outlive this hook), and
    // the client is always closed.
    const AUDIT_CHAIN_LOCK_KEY = 'platform.audit_log';
    const teardownClient = new Client(SUPERUSER_CONNECTION);
    await teardownClient.connect();
    try {
      await teardownClient.query('begin');
      await teardownClient.query('select pg_advisory_xact_lock(hashtext($1))', [
        AUDIT_CHAIN_LOCK_KEY,
      ]);
      await teardownClient.query(
        `delete from platform.audit_log
          where id = $1 and occurred_at = $2::timestamptz
            and not exists (
              select 1 from platform.audit_log a
              where a.chain_seq > (
                select chain_seq from platform.audit_log where id = $1 and occurred_at = $2::timestamptz
              )
            )`,
        [fixtureRowId, fixtureOccurredAt],
      );
      await teardownClient.query('commit');
    } catch (error: unknown) {
      // The original error is the one reported. A rollback that itself fails is not re-raised over
      // it: closing the connection below aborts the transaction (and releases the lock) server-side.
      await teardownClient.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await teardownClient.end();
    }
  });

  it("a portal context with no entity access reads zero platform.audit_log rows with entity_id is not null, and the query does not throw", async () => {
    // Vacuity guard: if the table happens to hold no row with entity_id is not null, the assertion
    // below would pass trivially and prove nothing. Thrown, not asserted, so the failure names
    // exactly what is missing rather than reporting a misleading "0 === 0" pass. Guaranteed to pass
    // now by this block's own beforeAll seeding (see the header comment above) — kept as a
    // regression guard, not removed.
    const precondition = await superuser.query<{ n: string }>(
      `select count(*)::text as n from platform.audit_log where entity_id is not null`,
    );
    const preconditionCount = Number(
      firstRow(precondition, 'platform.audit_log precondition count (entity_id is not null)').n,
    );
    if (preconditionCount < 1) {
      throw new Error(
        'vacuity guard: platform.audit_log has zero rows with entity_id is not null — the bypass assertion below would pass trivially',
      );
    }

    let thrown: unknown = null;
    let result: QueryResult<{ n: number }> | undefined;
    try {
      result = await withContext(ctxA, (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from platform.audit_log where entity_id is not null`,
        ),
      );
    } catch (error) {
      thrown = error;
    }

    // Both halves, exactly like the G14 tampering cases above: "0" alone would also be true of a
    // rejected promise whose .rows was never reached.
    expect(thrown).toBeNull();
    expect(result ? firstRow(result, "platform.audit_log count inside client A's portal context").n : undefined).toBe(0);

    // Proves this block's own fixture insert (beforeAll, above) chained correctly and did not
    // corrupt G8 — via the superuser client, which bypasses RLS (irrelevant here: G8 checks the
    // hash chain, not row visibility).
    const chainCheck = await superuser.query('select * from platform.verify_audit_chain()');
    expect(chainCheck.rows).toEqual([]);
  });

  it('platform.audit_log has row security enabled and carries an entity_scope policy (SCR-RLS-02 Option A)', async () => {
    const result = await superuser.query<{ relrowsecurity: boolean; policy_count: string }>(
      `select c.relrowsecurity,
              (select count(*) from pg_policy p
                where p.polrelid = c.oid and p.polname = 'entity_scope')::text as policy_count
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'platform' and c.relname = 'audit_log'`,
    );
    const row = firstRow(result, 'pg_class/pg_policy lookup for platform.audit_log');

    expect(row.relrowsecurity).toBe(true);
    expect(Number(row.policy_count)).toBeGreaterThanOrEqual(1);
  });
});
