// tests/scenarios/fixtures/request.ts — enablement item 3a (Master decision 6: request shape
// `{ headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: randomUUID() }, body, ctx }`,
// `ctx = { userId, clientId: null, isInternal: true }`).

import { randomUUID } from 'node:crypto';

import { IDEMPOTENCY_KEY_HEADER_NAME } from '@pg-eos/contracts';
import type { ApiRequest } from '@pg-eos/api-kit';

/** Structurally identical to `WithContextCtx` (packages/db/src/with-context.ts) — every real
 *  handler call goes through `withContext(ctx, fn)` inside the module's own composition, which
 *  accepts this shape. */
export interface ScenarioCtx {
  readonly userId: string;
  readonly clientId: string | null;
  readonly isInternal: boolean;
}

export function ctxFor(userId: string): ScenarioCtx {
  return { userId, clientId: null, isInternal: true };
}

export function requestWithKey<TBody>(body: TBody, ctx: ScenarioCtx, idempotencyKey?: string): ApiRequest<TBody> {
  return { headers: { [IDEMPOTENCY_KEY_HEADER_NAME]: idempotencyKey ?? randomUUID() }, body, ctx };
}

export interface CorrelationTracker {
  /** correlationId is a plain field on every command body (never derived from the idempotency key)
   *  — one fresh uuid per call, same as every module test's own `nextCorrelationId` use. */
  readonly next: () => string;
  /** Every id this tracker ever handed out — teardown deletes `platform.outbox` rows keyed on
   *  these (fix round finding 2: `platform.outbox` is NOT protected like `platform.audit_log`;
   *  precedent modules/wms/tests/process-outbound/process-outbound.test.ts:856). */
  readonly all: () => readonly string[];
}

/** A FACTORY, not a shared singleton — same reasoning as `./pool.js`'s `createPool()`: `workers: 1`
 *  reuses one Node process across both spec files, so a shared module-level Set would mix S1's and
 *  S2's correlation ids together. Each spec file creates its own tracker. */
export function createCorrelationTracker(): CorrelationTracker {
  const ids: string[] = [];
  return {
    next: () => {
      const id = randomUUID();
      ids.push(id);
      return id;
    },
    all: () => ids,
  };
}
