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

import { createHash } from 'node:crypto';

import { ZodError } from 'zod';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import { ConfirmCommissionInputSchema } from '@pg-eos/contracts/hr/confirm-commission';
import { IdempotencyConflictError, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { confirmCommission, type ConfirmCommissionDeps } from '../../application/confirm-commission/index.js';
import {
  ConfirmPermissionRequiredError,
  DisputeWindowStillOpenError,
  IllegalTransitionError,
  MissingActorError,
  SelfReviewNotAllowedError,
  StaleVersionError,
} from '../../domain/confirm-commission/errors.js';

const IDEMPOTENCY_ENDPOINT_CONFIRM = 'hr.confirm-commission.confirm-commission';

export interface ApiHeaders {
  readonly [headerName: string]: string | undefined;
}

export interface ApiRequest<TBody> {
  readonly headers: ApiHeaders;
  readonly body: TBody;
  readonly ctx: WithContextCtx;
}

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

export interface ApiSuccess<TBody> {
  readonly status: typeof HTTP_STATUS_OK;
  readonly body: TBody;
}

export interface ApiFailure {
  readonly status: number;
  readonly body: Problem;
}

export type ApiResult<TBody> = ApiSuccess<TBody> | ApiFailure;

const IDEMPOTENCY_KEY_HEADER_LOWER = IDEMPOTENCY_KEY_HEADER_NAME.toLowerCase();
const PROBLEM_TYPE_BASE = 'https://pg-eos.local/problems/';

function findHeader(headers: ApiHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }
  return undefined;
}

const UNKNOWN_ERROR_DETAIL = 'An unexpected error occurred. (Allowed: retry, or report it with the correlationId.)';

function problem(status: number, title: string, detail: string): ApiFailure {
  return {
    status,
    body: { type: `${PROBLEM_TYPE_BASE}${title.toLowerCase().replace(/\s+/g, '-')}`, title, status, detail, instance: '' },
  };
}

function requireIdempotencyKey(headers: ApiHeaders): ApiFailure | undefined {
  const value = findHeader(headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!value) {
    return problem(
      PROBLEM_STATUS.BAD_REQUEST,
      'Idempotency-Key required',
      `every write endpoint requires the ${IDEMPOTENCY_KEY_HEADER_NAME} header (doc 40 §A4).`,
    );
  }
  return undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function requestHashOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

function buildIdem(request: ApiRequest<unknown>, endpoint: string, parsedBody: unknown): IdempotencyInput {
  const key = findHeader(request.headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!key) {
    throw new Error('buildIdem: Idempotency-Key header missing (requireIdempotencyKey should have caught this).');
  }
  return { key, endpoint, requestHash: requestHashOf(parsedBody), entityId: null, successStatus: HTTP_STATUS_OK };
}

function extractCorrelationId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'correlationId' in body) {
    const value = (body as Record<string, unknown>)['correlationId'];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

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
