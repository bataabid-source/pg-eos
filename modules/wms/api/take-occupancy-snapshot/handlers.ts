// modules/wms/api/take-occupancy-snapshot/handlers.ts — WBS 2.14 (lane 2).
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/wms/take-occupancy-snapshot.ts, an Idempotency-Key header required on this
// write (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope. Same shape as ../count-inventory/handlers.ts.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - WarehouseNotFoundError, ServiceNotFoundError, RoleRequiredError, MissingActorError all map
//     to 422 (PROBLEM_STATUS has no 404, same as ../count-inventory/handlers.ts);
//   - IdempotencyConflictError maps to 409 — no StaleVersionError exists here (brief D1: no
//     version column on this aggregate);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, logged server-side via
//     deps.logger.error before the Problem is returned (CLAUDE.md · AGENT CONSTRAINTS "No
//     console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`).
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): the write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to the command as `idem` — the command itself runs the whole thing inside
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
import { TakeOccupancySnapshotInputSchema } from '@pg-eos/contracts/wms/take-occupancy-snapshot';
import { IdempotencyConflictError } from '@pg-eos/db';

import { takeOccupancySnapshot, type TakeOccupancySnapshotDeps } from '../../application/take-occupancy-snapshot/index.js';
import { MissingActorError, RoleRequiredError, ServiceNotFoundError, WarehouseNotFoundError } from '../../domain/take-occupancy-snapshot/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_TAKE_SNAPSHOT = 'wms.take-occupancy-snapshot.take-occupancy-snapshot';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404, so WarehouseNotFoundError/ServiceNotFoundError map to
 *  422 alongside every other business-rule rejection. An error NOT in this list is unknown —
 *  mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof RoleRequiredError ||
    error instanceof WarehouseNotFoundError ||
    error instanceof ServiceNotFoundError ||
    error instanceof MissingActorError
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
  deps: TakeOccupancySnapshotDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'wms.take-occupancy-snapshot: unhandled error');
    }
    return failure;
  }
}

export async function handleTakeOccupancySnapshot(
  request: ApiRequest<unknown>,
  deps: TakeOccupancySnapshotDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof takeOccupancySnapshot>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = TakeOccupancySnapshotInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_TAKE_SNAPSHOT, input);
      return takeOccupancySnapshot(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
