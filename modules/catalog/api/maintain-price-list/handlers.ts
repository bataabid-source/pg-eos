// modules/catalog/api/maintain-price-list/handlers.ts — WBS 1.2, M03 catalog.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/catalog/maintain-price-list.ts, an Idempotency-Key header required on every
// write (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope (slice brief Master decision 12).
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - StaleVersionError and IdempotencyConflictError -> 409 (both optimistic-concurrency style
//     conflicts);
//   - every OTHER typed domain error from ../../domain/maintain-price-list/errors.ts -> 422 (no
//     per-error whitelist — decision 12: "every other typed domain error -> 422");
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller, and is
//     logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md · AGENT
//     CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200/201 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants
//     here, alongside the imported PROBLEM_STATUS.
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
  ActivatePriceListInputSchema,
  CreatePriceListInputSchema,
  ExpirePriceListInputSchema,
  GrantPriceExceptionInputSchema,
  ImportPriceListLinesInputSchema,
  UpsertPriceListLineInputSchema,
} from '@pg-eos/contracts/catalog/maintain-price-list';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  activatePriceList,
  createPriceList,
  expirePriceList,
  grantPriceException,
  importPriceListLines,
  upsertPriceListLine,
  type MaintainPriceListDeps,
} from '../../application/maintain-price-list/index.js';
import {
  CurrencyMismatchError,
  EmptyPriceListError,
  IllegalTransitionError,
  InvalidValidityError,
  MissingActorError,
  PriceBelowFloorError,
  PriceListCodeTakenError,
  PriceListLockedError,
  PriceListNotFoundError,
  RoleRequiredError,
  SegmentAndClientError,
  ServiceNotFoundError,
  ServiceNotPriceableError,
  StaleVersionError,
  TierLadderError,
} from '../../domain/maintain-price-list/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// this use case's own idempotency endpoint identifiers, one per write command (slice brief Master
// decision 11).
const IDEMPOTENCY_ENDPOINT_CREATE = 'catalog.maintain-price-list.create-price-list';
const IDEMPOTENCY_ENDPOINT_UPSERT_LINE = 'catalog.maintain-price-list.upsert-price-list-line';
const IDEMPOTENCY_ENDPOINT_IMPORT = 'catalog.maintain-price-list.import-price-list-lines';
const IDEMPOTENCY_ENDPOINT_ACTIVATE = 'catalog.maintain-price-list.activate-price-list';
const IDEMPOTENCY_ENDPOINT_EXPIRE = 'catalog.maintain-price-list.expire-price-list';
const IDEMPOTENCY_ENDPOINT_GRANT = 'catalog.maintain-price-list.grant-price-exception';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404, so PriceListNotFoundError/ServiceNotFoundError map to
 *  422 alongside every other business-rule rejection (decision 12: "every other typed domain
 *  error -> 422", no per-error whitelist). An error NOT in this list is unknown — mapped to 500,
 *  never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof IllegalTransitionError ||
    error instanceof RoleRequiredError ||
    error instanceof PriceListLockedError ||
    error instanceof PriceBelowFloorError ||
    error instanceof ServiceNotFoundError ||
    error instanceof ServiceNotPriceableError ||
    error instanceof CurrencyMismatchError ||
    error instanceof PriceListCodeTakenError ||
    error instanceof SegmentAndClientError ||
    error instanceof InvalidValidityError ||
    error instanceof EmptyPriceListError ||
    error instanceof TierLadderError ||
    error instanceof MissingActorError ||
    error instanceof PriceListNotFoundError
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
  deps: MaintainPriceListDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'catalog.maintain-price-list: unhandled error');
    }
    return failure;
  }
}

export async function handleCreatePriceList(
  request: ApiRequest<unknown>,
  deps: MaintainPriceListDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof createPriceList>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CreatePriceListInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE, input);
      return createPriceList(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleUpsertPriceListLine(
  request: ApiRequest<unknown>,
  deps: MaintainPriceListDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof upsertPriceListLine>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = UpsertPriceListLineInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_UPSERT_LINE, input);
      return upsertPriceListLine(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleImportPriceListLines(
  request: ApiRequest<unknown>,
  deps: MaintainPriceListDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof importPriceListLines>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ImportPriceListLinesInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_IMPORT, input);
      return importPriceListLines(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleActivatePriceList(
  request: ApiRequest<unknown>,
  deps: MaintainPriceListDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof activatePriceList>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ActivatePriceListInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_ACTIVATE, input);
      return activatePriceList(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleExpirePriceList(
  request: ApiRequest<unknown>,
  deps: MaintainPriceListDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof expirePriceList>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ExpirePriceListInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_EXPIRE, input);
      return expirePriceList(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleGrantPriceException(
  request: ApiRequest<unknown>,
  deps: MaintainPriceListDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof grantPriceException>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = GrantPriceExceptionInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_GRANT, input);
      return grantPriceException(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
