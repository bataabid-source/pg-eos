// modules/hr/api/maintain-shift/handlers.ts — WBS 5.5a part 2 (lane 2).
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/hr/maintain-shift.ts, an Idempotency-Key header required on every WRITE
// (CLAUDE.md · ARCHITECTURE) — all four commands here are writes, every typed domain error mapped
// to the RFC 9457 Problem envelope. Shape copied from the platform/maintain-site precedent
// (../../../platform/api/maintain-site/handlers.ts).
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     (including an empty daysOfWeek) produces a 400 Problem (BAD_REQUEST) instead of an uncaught
//     ZodError;
//   - StaleVersionError / IdempotencyConflictError / ShiftCodeTakenError / ShiftGroupCodeTakenError
//     (pg-reviewer round-1 finding 7) -> 409;
//   - ShiftAssignmentOverlapError, ShiftGroupShiftMismatchError, ShiftAssignmentNotFoundError,
//     ShiftGroupNotFoundError, RoleRequiredError, EntityScopeAmbiguousError, MissingActorError,
//     ShiftAssignmentRangeInvalidError, ShiftAssignmentAlreadyEndedError, DaysOfWeekInvalidError,
//     ShiftGraceMinutesInvalidError, ShiftGroupTypeInvalidError (pg-reviewer round-1 findings
//     1/2/3/5/6) -> 422 (PROBLEM_STATUS has no 404, so the two NotFoundError variants also map to
//     422, same discipline as SiteNotFoundError in the platform/maintain-site precedent);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller, and is
//     logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md · AGENT
//     CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants here,
//     alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): every WRITE handler below builds an IdempotencyInput from the
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
  AssignShiftInputSchema,
  CreateShiftGroupInputSchema,
  CreateShiftInputSchema,
  EndShiftAssignmentInputSchema,
} from '@pg-eos/contracts/hr/maintain-shift';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  assignShift,
  createShift,
  createShiftGroup,
  endShiftAssignment,
  type MaintainShiftDeps,
} from '../../application/maintain-shift/index.js';
import {
  DaysOfWeekInvalidError,
  EntityScopeAmbiguousError,
  MissingActorError,
  RoleRequiredError,
  ShiftAssignmentAlreadyEndedError,
  ShiftAssignmentNotFoundError,
  ShiftAssignmentOverlapError,
  ShiftAssignmentRangeInvalidError,
  ShiftCodeTakenError,
  ShiftGraceMinutesInvalidError,
  ShiftGroupCodeTakenError,
  ShiftGroupNotFoundError,
  ShiftGroupShiftMismatchError,
  ShiftGroupTypeInvalidError,
  StaleVersionError,
} from '../../domain/maintain-shift/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// REPLACE-ON-COPY: this use case's own idempotency endpoint identifiers, one per write command.
const IDEMPOTENCY_ENDPOINT_CREATE_SHIFT = 'hr.maintain-shift.create-shift';
const IDEMPOTENCY_ENDPOINT_CREATE_SHIFT_GROUP = 'hr.maintain-shift.create-shift-group';
const IDEMPOTENCY_ENDPOINT_ASSIGN_SHIFT = 'hr.maintain-shift.assign-shift';
const IDEMPOTENCY_ENDPOINT_END_SHIFT_ASSIGNMENT = 'hr.maintain-shift.end-shift-assignment';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404 (only 400/409/422), so the two NotFoundError variants
 *  map to 422 alongside every other business-rule rejection. An error NOT in this list is
 *  unknown — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (
    error instanceof StaleVersionError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ShiftCodeTakenError ||
    error instanceof ShiftGroupCodeTakenError
  ) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof ShiftAssignmentOverlapError ||
    error instanceof ShiftGroupShiftMismatchError ||
    error instanceof ShiftAssignmentNotFoundError ||
    error instanceof ShiftGroupNotFoundError ||
    error instanceof RoleRequiredError ||
    error instanceof EntityScopeAmbiguousError ||
    error instanceof MissingActorError ||
    error instanceof ShiftAssignmentRangeInvalidError ||
    error instanceof ShiftAssignmentAlreadyEndedError ||
    error instanceof DaysOfWeekInvalidError ||
    error instanceof ShiftGraceMinutesInvalidError ||
    error instanceof ShiftGroupTypeInvalidError
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
  deps: MaintainShiftDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'hr.maintain-shift: unhandled error');
    }
    return failure;
  }
}

export async function handleCreateShift(
  request: ApiRequest<unknown>,
  deps: MaintainShiftDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof createShift>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CreateShiftInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE_SHIFT, input);
      return createShift(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleCreateShiftGroup(
  request: ApiRequest<unknown>,
  deps: MaintainShiftDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof createShiftGroup>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CreateShiftGroupInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE_SHIFT_GROUP, input);
      return createShiftGroup(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleAssignShift(
  request: ApiRequest<unknown>,
  deps: MaintainShiftDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof assignShift>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = AssignShiftInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_ASSIGN_SHIFT, input);
      return assignShift(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleEndShiftAssignment(
  request: ApiRequest<unknown>,
  deps: MaintainShiftDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof endShiftAssignment>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = EndShiftAssignmentInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_END_SHIFT_ASSIGNMENT, input);
      return endShiftAssignment(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
