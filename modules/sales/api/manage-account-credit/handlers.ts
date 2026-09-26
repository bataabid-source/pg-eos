// modules/sales/api/manage-account-credit/handlers.ts — WBS 1.8, M02 sales.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/sales/manage-account-credit.ts, an Idempotency-Key header required on every
// write (CLAUDE.md · ARCHITECTURE). `getAccountCreditStatus` has NO handler — Master decision 5:
// read-only, no Idempotency-Key (same as 1.7's `getContractForOrder`).
//
// Error mapping (Master decision 8):
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - StaleVersionError and IdempotencyConflictError -> 409 (both optimistic-concurrency style
//     conflicts);
//   - every OTHER typed domain error from ../../domain/manage-account-credit/errors.ts -> 422 (no
//     per-error whitelist);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller, and is
//     logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md · AGENT
//     CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants here,
//     alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): every write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to its command as `idem` — the command itself runs the whole thing inside
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
import {
  ReleaseCreditHoldInputSchema,
  SetCreditHoldInputSchema,
  SetCreditLimitInputSchema,
} from '@pg-eos/contracts/sales/manage-account-credit';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  releaseCreditHold,
  setCreditHold,
  setCreditLimit,
  type ManageAccountCreditDeps,
} from '../../application/manage-account-credit/index.js';
import {
  AccountNotFoundError,
  AccountOnCreditHoldError,
  InvalidCreditLimitError,
  InvalidReasonError,
  MissingActorError,
  NotOnHoldError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/manage-account-credit/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// this use case's own idempotency endpoint identifiers, one per write command (slice brief Master
// decision 7).
const IDEMPOTENCY_ENDPOINT_SET_CREDIT_LIMIT = 'sales.manage-account-credit.set-credit-limit';
const IDEMPOTENCY_ENDPOINT_SET_CREDIT_HOLD = 'sales.manage-account-credit.set-credit-hold';
const IDEMPOTENCY_ENDPOINT_RELEASE_CREDIT_HOLD = 'sales.manage-account-credit.release-credit-hold';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404, so AccountNotFoundError maps to 422 alongside every
 *  other business-rule rejection (decision 8: "every other typed domain error -> 422", no
 *  per-error whitelist). An error NOT in this list is unknown — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof AccountNotFoundError ||
    error instanceof AccountOnCreditHoldError ||
    error instanceof NotOnHoldError ||
    error instanceof RoleRequiredError ||
    error instanceof MissingActorError ||
    error instanceof InvalidCreditLimitError ||
    error instanceof InvalidReasonError
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
  deps: ManageAccountCreditDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'sales.manage-account-credit: unhandled error');
    }
    return failure;
  }
}

export async function handleSetCreditLimit(
  request: ApiRequest<unknown>,
  deps: ManageAccountCreditDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof setCreditLimit>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = SetCreditLimitInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_SET_CREDIT_LIMIT, input);
      return setCreditLimit(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleSetCreditHold(
  request: ApiRequest<unknown>,
  deps: ManageAccountCreditDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof setCreditHold>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = SetCreditHoldInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_SET_CREDIT_HOLD, input);
      return setCreditHold(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleReleaseCreditHold(
  request: ApiRequest<unknown>,
  deps: ManageAccountCreditDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof releaseCreditHold>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ReleaseCreditHoldInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_RELEASE_CREDIT_HOLD, input);
      return releaseCreditHold(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
