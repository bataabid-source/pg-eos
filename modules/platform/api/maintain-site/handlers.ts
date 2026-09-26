// modules/platform/api/maintain-site/handlers.ts — WBS 5.5a part 1 (lane 2).
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/platform/maintain-site.ts, an Idempotency-Key header required on every WRITE
// (CLAUDE.md · ARCHITECTURE) — both CreateSite and UpdateSite are writes, every typed domain error
// mapped to the RFC 9457 Problem envelope. Shape copied from the hr/register-employee precedent
// (modules/hr/api/register-employee/handlers.ts).
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     (including an invalid `kind`) produces a 400 Problem (BAD_REQUEST) instead of an uncaught
//     ZodError;
//   - StaleVersionError / IdempotencyConflictError -> 409;
//   - SiteNotFoundError, SiteAccountRequiredError, SiteKindInvalidError, SiteRadiusInvalidError,
//     RoleRequiredError, EntityScopeAmbiguousError, MissingActorError -> 422 (PROBLEM_STATUS has
//     no 404, so
//     SiteNotFoundError also maps to 422, same discipline as EmployeeNotFoundError in the
//     hr/register-employee precedent);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller, and is
//     logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md · AGENT
//     CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants here,
//     alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): every WRITE handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to its command as `idem` — the command itself runs the whole thing inside
// withIdempotentContext (packages/db/src/idempotency.ts).

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
import { CreateSiteInputSchema, UpdateSiteInputSchema } from '@pg-eos/contracts/platform/maintain-site';
import { IdempotencyConflictError } from '@pg-eos/db';

import { createSite, updateSite, type MaintainSiteDeps } from '../../application/maintain-site/index.js';
import {
  EntityScopeAmbiguousError,
  MissingActorError,
  RoleRequiredError,
  SiteAccountRequiredError,
  SiteKindInvalidError,
  SiteNotFoundError,
  SiteRadiusInvalidError,
  StaleVersionError,
} from '../../domain/maintain-site/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// REPLACE-ON-COPY: this use case's own idempotency endpoint identifiers, one per write command.
const IDEMPOTENCY_ENDPOINT_CREATE_SITE = 'platform.maintain-site.create-site';
const IDEMPOTENCY_ENDPOINT_UPDATE_SITE = 'platform.maintain-site.update-site';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404 (only 400/409/422), so SiteNotFoundError maps to 422
 *  alongside every other business-rule rejection. An error NOT in this list is unknown — mapped
 *  to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof SiteAccountRequiredError ||
    error instanceof SiteKindInvalidError ||
    error instanceof SiteRadiusInvalidError ||
    error instanceof SiteNotFoundError ||
    error instanceof RoleRequiredError ||
    error instanceof EntityScopeAmbiguousError ||
    error instanceof MissingActorError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
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
  deps: MaintainSiteDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'platform.maintain-site: unhandled error');
    }
    return failure;
  }
}

export async function handleCreateSite(
  request: ApiRequest<unknown>,
  deps: MaintainSiteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof createSite>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CreateSiteInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE_SITE, input);
      return createSite(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleUpdateSite(
  request: ApiRequest<unknown>,
  deps: MaintainSiteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof updateSite>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = UpdateSiteInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_UPDATE_SITE, input);
      return updateSite(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
