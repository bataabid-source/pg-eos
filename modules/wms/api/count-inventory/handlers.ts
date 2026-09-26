// modules/wms/api/count-inventory/handlers.ts — WBS 2.13 (lane 2).
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/wms/count-inventory.ts, an Idempotency-Key header required on every write
// (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem envelope.
// Same shape as ../receive-inbound/handlers.ts, the golden slice.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - WarehouseNotFoundError, CountNotFoundError, LineNotFoundError, SkuNotFoundError,
//     AlreadyCountedError, NotFlaggedForRecountError, RecountRequiredError,
//     MovementUomNotFoundError, AdjustmentPostingError, CountFilterRequiredError,
//     IllegalTransitionError, RoleRequiredError, MissingActorError and the reused ledger's own
//     InvalidQuantityError / LocationLimitExceededError / LocationBlockedError /
//     NegativeStockError all map to 422 (PROBLEM_STATUS has no 404, same as
//     ../receive-inbound/handlers.ts);
//   - StaleVersionError and IdempotencyConflictError map to 409;
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, logged server-side via
//     deps.logger.error before the Problem is returned (CLAUDE.md · AGENT CONSTRAINTS "No
//     console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`).
//
// D2 — the blind-count contract enforced at the response layer: handleCountLocation's and
// handleRecount's success body is exactly what countLocation/recount themselves return
// ({ lineId, recorded: true }) — this file adds no field to it.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): every write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to its command as `idem` — the command itself runs the whole thing inside
// withIdempotentContext (packages/db/src/idempotency.ts).

import { ZodError } from 'zod';

import {
  buildIdem,
  extractCorrelationId,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  problem,
  requireIdempotencyKey,
  UNKNOWN_ERROR_DETAIL,
  type ApiFailure,
  type ApiRequest,
  type ApiResult,
} from '@pg-eos/api-kit';
import { PROBLEM_STATUS } from '@pg-eos/contracts';
import {
  AdjustCountInputSchema,
  CountLocationInputSchema,
  RecountInputSchema,
  StartCountInputSchema,
} from '@pg-eos/contracts/wms/count-inventory';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  adjustCount,
  countLocation,
  recount,
  startCount,
  type CountInventoryDeps,
} from '../../application/count-inventory/index.js';
import {
  AdjustmentPostingError,
  AlreadyCountedError,
  CountFilterRequiredError,
  CountNotFoundError,
  IllegalTransitionError,
  LineNotFoundError,
  MissingActorError,
  MovementUomNotFoundError,
  NotFlaggedForRecountError,
  RecountRequiredError,
  RoleRequiredError,
  SkuNotFoundError,
  StaleVersionError,
  WarehouseNotFoundError,
} from '../../domain/count-inventory/errors.js';
import {
  InvalidQuantityError,
  LocationBlockedError,
  LocationLimitExceededError,
  NegativeStockError,
} from '../../src/stock-ledger/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_START_COUNT = 'wms.count-inventory.start-count';
const IDEMPOTENCY_ENDPOINT_COUNT_LOCATION = 'wms.count-inventory.count-location';
const IDEMPOTENCY_ENDPOINT_RECOUNT = 'wms.count-inventory.recount';
const IDEMPOTENCY_ENDPOINT_ADJUST_COUNT = 'wms.count-inventory.adjust-count';

/** Maps every typed error this use case (or the reused stock-ledger it calls) can throw to its
 *  HTTP status. `title` is always `error.name`. PROBLEM_STATUS has no 404, so every "not found"
 *  error maps to 422 alongside every other business-rule rejection. An error NOT in this list is
 *  unknown — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof IllegalTransitionError ||
    error instanceof RoleRequiredError ||
    error instanceof AlreadyCountedError ||
    error instanceof NotFlaggedForRecountError ||
    error instanceof RecountRequiredError ||
    error instanceof CountFilterRequiredError ||
    error instanceof WarehouseNotFoundError ||
    error instanceof CountNotFoundError ||
    error instanceof LineNotFoundError ||
    error instanceof SkuNotFoundError ||
    error instanceof MovementUomNotFoundError ||
    error instanceof AdjustmentPostingError ||
    error instanceof MissingActorError ||
    error instanceof InvalidQuantityError ||
    error instanceof LocationLimitExceededError ||
    error instanceof LocationBlockedError ||
    error instanceof NegativeStockError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  // An unknown error's own message may carry SQL or table names — never sent to the client. The
  // server-side record is the deps.logger.error call in handle() below; the response stays generic.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** Every unknown (500) error is logged via deps.logger.error before the Problem envelope is
 *  returned — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." */
async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: CountInventoryDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'wms.count-inventory: unhandled error');
    }
    return failure;
  }
}

export async function handleStartCount(
  request: ApiRequest<unknown>,
  deps: CountInventoryDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof startCount>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = StartCountInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_START_COUNT, input);
      return startCount(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleCountLocation(
  request: ApiRequest<unknown>,
  deps: CountInventoryDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof countLocation>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CountLocationInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_COUNT_LOCATION, input);
      return countLocation(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleRecount(
  request: ApiRequest<unknown>,
  deps: CountInventoryDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof recount>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = RecountInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_RECOUNT, input);
      return recount(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleAdjustCount(
  request: ApiRequest<unknown>,
  deps: CountInventoryDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof adjustCount>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = AdjustCountInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_ADJUST_COUNT, input);
      return adjustCount(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
