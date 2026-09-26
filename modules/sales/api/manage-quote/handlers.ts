// modules/sales/api/manage-quote/handlers.ts — WBS 1.6, M02 sales.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/sales/manage-quote.ts, an Idempotency-Key header required on every write
// (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem envelope
// (slice brief Master decision 15).
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - StaleVersionError and IdempotencyConflictError -> 409 (both optimistic-concurrency style
//     conflicts);
//   - every OTHER typed domain error from ../../domain/manage-quote/errors.ts -> 422 (no per-error
//     whitelist — decision 15: "every other typed domain error -> 422");
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
// same-key/different-body call is a 409 IdempotencyConflictError caught by errorToApiFailure
// below. ReviseQuote carries no `expectedVersion` (Master decision 12) but still requires the
// Idempotency-Key header and still runs through withIdempotentContext — it is a write command.

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
  ApproveCommercialInputSchema,
  ApproveFinanceInputSchema,
  CreateQuoteInputSchema,
  RecordDecisionInputSchema,
  ReturnToDraftInputSchema,
  ReviseQuoteInputSchema,
  SendQuoteInputSchema,
  SubmitForReviewInputSchema,
  UpsertQuoteLineInputSchema,
} from '@pg-eos/contracts/sales/manage-quote';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  approveCommercial,
  approveFinance,
  createQuote,
  recordDecision,
  returnToDraft,
  reviseQuote,
  sendQuote,
  submitForReview,
  upsertQuoteLine,
  type ManageQuoteDeps,
} from '../../application/manage-quote/index.js';
import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  EmptyQuoteError,
  IllegalTransitionError,
  InvalidDiscountError,
  InvalidPriceExceptionError,
  InvalidValidUntilError,
  MarginOutOfRangeError,
  MissingActorError,
  QuoteFrozenError,
  QuoteNotFoundError,
  RoleRequiredError,
  ServiceNotFoundError,
  StaleVersionError,
} from '../../domain/manage-quote/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// this use case's own idempotency endpoint identifiers, one per write command (slice brief Master
// decision 14).
const IDEMPOTENCY_ENDPOINT_CREATE_QUOTE = 'sales.manage-quote.create-quote';
const IDEMPOTENCY_ENDPOINT_UPSERT_QUOTE_LINE = 'sales.manage-quote.upsert-quote-line';
const IDEMPOTENCY_ENDPOINT_SUBMIT_FOR_REVIEW = 'sales.manage-quote.submit-for-review';
const IDEMPOTENCY_ENDPOINT_APPROVE_COMMERCIAL = 'sales.manage-quote.approve-commercial';
const IDEMPOTENCY_ENDPOINT_APPROVE_FINANCE = 'sales.manage-quote.approve-finance';
const IDEMPOTENCY_ENDPOINT_RETURN_TO_DRAFT = 'sales.manage-quote.return-to-draft';
const IDEMPOTENCY_ENDPOINT_SEND_QUOTE = 'sales.manage-quote.send-quote';
const IDEMPOTENCY_ENDPOINT_RECORD_DECISION = 'sales.manage-quote.record-decision';
const IDEMPOTENCY_ENDPOINT_REVISE_QUOTE = 'sales.manage-quote.revise-quote';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404, so QuoteNotFoundError/ServiceNotFoundError map to 422
 *  alongside every other business-rule rejection (decision 15: "every other typed domain error ->
 *  422", no per-error whitelist). An error NOT in this list is unknown — mapped to 500, never
 *  rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof AccountNotFoundError ||
    error instanceof AccountNotQualifiedError ||
    error instanceof QuoteNotFoundError ||
    error instanceof QuoteFrozenError ||
    error instanceof EmptyQuoteError ||
    error instanceof RoleRequiredError ||
    error instanceof InvalidPriceExceptionError ||
    error instanceof InvalidDiscountError ||
    error instanceof InvalidValidUntilError ||
    error instanceof MarginOutOfRangeError ||
    error instanceof ServiceNotFoundError ||
    error instanceof IllegalTransitionError ||
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
  deps: ManageQuoteDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'sales.manage-quote: unhandled error');
    }
    return failure;
  }
}

export async function handleCreateQuote(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof createQuote>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CreateQuoteInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE_QUOTE, input);
      return createQuote(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleUpsertQuoteLine(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof upsertQuoteLine>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = UpsertQuoteLineInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_UPSERT_QUOTE_LINE, input);
      return upsertQuoteLine(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleSubmitForReview(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof submitForReview>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = SubmitForReviewInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_SUBMIT_FOR_REVIEW, input);
      return submitForReview(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleApproveCommercial(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof approveCommercial>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ApproveCommercialInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_APPROVE_COMMERCIAL, input);
      return approveCommercial(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleApproveFinance(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof approveFinance>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ApproveFinanceInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_APPROVE_FINANCE, input);
      return approveFinance(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleReturnToDraft(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof returnToDraft>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ReturnToDraftInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_RETURN_TO_DRAFT, input);
      return returnToDraft(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleSendQuote(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof sendQuote>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = SendQuoteInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_SEND_QUOTE, input);
      return sendQuote(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleRecordDecision(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof recordDecision>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = RecordDecisionInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_RECORD_DECISION, input);
      return recordDecision(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleReviseQuote(
  request: ApiRequest<unknown>,
  deps: ManageQuoteDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof reviseQuote>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ReviseQuoteInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_REVISE_QUOTE, input);
      return reviseQuote(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
