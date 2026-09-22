// WBS 0.11 (pg-tester). RED phase: packages/db does not exist yet — the import of `withContext`
// below fails to resolve until pg-backend builds packages/db/index.ts + packages/db/src/**. That
// import-resolution failure IS the correct RED for this task (unlike WBS 0.9/0.10, which proved
// already-existing schema and had no real RED phase — see .claude/briefs and the WBS 0.11 brief).
//
// Contract under test — withContext(ctx, fn) — CLAUDE.md · ARCHITECTURE ("All DB access goes
// through withContext(ctx, fn), which sets RLS session variables") and doc 40 line 64-68 (quoted
// in the WBS 0.11 brief): "Every transaction: opened via withContext(ctx, fn) which executes
// SET LOCAL app.user_id, app.is_internal, app.client_id." The three GUCs it must set are the ONLY
// three that exist anywhere in the schema (database/schema/01-Data-Model.sql:32-40):
// platform.current_user_id(), platform.current_client_id(), platform.is_internal() — this suite
// reads them back through those exact functions (never raw current_setting() outside the one
// injection test below, where a cast through current_user_id()'s ::uuid would itself throw on a
// non-UUID-shaped string and defeat the point of that test), so it exercises precisely what RLS
// policies call, not a parallel, possibly-divergent mechanism.
//
// Connects to the already-running dev database (infra/docker/docker-compose.yml, `postgres`
// service) via PG* env vars, defaulting to the documented local values — same convention as
// modules/platform/tests/integration/*.test.ts (WBS 0.9/0.10).

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

// The package under test. packages/db does not exist yet (WBS 0.11 RED) — this import fails to
// resolve until pg-backend builds packages/db/index.ts exporting `withContext` (and `db`).
import { withContext } from '../index.js';

// The package's OWN internal pool — the exact pool withContext (src/with-context.ts) checks its
// client out of. Reached via a relative import past the public barrel (index.ts), which
// deliberately does not re-export `pool` — review round 2, finding 4. This is module-internal test
// access (this test file lives inside packages/db itself), not an external caller bypassing the
// barrel. Used ONLY where a claim is specifically about "the same pool withContext uses" — the
// never-touched-fresh-connection baseline and the post-rollback no-leak check (review round 2,
// finding 3: a client from a genuinely different Pool object reads unset GUCs regardless of
// whether withContext leaked anything, so it proves nothing about pool-identity claims).
import { pool as internalPool } from '../src/client.js';

// A second, independent pg.Pool used ONLY to inspect connection-local state (current_setting /
// the platform.current_*() functions) from OUTSIDE whatever packages/db exports — per the WBS
// 0.11 brief: "you may need a plain pg.Pool in the test itself to inspect connection-local state,
// separate from whatever packages/db exports." Same PG* env-var convention as
// modules/platform/tests/integration/*.test.ts. Used for assertions that are NOT about
// pool-identity (row-count / row-presence checks on platform.thresholds, and reading the
// baseline/original row values before any mutation).
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// A real seeded ADR-27 key (13B-Schema-Reference-Consolidation.sql:1324), DIFFERENT from the key
// modules/platform/tests/integration/thresholds-live-read.test.ts already uses
// ('dtl.auto_close.max_cod_kwd') so the two suites never race on the same row when run
// concurrently in CI. Not invented — value/unit confirmed live below, never hardcoded into an
// assertion (only usable as a restore fallback if the initial read itself fails).
const COMMIT_PROOF_THRESHOLD_KEY = 'dtl.auto_close.min_confidence';

// platform.thresholds.changed_by is NOT NULL; seed data and WBS 0.10's own test share this
// sentinel actor id (modules/platform/tests/integration/thresholds-live-read.test.ts) — reused
// here for the same reason.
const SENTINEL_CHANGED_BY = '00000000-0000-0000-0000-000000000000';

afterAll(async () => {
  await pool.end();
});

describe('withContext — sets exactly the three RLS GUCs for the duration of the callback (WBS 0.11)', () => {
  it('exposes userId/isInternal via platform.current_user_id()/is_internal() inside the callback, and leaves clientId unset (null) when the caller passes null', async () => {
    const userId = randomUUID();

    await withContext({ userId, clientId: null, isInternal: true }, async (tx) => {
      const result = await tx.execute(
        sql`select platform.current_user_id() as user_id, platform.current_client_id() as client_id, platform.is_internal() as is_internal`,
      );
      const row = result.rows[0] as
        | { user_id: string; client_id: string | null; is_internal: boolean }
        | undefined;
      if (!row) {
        throw new Error('withContext callback query returned no row');
      }
      expect(row.user_id).toBe(userId);
      expect(row.client_id).toBeNull();
      expect(row.is_internal).toBe(true);
    });
  });

  it('exposes a non-null clientId and isInternal=false via the same three functions when both are passed explicitly', async () => {
    const userId = randomUUID();
    const clientId = randomUUID();

    await withContext({ userId, clientId, isInternal: false }, async (tx) => {
      const result = await tx.execute(
        sql`select platform.current_user_id() as user_id, platform.current_client_id() as client_id, platform.is_internal() as is_internal`,
      );
      const row = result.rows[0] as
        | { user_id: string; client_id: string; is_internal: boolean }
        | undefined;
      if (!row) {
        throw new Error('withContext callback query returned no row');
      }
      expect(row.user_id).toBe(userId);
      expect(row.client_id).toBe(clientId);
      expect(row.is_internal).toBe(false);
    });
  });
});

// pg-reviewer (opus), round 3: the original single test here was named as if it exercised "a
// connection that has never run through withContext," but the connection `internalPool.connect()`
// actually hands back depends entirely on pg.Pool's own LIFO idle-list behavior and on what ran
// earlier in this same file — the test only caught the WBS 0.11 empty-GUC regression when an
// earlier test in the file happened to have already pushed a committed-then-reverted connection
// onto the idle stack ahead of it. Run in isolation (`-t` filtering, `.only`, or a reordered/split
// file) it passed even against the buggy `platform.is_internal()`, because in isolation the pool
// hands back a connection that was never actually exercised. Split into two precisely-named,
// order-independent tests below: one that proves its "genuinely new connection" claim using the
// pool's own public API instead of assuming it, and one that deterministically drives a connection
// through the exact bug scenario itself rather than relying on an earlier test to have done so.
describe('withContext — connections handed back by the internal pool correctly read unset RLS GUCs, whether genuinely new or previously used by a committed withContext call (WBS 0.11, fail-closed RLS)', () => {
  it('a physical connection the pool itself just created (proven via pg.Pool\'s own "connect" event — pg-pool emits it only when isNew, never when handing back a reused idle client — after first draining every currently-idle connection so none can be silently reused instead) reads current_user_id()/current_client_id() as null and is_internal() as false', async () => {
    // Drain every idle connection out of `internalPool` first, holding (not releasing) each one.
    // pg.Pool.connect() reuses an idle client whenever `idleCount > 0` (pg-pool/index.js
    // `connect()`); only once idleCount is 0 does the next connect() call have to create a
    // genuinely new client. This is the "explicitly grow the pool" approach — using pg.Pool's own
    // public idleCount/connect API, not an assumption about what earlier tests left behind.
    const drained: PoolClient[] = [];
    while (internalPool.idleCount > 0) {
      drained.push(await internalPool.connect());
    }

    let sawNewConnection = false;
    const onConnect = (): void => {
      sawNewConnection = true;
    };
    internalPool.once('connect', onConnect);

    let client: PoolClient | undefined;
    try {
      client = await internalPool.connect();
      // If the pool did NOT just emit 'connect' for this checkout, it handed back a reused
      // client instead of creating a new one, and this test's claim about a "genuinely new
      // connection" would be unproven — fail loudly here rather than assert on an unverified
      // connection (pg-reviewer round 3: "if you can't prove it's pristine, don't claim it is").
      expect(sawNewConnection).toBe(true);

      const result: QueryResult<{
        user_id: string | null;
        client_id: string | null;
        is_internal: boolean;
      }> = await client.query(
        'select platform.current_user_id() as user_id, platform.current_client_id() as client_id, platform.is_internal() as is_internal',
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('new-connection query returned no row');
      }
      expect(row.user_id).toBeNull();
      expect(row.client_id).toBeNull();
      expect(row.is_internal).toBe(false);
    } finally {
      internalPool.removeListener('connect', onConnect);
      client?.release();
      for (const drainedClient of drained) {
        drainedClient.release();
      }
    }
  });

  it('a connection that HAS run through withContext and committed reads current_user_id()/current_client_id() as null and is_internal() as false again afterward — deterministically driven within this one test, not inferred from an earlier test happening to run first (regression test for the WBS 0.11 fail-closed RLS bug fixed by database/migrations/0001_B_fix-is-internal-empty-guc.sql)', async () => {
    const userId = randomUUID();
    const clientId = randomUUID();
    let backendPidDuringCommit: number | undefined;

    // Step 1 — deterministically put a connection from `internalPool` into the exact
    // "committed-then-reverted" state the bug is about: a withContext(...) call that sets all
    // three GUCs and commits normally (no throw). SET LOCAL is transaction-scoped, so once this
    // commits, the underlying physical connection's custom GUCs revert to Postgres's post-commit
    // default for a never-in-postgresql.conf custom GUC — the EMPTY STRING (''), not NULL (see
    // database/migrations/0001_B_fix-is-internal-empty-guc.sql lines 12-27 for the live proof).
    // That empty string is exactly what made the old `coalesce(current_setting(...), 'false')`
    // throw `invalid input syntax for type boolean: ""` on any connection reused after a commit.
    await withContext({ userId, clientId, isInternal: true }, async (tx) => {
      const seenBeforeCommit = await tx.execute(
        sql`select platform.is_internal() as is_internal, pg_backend_pid() as pid`,
      );
      const row = seenBeforeCommit.rows[0] as { is_internal: boolean; pid: number } | undefined;
      if (!row) {
        throw new Error('pre-commit sanity query returned no row');
      }
      expect(row.is_internal).toBe(true);
      backendPidDuringCommit = row.pid;
    });

    // Step 2 — ONLY AFTER that withContext(...) promise has resolved (i.e., committed and
    // released its client back to the pool — see src/with-context.ts, the success path calls
    // `client.release()` synchronously right after `commit`), check out a connection from the SAME
    // internal pool. This test does not rely on test-file ordering, `.only`/`-t` filtering, or
    // which physical connection pg.Pool happens to hand back for unrelated reasons — the
    // withContext call immediately above, inside THIS test, is what puts a connection into the
    // state being asserted on.
    const client = await internalPool.connect();
    try {
      const after: QueryResult<{
        user_id: string | null;
        client_id: string | null;
        is_internal: boolean;
        pid: number;
      }> = await client.query(
        'select platform.current_user_id() as user_id, platform.current_client_id() as client_id, platform.is_internal() as is_internal, pg_backend_pid() as pid',
      );
      const row = after.rows[0];
      if (!row) {
        throw new Error('post-commit query returned no row');
      }
      // Prove, at the Postgres level rather than by assuming pg.Pool's internal LIFO idle-list
      // behavior, that this checkout really did hand back the exact same physical backend
      // connection Step 1 just committed on — otherwise the assertions below would prove nothing
      // about the regression (a genuinely different, never-touched connection would trivially
      // read unset GUCs regardless of whether the bug is present).
      expect(row.pid).toBe(backendPidDuringCommit);
      expect(row.user_id).toBeNull();
      expect(row.client_id).toBeNull();
      expect(row.is_internal).toBe(false);
    } finally {
      client.release();
    }
  });
});

describe('withContext — rolls back and does not leak session state when fn throws (WBS 0.11)', () => {
  it('rejects with the callback\'s thrown error, and a fresh client checked out of the SAME internal pool withContext uses afterward still reads unset GUCs (SET LOCAL scope ended with the transaction, not leaked)', async () => {
    const userId = randomUUID();
    const marker = new Error('intentional-throw-for-rollback-proof');

    await expect(
      withContext({ userId, clientId: null, isInternal: true }, async (tx) => {
        // Prove the GUC really was set before throwing, so the throw below is a meaningful
        // mid-transaction abort, not a no-op that would make this test vacuously true.
        const seenBeforeThrow = await tx.execute(
          sql`select platform.current_user_id() as user_id`,
        );
        const row = seenBeforeThrow.rows[0] as { user_id: string } | undefined;
        if (!row) {
          throw new Error('pre-throw sanity query returned no row');
        }
        expect(row.user_id).toBe(userId);

        throw marker;
      }),
    ).rejects.toBe(marker);

    // A brand-new client checked out from the SAME pool `withContext` itself uses internally
    // (packages/db/src/client.ts's `pool`, imported above as `internalPool` — NOT this test
    // file's own separate `new Pool(...)`) must not see the aborted transaction's session state —
    // SET LOCAL is transaction-scoped, so a properly rolled-back / released connection reads
    // unset GUCs again, exactly like the never-touched fresh-connection case above. Using a
    // genuinely different Pool object here would read unset GUCs regardless of whether
    // withContext leaked anything, proving nothing (review round 2, finding 3).
    const freshClient = await internalPool.connect();
    try {
      const after: QueryResult<{ user_id: string | null }> = await freshClient.query(
        'select platform.current_user_id() as user_id',
      );
      expect(after.rows[0]?.user_id ?? null).toBeNull();
    } finally {
      freshClient.release();
    }
  });
});

describe('withContext — an injection-shaped ctx value is treated as an inert literal, never executed as SQL (WBS 0.11)', () => {
  it('a userId containing a DROP TABLE payload is set as a literal GUC value and does not execute — platform.thresholds is untouched', async () => {
    const maliciousUserId = "'; drop table platform.thresholds; --";

    const before: QueryResult<{ count: string }> = await pool.query(
      'select count(*)::text as count from platform.thresholds',
    );
    const beforeCount = before.rows[0]?.count;
    if (beforeCount === undefined) {
      throw new Error('baseline count query returned no row');
    }

    // withContext must not throw (not a Postgres syntax error, not a UUID-cast error — the value
    // is opaque text as far as the GUC is concerned), and the injected statement must never run.
    // Read via raw current_setting(), NOT platform.current_user_id() — that function casts to
    // ::uuid and would itself throw on this non-UUID string, which would prove nothing about
    // whether the value was executed as SQL.
    await withContext({ userId: maliciousUserId, clientId: null, isInternal: false }, async (tx) => {
      const seen = await tx.execute(sql`select current_setting('app.user_id', true) as raw`);
      const row = seen.rows[0] as { raw: string } | undefined;
      if (!row) {
        throw new Error('injection-probe query returned no row');
      }
      expect(row.raw).toBe(maliciousUserId);
    });

    const after: QueryResult<{ count: string }> = await pool.query(
      'select count(*)::text as count from platform.thresholds',
    );
    expect(after.rows[0]?.count).toBe(beforeCount);

    // The seeded ADR-27 key used elsewhere in this suite (WBS 0.10, thresholds-live-read.test.ts)
    // must still be present — proves the table was never touched, not merely that its row count
    // happens to match by coincidence.
    const seededKey: QueryResult<{ key: string }> = await pool.query(
      "select key from platform.thresholds where key = 'dtl.auto_close.max_cod_kwd'",
    );
    expect(seededKey.rows).toHaveLength(1);
  });

  it('a clientId containing a single quote is set as a literal GUC value and does not execute', async () => {
    const userId = randomUUID();
    const maliciousClientId = "x'); drop table platform.thresholds; --";

    const before: QueryResult<{ count: string }> = await pool.query(
      'select count(*)::text as count from platform.thresholds',
    );
    const beforeCount = before.rows[0]?.count;
    if (beforeCount === undefined) {
      throw new Error('baseline count query returned no row');
    }

    await withContext({ userId, clientId: maliciousClientId, isInternal: false }, async (tx) => {
      const seen = await tx.execute(sql`select current_setting('app.client_id', true) as raw`);
      const row = seen.rows[0] as { raw: string } | undefined;
      if (!row) {
        throw new Error('injection-probe query returned no row');
      }
      expect(row.raw).toBe(maliciousClientId);
    });

    const after: QueryResult<{ count: string }> = await pool.query(
      'select count(*)::text as count from platform.thresholds',
    );
    expect(after.rows[0]?.count).toBe(beforeCount);
  });
});

describe('withContext — a write inside the callback is durably committed once the promise resolves (WBS 0.11 review round 2, finding 2)', () => {
  it('a value written via tx.execute(...) inside withContext is visible, after withContext resolves, to an independent read on a completely different connection (from the package\'s own internal pool)', async () => {
    // Step 1 — read the real, currently-seeded row via this test file's own plain pool.query, so
    // the "clearly different" write below is always derived from what is actually there, never a
    // hardcoded assumed original. changed_by/changed_at are captured too because the write below
    // overwrites them and all four columns must be restored exactly (WBS 0.10's four-column
    // restore discipline).
    const initialRead: QueryResult<{
      value: string;
      unit: string | null;
      changed_by: string;
      changed_at: string;
    }> = await pool.query(
      'select value, unit, changed_by, changed_at from platform.thresholds where key = $1',
      [COMMIT_PROOF_THRESHOLD_KEY],
    );
    const initialRow = initialRead.rows[0];
    if (!initialRow) {
      throw new Error(
        `seed threshold '${COMMIT_PROOF_THRESHOLD_KEY}' not found in platform.thresholds — is database/schema/apply.sh applied to this database?`,
      );
    }
    const originalValue = initialRow.value;
    const originalUnit = initialRow.unit;
    const originalChangedBy = initialRow.changed_by;
    const originalChangedAt = initialRow.changed_at;

    // A value "clearly different" from the original, still numeric(14,3)-valid — derived from the
    // real captured value, never an invented absolute number.
    const newValue = (Number(originalValue) + 0.001).toFixed(3);
    expect(newValue).not.toBe(originalValue);

    try {
      // Step 2 — the write happens INSIDE withContext's callback, via tx.execute(...) — a genuine
      // write through the mechanism under test, not a bypass of it.
      await withContext({ userId: SENTINEL_CHANGED_BY, clientId: null, isInternal: true }, async (tx) => {
        await tx.execute(sql`
          update platform.thresholds
          set value = ${newValue}::numeric, changed_by = ${SENTINEL_CHANGED_BY}::uuid, changed_at = now()
          where key = ${COMMIT_PROOF_THRESHOLD_KEY}
        `);
      });

      // Step 3 — ONLY AFTER the withContext(...) promise has settled (proving the transaction
      // committed, not merely that the write happened inside an as-yet-uncommitted transaction),
      // read the row back on a completely different, independent connection: the package's own
      // internal pool (packages/db/src/client.ts), checked out explicitly so it is a distinct
      // physical connection from whatever withContext itself used internally, and distinct from
      // this test file's separate `pool` too.
      const reader = await internalPool.connect();
      let readBackValue: string | undefined;
      try {
        const readBack: QueryResult<{ value: string }> = await reader.query(
          'select value from platform.thresholds where key = $1',
          [COMMIT_PROOF_THRESHOLD_KEY],
        );
        readBackValue = readBack.rows[0]?.value;
      } finally {
        reader.release();
      }
      if (readBackValue === undefined) {
        throw new Error(`read-back of '${COMMIT_PROOF_THRESHOLD_KEY}' after commit returned no row`);
      }
      expect(readBackValue).toBe(newValue);
    } finally {
      // Restore the original four columns no matter what happened above — mirrors WBS 0.10's
      // try/finally-then-verify pattern exactly, so this test never permanently corrupts a real
      // operational threshold.
      await pool.query(
        'update platform.thresholds set value = $2, unit = $3, changed_by = $4, changed_at = $5 where key = $1',
        [COMMIT_PROOF_THRESHOLD_KEY, originalValue, originalUnit, originalChangedBy, originalChangedAt],
      );
    }

    // Confirm the restore actually took, on all four columns this test mutated.
    const restoredCheck: QueryResult<{
      value: string;
      unit: string | null;
      changed_by: string;
      changed_at: string;
    }> = await pool.query(
      'select value, unit, changed_by, changed_at from platform.thresholds where key = $1',
      [COMMIT_PROOF_THRESHOLD_KEY],
    );
    const restoredRow = restoredCheck.rows[0];
    if (!restoredRow) {
      throw new Error(`post-restore read of '${COMMIT_PROOF_THRESHOLD_KEY}' returned no row`);
    }
    expect(restoredRow.value).toBe(originalValue);
    expect(restoredRow.unit).toBe(originalUnit);
    expect(restoredRow.changed_by).toBe(originalChangedBy);
    expect(new Date(restoredRow.changed_at).getTime()).toBe(new Date(originalChangedAt).getTime());
  });
});
