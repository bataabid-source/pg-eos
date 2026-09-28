// packages/contracts/_shared/route-responses.ts — Master task, docs/STREAMS.md §Enablement item 6.
//
// Shared response-set builders every module's `ROUTES` export reuses, so the same doc 40 §A4
// status set (400/409/422, all with a `ProblemSchema` body) is not hand-rolled 24 times. A route
// declares a status only when its own handlers.ts maps it: 403/404 where the handler defines a
// local HTTP_STATUS_FORBIDDEN / HTTP_STATUS_NOT_FOUND, 409 unless the handler documents that it
// never maps IdempotencyConflictError (`conflict: false`), and no 409 on a GET.
//
// X part 12 (a)+(b): `withHostResponses` (below) adds the host's own statuses on top of whatever
// a route already declares — it never replaces a route's own entry (the collision rule).

import type { z } from 'zod';

import type { HttpMethod, RouteDefinitionInput, RouteResponseDefinition, RouteResponses } from './registry.js';
import { PROBLEM_STATUS, ProblemSchema } from './problem.js';

// HTTP status codes PROBLEM_STATUS does not name (doc 40 §A4 fixes only 400/403/409/422).
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

// Host statuses (X part 12 (a)+(b), brief decision 3) — every one the host itself can emit for a
// route (apps/api/src/http-status.ts, quoted verbatim in the brief so this browser-safe package
// never imports the host app; 500 is api-kit's, named again above).
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
/** ADR-0006 §4 (X part 12): the one source for the 501 number — `identity/otp-login.ts` (held
 *  until 2.16 part 1a-5) imports this instead of naming 501 itself. */
export const HTTP_STATUS_NOT_IMPLEMENTED = 501;

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

/** ADR-0006 §4 (X part 12): the one `ProblemSchema`-bodied 501 entry — `withHostResponses` uses it
 *  for a `contractFirst` route with no handler, and `identity/otp-login.ts` (held until 2.16 part
 *  1a-5) imports it instead of declaring its own. */
export const NOT_IMPLEMENTED_RESPONSE: RouteResponseDefinition = problemResponse('Not Implemented');

export interface ErrorResponseOptions {
  /** Adds 403 — only when the handler's own errorToApiFailure maps a 403. */
  readonly forbidden?: boolean;
  /** Adds 404 — only when the handler defines its own `HTTP_STATUS_NOT_FOUND` constant. */
  readonly notFound?: boolean;
  /** Write routes declare 409 unless the handler never maps IdempotencyConflictError. */
  readonly conflict?: boolean;
}

/** doc 40 §A4's write-endpoint response set: 400 (missing Idempotency-Key / bad body), 409 (key
 * reuse or a stale `version`), 422 (illegal state transition), 500 (unknown). */
export function writeErrorResponses(options: ErrorResponseOptions = {}): RouteResponses {
  const responses: RouteResponses = {
    [PROBLEM_STATUS.BAD_REQUEST]: problemResponse('Bad Request'),
    [PROBLEM_STATUS.UNPROCESSABLE_ENTITY]: problemResponse('Unprocessable Entity'),
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: problemResponse('Internal Server Error'),
  };
  if (options.conflict !== false) responses[PROBLEM_STATUS.CONFLICT] = problemResponse('Conflict');
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

// X part 12 (a)+(b), brief decision 3: every operation this host mounts passes through the same
// pipeline (server.ts's own header comment) — authenticate (401), entity scope (X-Entity-Id: 403
// and 422) and the catch-all (500) — regardless of method. A Zod contract failure is the *route's
// own* 400 (writeErrorResponses / readErrorResponses's BAD_REQUEST entry, mapped by the handler),
// never a host status added here.
//
// Each pair is `[status, description]` (nit 6: a status and its description are named together,
// so there is no separate lookup table and no unreachable "else" branch when adding one).
const EVERY_OPERATION_HOST_RESPONSES: ReadonlyArray<readonly [number, string]> = [
  [HTTP_STATUS_UNAUTHORIZED, 'Unauthorized'],
  [PROBLEM_STATUS.FORBIDDEN, 'Forbidden'],
  [PROBLEM_STATUS.UNPROCESSABLE_ENTITY, 'Unprocessable Entity'],
  [HTTP_STATUS_INTERNAL_SERVER_ERROR, 'Internal Server Error'],
];

// Fastify treats GET as bodyless (brief decision 3) — only a body-carrying method can raise a
// missing-body 400, an over-limit 413 or a wrong-content-type 415.
const BODY_CARRYING_ONLY_HOST_RESPONSES: ReadonlyArray<readonly [number, string]> = [
  [PROBLEM_STATUS.BAD_REQUEST, 'Bad Request'],
  [HTTP_STATUS_PAYLOAD_TOO_LARGE, 'Payload Too Large'],
  [HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE, 'Unsupported Media Type'],
];

const BODY_CARRYING_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The host `[status, description]` pairs `route` must additionally declare (brief decision 3):
 * every operation gets 401/403/422/500; a body-carrying method also gets 400/413/415. (501 is
 * handled separately in `withHostResponses` — it needs `NOT_IMPLEMENTED_RESPONSE`, not a fresh
 * description.) */
function hostResponsePairsFor(route: RouteDefinitionInput): ReadonlyArray<readonly [number, string]> {
  return BODY_CARRYING_METHODS.has(route.method)
    ? [...EVERY_OPERATION_HOST_RESPONSES, ...BODY_CARRYING_ONLY_HOST_RESPONSES]
    : EVERY_OPERATION_HOST_RESPONSES;
}

/**
 * Returns a new route whose `responses` add every host status (brief decision 3): 401, 403, 422
 * and 500 on every method; 400, 413 and 415 on POST/PUT/PATCH/DELETE only; 501
 * (`NOT_IMPLEMENTED_RESPONSE`) only when `route.contractFirst === true`. Every added body is
 * `ProblemSchema`.
 *
 * Collision rule: a status the route already declares keeps its own entry object — it is never
 * replaced, so `identity/otp-login`'s own 501 (held until 2.16 part 1a-5) and any route's own
 * 422/500 entry survive unchanged.
 */
export function withHostResponses(route: RouteDefinitionInput): RouteDefinitionInput {
  const responses: RouteResponses = { ...route.responses };

  for (const [status, description] of hostResponsePairsFor(route)) {
    if (responses[status] !== undefined) continue;
    responses[status] = problemResponse(description);
  }

  if (route.contractFirst === true && responses[HTTP_STATUS_NOT_IMPLEMENTED] === undefined) {
    responses[HTTP_STATUS_NOT_IMPLEMENTED] = NOT_IMPLEMENTED_RESPONSE;
  }

  return { ...route, responses };
}
