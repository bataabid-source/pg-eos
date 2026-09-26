// modules/fleet/api/register-vehicle/handlers.ts — WBS 3.1.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/fleet/register-vehicle.ts, an Idempotency-Key header required on this write
// endpoint (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - DuplicatePlateNoError / IdempotencyConflictError -> 409;
//   - EntityScopeAmbiguousError / MissingActorError / VehicleDocumentAccessDeniedError -> 422
//     (PROBLEM_STATUS has no 404, same discipline as every prior slice's own map);
//     VehicleDocumentAccessDeniedError (pg-reviewer round 1, Finding 3) is the repository's own
//     translation of tms.vehicle_documents' internal_only RLS rejection (SQLSTATE 42501) — the RLS
//     policy remains the sole enforcement layer, this only maps its rejection to a meaningful
//     status instead of a generic 500;
//   - any OTHER unknown error maps to a 500 Problem — never rethrown, never crashes the caller, and
//     is logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md ·
//     AGENT CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants here,
//     alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): the write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes it
// to the command as `idem` — the command itself runs the whole thing inside withIdempotentContext
// (packages/db/src/idempotency.ts). A replay never re-runs the command; a same-key/different-body
// call is a 409 IdempotencyConflictError caught by errorToApiFailure below.

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
import { RegisterVehicleInputSchema } from '@pg-eos/contracts/fleet/register-vehicle';
import { IdempotencyConflictError } from '@pg-eos/db';

import { registerVehicle, type RegisterVehicleDeps } from '../../application/register-vehicle/index.js';
import {
  DuplicatePlateNoError,
  EntityScopeAmbiguousError,
  MissingActorError,
  VehicleDocumentAccessDeniedError,
} from '../../domain/register-vehicle/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_REGISTER_VEHICLE = 'fleet.register-vehicle.register-vehicle';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404 (only 400/409/422). A row-level security violation on
 *  tms.vehicle_documents is translated by the repository into VehicleDocumentAccessDeniedError
 *  before it reaches here (pg-reviewer round 1, Finding 3) — an error NOT in this list is
 *  genuinely unknown, mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof DuplicatePlateNoError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof EntityScopeAmbiguousError ||
    error instanceof MissingActorError ||
    error instanceof VehicleDocumentAccessDeniedError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  // An unknown error's own message may carry SQL or table names — never sent to the client. The
  // server-side record is the deps.logger.error call in handle() below; the response stays generic.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** Every unknown (500) error is logged via deps.logger.error before the Problem envelope is
 *  returned — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." The raw `error` value is
 *  passed under the `err` key so pino's own error serializer formats the stack trace; the HTTP
 *  response itself stays the generic UNKNOWN_ERROR_DETAIL — this is server-side only. */
async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: RegisterVehicleDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'fleet.register-vehicle: unhandled error');
    }
    return failure;
  }
}

export async function handleRegisterVehicle(
  request: ApiRequest<unknown>,
  deps: RegisterVehicleDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof registerVehicle>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = RegisterVehicleInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_REGISTER_VEHICLE, input);
      return registerVehicle(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
