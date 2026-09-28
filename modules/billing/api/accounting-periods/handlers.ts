// modules/billing/api/accounting-periods/handlers.ts — WBS 4.19 (lane 2).
//
// api/ layer: request in, response out — framework-free async functions, one per FROZEN contract
// route (packages/contracts/billing/accounting-periods.ts ROUTES; the apps/api host mounts
// `handle<Operation>` for each /billing/accounting-periods/<operation>). Zod-validated input, an
// Idempotency-Key header required on every write (CLAUDE.md · ARCHITECTURE), every typed domain
// error mapped to the RFC 9457 Problem envelope (golden slice:
// modules/wms/api/receive-inbound/handlers.ts). No business logic lives here.
// applyPeriodReopenDecision has no route (internal, called by the Decision Inbox) — no handler.
//
// Error mapping (title is always error.name, or 'InternalServerError'):
//   - an invalid body (the contract schema's safeParse, before the command runs) -> 400, title
//     'ZodError' (@pg-eos/billing does not depend on zod directly — the schema carries it);
//   - StaleVersionError, IdempotencyConflictError -> 409;
//   - RoleRequiredError -> 403 (the contract declares 403 on create-fiscal-year, close and lock);
//   - IllegalPeriodTransitionError, PeriodNotFoundError, FiscalYearNotFoundError,
//     SelfApprovalNotAllowedError, MissingActorError, and the mapped DB refusals
//     FiscalYearOverlapError, PeriodOverlapError, PeriodOutsideFiscalYearError,
//     EntityNotInScopeError -> 422 (PROBLEM_STATUS has no 404);
//   - anything else -> 500, logged via deps.logger.error, generic detail (never SQL to the client).

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
  ClosePeriodInputSchema,
  CreateFiscalYearInputSchema,
  LockPeriodInputSchema,
  OpenPeriodInputSchema,
  ReopenPeriodInputSchema,
} from '@pg-eos/contracts/billing/accounting-periods';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  closePeriod,
  createFiscalYear,
  lockPeriod,
  openPeriod,
  requestReopenPeriod,
  type AccountingPeriodsDeps,
} from '../../application/accounting-periods/index.js';
import {
  EntityNotInScopeError,
  FiscalYearNotFoundError,
  FiscalYearOverlapError,
  IllegalPeriodTransitionError,
  MissingActorError,
  PeriodNotFoundError,
  PeriodOutsideFiscalYearError,
  PeriodOverlapError,
  RoleRequiredError,
  SelfApprovalNotAllowedError,
  StaleVersionError,
} from '../../domain/accounting-periods/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// This use case's idempotency endpoint identifiers, one per write command.
const IDEMPOTENCY_ENDPOINT_CREATE_FISCAL_YEAR = 'billing.accounting-periods.create-fiscal-year';
const IDEMPOTENCY_ENDPOINT_OPEN_PERIOD = 'billing.accounting-periods.open-period';
const IDEMPOTENCY_ENDPOINT_CLOSE_PERIOD = 'billing.accounting-periods.close-period';
const IDEMPOTENCY_ENDPOINT_LOCK_PERIOD = 'billing.accounting-periods.lock-period';
const IDEMPOTENCY_ENDPOINT_REOPEN_PERIOD = 'billing.accounting-periods.reopen-period';

function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (error instanceof RoleRequiredError) {
    return problem(PROBLEM_STATUS.FORBIDDEN, error.name, error.message);
  }
  if (
    error instanceof IllegalPeriodTransitionError ||
    error instanceof PeriodNotFoundError ||
    error instanceof FiscalYearNotFoundError ||
    error instanceof SelfApprovalNotAllowedError ||
    error instanceof MissingActorError ||
    error instanceof FiscalYearOverlapError ||
    error instanceof PeriodOverlapError ||
    error instanceof PeriodOutsideFiscalYearError ||
    error instanceof EntityNotInScopeError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** An invalid body is a 400 Problem, never an uncaught exception. */
function badRequest(error: Error): ApiFailure {
  return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
}

async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: AccountingPeriodsDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'billing.accounting-periods: unhandled error');
    }
    return failure;
  }
}

export async function handleCreateFiscalYear(
  request: ApiRequest<unknown>,
  deps: AccountingPeriodsDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof createFiscalYear>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  const parsed = CreateFiscalYearInputSchema.safeParse(request.body);
  if (!parsed.success) return badRequest(parsed.error);
  const input = parsed.data;
  return handle(
    () => createFiscalYear(request.ctx, { ...input, idem: buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE_FISCAL_YEAR, input) }, deps),
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleOpenPeriod(
  request: ApiRequest<unknown>,
  deps: AccountingPeriodsDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof openPeriod>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  const parsed = OpenPeriodInputSchema.safeParse(request.body);
  if (!parsed.success) return badRequest(parsed.error);
  const input = parsed.data;
  return handle(
    () => openPeriod(request.ctx, { ...input, idem: buildIdem(request, IDEMPOTENCY_ENDPOINT_OPEN_PERIOD, input) }, deps),
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleClosePeriod(
  request: ApiRequest<unknown>,
  deps: AccountingPeriodsDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof closePeriod>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  const parsed = ClosePeriodInputSchema.safeParse(request.body);
  if (!parsed.success) return badRequest(parsed.error);
  const input = parsed.data;
  return handle(
    () => closePeriod(request.ctx, { ...input, idem: buildIdem(request, IDEMPOTENCY_ENDPOINT_CLOSE_PERIOD, input) }, deps),
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleLockPeriod(
  request: ApiRequest<unknown>,
  deps: AccountingPeriodsDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof lockPeriod>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  const parsed = LockPeriodInputSchema.safeParse(request.body);
  if (!parsed.success) return badRequest(parsed.error);
  const input = parsed.data;
  return handle(
    () => lockPeriod(request.ctx, { ...input, idem: buildIdem(request, IDEMPOTENCY_ENDPOINT_LOCK_PERIOD, input) }, deps),
    deps,
    extractCorrelationId(request.body),
  );
}

/** POST /billing/accounting-periods/reopen-period — files the Decision Inbox request (OD-12); the
 *  period stays closed until applyPeriodReopenDecision runs on the approved decision. */
export async function handleReopenPeriod(
  request: ApiRequest<unknown>,
  deps: AccountingPeriodsDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof requestReopenPeriod>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  const parsed = ReopenPeriodInputSchema.safeParse(request.body);
  if (!parsed.success) return badRequest(parsed.error);
  const input = parsed.data;
  return handle(
    () => requestReopenPeriod(request.ctx, { ...input, idem: buildIdem(request, IDEMPOTENCY_ENDPOINT_REOPEN_PERIOD, input) }, deps),
    deps,
    extractCorrelationId(request.body),
  );
}
