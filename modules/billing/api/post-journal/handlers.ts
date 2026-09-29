// modules/billing/api/post-journal/handlers.ts — WBS 4.20 (lane 2).
//
// api/ layer: request in, response out — framework-free async functions, one per FROZEN contract
// route (packages/contracts/billing/post-journal.ts ROUTES: post-journal, reverse-journal,
// adjust-journal; the apps/api host mounts `handle<Operation>` for each). Zod-validated input, an
// Idempotency-Key header required on every write (CLAUDE.md · ARCHITECTURE), every typed domain
// error mapped to the RFC 9457 Problem envelope (golden slice:
// modules/wms/api/receive-inbound/handlers.ts). No business logic lives here.
//
// Error mapping (title is always error.name, or 'InternalServerError'):
//   - a missing Idempotency-Key or an invalid body -> 400;
//   - StaleVersionError, IdempotencyConflictError -> 409;
//   - every other typed refusal of ../../domain/post-journal/errors.ts -> 422, RoleRequiredError
//     included (the frozen contract declares no 403);
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
  AdjustJournalInputSchema,
  PostJournalInputSchema,
  ReverseJournalInputSchema,
} from '@pg-eos/contracts/billing/post-journal';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  adjustJournal,
  postJournal,
  reverseJournal,
  type AdjustJournalResult,
  type PostJournalDeps,
  type PostJournalResult,
  type ReverseJournalResult,
} from '../../application/post-journal/index.js';
import {
  AccountNotInEntityError,
  AccountNotPostableError,
  AlreadyReversedError,
  EntityNotInScopeError,
  IllegalJournalTransitionError,
  InsufficientLinesError,
  InvalidAmountError,
  JournalEntryNotFoundError,
  ManualJournalApprovalRequiredError,
  ManualRevenueJournalRefusedError,
  MissingActorError,
  PeriodNotOpenError,
  RoleRequiredError,
  StaleVersionError,
  UnbalancedEntryError,
} from '../../domain/post-journal/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// This use case's idempotency endpoint identifiers, one per write command.
const IDEMPOTENCY_ENDPOINT_POST_JOURNAL = 'billing.post-journal.post-journal';
const IDEMPOTENCY_ENDPOINT_REVERSE_JOURNAL = 'billing.post-journal.reverse-journal';
const IDEMPOTENCY_ENDPOINT_ADJUST_JOURNAL = 'billing.post-journal.adjust-journal';

const UNPROCESSABLE_ERRORS: ReadonlyArray<new (message: string) => Error> = [
  AccountNotInEntityError,
  AccountNotPostableError,
  AlreadyReversedError,
  EntityNotInScopeError,
  IllegalJournalTransitionError,
  InsufficientLinesError,
  InvalidAmountError,
  JournalEntryNotFoundError,
  ManualJournalApprovalRequiredError,
  ManualRevenueJournalRefusedError,
  MissingActorError,
  PeriodNotOpenError,
  RoleRequiredError,
  UnbalancedEntryError,
];

function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (error instanceof Error && UNPROCESSABLE_ERRORS.some((ctor) => error instanceof ctor)) {
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
  deps: PostJournalDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'billing.post-journal: unhandled error');
    }
    return failure;
  }
}

/** POST /billing/post-journal/post-journal */
export async function handlePostJournal(
  request: ApiRequest<unknown>,
  deps: PostJournalDeps,
): Promise<ApiResult<PostJournalResult>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  const parsed = PostJournalInputSchema.safeParse(request.body);
  if (!parsed.success) return badRequest(parsed.error);
  const input = parsed.data;
  return handle(
    () => postJournal(request.ctx, { ...input, idem: buildIdem(request, IDEMPOTENCY_ENDPOINT_POST_JOURNAL, input) }, deps),
    deps,
    extractCorrelationId(request.body),
  );
}

/** POST /billing/post-journal/reverse-journal */
export async function handleReverseJournal(
  request: ApiRequest<unknown>,
  deps: PostJournalDeps,
): Promise<ApiResult<ReverseJournalResult>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  const parsed = ReverseJournalInputSchema.safeParse(request.body);
  if (!parsed.success) return badRequest(parsed.error);
  const input = parsed.data;
  return handle(
    () => reverseJournal(request.ctx, { ...input, idem: buildIdem(request, IDEMPOTENCY_ENDPOINT_REVERSE_JOURNAL, input) }, deps),
    deps,
    extractCorrelationId(request.body),
  );
}

/** POST /billing/post-journal/adjust-journal */
export async function handleAdjustJournal(
  request: ApiRequest<unknown>,
  deps: PostJournalDeps,
): Promise<ApiResult<AdjustJournalResult>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  const parsed = AdjustJournalInputSchema.safeParse(request.body);
  if (!parsed.success) return badRequest(parsed.error);
  const input = parsed.data;
  return handle(
    () => adjustJournal(request.ctx, { ...input, idem: buildIdem(request, IDEMPOTENCY_ENDPOINT_ADJUST_JOURNAL, input) }, deps),
    deps,
    extractCorrelationId(request.body),
  );
}
