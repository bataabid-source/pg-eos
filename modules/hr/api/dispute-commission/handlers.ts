// modules/hr/api/dispute-commission/handlers.ts — WBS 3.13 part 4.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/hr/dispute-commission.ts, an Idempotency-Key header required on the write
// (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem envelope.
// Shape copied from calculate-daily-commission's own handlers.ts.
//
// Error mapping (brief, Deliver's own final paragraph; round-1 review finding 2 adds the
// CannotDisputeAnotherEmployeesRowError line):
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem instead of an uncaught ZodError;
//   - IdempotencyConflictError maps to 409;
//   - DisputeWindowExpiredError / StaleVersionError map to 409 (a real conflict);
//   - CannotDisputeAnotherEmployeesRowError maps to 403 — a LOCAL status constant
//     (`HTTP_STATUS_FORBIDDEN`), not the frozen shared packages/contracts/_shared/problem.ts
//     PROBLEM_STATUS (which names only 400/409/422 — "No other numbers"), same discipline as
//     confirm-commission's own handlers.ts SelfReviewNotAllowedError/ConfirmPermissionRequiredError
//     mapping;
//   - IllegalTransitionError maps to 422;
//   - MissingActorError maps to 422 (cross-module convention);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, logged via deps.logger.error
//     (CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino").

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
import { DisputeCommissionInputSchema } from '@pg-eos/contracts/hr/dispute-commission';
import { IdempotencyConflictError } from '@pg-eos/db';

import { disputeCommission, type DisputeCommissionDeps } from '../../application/dispute-commission/index.js';
import {
  CannotDisputeAnotherEmployeesRowError,
  DisputeWindowExpiredError,
  IllegalTransitionError,
  MissingActorError,
  StaleVersionError,
} from '../../domain/dispute-commission/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_DISPUTE = 'hr.dispute-commission.dispute-commission';

const HTTP_STATUS_FORBIDDEN = 403;

function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof IdempotencyConflictError || error instanceof DisputeWindowExpiredError || error instanceof StaleVersionError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (error instanceof CannotDisputeAnotherEmployeesRowError) {
    return problem(HTTP_STATUS_FORBIDDEN, error.name, error.message);
  }
  if (error instanceof IllegalTransitionError || error instanceof MissingActorError) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: DisputeCommissionDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'hr.dispute-commission: unhandled error');
    }
    return failure;
  }
}

export async function handleDisputeCommission(
  request: ApiRequest<unknown>,
  deps: DisputeCommissionDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof disputeCommission>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = DisputeCommissionInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_DISPUTE, input);
      return disputeCommission(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
