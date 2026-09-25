// modules/fleet/api/assert-vehicle-assignable/handlers.ts — WBS 3.1.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/fleet/assert-vehicle-assignable.ts. UNLIKE ../register-vehicle/handlers.ts,
// this endpoint requires NO Idempotency-Key header — brief, second Contract section: "No
// Idempotency-Key — this is a pure read-and-assert, no write, no side effect."
//
// Response-shape decisions PINNED by ../../tests/assert-vehicle-assignable/handlers.test.ts (file
// header there — status-code mapping not dictated by the brief, decided at build time):
//   - success -> HTTP 200, `body: undefined`;
//   - VehicleNotAssignableError -> HTTP 422 (same status class as this module's OWN established
//     convention for a typed business-rule rejection, ../register-vehicle/handlers.ts's own
//     VehicleDocumentAccessDeniedError -> 422); its Problem body also carries `i18nKey`/`params`
//     (review-round 2 finding 5, following modules/wms/api/process-outbound/handlers.ts's own
//     ProblemBody-with-i18nKey-and-params precedent);
//   - VehicleDocumentAccessDeniedError (review-round 2 finding 1's refusal, reused from
//     ../register-vehicle/errors.ts) -> HTTP 422, same convention as register-vehicle's own handler;
//   - VehicleNotFoundError -> HTTP 404 (PROBLEM_STATUS, packages/contracts/_shared/problem.ts, has
//     no 404 constant — a local literal constant is used here, same discipline as
//     HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR in ../register-vehicle/handlers.ts);
//   - a Zod contract failure -> HTTP 400;
//   - any OTHER unknown error -> HTTP 500 Problem, logged server-side via deps.logger.error before
//     the Problem is returned (CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino").

import { ZodError } from 'zod';

import { PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import { AssertVehicleAssignableInputSchema } from '@pg-eos/contracts/fleet/assert-vehicle-assignable';
import type { WithContextCtx } from '@pg-eos/db';

import { assertVehicleAssignable, type AssertVehicleAssignableDeps } from '../../application/assert-vehicle-assignable/index.js';
import { VehicleNotAssignableError, VehicleNotFoundError } from '../../domain/assert-vehicle-assignable/errors.js';
import { VehicleDocumentAccessDeniedError } from '../../domain/register-vehicle/errors.js';

export interface ApiHeaders {
  readonly [headerName: string]: string | undefined;
}

export interface ApiRequest<TBody> {
  readonly headers: ApiHeaders;
  readonly body: TBody;
  readonly ctx: WithContextCtx;
}

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

export interface ApiSuccess<TBody> {
  readonly status: typeof HTTP_STATUS_OK;
  readonly body: TBody;
}

/** Review-round 2 finding 5: a condition-check failure's Problem body ALSO carries the typed
 *  error's `.i18nKey`/`.params` — packages/contracts/_shared/problem.ts's `ProblemSchema` (frozen,
 *  five required fields only) is never edited; this is a structural extension of `Problem`, not a
 *  contract change. Same shape as modules/wms/api/process-outbound/handlers.ts's own `ProblemBody`. */
export interface ProblemBody extends Problem {
  readonly i18nKey?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ApiFailure {
  readonly status: number;
  readonly body: ProblemBody;
}

export type ApiResult<TBody> = ApiSuccess<TBody> | ApiFailure;

const PROBLEM_TYPE_BASE = 'https://pg-eos.local/problems/';

const UNKNOWN_ERROR_DETAIL = 'An unexpected error occurred. (Allowed: retry, or report it with the correlationId.)';

function problem(
  status: number,
  title: string,
  detail: string,
  i18n?: { readonly i18nKey: string; readonly params: Readonly<Record<string, unknown>> },
): ApiFailure {
  return {
    status,
    body: {
      type: `${PROBLEM_TYPE_BASE}${title.toLowerCase().replace(/\s+/g, '-')}`,
      title,
      status,
      detail,
      instance: '',
      ...(i18n ? { i18nKey: i18n.i18nKey, params: i18n.params } : {}),
    },
  };
}

/** Reads `body.correlationId` without ever asserting `any` — used only to enrich the 500 log line
 *  below; the command's own input also carries `correlationId`, but a 500 can happen before the
 *  body even parses, so this reads the raw, pre-validation body defensively. */
function extractCorrelationId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'correlationId' in body) {
    const value = (body as Record<string, unknown>)['correlationId'];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. An error NOT in this list is genuinely unknown, mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof VehicleNotAssignableError) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message, {
      i18nKey: error.i18nKey,
      params: { plateNo: error.plateNo, expiredDocuments: error.expiredDocuments },
    });
  }
  if (error instanceof VehicleDocumentAccessDeniedError) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  if (error instanceof VehicleNotFoundError) {
    return problem(HTTP_STATUS_NOT_FOUND, error.name, error.message);
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
  deps: AssertVehicleAssignableDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'fleet.assert-vehicle-assignable: unhandled error');
    }
    return failure;
  }
}

/** No Idempotency-Key header is required — brief, second Contract section: "No Idempotency-Key —
 *  this is a pure read-and-assert, no write, no side effect." Success is HTTP 200 with
 *  `body: undefined`. */
export async function handleAssertVehicleAssignable(
  request: ApiRequest<unknown>,
  deps: AssertVehicleAssignableDeps,
): Promise<ApiResult<void>> {
  return handle(
    () => {
      const input = AssertVehicleAssignableInputSchema.parse(request.body);
      return assertVehicleAssignable(
        request.ctx,
        { vehicleId: input.vehicleId, at: new Date(input.at), correlationId: input.correlationId },
        deps,
      );
    },
    deps,
    extractCorrelationId(request.body),
  );
}
