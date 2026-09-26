// modules/hr/api/calculate-daily-commission/handlers.ts — WBS 3.13 part 2.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/hr/calculate-daily-commission.ts, an Idempotency-Key header required on the
// write (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope. Shape copied from register-employee/assign-driver-id's own handlers.ts.
//
// Error mapping (brief, Deliver's own final paragraph):
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - IdempotencyConflictError (SCR-PLAT-IDEM-01) maps to 409;
//   - CommissionAlreadyCalculatedError maps to 409 (a real conflict — the DB's own unique-violation
//     translated, same class as DuplicatePlateNoError/EmployeeAlreadyAssignedError);
//   - NoApplicableCommissionRuleError / AmbiguousCommissionRuleError map to 422 (brief: "422, a
//     data-completeness problem, not a conflict");
//   - EntityScopeAmbiguousError / EmployeeNotInCallerEntityError map to 422 (round-1 review
//     findings 1 and 5 — see ../../domain/calculate-daily-commission/errors.js's own header for
//     why each is 422, not a raw 404, within this Problem envelope);
//   - NotInternalActorError maps to 422 (MASTER_BACKLOG 3.13 part 2 item 2 — a non-internal caller with a
//     real entity scope, translated from hr.commission_daily's own migration-0027 RLS write-policy
//     gate; same status as the expire-contract/RoleRequiredError precedent this class cites);
//   - MissingActorError maps to 422 (cross-module convention, same as every prior slice's own
//     handlers.ts);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller, and is
//     logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md · AGENT
//     CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants here,
//     alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): the write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to calculateDailyCommission as `idem` — the command itself runs its DB-writing transaction
// inside withIdempotentContext (packages/db/src/idempotency.ts). A replay never re-runs the
// command; a same-key/different-body call is a 409 IdempotencyConflictError caught by
// errorToApiFailure below. `entityId` is null on the idempotency key row — the command itself
// resolves the entity (same convention as register-employee's own buildIdem).

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
import { CalculateDailyCommissionInputSchema } from '@pg-eos/contracts/hr/calculate-daily-commission';
import { IdempotencyConflictError } from '@pg-eos/db';

import { calculateDailyCommission, type CalculateDailyCommissionDeps } from '../../application/calculate-daily-commission/index.js';
import {
  AmbiguousCommissionRuleError,
  CommissionAlreadyCalculatedError,
  EmployeeNotInCallerEntityError,
  EntityScopeAmbiguousError,
  MissingActorError,
  NoApplicableCommissionRuleError,
  NotInternalActorError,
} from '../../domain/calculate-daily-commission/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_CALCULATE = 'hr.calculate-daily-commission.calculate-daily-commission';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. An error NOT in this list is unknown — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof IdempotencyConflictError || error instanceof CommissionAlreadyCalculatedError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof NoApplicableCommissionRuleError ||
    error instanceof AmbiguousCommissionRuleError ||
    error instanceof EntityScopeAmbiguousError ||
    error instanceof EmployeeNotInCallerEntityError ||
    error instanceof NotInternalActorError ||
    error instanceof MissingActorError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  // An unknown error's own message may carry SQL, table names or port internals — never sent to
  // the client. The server-side record is the deps.logger.error call in handle() below; the
  // response stays generic.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** Every unknown (500) error is logged via deps.logger.error before the Problem envelope is
 *  returned — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." The raw `error` value is
 *  passed under the `err` key so pino's own error serializer formats the stack trace; the HTTP
 *  response itself stays the generic UNKNOWN_ERROR_DETAIL — this is server-side only. */
async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: CalculateDailyCommissionDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'hr.calculate-daily-commission: unhandled error');
    }
    return failure;
  }
}

export async function handleCalculateDailyCommission(
  request: ApiRequest<unknown>,
  deps: CalculateDailyCommissionDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof calculateDailyCommission>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CalculateDailyCommissionInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CALCULATE, input);
      return calculateDailyCommission(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
