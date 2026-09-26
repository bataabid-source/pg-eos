// modules/wms/api/schedule-inbound/handlers.ts — WBS 2.9b (lane 2).
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/wms/schedule-inbound.ts, an Idempotency-Key header required on the write
// command (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope. Shape copied from ../manage-space/handlers.ts (brief Read list). ScheduleInbound's
// legality IS machine-gated (INBOUND_ORDER_EVENTS.SCHEDULE, a self-transition — no NEW state, only
// a version bump; round-1 review finding 12). No handler for listScheduledAppointmentsToday: it is a read, no UI this slice
// (brief Facts) — the application function is the deliverable, not an endpoint.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - ScheduleInPastError, InvalidVehicleTypeError, InvalidHandoverPointError,
//     InvalidTransportByError, InvalidLabourByError, InvalidLabourCountError,
//     IllegalTransitionError, RoleRequiredError, OrderNotFoundError, MissingActorError -> 422
//     (PROBLEM_STATUS has no 404);
//   - StaleVersionError -> 409;
//   - IdempotencyConflictError -> 409 (SCR-PLAT-IDEM-01);
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
import { ScheduleInboundInputSchema } from '@pg-eos/contracts/wms/schedule-inbound';
import { IdempotencyConflictError } from '@pg-eos/db';

import { scheduleInbound, type ScheduleInboundDeps } from '../../application/schedule-inbound/index.js';
import {
  IllegalTransitionError,
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
  MissingActorError,
  OrderNotFoundError,
  RoleRequiredError,
  ScheduleInPastError,
  StaleVersionError,
} from '../../domain/schedule-inbound/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_SCHEDULE_INBOUND = 'wms.schedule-inbound.schedule';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404 (only 400/409/422). An error NOT in this list is
 *  unknown — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof IdempotencyConflictError || error instanceof StaleVersionError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof ScheduleInPastError ||
    error instanceof InvalidVehicleTypeError ||
    error instanceof InvalidHandoverPointError ||
    error instanceof InvalidTransportByError ||
    error instanceof InvalidLabourByError ||
    error instanceof InvalidLabourCountError ||
    error instanceof IllegalTransitionError ||
    error instanceof RoleRequiredError ||
    error instanceof OrderNotFoundError ||
    error instanceof MissingActorError
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
  deps: ScheduleInboundDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'wms.schedule-inbound: unhandled error');
    }
    return failure;
  }
}

export async function handleScheduleInbound(
  request: ApiRequest<unknown>,
  deps: ScheduleInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof scheduleInbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ScheduleInboundInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_SCHEDULE_INBOUND, input);
      return scheduleInbound(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
