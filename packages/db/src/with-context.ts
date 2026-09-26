// packages/db/src/with-context.ts — WBS 0.11.
//
// withContext(ctx, fn) — CLAUDE.md · ARCHITECTURE ("All DB access goes through withContext(ctx,
// fn), which sets RLS session variables") and doc 40 line 64-68: "Every transaction: opened via
// withContext(ctx, fn) which executes SET LOCAL app.user_id, app.is_internal, app.client_id."
//
// Opens a transaction on a dedicated pool client, sets the four transaction-local GUCs the schema
// reads back through platform.current_user_id() / platform.current_client_id() /
// platform.is_internal() (database/schema/01-Data-Model.sql:32-40) and, since migration 0031
// (Master task P6b-2, SCR-PLAT-CTX-01, D-190), app.entity_id read by platform.allowed_entities()
// to narrow entity-scoped RLS to the active entity. app.entity_id is ALWAYS set (to NULL when
// ctx.entityId is absent), so the result is deterministic and overrides any session-level
// leftover on a pooled connection. Then it runs `fn` against a drizzle
// handle bound to that same transaction/client, commits on success, rolls back and re-throws the
// original error on failure, and always releases the client back to the pool.
//
// The set_config(...) calls are parameterized via drizzle's `sql` tagged template — the
// interpolated ctx values are bound query parameters, never string-interpolated into the SQL
// text, so an injection-shaped ctx value is treated as an inert literal (see
// tests/with-context.test.ts, the two injection-payload cases).
//
// A JS `null` for userId/clientId/entityId binds as SQL NULL; passing SQL NULL as set_config's second
// argument makes the GUC read back as '' (empty string) via current_setting(setting, true) — not
// NULL, but nullif(current_setting(...), '')::uuid (the cast every platform.current_*() function
// uses) turns that empty string back into a genuine NULL. Confirmed against the live local
// database before relying on it (WBS 0.11 brief).

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { pool } from './client.js';

export interface WithContextCtx {
  readonly userId: string | null;
  readonly clientId: string | null;
  readonly isInternal: boolean;
  /** Optional (Master task P6b-1; RLS effect since P6b-2 / migration 0031): the active entity
   *  resolved by `resolveActiveEntityId` (entity-scope.ts). Always written to the `app.entity_id`
   *  GUC (NULL when absent); platform.allowed_entities() then returns only this entity (if the
   *  user is a member of it), so every entity-scoped RLS policy follows the active entity. NULL
   *  or absent means the user's full entity set. */
  readonly entityId?: string | null;
}

export async function withContext<T>(
  ctx: WithContextCtx,
  fn: (tx: NodePgDatabase) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tx = drizzle(client);
    try {
      await tx.execute(sql`select set_config('app.user_id', ${ctx.userId}, true)`);
      await tx.execute(sql`select set_config('app.client_id', ${ctx.clientId}, true)`);
      await tx.execute(
        sql`select set_config('app.is_internal', ${ctx.isInternal ? 'true' : 'false'}, true)`,
      );
      await tx.execute(sql`select set_config('app.entity_id', ${ctx.entityId ?? null}, true)`);

      const result = await fn(tx);
      await client.query('commit');
      client.release();
      return result;
    } catch (error) {
      // A rollback failure (broken connection, aborted socket) must never mask the ORIGINAL
      // error: the rollback attempt gets its own try/catch, and the error thrown below is always
      // the original `error` — never whatever the rollback attempt itself might throw.
      try {
        await client.query('rollback');
      } catch {
        // Intentionally ignored — see comment above. The original error still wins.
      }
      throw error;
    }
  } catch (error) {
    // pg's PoolClient#release(err?) tells the pool to destroy this client instead of returning a
    // possibly-broken connection to the pool for reuse — appropriate on every path that reaches
    // here, since they all followed a thrown error (including `begin` itself failing). The
    // success path above already released with no argument and returned before this is reached.
    client.release(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}
