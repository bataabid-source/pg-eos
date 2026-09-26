// modules/wms/api/process-outbound/handlers.ts — WBS 2.11 part 1, following
// ../../api/receive-inbound/handlers.ts (golden slice).
//
// api/ layer: request in, response out. Framework-free async functions: Zod-validated input from
// packages/contracts/wms/process-outbound.ts, an Idempotency-Key header required on every write
// (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem envelope
// (brief Master decision 8):
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem instead of an uncaught ZodError;
//   - StaleVersionError / IdempotencyConflictError -> 409;
//   - every other typed domain error (IllegalTransitionError, RoleRequiredError,
//     OrderNotFoundError, MissingActorError, ClientNotQualifiedError, CancelReasonRequiredError,
//     and all nine condition-check errors) -> 422;
//   - every OutboundCheckError subclass (the nine condition-check errors and
//     StockBalanceRowMissingError) -> 422 carrying its i18nKey + params in the Problem body;
//   - an UNKNOWN error -> 500, generic detail, logged server-side via deps.logger.error;
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`).

import { createHash } from 'node:crypto';

import { ZodError } from 'zod';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import {
  AllocateInputSchema,
  ApproveOutboundInputSchema,
  CancelOutboundInputSchema,
  CheckOrderInputSchema,
  CreateOutboundInputSchema,
  GeneratePickListInputSchema,
  PickLineInputSchema,
  RunOutboundChecksInputSchema,
} from '@pg-eos/contracts/wms/process-outbound';
import { IdempotencyConflictError, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import {
  allocate,
  approveOutbound,
  cancelOutbound,
  checkOrder,
  createOutbound,
  generatePickList,
  pickLine,
  runOutboundChecks,
  type ProcessOutboundDeps,
} from '../../application/process-outbound/index.js';
import {
  CancelReasonRequiredError,
  ClientNotQualifiedError,
  IllegalTransitionError,
  MissingActorError,
  OrderNotFoundError,
  OutboundCheckError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/process-outbound/errors.js';

const IDEMPOTENCY_ENDPOINT_CREATE = 'wms.process-outbound.create-outbound';
const IDEMPOTENCY_ENDPOINT_RUN_CHECKS = 'wms.process-outbound.run-outbound-checks';
const IDEMPOTENCY_ENDPOINT_APPROVE = 'wms.process-outbound.approve-outbound';
const IDEMPOTENCY_ENDPOINT_CANCEL = 'wms.process-outbound.cancel-outbound';
const IDEMPOTENCY_ENDPOINT_ALLOCATE = 'wms.process-outbound.allocate';
const IDEMPOTENCY_ENDPOINT_PICK_LINE = 'wms.process-outbound.pick-line';
const IDEMPOTENCY_ENDPOINT_CHECK_ORDER = 'wms.process-outbound.check-order';

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

/** brief Scope item 3: a condition-check failure's Problem body ALSO carries the typed error's
 *  `.i18nKey`/`.params` — packages/contracts/_shared/problem.ts's `ProblemSchema` (frozen, five
 *  required fields only) is never edited; this is a structural extension of `Problem`, not a
 *  contract change. */
export interface ProblemBody extends Problem {
  readonly i18nKey?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ApiFailure {
  readonly status: number;
  readonly body: ProblemBody;
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

/** doc 40 §A4: every write endpoint requires the Idempotency-Key header. Returns a 400 Problem
 *  when it is absent, `undefined` (meaning "continue") otherwise. */
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

/** Deterministic, stable-key-order JSON — object keys sorted recursively, arrays kept in order. */
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

function requestHashOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

/** Builds the IdempotencyInput every write handler passes to its command as `idem`. Called only
 *  after requireIdempotencyKey already confirmed the header is present. */
function buildIdem(request: ApiRequest<unknown>, endpoint: string, parsedBody: unknown): IdempotencyInput {
  const key = findHeader(request.headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!key) {
    throw new Error('buildIdem: Idempotency-Key header missing (requireIdempotencyKey should have caught this).');
  }
  return { key, endpoint, requestHash: requestHashOf(parsedBody), entityId: null, successStatus: HTTP_STATUS_OK };
}

function extractCorrelationId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'correlationId' in body) {
    const value = (body as Record<string, unknown>)['correlationId'];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404, so OrderNotFoundError also maps to 422 alongside
 *  every other business-rule rejection. An error NOT in this list is unknown — mapped to 500,
 *  never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof StaleVersionError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  // OutboundCheckError covers the nine condition-check errors AND StockBalanceRowMissingError.
  if (error instanceof OutboundCheckError) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message, {
      i18nKey: error.i18nKey,
      params: error.params,
    });
  }
  if (
    error instanceof IllegalTransitionError ||
    error instanceof RoleRequiredError ||
    error instanceof OrderNotFoundError ||
    error instanceof MissingActorError ||
    error instanceof ClientNotQualifiedError ||
    error instanceof CancelReasonRequiredError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  // An unknown error's own message may carry SQL or table names — never sent to the client. The
  // server-side record is the deps.logger.error call in handle() below; the response stays generic.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** Every unknown (500) error is logged via deps.logger.error before the Problem envelope is
 *  returned — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." */
async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: ProcessOutboundDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'wms.process-outbound: unhandled error');
    }
    return failure;
  }
}

export async function handleCreateOutbound(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof createOutbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CreateOutboundInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE, input);
      return createOutbound(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleRunOutboundChecks(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof runOutboundChecks>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = RunOutboundChecksInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_RUN_CHECKS, input);
      return runOutboundChecks(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleApproveOutbound(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof approveOutbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ApproveOutboundInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_APPROVE, input);
      return approveOutbound(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleCancelOutbound(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof cancelOutbound>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CancelOutboundInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CANCEL, input);
      return cancelOutbound(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

// --- WBS 2.11 part 2: Allocate / GeneratePickList (brief Master decisions 2/3/5) ------------------

export async function handleAllocate(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof allocate>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = AllocateInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_ALLOCATE, input);
      return allocate(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

/** Read-only — no Idempotency-Key requirement (brief Master decision 5: GeneratePickList never
 *  writes, so it needs no optimistic lock / idempotency replay). */
export async function handleGeneratePickList(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof generatePickList>>>> {
  return handle(
    () => {
      const input = GeneratePickListInputSchema.parse(request.body);
      return generatePickList(request.ctx, input, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

// --- WBS 2.12 part 1: PickLine / CheckOrder (brief Master decisions 2/3) -------------------------

export async function handlePickLine(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof pickLine>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = PickLineInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_PICK_LINE, input);
      return pickLine(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleCheckOrder(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof checkOrder>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CheckOrderInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CHECK_ORDER, input);
      return checkOrder(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
