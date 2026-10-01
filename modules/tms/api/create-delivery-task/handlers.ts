// modules/tms/api/create-delivery-task/handlers.ts — WBS 3.4 part 1.
//
// api/ layer: request in, response out. Framework-free async function (no NestJS app yet): Zod-
// validated input from packages/contracts/tms/create-delivery-task.ts, an Idempotency-Key header
// required (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope. A future NestJS controller wraps it one-to-one; no business logic lives here.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body is a
//     400 Problem instead of an uncaught ZodError;
//   - StaleVersionError / DeliveryTaskAlreadyExistsError / IdempotencyConflictError -> 409;
//   - OrderNotReadyError / AddressIncompleteError / OrderNotFoundError / MissingActorError /
//     EntityScopeRequiredError (@pg-eos/db) -> 422 (PROBLEM_STATUS has no 404);
//   - the three keyed errors also carry their `i18nKey` in the Problem body (a structural extension
//     of the frozen `Problem`, same shape as modules/fleet/api/assert-vehicle-assignable);
//   - an UNKNOWN error -> 500 with the generic UNKNOWN_ERROR_DETAIL, never rethrown, logged through
//     deps.logger.error({ correlationId, err });
//   - `title` is always `error.name` (or 'ZodError' / 'InternalServerError').
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): buildIdem hashes the CANONICAL parsed body; the command runs inside
// withIdempotentContext. A replay never re-runs the command; same key + different body -> 409.

import { ZodError } from 'zod';

import {
  buildIdem,
  extractCorrelationId,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  problem,
  requireIdempotencyKey,
  UNKNOWN_ERROR_DETAIL,
  type ApiRequest,
  type ApiSuccess,
} from '@pg-eos/api-kit';
import { PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import { CreateDeliveryTaskInputSchema } from '@pg-eos/contracts/tms/create-delivery-task';
import { EntityScopeRequiredError, IdempotencyConflictError } from '@pg-eos/db';

import {
  createDeliveryTask,
  type CreateDeliveryTaskDeps,
  type CreateDeliveryTaskResult,
} from '../../application/create-delivery-task/index.js';
import {
  AddressIncompleteError,
  DeliveryTaskAlreadyExistsError,
  MissingActorError,
  OrderNotFoundError,
  OrderNotReadyError,
  StaleVersionError,
} from '../../domain/create-delivery-task/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_CREATE_DELIVERY_TASK = 'tms.create-delivery-task.create-delivery-task';

/** The Problem body, plus the typed error's `i18nKey` when it has one. */
export interface ProblemBody extends Problem {
  readonly i18nKey?: string;
}

export interface ApiFailure {
  readonly status: number;
  readonly body: ProblemBody;
}

export type ApiResult<TBody> = ApiSuccess<TBody> | ApiFailure;

function withI18nKey(failure: ApiFailure, i18nKey: string): ApiFailure {
  return { status: failure.status, body: { ...failure.body, i18nKey } };
}

/** Maps every typed error this use case can throw to its HTTP status. An error NOT in this list is
 *  unknown — 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof DeliveryTaskAlreadyExistsError) {
    return withI18nKey(problem(PROBLEM_STATUS.CONFLICT, error.name, error.message), error.i18nKey);
  }
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (error instanceof OrderNotReadyError || error instanceof AddressIncompleteError) {
    return withI18nKey(problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message), error.i18nKey);
  }
  if (
    error instanceof OrderNotFoundError ||
    error instanceof MissingActorError ||
    error instanceof EntityScopeRequiredError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  // An unknown error's own message may carry SQL or table names — never sent to the client.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: CreateDeliveryTaskDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'tms.create-delivery-task: unhandled error');
    }
    return failure;
  }
}

export async function handleCreateDeliveryTask(
  request: ApiRequest<unknown>,
  deps: CreateDeliveryTaskDeps,
): Promise<ApiResult<CreateDeliveryTaskResult>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CreateDeliveryTaskInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE_DELIVERY_TASK, input);
      return createDeliveryTask(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
