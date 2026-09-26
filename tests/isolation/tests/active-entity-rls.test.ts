// tests/isolation/tests/active-entity-rls.test.ts — Master task P6b-2 (pg-tester).
//
// Proves SCR-PLAT-CTX-01 (docs/notes/SCR-PLAT-CTX-01-active-entity-rls.md, D-190), GREEN since
// migration 0031: `withContext` ALWAYS writes the transaction-local GUC `app.entity_id` —
// `set_config('app.entity_id', ctx.entityId, true)`, where a JS `null`/absent `ctx.entityId` binds
// as SQL NULL (which `set_config` reads back as `''`, the empty string) — so the GUC is
// deterministic every transaction, never a leftover from a previously pooled connection.
// `platform.allowed_entities()` returns the caller's `identity.user_entities` INTERSECTED with
// `nullif(current_setting('app.entity_id', true), '')::uuid` when that value is non-empty, and
// EXACTLY the caller's full entity set when it is empty (GUC unset, or explicitly set to `''`).
// Every `entity_scope` RLS policy (`entity_id = any(platform.allowed_entities())`,
// `01-Data-Model.sql:1443-1468` + the seven SCR-RLS-01 tables) therefore follows the active
// entity, for both reads (`USING`) and writes (`WITH CHECK`).
//
// IMPORTS '@pg-eos/db' BY NAME (Master correction — the "import source, not the package" rule
// from commit 4c2844d applies only INSIDE packages/db, where the package would otherwise import
// itself; `tests/isolation` is a separate workspace package, so it depends on `@pg-eos/db`
// (tests/isolation/package.json) like every sibling isolation test, and turbo's `^build` builds
// that package first). A relative import into `packages/db/src/*.ts` across the package boundary
// was tried first and rejected: it violates `tests/isolation/tsconfig.json`'s `rootDir` (TS6059),
// which this file must not work around by widening — the fix is to depend on the package
// properly, not to reach into its source.
//
// DATABASE: this file's own `pgeos_p6c` — never `pgeos` or `pgeos_lane*` (D-183). Run as
// `PGDATABASE=pgeos_p6c PG_APP_USER=pgeos_app pnpm --filter @pg-eos/isolation-tests test:isolation
// -- active-entity-rls`. `PGDATABASE` is read from the environment as-is (no override, no
// hard-coded database name, matching the "finding 4" discipline in
// packages/db/tests/entity-scope-integration.test.ts and packages/db/src/client.ts's own default)
// — this file's own fallback below only matches client.ts's default ('pgeos'), it does not choose
// pgeos_p6c itself; the Master's run command sets PGDATABASE=pgeos_p6c.
//
// `PG_APP_USER` (not a plain `PGUSER` mutation) is set at MODULE TOP LEVEL, before `@pg-eos/db` is
// ever imported — `packages/db/src/client.ts` builds its `Pool` at MODULE LOAD time from
// `process.env['PG_APP_USER'] ?? process.env['PGUSER'] ?? 'postgres'`, so the mutation must land
// before that module evaluates (same ordering discipline as
// tests/isolation/tests/client-isolation.test.ts's own header comment). `pgeos_app`
// (migration 0007) is a real, already-applied NOBYPASSRLS login role — no throwaway role is
// provisioned by this file, unlike client-isolation.test.ts's `pgeos_rls_isolation_test` (that
// file predates 0007; this one does not need to reinvent the role).
//
// FIXTURE: one real `identity.users` row (internal, so RLS's own `client_portal_scope` OR-leg
// never interferes) holding TWO `identity.user_entities` rows — entity A (`PST`) and entity B
// (`PDL`) — seeded through the admin/superuser pool, bypassing RLS (same discipline as every other
// fixture in this codebase). One row each, for entity A and entity B, in TWO representative
// entity_scope-gated tables (`wms.inbound_orders`, `wms.outbound_orders` —
// `01-Data-Model.sql:1443-1468`), also seeded via the admin pool. Entity `PCC` is used as "an
// entity outside the user's user_entities" (scenario (c)) — the user never holds a
// `identity.user_entities` row for it.
//
// CLEANUP: `afterAll` only (D-183) — every fixture row's uniqueness comes from a `randomUUID()`
// suffix (`doc_no`, `email`), so two runs never collide on name alone and there is nothing to sweep
// in `beforeAll`.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WithContextCtx } from '@pg-eos/db';

// PG_APP_USER must be set before packages/db/src/client.ts (imported transitively by with-context.ts)
// is ever evaluated — see header comment "ORDERING" discipline above.
const ORIGINAL_PG_APP_USER = process.env['PG_APP_USER'];
process.env['PG_APP_USER'] = 'pgeos_app';

const CONNECTION_HOST = process.env['PGHOST'] ?? 'localhost';
const CONNECTION_PORT = Number(process.env['PGPORT'] ?? '5432');
const CONNECTION_USER = process.env['PGUSER'] ?? 'postgres';
const CONNECTION_PASSWORD = process.env['PGPASSWORD'];
const CONNECTION_DATABASE = process.env['PGDATABASE'] ?? 'pgeos';

// Admin/superuser pool — seeds and reads back fixture rows, bypassing RLS. Never used to run the
// scoped queries under test (those go through `withContext`, as `pgeos_app`).
const admin = new Pool({
  host: CONNECTION_HOST,
  port: CONNECTION_PORT,
  user: CONNECTION_USER,
  password: CONNECTION_PASSWORD,
  database: CONNECTION_DATABASE,
});

// Dynamic, and AFTER the PG_APP_USER mutation above — see header comment.
const { withContext, withIdempotentContext, createUserEntitiesLookup } = await import('@pg-eos/db');

function firstRow<T extends QueryResultRow>(result: QueryResult<T>, what: string): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`${what}: query returned no rows where at least one was expected`);
  }
  return row;
}

/**
 * The PostgreSQL SQLSTATE carried by `error`, whether thrown directly by `pg` (a plain `.code`) or
 * wrapped by drizzle-orm 0.45's `DrizzleQueryError` (the original `pg` error, and therefore its
 * `.code`, lives on `.cause` — `error.cause.code`, not `error.code`). Checks `.cause.code` FIRST,
 * falling back to a direct `.code`, so this one helper covers both shapes rather than asserting on
 * whichever one happens to be right today. Same `'code' in x` narrowing idiom as
 * tests/isolation/tests/client-isolation.test.ts's own `sqlStateOf`.
 */
function sqlStateOf(error: unknown): string | undefined {
  if (error instanceof Error) {
    const { cause } = error;
    if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') {
      return cause.code;
    }
    if ('code' in error && typeof error.code === 'string') {
      return error.code;
    }
  }
  return undefined;
}

async function resolveEntityId(code: string): Promise<string> {
  const result = await admin.query<{ id: string }>(
    'select id from platform.entities where code = $1',
    [code],
  );
  return firstRow(result, `platform.entities lookup for code ${code}`).id;
}

async function resolveWarehouseId(code: string): Promise<string> {
  const result = await admin.query<{ id: string }>('select id from wms.warehouses where code = $1', [
    code,
  ]);
  return firstRow(result, `wms.warehouses lookup for code ${code}`).id;
}

const FIXTURE_EMAIL = `p6b2-active-entity-rls-test-${randomUUID()}@example.invalid`;

let userId: string;
let entityA: string; // PST — the user holds this
let entityB: string; // PDL — the user holds this
let entityOutside: string; // PCC — the user does NOT hold this
let warehouseId: string;
let clientId: string;

// One row per entity, per table — {inbound,outbound}_orders x {A,B}.
let inboundOrderRowIdA: string;
let inboundOrderRowIdB: string;
let outboundOrderRowIdA: string;
let outboundOrderRowIdB: string;

// Rows this suite writes DURING an `it` (not in beforeAll) — recorded here, deleted ONLY in
// afterAll, never inline after an assertion, so a failed assertion can never skip cleanup.
const writtenInboundOrderIds: string[] = [];
// Same discipline (D-183) for platform.idempotency_keys rows written by the
// withIdempotentContext describe block, below.
const writtenIdempotencyKeys: string[] = [];

beforeAll(async () => {
  entityA = await resolveEntityId('PST');
  entityB = await resolveEntityId('PDL');
  entityOutside = await resolveEntityId('PCC');
  warehouseId = await resolveWarehouseId('WH1');

  const user = await admin.query<{ id: string }>(
    `insert into identity.users (email, full_name_ar, user_type) values ($1, $2, 'internal') returning id`,
    [FIXTURE_EMAIL, 'مستخدم اختبار P6b-2 — كيانان (أ) و(ب)'],
  );
  userId = firstRow(user, 'insert identity.users P6b-2 fixture').id;

  await admin.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2), ($1, $3)`, [
    userId,
    entityA,
    entityB,
  ]);

  const account = await admin.query<{ id: string }>(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [`p6b2-active-entity-rls-${randomUUID()}`, 'عميل اختبار P6b-2'],
  );
  clientId = firstRow(account, 'insert sales.accounts P6b-2 fixture').id;

  const inboundA = await admin.query<{ id: string }>(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id) values ($1, $2, $3, $4) returning id`,
    [entityA, `P6B2-IN-A-${randomUUID()}`, clientId, warehouseId],
  );
  inboundOrderRowIdA = firstRow(inboundA, 'insert wms.inbound_orders (entity A)').id;

  const inboundB = await admin.query<{ id: string }>(
    `insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id) values ($1, $2, $3, $4) returning id`,
    [entityB, `P6B2-IN-B-${randomUUID()}`, clientId, warehouseId],
  );
  inboundOrderRowIdB = firstRow(inboundB, 'insert wms.inbound_orders (entity B)').id;

  const outboundA = await admin.query<{ id: string }>(
    `insert into wms.outbound_orders (entity_id, doc_no, client_id, warehouse_id) values ($1, $2, $3, $4) returning id`,
    [entityA, `P6B2-OUT-A-${randomUUID()}`, clientId, warehouseId],
  );
  outboundOrderRowIdA = firstRow(outboundA, 'insert wms.outbound_orders (entity A)').id;

  const outboundB = await admin.query<{ id: string }>(
    `insert into wms.outbound_orders (entity_id, doc_no, client_id, warehouse_id) values ($1, $2, $3, $4) returning id`,
    [entityB, `P6B2-OUT-B-${randomUUID()}`, clientId, warehouseId],
  );
  outboundOrderRowIdB = firstRow(outboundB, 'insert wms.outbound_orders (entity B)').id;
});

afterAll(async () => {
  try {
    for (const key of writtenIdempotencyKeys) {
      await admin.query('delete from platform.idempotency_keys where key = $1', [key]);
    }
  } finally {
    try {
      for (const id of writtenInboundOrderIds) {
        await admin.query('delete from wms.inbound_orders where id = $1', [id]);
      }
    } finally {
      try {
        await admin.query('delete from wms.outbound_orders where id in ($1, $2)', [
          outboundOrderRowIdA,
          outboundOrderRowIdB,
        ]);
        await admin.query('delete from wms.inbound_orders where id in ($1, $2)', [
          inboundOrderRowIdA,
          inboundOrderRowIdB,
        ]);
      } finally {
        try {
          if (userId) {
            await admin.query('delete from identity.user_entities where user_id = $1', [userId]);
            await admin.query('delete from identity.users where id = $1', [userId]);
          }
        } finally {
          try {
            await admin.end();
          } finally {
            if (ORIGINAL_PG_APP_USER === undefined) {
              delete process.env['PG_APP_USER'];
            } else {
              process.env['PG_APP_USER'] = ORIGINAL_PG_APP_USER;
            }
          }
        }
      }
    }
  }
});

/**
 * `entityId: undefined` (rather than the key being absent) is REJECTED under this workspace's
 * `exactOptionalPropertyTypes` (`WithContextCtx.entityId` is `string | null` — optional, but not
 * `| undefined`) — the key is omitted entirely for the "no entityId" case rather than assigned
 * `undefined`, and included (possibly `null`) otherwise.
 */
function ctxWithEntity(entityId: string | null | undefined): WithContextCtx {
  if (entityId === undefined) {
    return { userId, clientId: null, isInternal: true };
  }
  return { userId, clientId: null, isInternal: true, entityId };
}

describe('(a) ctx.entityId = A (held entity) — reads and writes are scoped to A alone', () => {
  it('wms.inbound_orders: only entity A\'s row is visible, entity B\'s row is not', async () => {
    const result = await withContext(ctxWithEntity(entityA), (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from wms.inbound_orders where id in (${inboundOrderRowIdA}, ${inboundOrderRowIdB})`,
      ),
    );
    const ids = result.rows.map((row) => row.id);
    expect(ids).toContain(inboundOrderRowIdA);
    expect(ids).not.toContain(inboundOrderRowIdB);
  });

  it('wms.outbound_orders: only entity A\'s row is visible, entity B\'s row is not', async () => {
    const result = await withContext(ctxWithEntity(entityA), (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from wms.outbound_orders where id in (${outboundOrderRowIdA}, ${outboundOrderRowIdB})`,
      ),
    );
    const ids = result.rows.map((row) => row.id);
    expect(ids).toContain(outboundOrderRowIdA);
    expect(ids).not.toContain(outboundOrderRowIdB);
  });

  it('an INSERT of an entity-B row while ctx.entityId = A is refused (42501) — entity_scope\'s WITH CHECK fails because allowed_entities() is narrowed to {A}', async () => {
    // Reuses the module-level `clientId` (beforeAll) — the fixture rows for entity A and entity B
    // both already share this one client, so no extra lookup is needed here.
    let thrownCode: string | undefined;
    try {
      const inserted = await withContext(ctxWithEntity(entityA), (tx) =>
        tx.execute<{ id: string }>(sql`
          insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id)
          values (${entityB}, ${`P6B2-IN-REFUSED-${randomUUID()}`}, ${clientId}, ${warehouseId})
          returning id
        `),
      );
      // If this line is reached, the insert unexpectedly SUCCEEDED — record the row so afterAll can
      // still remove it even though the test itself is about to fail.
      writtenInboundOrderIds.push(firstRow(inserted, 'unexpectedly-inserted entity-B row').id);
    } catch (error) {
      thrownCode = sqlStateOf(error);
    }

    expect(thrownCode).toBe('42501');
  });
});

describe('(b) no entityId — the caller\'s full entity set: reads show both A and B\'s rows', () => {
  it('wms.inbound_orders: both entity A and entity B rows are visible with ctx.entityId unset', async () => {
    const result = await withContext(ctxWithEntity(undefined), (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from wms.inbound_orders where id in (${inboundOrderRowIdA}, ${inboundOrderRowIdB})`,
      ),
    );
    const ids = result.rows.map((row) => row.id).sort();
    expect(ids).toEqual([inboundOrderRowIdA, inboundOrderRowIdB].sort());
  });
});

describe('(c) app.entity_id set (via set_config, bypassing ctx) to an entity outside the user\'s user_entities — zero rows, writes refused', () => {
  it('setting app.entity_id = entityOutside makes wms.inbound_orders reads for A and B return zero rows', async () => {
    const result = await withContext(ctxWithEntity(null), (tx) => {
      // Deliberately bypasses ctx.entityId — sets the raw GUC directly, as the brief specifies, to
      // prove the RLS predicate reads THIS GUC, not merely trusts an application-level ctx value.
      return tx
        .execute(sql`select set_config('app.entity_id', ${entityOutside}, true)`)
        .then(() =>
          tx.execute<{ id: string }>(
            sql`select id from wms.inbound_orders where id in (${inboundOrderRowIdA}, ${inboundOrderRowIdB})`,
          ),
        );
    });

    expect(result.rows).toEqual([]);
  });

  it('an INSERT while app.entity_id = entityOutside is refused (42501)', async () => {
    // Reuses the module-level `clientId` (beforeAll) — see the analogous comment in the (a) INSERT
    // test above.
    let thrownCode: string | undefined;
    try {
      const inserted = await withContext(ctxWithEntity(null), (tx) =>
        tx
          .execute(sql`select set_config('app.entity_id', ${entityOutside}, true)`)
          .then(() =>
            tx.execute<{ id: string }>(sql`
              insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id)
              values (${entityOutside}, ${`P6B2-IN-OUTSIDE-${randomUUID()}`}, ${clientId}, ${warehouseId})
              returning id
            `),
          ),
      );
      writtenInboundOrderIds.push(firstRow(inserted, 'unexpectedly-inserted outside-entity row').id);
    } catch (error) {
      thrownCode = sqlStateOf(error);
    }

    expect(thrownCode).toBe('42501');
  });
});

describe('positive write — ctx.entityId = A, inserting an entity-A row succeeds', () => {
  it('an INSERT of an entity-A row while ctx.entityId = A succeeds (entity_scope\'s WITH CHECK passes for the caller\'s own active entity)', async () => {
    let insertedId: string | undefined;
    let thrown: unknown = null;
    try {
      const inserted = await withContext(ctxWithEntity(entityA), (tx) =>
        tx.execute<{ id: string }>(sql`
          insert into wms.inbound_orders (entity_id, doc_no, client_id, warehouse_id)
          values (${entityA}, ${`P6B2-IN-POSITIVE-${randomUUID()}`}, ${clientId}, ${warehouseId})
          returning id
        `),
      );
      insertedId = firstRow(inserted, 'positive-control entity-A insert').id;
    } catch (error) {
      thrown = error;
    } finally {
      // Recorded for afterAll cleanup regardless of outcome — never inline after the assertion.
      if (insertedId) {
        writtenInboundOrderIds.push(insertedId);
      }
    }

    expect(thrown).toBeNull();
    expect(insertedId).toBeDefined();
  });
});

describe('empty GUC — set_config(\'app.entity_id\', \'\', true) is equivalent to unset (the pool-reuse path)', () => {
  it('with app.entity_id explicitly set to the empty string, both entity A and entity B rows are visible', async () => {
    const result = await withContext(ctxWithEntity(null), (tx) =>
      tx
        .execute(sql`select set_config('app.entity_id', '', true)`)
        .then(() =>
          tx.execute<{ id: string }>(
            sql`select id from wms.inbound_orders where id in (${inboundOrderRowIdA}, ${inboundOrderRowIdB})`,
          ),
        ),
    );

    const ids = result.rows.map((row) => row.id).sort();
    expect(ids).toEqual([inboundOrderRowIdA, inboundOrderRowIdB].sort());
  });
});

describe('malformed app.entity_id — a non-UUID value fails closed', () => {
  it('setting app.entity_id = \'x\' raises 22P02 (invalid_text_representation) on the next read, rather than silently matching nothing or everything', async () => {
    let thrownCode: string | undefined;
    try {
      await withContext(ctxWithEntity(null), (tx) =>
        tx
          .execute(sql`select set_config('app.entity_id', 'x', true)`)
          .then(() =>
            tx.execute<{ id: string }>(
              sql`select id from wms.inbound_orders where id in (${inboundOrderRowIdA}, ${inboundOrderRowIdB})`,
            ),
          ),
      );
    } catch (error) {
      thrownCode = sqlStateOf(error);
    }

    expect(thrownCode).toBe('22P02');
  });
});

describe('transaction-local GUC — reverts after commit, even on a reused pooled connection', () => {
  it('after a withContext with ctx.entityId = A commits, the NEXT withContext with no entityId still sees both A and B rows', async () => {
    await withContext(ctxWithEntity(entityA), (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from wms.inbound_orders where id in (${inboundOrderRowIdA}, ${inboundOrderRowIdB})`,
      ),
    );

    const result = await withContext(ctxWithEntity(undefined), (tx) =>
      tx.execute<{ id: string }>(
        sql`select id from wms.inbound_orders where id in (${inboundOrderRowIdA}, ${inboundOrderRowIdB})`,
      ),
    );

    const ids = result.rows.map((row) => row.id).sort();
    expect(ids).toEqual([inboundOrderRowIdA, inboundOrderRowIdB].sort());
  });
});

describe('createUserEntitiesLookup is unaffected by ctx.entityId — it still returns the caller\'s FULL entity set', () => {
  it('createUserEntitiesLookup(ctx) with ctx.entityId = A still resolves BOTH entity A and entity B for the caller\'s own id', async () => {
    const lookup = createUserEntitiesLookup(ctxWithEntity(entityA));

    const entities = await lookup(userId);

    expect([...entities].sort()).toEqual([entityA, entityB].sort());
  });
});

describe('withIdempotentContext — an Idempotency-Key recorded under entity A, reused under entity B, is refused by RLS', () => {
  // `platform.idempotency_keys` (migration 0010) carries its own `entity_scope` policy
  // (`entity_id is null or entity_id = any(platform.allowed_entities())`, FOR ALL). A LIVE key
  // (not yet expired) never reaches that policy's UPDATE leg at all: `withIdempotentContext`'s own
  // `insert ... on conflict (user_id, key) do update ... where expires_at <= now()` skips the
  // update entirely for a live key, and the subsequent SELECT that checks endpoint/request_hash
  // for a mismatch is itself entity-scoped — so a live key reused under a different entity is
  // filtered to zero rows there and raises `IdempotencyConflictError('mismatch')` (a plain JS
  // error, no SQLSTATE) rather than an RLS violation. The scenario the Master asked for — reuse
  // RAISES 42501 — needs the key to be EXPIRED, so the `ON CONFLICT DO UPDATE` branch actually
  // executes: Postgres then attempts to UPDATE the pre-existing row (entity_id = A) while the
  // caller's `app.entity_id` GUC is B, and the new row's `entity_id = B` fails entity_scope's
  // WITH CHECK — confirmed live against pgeos_p6c before writing this assertion.
  it('a same Idempotency-Key call under entity A, once expired, then reused under entity B, raises 42501 (read via error.cause.code)', async () => {
    const key = `p6b2-idem-entity-${randomUUID()}`;
    const requestHash = createHash('sha256').update('p6b2-idem-entity-test-body').digest('hex');

    const idemA = {
      key,
      endpoint: '/p6b2/idem-entity-test',
      requestHash,
      entityId: entityA,
      successStatus: 200,
    };
    const idemB = { ...idemA, entityId: entityB };

    // First call, under entity A — completes normally, no idempotency conflict.
    const first = await withIdempotentContext(ctxWithEntity(entityA), idemA, async () => ({ ok: true }));
    expect(first).toEqual({ ok: true });

    // Force expiry so the second call's `ON CONFLICT DO UPDATE` branch actually runs, rather than
    // taking the "live key" mismatch path described above.
    await admin.query(
      `update platform.idempotency_keys set expires_at = now() - interval '1 second' where key = $1`,
      [key],
    );

    // Recorded for the file's shared afterAll (D-183) — never deleted inline here, so a failed
    // assertion below can never skip cleanup.
    writtenIdempotencyKeys.push(key);

    let thrownCode: string | undefined;
    try {
      await withIdempotentContext(ctxWithEntity(entityB), idemB, async () => ({ ok: true, second: true }));
    } catch (error) {
      thrownCode = sqlStateOf(error);
    }

    expect(thrownCode).toBe('42501');
  });
});
