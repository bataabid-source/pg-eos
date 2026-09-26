// modules/sales/api/manage-contract/handlers.ts — WBS 1.7, M02 sales.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/sales/manage-contract.ts, an Idempotency-Key header required on every write
// (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem envelope
// (slice brief Master decision 13). `getContractForOrder` has NO handler — Master decision 10:
// "makes NO write", not a write endpoint, carries no Idempotency-Key.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - StaleVersionError and IdempotencyConflictError -> 409 (both optimistic-concurrency style
//     conflicts);
//   - every OTHER typed domain error from ../../domain/manage-contract/errors.ts -> 422 (no
//     per-error whitelist — decision 13: "every other typed domain error -> 422");
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
  ActivateContractInputSchema,
  AddContractSlaInputSchema,
  CreateContractInputSchema,
  ExpireContractInputSchema,
  ResumeContractInputSchema,
  SetContractPriceListInputSchema,
  SignContractInputSchema,
  SuspendContractInputSchema,
} from '@pg-eos/contracts/sales/manage-contract';
import { IdempotencyConflictError } from '@pg-eos/db';

import {
  activateContract,
  addContractSla,
  createContract,
  expireContract,
  resumeContract,
  setContractPriceList,
  signContract,
  suspendContract,
  type ManageContractDeps,
} from '../../application/manage-contract/index.js';
import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  ContractNotActiveError,
  ContractNotFoundError,
  ContractNotPriceableError,
  ContractNotYetExpirableError,
  IllegalTransitionError,
  InvalidEndDateError,
  InvalidStartDateError,
  MissingActorError,
  PriceListNotApplicableError,
  RoleRequiredError,
  SlaNotEnabledError,
  StaleVersionError,
} from '../../domain/manage-contract/errors.js';

export type { ApiHeaders, ApiRequest, ApiSuccess, ApiFailure, ApiResult } from '@pg-eos/api-kit';

// this use case's own idempotency endpoint identifiers, one per write command (slice brief Master
// decision 12).
const IDEMPOTENCY_ENDPOINT_CREATE_CONTRACT = 'sales.manage-contract.create-contract';
const IDEMPOTENCY_ENDPOINT_SIGN_CONTRACT = 'sales.manage-contract.sign-contract';
const IDEMPOTENCY_ENDPOINT_SET_CONTRACT_PRICE_LIST = 'sales.manage-contract.set-contract-price-list';
const IDEMPOTENCY_ENDPOINT_ACTIVATE_CONTRACT = 'sales.manage-contract.activate-contract';
const IDEMPOTENCY_ENDPOINT_SUSPEND_CONTRACT = 'sales.manage-contract.suspend-contract';
const IDEMPOTENCY_ENDPOINT_RESUME_CONTRACT = 'sales.manage-contract.resume-contract';
const IDEMPOTENCY_ENDPOINT_EXPIRE_CONTRACT = 'sales.manage-contract.expire-contract';
const IDEMPOTENCY_ENDPOINT_ADD_CONTRACT_SLA = 'sales.manage-contract.add-contract-sla';

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404, so ContractNotFoundError maps to 422 alongside every
 *  other business-rule rejection (decision 13: "every other typed domain error -> 422", no
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
    error instanceof AccountNotQualifiedError ||
    error instanceof ContractNotFoundError ||
    error instanceof ContractNotPriceableError ||
    error instanceof PriceListNotApplicableError ||
    error instanceof ContractNotActiveError ||
    error instanceof ContractNotYetExpirableError ||
    error instanceof SlaNotEnabledError ||
    error instanceof RoleRequiredError ||
    error instanceof InvalidStartDateError ||
    error instanceof InvalidEndDateError ||
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
  deps: ManageContractDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'sales.manage-contract: unhandled error');
    }
    return failure;
  }
}

export async function handleCreateContract(
  request: ApiRequest<unknown>,
  deps: ManageContractDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof createContract>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CreateContractInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CREATE_CONTRACT, input);
      return createContract(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleSignContract(
  request: ApiRequest<unknown>,
  deps: ManageContractDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof signContract>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = SignContractInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_SIGN_CONTRACT, input);
      return signContract(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleSetContractPriceList(
  request: ApiRequest<unknown>,
  deps: ManageContractDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof setContractPriceList>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = SetContractPriceListInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_SET_CONTRACT_PRICE_LIST, input);
      return setContractPriceList(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleActivateContract(
  request: ApiRequest<unknown>,
  deps: ManageContractDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof activateContract>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ActivateContractInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_ACTIVATE_CONTRACT, input);
      return activateContract(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleSuspendContract(
  request: ApiRequest<unknown>,
  deps: ManageContractDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof suspendContract>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = SuspendContractInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_SUSPEND_CONTRACT, input);
      return suspendContract(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleResumeContract(
  request: ApiRequest<unknown>,
  deps: ManageContractDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof resumeContract>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ResumeContractInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_RESUME_CONTRACT, input);
      return resumeContract(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleExpireContract(
  request: ApiRequest<unknown>,
  deps: ManageContractDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof expireContract>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ExpireContractInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_EXPIRE_CONTRACT, input);
      return expireContract(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleAddContractSla(
  request: ApiRequest<unknown>,
  deps: ManageContractDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof addContractSla>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = AddContractSlaInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_ADD_CONTRACT_SLA, input);
      return addContractSla(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
