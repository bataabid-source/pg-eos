// modules/platform/api/evaluate-alerts/handlers.ts — WBS 5.13 part 1, replicated (shape only)
// from the golden slice's handlers.ts (modules/wms/api/receive-inbound/handlers.ts). Scoped, per
// the build brief, to the AcknowledgeAlert handler only — EvaluateAlertRules is the pg-boss job
// body / internal trigger in part 1, not an HTTP write endpoint.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace —
// framework-free async functions: Zod-validated input from
// packages/contracts/platform/evaluate-alerts.ts, an Idempotency-Key header required (CLAUDE.md ·
// ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem envelope.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem instead of an uncaught ZodError;
//   - ActionLinkMissingError -> 400 (a bad request-shaped domain invariant, doc 40 §B6);
//   - StaleVersionError and AlertAlreadyAcknowledgedError -> 409 (both are "someone else already
//     changed this row" conflicts), alongside IdempotencyConflictError (SCR-PLAT-IDEM-01);
//   - RoleRequiredError -> 403 (PROBLEM_STATUS carries no 403 — HTTP_STATUS_FORBIDDEN is a local
//     constant here, same discipline as HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR below);
//   - MissingActorError -> 422 (the golden slice's own mapping for this error —
//     modules/wms/api/receive-inbound/handlers.ts ~L211-216);
//   - AlertLogNotFoundError -> 404 (HTTP_STATUS_NOT_FOUND, a local constant — same discipline as
//     HTTP_STATUS_FORBIDDEN);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, logged server-side via
//     deps.logger.error before the Problem is returned (CLAUDE.md · AGENT CONSTRAINTS "No
//     console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`).
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): the write handler builds an IdempotencyInput from the required
// header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes it to
// acknowledgeAlert as `idem` — the command itself runs the whole thing inside
// withIdempotentContext (packages/db/src/idempotency.ts). A replay never re-runs the command; a
// same-key/different-body call is a 409 IdempotencyConflictError caught by errorToApiFailure below.

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
import { AcknowledgeAlertInputSchema } from '@pg-eos/contracts/platform/evaluate-alerts';
import { IdempotencyConflictError } from '@pg-eos/db';

import { acknowledgeAlert, type EvaluateAlertsDeps } from '../../application/evaluate-alerts/index.js';
import {
  ActionLinkMissingError,
  AlertAlreadyAcknowledgedError,
  AlertLogNotFoundError,
  MissingActorError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/evaluate-alerts/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// REPLACE-ON-COPY: this use case's own idempotency endpoint identifier for its one write command.
const IDEMPOTENCY_ENDPOINT_ACKNOWLEDGE = 'platform.evaluate-alerts.acknowledge-alert';

const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. An error NOT in this list is unknown — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof ActionLinkMissingError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (
    error instanceof StaleVersionError ||
    error instanceof AlertAlreadyAcknowledgedError ||
    error instanceof IdempotencyConflictError
  ) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (error instanceof RoleRequiredError) {
    return problem(HTTP_STATUS_FORBIDDEN, error.name, error.message);
  }
  if (error instanceof MissingActorError) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  if (error instanceof AlertLogNotFoundError) {
    return problem(HTTP_STATUS_NOT_FOUND, error.name, error.message);
  }
  // An unknown error's own message may carry SQL or table names — never sent to the client. The
  // server-side record is the deps.logger.error call in handle() below; the response stays generic.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** Every unknown (500) error is logged via deps.logger.error before the Problem envelope is
 *  returned — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." */
async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: EvaluateAlertsDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'platform.evaluate-alerts: unhandled error');
    }
    return failure;
  }
}

export async function handleAcknowledgeAlert(
  request: ApiRequest<unknown>,
  deps: EvaluateAlertsDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof acknowledgeAlert>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = AcknowledgeAlertInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_ACKNOWLEDGE, input);
      return acknowledgeAlert({ ...input, idem }, request.ctx, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
