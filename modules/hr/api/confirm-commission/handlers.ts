// modules/hr/api/confirm-commission/handlers.ts — WBS 3.13 part 4.
//
// api/ layer: request in, response out. Framework-free async functions: Zod-validated input from
// packages/contracts/hr/confirm-commission.ts, an Idempotency-Key header required on the write,
// every typed domain error mapped to the RFC 9457 Problem envelope. Shape copied from
// dispute-commission's own handlers.ts.
//
// Error mapping (brief, Deliver's own final paragraph):
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem instead of an uncaught ZodError;
//   - IdempotencyConflictError / DisputeWindowStillOpenError / StaleVersionError map to 409;
//   - SelfReviewNotAllowedError / ConfirmPermissionRequiredError map to 403 — a LOCAL status
//     constant (`HTTP_STATUS_FORBIDDEN`), not the frozen shared
//     packages/contracts/_shared/problem.ts PROBLEM_STATUS (which names only 400/409/422 — "No
//     other numbers"), same discipline as this file's own
//     HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR;
//   - IllegalTransitionError / MissingActorError map to 422;
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, logged via deps.logger.error.

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
import { ConfirmCommissionInputSchema } from '@pg-eos/contracts/hr/confirm-commission';
import { IdempotencyConflictError } from '@pg-eos/db';

import { confirmCommission, type ConfirmCommissionDeps } from '../../application/confirm-commission/index.js';
import {
  ConfirmPermissionRequiredError,
  DisputeWindowStillOpenError,
  IllegalTransitionError,
  MissingActorError,
  SelfReviewNotAllowedError,
  StaleVersionError,
} from '../../domain/confirm-commission/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_CONFIRM = 'hr.confirm-commission.confirm-commission';

const HTTP_STATUS_FORBIDDEN = 403;

function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof DisputeWindowStillOpenError ||
    error instanceof StaleVersionError
  ) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (error instanceof SelfReviewNotAllowedError || error instanceof ConfirmPermissionRequiredError) {
    return problem(HTTP_STATUS_FORBIDDEN, error.name, error.message);
  }
  if (error instanceof IllegalTransitionError || error instanceof MissingActorError) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: ConfirmCommissionDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'hr.confirm-commission: unhandled error');
    }
    return failure;
  }
}

export async function handleConfirmCommission(
  request: ApiRequest<unknown>,
  deps: ConfirmCommissionDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof confirmCommission>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ConfirmCommissionInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CONFIRM, input);
      return confirmCommission(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
