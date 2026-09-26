// packages/contracts/_shared/route-responses.ts — Master task, docs/STREAMS.md §Enablement item 6.
//
// Shared response-set builders every module's `ROUTES` export reuses, so the same doc 40 §A4
// status set (400/409/422, all with a `ProblemSchema` body) is not hand-rolled 24 times. A write
// route additionally gets 403/404 only when its own handlers.ts actually maps that status (the
// Master brief's literal rule: 403 only on a `PROBLEM_STATUS.FORBIDDEN` grep hit — none exists
// today, brief default recorded in the closing report; 404 only when the handler defines a local
// `HTTP_STATUS_NOT_FOUND` constant).

import type { z } from 'zod';

import type { RouteResponseDefinition, RouteResponses } from './registry.js';
import { PROBLEM_STATUS, ProblemSchema } from './problem.js';

// HTTP status codes PROBLEM_STATUS does not name (doc 40 §A4 fixes only 400/403/409/422).
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

/** A 200 with no response body — every command whose contract file exports no result/output
 * schema (never invent one). */
export const OK_RESPONSE: RouteResponseDefinition = { description: 'OK' };

/** A 200 with the given result schema as its body. */
export function okWithBody(body: z.ZodType): RouteResponseDefinition {
  return { description: 'OK', body };
}

function problemResponse(description: string): RouteResponseDefinition {
  return { description, body: ProblemSchema };
}

export interface ErrorResponseOptions {
  /** Adds 403 — only when the handler's own errorToApiFailure maps a FORBIDDEN error
   * (grep `PROBLEM_STATUS.FORBIDDEN`, per the Master brief's literal rule). */
  readonly forbidden?: boolean;
  /** Adds 404 — only when the handler defines its own `HTTP_STATUS_NOT_FOUND` constant. */
  readonly notFound?: boolean;
}

/** doc 40 §A4's write-endpoint response set: 400 (missing Idempotency-Key / bad body), 409 (key
 * reuse or a stale `version`), 422 (illegal state transition), 500 (unknown). */
export function writeErrorResponses(options: ErrorResponseOptions = {}): RouteResponses {
  const responses: RouteResponses = {
    [PROBLEM_STATUS.BAD_REQUEST]: problemResponse('Bad Request'),
    [PROBLEM_STATUS.CONFLICT]: problemResponse('Conflict'),
    [PROBLEM_STATUS.UNPROCESSABLE_ENTITY]: problemResponse('Unprocessable Entity'),
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: problemResponse('Internal Server Error'),
  };
  if (options.forbidden) responses[PROBLEM_STATUS.FORBIDDEN] = problemResponse('Forbidden');
  if (options.notFound) responses[HTTP_STATUS_NOT_FOUND] = problemResponse('Not Found');
  return responses;
}

/** A read-only (GET, no Idempotency-Key) route's response set: no 409 — that status is doc 40
 * §A4's write-conflict status, and a GET here never runs the idempotency machinery that could
 * raise it. */
export function readErrorResponses(options: ErrorResponseOptions = {}): RouteResponses {
  const responses: RouteResponses = {
    [PROBLEM_STATUS.BAD_REQUEST]: problemResponse('Bad Request'),
    [PROBLEM_STATUS.UNPROCESSABLE_ENTITY]: problemResponse('Unprocessable Entity'),
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: problemResponse('Internal Server Error'),
  };
  if (options.forbidden) responses[PROBLEM_STATUS.FORBIDDEN] = problemResponse('Forbidden');
  if (options.notFound) responses[HTTP_STATUS_NOT_FOUND] = problemResponse('Not Found');
  return responses;
}
