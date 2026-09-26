// modules/imile/api/evaluate-dtl-problem/handlers.ts — WBS 3.17 (part 1).
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/imile/evaluate-dtl-problem.ts, an Idempotency-Key header required on the
// write (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope. A future NestJS controller wraps this one-to-one; no business logic lives here.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - IdempotencyConflictError (SCR-PLAT-IDEM-01) maps to 409;
//   - MissingActorError maps to 422 (PROBLEM_STATUS has no 404) — same convention this module's
//     other use cases already follow;
//   - an UNKNOWN error (including PortNotConfiguredError — a configuration/programming error,
//     never caught inside evaluateDtlProblem) maps to a 500 Problem — never rethrown, never
//     crashes the caller, and is logged server-side via deps.logger.error before the Problem is
//     returned (CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants here,
//     alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): the write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to evaluateDtlProblem as `idem` — the command itself runs its DB-writing transaction inside
// withIdempotentContext (packages/db/src/idempotency.ts). A replay never re-runs the command; a
// same-key/different-body call is a 409 IdempotencyConflictError caught by errorToApiFailure below.
// `entityId` is always null — imile.dtl_problems has no entity_id column (brief, Design).

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
import { EvaluateDtlProblemInputSchema } from '@pg-eos/contracts/imile/evaluate-dtl-problem';
import { IdempotencyConflictError } from '@pg-eos/db';

import { evaluateDtlProblem, type EvaluateDtlProblemDeps } from '../../application/evaluate-dtl-problem/index.js';
import { MissingActorError } from '../../domain/evaluate-dtl-problem/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_EVALUATE = 'imile.evaluate-dtl-problem.evaluate';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. An error NOT in this list is unknown (including PortNotConfiguredError and any
 *  untyped error the injected content-analysis port throws) — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (error instanceof MissingActorError) {
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
  deps: EvaluateDtlProblemDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'imile.evaluate-dtl-problem: unhandled error');
    }
    return failure;
  }
}

export async function handleEvaluateDtlProblem(
  request: ApiRequest<unknown>,
  deps: EvaluateDtlProblemDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof evaluateDtlProblem>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = EvaluateDtlProblemInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_EVALUATE, input);
      return evaluateDtlProblem(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
