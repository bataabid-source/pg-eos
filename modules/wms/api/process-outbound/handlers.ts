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

import { ZodError } from 'zod';

import {
  buildIdem,
  extractCorrelationId,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  PROBLEM_TYPE_BASE,
  requireIdempotencyKey,
  UNKNOWN_ERROR_DETAIL,
  type ApiRequest,
  type ApiSuccess,
} from '@pg-eos/api-kit';
import { PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import {
  AllocateInputSchema,
  ApproveOutboundInputSchema,
  CancelOutboundInputSchema,
  CheckOrderInputSchema,
  CreateOutboundInputSchema,
  GeneratePickListInputSchema,
  LoadOrderInputSchema,
  PackOrderInputSchema,
  PickLineInputSchema,
  RunOutboundChecksInputSchema,
} from '@pg-eos/contracts/wms/process-outbound';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  allocate,
  approveOutbound,
  cancelOutbound,
  checkOrder,
  createOutbound,
  generatePickList,
  loadOrder,
  packOrder,
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

export type { ApiHeaders, ApiRequest, ApiSuccess } from '@pg-eos/api-kit';

const IDEMPOTENCY_ENDPOINT_CREATE = 'wms.process-outbound.create-outbound';
const IDEMPOTENCY_ENDPOINT_RUN_CHECKS = 'wms.process-outbound.run-outbound-checks';
const IDEMPOTENCY_ENDPOINT_APPROVE = 'wms.process-outbound.approve-outbound';
const IDEMPOTENCY_ENDPOINT_CANCEL = 'wms.process-outbound.cancel-outbound';
const IDEMPOTENCY_ENDPOINT_ALLOCATE = 'wms.process-outbound.allocate';
const IDEMPOTENCY_ENDPOINT_PICK_LINE = 'wms.process-outbound.pick-line';
const IDEMPOTENCY_ENDPOINT_CHECK_ORDER = 'wms.process-outbound.check-order';
const IDEMPOTENCY_ENDPOINT_PACK_ORDER = 'wms.process-outbound.pack-order';
const IDEMPOTENCY_ENDPOINT_LOAD_ORDER = 'wms.process-outbound.load-order';

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

// --- WBS 2.12 part 4: PackOrder / LoadOrder (brief Master decisions 2/3/4/5/6) ---------------------

export async function handlePackOrder(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof packOrder>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = PackOrderInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_PACK_ORDER, input);
      return packOrder(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleLoadOrder(
  request: ApiRequest<unknown>,
  deps: ProcessOutboundDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof loadOrder>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = LoadOrderInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_LOAD_ORDER, input);
      return loadOrder(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
