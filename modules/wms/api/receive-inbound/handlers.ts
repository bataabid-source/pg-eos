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
//     here, alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): every write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to its command as `idem` — the command itself runs the whole thing inside
// withIdempotentContext (packages/db/src/idempotency.ts). A replay never re-runs the command; a
// same-key/different-body call is a 409 IdempotencyConflictError caught by errorToApiFailure below.

import { createHash } from 'node:crypto';

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
import { IdempotencyConflictError, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

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
import { InvalidQuantityError, LocationBlockedError, LocationLimitExceededError } from '../../src/stock-ledger/errors.js';
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

// REPLACE-ON-COPY: this use case's own idempotency endpoint identifiers, one per write command.
const IDEMPOTENCY_ENDPOINT_APPROVE = 'wms.receive-inbound.approve-inbound';
const IDEMPOTENCY_ENDPOINT_RECEIVE_LINE = 'wms.receive-inbound.receive-line';
const IDEMPOTENCY_ENDPOINT_CONFIRM_PUTAWAY = 'wms.receive-inbound.confirm-putaway';
const IDEMPOTENCY_ENDPOINT_CLOSE = 'wms.receive-inbound.close-inbound';
const IDEMPOTENCY_ENDPOINT_CANCEL = 'wms.receive-inbound.cancel-inbound';

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
 *  Presence is checked here (SCR-PLAT-IDEM-01); the 409-on-mismatch and the replay of the prior
 *  result are handled by `buildIdem` below plus packages/db/src/idempotency.ts's
 *  `withIdempotentContext`, which every write command in this use case runs its transaction
 *  through. */
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

/** Deterministic, stable-key-order JSON — object keys sorted recursively, arrays kept in order —
 *  so two logically-identical bodies with keys written in a different order hash the same. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** sha256 hex of the canonical JSON of `body` — the `requestHash` every IdempotencyInput carries. */
function requestHashOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

/** Builds the IdempotencyInput every write handler passes to its command as `idem`. `entityId` is
 *  null — the command itself resolves the entity; the key row's entity scope is optional. Called
 *  only after requireIdempotencyKey already confirmed the header is present. */
function buildIdem(request: ApiRequest<unknown>, endpoint: string, parsedBody: unknown): IdempotencyInput {
  const key = findHeader(request.headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!key) {
    // Unreachable in practice — every write handler calls requireIdempotencyKey first and returns
    // before reaching here when it is missing. Thrown, not silently defaulted, if that ever drifts.
    throw new Error('buildIdem: Idempotency-Key header missing (requireIdempotencyKey should have caught this).');
  }
  return { key, endpoint, requestHash: requestHashOf(parsedBody), entityId: null, successStatus: HTTP_STATUS_OK };
}

/** Reads `body.correlationId` without ever asserting `any` — used only to enrich the 500 log line
 *  below; every write command's own input also carries `correlationId`, but a 500 can happen
 *  before the body even parses, so this reads the raw, pre-validation body defensively. */
function extractCorrelationId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'correlationId' in body) {
    const value = (body as Record<string, unknown>)['correlationId'];
    return typeof value === 'string' ? value : undefined;
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
