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
//   - LineNotFoundError, LineAlreadyReceivedError, LineAlreadyPutAwayError, RcvBalanceMissingError,
//     VariancePhotoWithoutVarianceError and InvalidQuantityError are all mapped (422 —
//     PROBLEM_STATUS has no 404, so LineNotFoundError also maps to 422, noted inline below, not
//     invented as a new status constant);
//   - WBS 2.9b round-1 review finding 1: ScheduleInPastError, InvalidVehicleTypeError,
//     InvalidHandoverPointError, InvalidTransportByError, InvalidLabourByError,
//     InvalidLabourCountError, LogisticsTermsRequireExpectedAtError (thrown by the extended
//     approveInbound, D2) and CancelReasonRequiredError (thrown by the extended cancelInbound, D3)
//     all map to 422 as well — same pattern as ../../api/schedule-inbound/handlers.ts's own map;
//   - IdempotencyConflictError (SCR-PLAT-IDEM-01) maps to 409 — same status as StaleVersionError,
//     both optimistic-concurrency style conflicts;
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller, and is
//     logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md · AGENT
//     CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200/201 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants
//     from @pg-eos/api-kit, alongside the imported PROBLEM_STATUS.
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
  ApproveInboundInputSchema,
  CancelInboundInputSchema,
  CloseInboundInputSchema,
  ConfirmPutawayInputSchema,
  ReceiveLineInputSchema,
  SuggestLocationInputSchema,
} from '@pg-eos/contracts/wms/receive-inbound';
import { IdempotencyConflictError } from '@pg-eos/db';

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
  VariancePhotoWithoutVarianceError,
} from '../../domain/receive-inbound/errors.js';
import {
  InvalidLedgerEntryError,
  InvalidQuantityError,
  LocationBlockedError,
  LocationLimitExceededError,
} from '../../src/stock-ledger/errors.js';
// WBS 2.9b round-1 review finding 1: thrown by the extended approveInbound (D2's optional slot)
// and cancelInbound (D3's mandatory cancelReason) — mapped alongside every other 422 below, same
// as ../../api/schedule-inbound/handlers.ts's own error map.
import {
  CancelReasonRequiredError,
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
  LogisticsTermsRequireExpectedAtError,
  ScheduleInPastError,
} from '../../domain/schedule-inbound/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// REPLACE-ON-COPY: this use case's own idempotency endpoint identifiers, one per write command.
const IDEMPOTENCY_ENDPOINT_APPROVE = 'wms.receive-inbound.approve-inbound';
const IDEMPOTENCY_ENDPOINT_RECEIVE_LINE = 'wms.receive-inbound.receive-line';
const IDEMPOTENCY_ENDPOINT_CONFIRM_PUTAWAY = 'wms.receive-inbound.confirm-putaway';
const IDEMPOTENCY_ENDPOINT_CLOSE = 'wms.receive-inbound.close-inbound';
const IDEMPOTENCY_ENDPOINT_CANCEL = 'wms.receive-inbound.cancel-inbound';

/** Maps every typed error this use case (or the reused stock-ledger it calls) can throw to its
 *  HTTP status. `title` is always `error.name`. PROBLEM_STATUS has no 404 (only 400/409/422),
 *  so OrderNotFoundError and LineNotFoundError map to 422 alongside every other business-rule
 *  rejection. An error NOT in this list is unknown — mapped to 500, never rethrown. */
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
    error instanceof SkuClientMismatchError ||
    error instanceof VarianceReasonRequiredError ||
    error instanceof VariancePhotoWithoutVarianceError ||
    error instanceof CloseBlockedError ||
    error instanceof CancelBlockedError ||
    error instanceof LineNotFoundError ||
    error instanceof OrderNotFoundError ||
    error instanceof LineAlreadyReceivedError ||
    error instanceof LineAlreadyPutAwayError ||
    error instanceof RcvBalanceMissingError ||
    error instanceof MissingActorError ||
    error instanceof InvalidQuantityError ||
    error instanceof InvalidLedgerEntryError ||
    error instanceof LocationLimitExceededError ||
    error instanceof LocationBlockedError ||
    // WBS 2.9b round-1 review finding 1.
    error instanceof ScheduleInPastError ||
    error instanceof InvalidVehicleTypeError ||
    error instanceof InvalidHandoverPointError ||
    error instanceof InvalidTransportByError ||
    error instanceof InvalidLabourByError ||
    error instanceof InvalidLabourCountError ||
    error instanceof LogisticsTermsRequireExpectedAtError ||
    error instanceof CancelReasonRequiredError
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
  deps: ReceiveInboundDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'wms.receive-inbound: unhandled error');
    }
    return failure;
  }
}

export async function handleApproveInbound(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof approveInbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ApproveInboundInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_APPROVE, input);
      return approveInbound(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleReceiveLine(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof receiveLine>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ReceiveLineInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_RECEIVE_LINE, input);
      return receiveLine(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleSuggestLocation(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof suggestLocation>>>> {
  // GET-equivalent read — no Idempotency-Key requirement (doc 40 §A4 exempts non-write endpoints).
  return handle(
    () => suggestLocation(request.ctx, SuggestLocationInputSchema.parse(request.body), deps),
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleConfirmPutaway(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof confirmPutaway>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ConfirmPutawayInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CONFIRM_PUTAWAY, input);
      return confirmPutaway(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleCloseInbound(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof closeInbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CloseInboundInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CLOSE, input);
      return closeInbound(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleCancelInbound(
  request: ApiRequest<unknown>,
  deps: ReceiveInboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof cancelInbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CancelInboundInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CANCEL, input);
      return cancelInbound(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
