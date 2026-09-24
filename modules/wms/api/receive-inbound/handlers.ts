// modules/wms/api/receive-inbound/handlers.ts — WBS 2.9, THE GOLDEN SLICE.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/wms/receive-inbound.ts, an Idempotency-Key header required on every write
// (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem envelope.
// A future NestJS controller wraps these one-to-one; no business logic lives here.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - LineNotFoundError, LineAlreadyReceivedError, LineAlreadyPutAwayError, RcvBalanceMissingError
//     and InvalidQuantityError are all mapped (422 — PROBLEM_STATUS has no 404, so LineNotFoundError
//     also maps to 422, noted inline below, not invented as a new status constant);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller;
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200/201 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants
//     here, alongside the imported PROBLEM_STATUS.
//
// OBSERVABILITY , Master default recorded here): pino is not a dependency of this
// workspace yet (CLAUDE.md bans console.log; no logger exists to replace it with). NO logger is
// added in this slice — wiring real structured logging is deferred until pino is added as a
// dependency, which is outside this slice's Write ONLY scope.

import { ZodError } from 'zod';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import {
  ApproveInboundInputSchema,
  CancelInboundInputSchema,
  CloseInboundInputSchema,
  ConfirmPutawayInputSchema,
  ReceiveLineInputSchema,
  SuggestLocationInputSchema,
} from '@pg-eos/contracts/wms/receive-inbound';
import type { WithContextCtx } from '@pg-eos/db';

import {
  approveInbound,
  cancelInbound,
  closeInbound,
  confirmPutaway,
  receiveLine,
  suggestLocation,
  type ReceiveInboundDeps,
} from '../../application/receive-inbound/index.js';
import {
  CancelBlockedError,
  CloseBlockedError,
  IllegalTransitionError,
  LineAlreadyPutAwayError,
  LineAlreadyReceivedError,
  LineNotFoundError,
  OrderNotFoundError,
  MissingActorError,
  RcvBalanceMissingError,
  RoleRequiredError,
  SkuClientMismatchError,
  StaleVersionError,
  VarianceReasonRequiredError,
} from '../../domain/receive-inbound/errors.js';
import { InvalidQuantityError, LocationBlockedError, LocationLimitExceededError } from '../../src/stock-ledger/errors.js';

export interface ApiHeaders {
  readonly [headerName: string]: string | undefined;
}

export interface ApiRequest<TBody> {
  readonly headers: ApiHeaders;
  readonly body: TBody;
  readonly ctx: WithContextCtx;
}

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

export interface ApiSuccess<TBody> {
  readonly status: typeof HTTP_STATUS_OK;
  readonly body: TBody;
}

export interface ApiFailure {
  readonly status: number;
  readonly body: Problem;
}

export type ApiResult<TBody> = ApiSuccess<TBody> | ApiFailure;

const IDEMPOTENCY_KEY_HEADER_LOWER = IDEMPOTENCY_KEY_HEADER_NAME.toLowerCase();
const PROBLEM_TYPE_BASE = 'https://pg-eos.local/problems/';

function findHeader(headers: ApiHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }
  return undefined;
}

const UNKNOWN_ERROR_DETAIL = 'An unexpected error occurred. (Allowed: retry, or report it with the correlationId.)';

function problem(status: number, title: string, detail: string): ApiFailure {
  return {
    status,
    body: { type: `${PROBLEM_TYPE_BASE}${title.toLowerCase().replace(/\s+/g, '-')}`, title, status, detail, instance: '' },
  };
}

/** doc 40 §A4: every write endpoint requires the Idempotency-Key header. Returns a 400 Problem
 *  when it is absent, `undefined` (meaning "continue") otherwise.
 *
 *  INCOMPLETE — presence only. doc 40 §A4 also requires 409 on key reuse with a different body and
 *  a 7-day replay of the prior result; both need the key store requested in
 *  docs/notes/SCR-PLAT-IDEM-01-idempotency-key-store.md (WAITING_GM). When it lands, this becomes one
 *  shared helper every slice's handlers call. A copied slice must NOT treat this check as finished. */
function requireIdempotencyKey(headers: ApiHeaders): ApiFailure | undefined {
  const value = findHeader(headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!value) {
    return problem(
      PROBLEM_STATUS.BAD_REQUEST,
      'Idempotency-Key required',
      `every write endpoint requires the ${IDEMPOTENCY_KEY_HEADER_NAME} header (doc 40 §A4).`,
    );
  }
  return undefined;
}

/** Maps every typed error this use case (or the reused stock-ledger it calls) can throw to its
 *  HTTP status. `title` is always `error.name`. PROBLEM_STATUS has no 404 (only 400/409/422),
 *  so OrderNotFoundError and LineNotFoundError map to 422 alongside every other business-rule
 *  rejection. An error NOT in this list is unknown — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof StaleVersionError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof IllegalTransitionError ||
    error instanceof RoleRequiredError ||
    error instanceof SkuClientMismatchError ||
    error instanceof VarianceReasonRequiredError ||
    error instanceof CloseBlockedError ||
    error instanceof CancelBlockedError ||
    error instanceof LineNotFoundError ||
    error instanceof OrderNotFoundError ||
    error instanceof LineAlreadyReceivedError ||
    error instanceof LineAlreadyPutAwayError ||
    error instanceof RcvBalanceMissingError ||
    error instanceof MissingActorError ||
    error instanceof InvalidQuantityError ||
    error instanceof LocationLimitExceededError ||
    error instanceof LocationBlockedError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  // An unknown error's own message may carry SQL or table names — never sent to the client. The
  // server-side record is pending the logger (observability deferred until pino is a dependency).
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

async function handle<TBody>(fn: () => Promise<TBody>): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    return errorToApiFailure(error);
  }
}

export async function handleApproveInbound(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof approveInbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(() => approveInbound(request.ctx, ApproveInboundInputSchema.parse(request.body), deps));
}

export async function handleReceiveLine(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof receiveLine>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(() => receiveLine(request.ctx, ReceiveLineInputSchema.parse(request.body), deps));
}

export async function handleSuggestLocation(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof suggestLocation>>>> {
  // GET-equivalent read — no Idempotency-Key requirement (doc 40 §A4 exempts non-write endpoints).
  return handle(() => suggestLocation(request.ctx, SuggestLocationInputSchema.parse(request.body), deps));
}

export async function handleConfirmPutaway(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof confirmPutaway>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(() => confirmPutaway(request.ctx, ConfirmPutawayInputSchema.parse(request.body), deps));
}

export async function handleCloseInbound(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof closeInbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(() => closeInbound(request.ctx, CloseInboundInputSchema.parse(request.body), deps));
}

export async function handleCancelInbound(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof cancelInbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(() => cancelInbound(request.ctx, CancelInboundInputSchema.parse(request.body), deps));
}
