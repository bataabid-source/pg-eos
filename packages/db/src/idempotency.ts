// packages/db/src/idempotency.ts — SCR-PLAT-IDEM-01, applied in
// database/migrations/0010_M_idempotency-keys-variance-photo.sql.
//
// withIdempotentContext(ctx, idem, fn) — the shared idempotency-replay helper every write
// command's api handler calls instead of withContext(ctx, fn) directly, per doc 40 §A4: a
// same-key + same-body call REPLAYS the stored response (fn is not re-run); a same-key +
// different-body call is a 409 IdempotencyConflictError('mismatch'); a key whose first call is
// still running (another transaction holds the advisory lock, or its response_status is still
// null) is a 409 IdempotencyConflictError('in_flight').
//
// The replay path returns the JSON round-trip of the stored `response_body` (jsonb) — so `fn`'s
// result must be plain JSON: no Date, no bigint, no class instance with non-enumerable fields.
// `fn`'s return type is bounded to `JsonValue`-compatible shapes (via the `JsonCompatible<T>`
// homomorphic check below — a plain `T extends JsonValue` constraint rejects every named
// interface outright, since TypeScript requires an interface to declare its OWN index signature
// before it satisfies one structurally; `JsonCompatible<T>` instead checks each of T's own
// properties recursively, which every command result type in this codebase already satisfies
// without adding an index signature) — a command result that is not plain JSON fails typecheck at
// its own call site instead of surfacing as a runtime replay bug.
//
// Lock order: the advisory lock (pg_try_advisory_xact_lock) plus the platform.idempotency_keys
// upsert run FIRST, inside the same withContext transaction, before any row lock the wrapped
// command takes — a copied command's own repository.ts lock-order comment records this as its own
// step 0 (see modules/wms/infrastructure/receive-inbound/repository.ts).

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { withContext, type WithContextCtx } from './with-context.js';

type JsonPrimitive = null | boolean | number | string;

/** A plain-JSON value — no Date, no bigint, no class instance, no function, no `undefined`
 *  property value. Used to document/type a JSON-plain value directly (e.g. a parsed
 *  `response_body`); `withIdempotentContext`'s own `T` is bounded via `JsonCompatible<T>` below,
 *  not this type directly (see that type's own comment for why). */
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Homomorphic recursive check: `T` is JSON-compatible iff every one of ITS OWN properties is,
 *  checked key-by-key over `keyof T` — unlike `T extends JsonValue` (which requires `T` to
 *  declare its own index signature before TypeScript treats it as structurally compatible with
 *  one), this accepts a plain readonly interface like `ApproveInboundResult` as-is. `Date`,
 *  `RegExp` and function types are excluded explicitly — they are structurally `object` but are
 *  never plain JSON. */
type JsonCompatible<T> = T extends JsonPrimitive
  ? T
  : T extends Date | RegExp | ((...args: never[]) => unknown)
    ? never
    : T extends readonly (infer U)[]
      ? readonly JsonCompatible<U>[]
      : T extends object
        ? { readonly [K in keyof T]: JsonCompatible<T[K]> }
        : never;

export interface IdempotencyInput {
  readonly key: string;
  readonly endpoint: string;
  /** sha256 hex of the canonical (stable-key-order) request body. */
  readonly requestHash: string;
  readonly entityId: string | null;
  /** the HTTP status the caller will report on success — stored as response_status. */
  readonly successStatus: number;
}

/** `reason: 'mismatch'` — the key was already used with a different endpoint/body. `reason:
 *  'in_flight'` — the key's first call has not finished yet (advisory lock held elsewhere, or its
 *  response_status is still null). Both map to HTTP 409 (api layer, title = error.name). */
export class IdempotencyConflictError extends Error {
  readonly reason: 'mismatch' | 'in_flight';

  constructor(message: string, reason: 'mismatch' | 'in_flight') {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.reason = reason;
  }
}

/**
 * `idem` undefined -> exactly `withContext(ctx, fn)`, no idempotency bookkeeping at all (a pure
 * read never needs a key). Otherwise: claim the key inside the SAME transaction fn runs in, then
 * either replay a prior response or run `fn` and persist its result.
 */
export async function withIdempotentContext<T>(
  ctx: WithContextCtx,
  idem: IdempotencyInput | undefined,
  fn: (tx: NodePgDatabase) => Promise<T extends JsonCompatible<T> ? T : never>,
): Promise<T> {
  const jsonFn = fn as unknown as (tx: NodePgDatabase) => Promise<T>;
  if (!idem) return withContext(ctx, jsonFn);
  if (!ctx.userId) {
    throw new Error('withIdempotentContext requires ctx.userId to scope an idempotency key.');
  }
  const userId = ctx.userId;

  return withContext(ctx, async (tx) => {
    // Step 0a — the advisory lock, first: a second concurrent call with the SAME key blocks here
    // (pg_try_advisory_xact_lock never blocks the caller — it returns false immediately) rather
    // than racing the upsert below.
    const lockResult = await tx.execute<{ locked: boolean }>(sql`
      select pg_try_advisory_xact_lock(hashtextextended(${userId}::text || '|' || ${idem.key}, 0)) as locked
    `);
    if (!lockResult.rows[0]?.locked) {
      throw new IdempotencyConflictError(
        `Idempotency-Key ${idem.key} is already in flight for this caller.`,
        'in_flight',
      );
    }

    // Step 0b — claim the key row: a fresh key inserts; an EXPIRED key is reclaimed in place
    // (the `where ... expires_at <= now()` guard on the DO UPDATE); a live key with the same
    // (user_id, key) pair is left untouched — the UPDATE's WHERE clause evaluates false, so
    // Postgres performs no update and RETURNING yields no row, which is exactly the "existing,
    // still-live key" case this function distinguishes below.
    const claimResult = await tx.execute<{ claimed: number }>(sql`
      insert into platform.idempotency_keys (user_id, key, entity_id, endpoint, request_hash)
      values (${userId}::uuid, ${idem.key}, ${idem.entityId}::uuid, ${idem.endpoint}, ${idem.requestHash})
      on conflict (user_id, key) do update set
        endpoint = excluded.endpoint,
        request_hash = excluded.request_hash,
        entity_id = excluded.entity_id,
        response_status = null,
        response_body = null,
        created_at = now(),
        expires_at = default
      where platform.idempotency_keys.expires_at <= now()
      returning 1 as claimed
    `);

    if (claimResult.rows.length === 0) {
      const existing = await tx.execute<{
        endpoint: string;
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
      }>(sql`
        select endpoint, request_hash, response_status, response_body
          from platform.idempotency_keys
         where user_id = ${userId}::uuid and key = ${idem.key}
      `);
      const row = existing.rows[0];
      if (!row || row.endpoint !== idem.endpoint || row.request_hash !== idem.requestHash) {
        throw new IdempotencyConflictError(
          `Idempotency-Key ${idem.key} was already used with a different request.`,
          'mismatch',
        );
      }
      if (row.response_status === null) {
        throw new IdempotencyConflictError(
          `Idempotency-Key ${idem.key} is already in flight for this caller.`,
          'in_flight',
        );
      }
      // A REPLAY: fn is never called. response_body is the JSON round-trip of the original result.
      return row.response_body as T;
    }

    const result = await jsonFn(tx);

    await tx.execute(sql`
      update platform.idempotency_keys
         set response_status = ${idem.successStatus}, response_body = ${JSON.stringify(result)}::jsonb
       where user_id = ${userId}::uuid and key = ${idem.key}
    `);

    return result;
  });
}
