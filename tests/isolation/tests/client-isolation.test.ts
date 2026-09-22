// tests/isolation/tests/client-isolation.test.ts — WBS 0.18 (pg-tester).
//
// Proves the executable half of tests/isolation/client-isolation.feature: doc 40 Part F row G7
// ("every operational table in the fourteen business schemas has RLS enabled" — 0 rows) and row
// G14 ("client A requests client B's ids directly" — 0 rows, no error). Runner name is fixed by
// doc 40 Part F: `pnpm test:isolation`. RLS itself (the policies under test) is ALREADY DELIVERED
// in database/schema/01-Data-Model.sql:1433-1486 — nothing here is schema; this file is the
// permanent, re-runnable proof that those policies hold against a live Postgres instance, in the
// same spirit as modules/platform/tests/integration/schema-invariants.test.ts.
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
  it('the G7 query (database/schema/guards.sql:80-88 / doc 40 Part F row G7) returns zero rows', async () => {
    const result = await withContext(ctxInternal, (tx) =>
      tx.execute(sql`
        select 'G7' as guard, n.nspname as schema_name, t.relname as table_name
        from pg_class t
        join pg_namespace n on n.oid = t.relnamespace
        where t.relkind = 'r'
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
    // database/schema/01-Data-Model.sql:1445-1479. Permissive policies are OR-ed together, so if
    // client A's user held ANY identity.user_entities row, entity_scope could grant visibility into
    // rows client_portal_scope alone would deny, silently defeating client isolation for any user
    // who is both a portal user and holds internal entity access. It does not happen here because
    // ctxA.userId is null (never linked in identity.user_entities either way) — this assertion
    // proves the OR's other leg is inert for the contexts every assertion above relies on, not just
    // assumed.
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
  it('an internal context sees both billing.invoices rows for client A and client B', async () => {
    const result = await withContext(ctxInternal, (tx) =>
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
// SCR-RLS-01 — KNOWN DEFECT: entity_scope OR-defeats client_portal_scope for a dual-role user
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Full write-up, options and reproduction SQL: docs/notes/SCR-RLS-01-entity-scope-defeats-client-
// isolation.md. Read that file first — this comment only summarizes it.
//
// Every assertion ABOVE this block deliberately used a portal context whose userId was `null` (see
// the "entity_scope does not leak" describe block), so `platform.allowed_entities()` was guaranteed
// empty and the entity_scope permissive leg was inert. That was NOT a loophole in this suite — it
// is the honest boundary of what the schema currently guarantees. This block removes that
// precondition: it seeds a REAL identity.users portal row for client A that ALSO holds an
// identity.user_entities row for the SAME entities as the seeded rows below. Nothing in the schema
// forbids that combination — verified: no constraint or trigger ties identity.users.user_type =
// 'client' to the absence of identity.user_entities rows. Reproduced live against the applied
// schema (see the note): the tampering query below returns 1 row where the acceptance criterion
// (doc 38 row 0.18 / doc 40 Part F row G14 — "zero rows, no error") demands 0.
//
// SCOPE — three of the seven affected tables (review round 3, Master-verified against live
// pg_policy): the Master confirmed the same permissive `allowed_entities()` OR permissive
// `current_client_id()` composition on ALL of billing.invoices · tms.delivery_tasks ·
// wms.outbound_orders · wms.occupancy_snapshots · wms.space_allocations · wms.space_reservations ·
// wms.work_orders. Only the first three already have seeded fixture rows and a SELECT_BY_ID
// builder in this file (TABLES, above) — SCR_RLS_01_TABLES below runs both tests in this block
// against exactly those three. The remaining four (wms.occupancy_snapshots, wms.space_allocations,
// wms.space_reservations, wms.work_orders) are recorded as affected in the SCR-RLS-01 note but are
// NOT seeded here — they are outside this slice's fixture surface (their own required-column
// shapes were never verified against the live schema for this brief) and adding invented fixtures
// for them would violate CLAUDE.md · AGENT CONSTRAINTS ("never fabricate a number, name, or
// decision").
//
// Each table's fixture row was seeded (seedClient, above) against a specific entity — outbound
// orders against PST, delivery tasks against PDL, invoices against PCC — so the dual-role user
// below is granted identity.user_entities access to all three entities, putting entity_scope's OR
// leg in play for all three tables, not only billing.invoices.
//
// TWO tests per table, deliberately paired (review round 3, FIX 2 — a regression from "leaks one
// row" to "errors out" must not go on recording green forever under `it.fails` alone, since
// `it.fails` passes for ANY thrown reason, not only the pinned leak):
//   - `it.fails` states the REQUIREMENT: `expect(result.rows).toEqual([])`, unmodified from every
//     positive G14 case above. It is NOT a weakened assertion — see the paragraph below.
//   - the companion `it(...)` pins TODAY'S REALITY precisely: the query resolves WITHOUT throwing,
//     and `result.rows` is EXACTLY `[{ id: <client B's row id for that table> }]` — one row, that
//     row, nothing else. A regression to "throws" turns the companion red immediately (a thrown
//     query never reaches `.rows`); a fix to "zero rows" turns the companion red too (the row no
//     longer leaks) at the same moment `it.fails` turns red for the opposite, correct reason. The
//     two can only ever disagree in the direction of a NEW failure mode neither anticipated, which
//     is exactly when a human should look, not when a green checkmark should hide it.
//
// `it.fails` records, honestly, that the correct assertion currently does NOT hold; if it ever
// started passing (i.e. SCR-RLS-01 got fixed, most likely via the note's Option B — gating
// entity_scope on platform.is_internal()) `it.fails` itself would turn RED, because a test declared
// "expected to fail" that instead passes is exactly what `it.fails` is for catching — forcing this
// block and the SCR note to be revisited and removed, rather than silently forgotten as a green
// checkmark that means nothing. Do not mistake either test for skipped, `.only`-ed, or softened:
// both assertions are real, unmodified in kind from every positive/negative G14 case above.
describe("SCR-RLS-01 — KNOWN DEFECT: entity_scope OR-defeats client_portal_scope for a dual-role user", () => {
  // Three of the seven affected tables — see the SCOPE paragraph in the header comment above for
  // why exactly these three and not all seven.
  const SCR_RLS_01_TABLES = ['billing.invoices', 'tms.delivery_tasks', 'wms.outbound_orders'] as const;

  // Prefixed the same way as every other fixture row in this file (see sweepLeftoverFixtureRows),
  // so an interrupted run's leftover user/user_entities rows are found and removed by prefix on the
  // NEXT run, and suffixed with randomUUID() so concurrent/repeated runs never collide.
  const dualRoleUserEmail = `rls-isolation-test-dual-role-${randomUUID()}@example.invalid`;
  let dualRoleUserId: string | undefined;

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

    // The SAME three entities the fixture rows in SCR_RLS_01_TABLES were seeded against
    // (entities.invoiceEntityId/PCC, entities.deliveryTaskEntityId/PDL,
    // entities.outboundOrderEntityId/PST — resolved once in the top-level beforeAll) — this is what
    // makes platform.allowed_entities() non-empty for this user for all three tables under test, so
    // the entity_scope OR-leg is in play for each of them, not only billing.invoices.
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
  });

  afterAll(async () => {
    // user_entities first, then users — FK order, and idempotent/safe even if beforeAll partially
    // failed (mirrors deleteClientRows's own ordering comment above).
    if (dualRoleUserId) {
      await superuser.query('delete from identity.user_entities where user_id = $1', [dualRoleUserId]);
      await superuser.query('delete from identity.users where id = $1', [dualRoleUserId]);
    }
  });

  function dualRoleCtx(): WithContextCtx {
    if (!dualRoleUserId) {
      throw new Error('dualRoleUserId was not seeded — beforeAll must have failed');
    }
    return { userId: dualRoleUserId, clientId: clientA.clientId, isInternal: false };
  }

  describe.each(SCR_RLS_01_TABLES)('%s', (table) => {
    it.fails(
      `client A's portal user, who ALSO holds identity.user_entities access to this row's entity, still gets zero rows from client B's row on direct ID substitution`,
      async () => {
        const result = await selectById(dualRoleCtx(), table, rowIdFor(clientB, table));

        expect(result.rows).toEqual([]);
      },
    );

    // The FIX 2 companion — pins TODAY'S reality precisely (no throw, exactly client B's one row),
    // so a regression from "leaks one row" to "errors out" cannot hide behind `it.fails` recording
    // green for the wrong reason. See the header comment above for the full pairing rationale.
    it(
      `today's reality (companion to the it.fails above): the tampering query on client A's dual-role context resolves WITHOUT throwing and returns exactly client B's row`,
      async () => {
        const bId = rowIdFor(clientB, table);

        const result = await selectById(dualRoleCtx(), table, bId);

        expect(result.rows).toEqual([{ id: bId }]);
      },
    );
  });
});
