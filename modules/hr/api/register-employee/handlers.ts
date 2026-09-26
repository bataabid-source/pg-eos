// modules/hr/api/register-employee/handlers.ts — WBS 3.3.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/hr/register-employee.ts, an Idempotency-Key header required on every WRITE
// (CLAUDE.md · ARCHITECTURE) — CheckDriverAssignable is read-only and needs none (brief D1), every
// typed domain error mapped to the RFC 9457 Problem envelope. Shape copied from the golden slice's
// own handlers.ts (modules/wms/api/receive-inbound/handlers.ts).
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - EmployeeCodeTakenError / StaleVersionError / IdempotencyConflictError -> 409;
//   - EmployeeNotFoundError, EmployeeNotActiveError, DriverDocumentExpiredError,
//     DriverDocumentMissingError, DocumentDatesInvalidError, DocumentTypeInvalidError,
//     EmployeeCodeFormatInvalidError, IllegalTransitionError, RoleRequiredError,
//     EntityScopeAmbiguousError, MissingActorError -> 422 (PROBLEM_STATUS has no 404, so
//     EmployeeNotFoundError also maps to 422, same discipline as OrderNotFoundError in the golden
//     slice);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller, and is
//     logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md · AGENT
//     CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants here,
//     alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): every WRITE handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to its command as `idem` — the command itself runs the whole thing inside
// withIdempotentContext (packages/db/src/idempotency.ts). CheckDriverAssignable never builds one
// (brief D1 — no Idempotency-Key requirement, no `idem` field on its input).

import { createHash } from 'node:crypto';

import { ZodError } from 'zod';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import {
  ChangeEmployeeStatusInputSchema,
  CheckDriverAssignableInputSchema,
  RecordEmployeeDocumentInputSchema,
  RegisterEmployeeInputSchema,
} from '@pg-eos/contracts/hr/register-employee';
import { IdempotencyConflictError, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import {
  changeEmployeeStatus,
  checkDriverAssignable,
  recordEmployeeDocument,
  registerEmployee,
  type RegisterEmployeeDeps,
} from '../../application/register-employee/index.js';
import {
  DocumentDatesInvalidError,
  DocumentTypeInvalidError,
  DriverDocumentExpiredError,
  DriverDocumentMissingError,
  EmployeeCodeFormatInvalidError,
  EmployeeCodeTakenError,
  EmployeeNotActiveError,
  EmployeeNotFoundError,
  EntityScopeAmbiguousError,
  IllegalTransitionError,
  MissingActorError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/register-employee/errors.js';

// REPLACE-ON-COPY: this use case's own idempotency endpoint identifiers, one per write command.
const IDEMPOTENCY_ENDPOINT_REGISTER = 'hr.register-employee.register-employee';
const IDEMPOTENCY_ENDPOINT_RECORD_DOCUMENT = 'hr.register-employee.record-employee-document';
const IDEMPOTENCY_ENDPOINT_CHANGE_STATUS = 'hr.register-employee.change-employee-status';

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
 *  when it is absent, `undefined` (meaning "continue") otherwise. CheckDriverAssignable never
 *  calls this — it is read-only (brief D1). */
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

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. PROBLEM_STATUS has no 404 (only 400/409/422), so EmployeeNotFoundError maps to
 *  422 alongside every other business-rule rejection. An error NOT in this list is unknown —
 *  mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof StaleVersionError || error instanceof EmployeeCodeTakenError || error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof IllegalTransitionError ||
    error instanceof RoleRequiredError ||
    error instanceof EmployeeNotFoundError ||
    error instanceof EmployeeNotActiveError ||
    error instanceof DriverDocumentExpiredError ||
    error instanceof DriverDocumentMissingError ||
    error instanceof DocumentDatesInvalidError ||
    error instanceof DocumentTypeInvalidError ||
    error instanceof EmployeeCodeFormatInvalidError ||
    error instanceof EntityScopeAmbiguousError ||
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
  deps: RegisterEmployeeDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'hr.register-employee: unhandled error');
    }
    return failure;
  }
}

export async function handleRegisterEmployee(
  request: ApiRequest<unknown>,
  deps: RegisterEmployeeDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof registerEmployee>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = RegisterEmployeeInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_REGISTER, input);
      return registerEmployee(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleRecordEmployeeDocument(
  request: ApiRequest<unknown>,
  deps: RegisterEmployeeDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof recordEmployeeDocument>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = RecordEmployeeDocumentInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_RECORD_DOCUMENT, input);
      return recordEmployeeDocument(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleChangeEmployeeStatus(
  request: ApiRequest<unknown>,
  deps: RegisterEmployeeDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof changeEmployeeStatus>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = ChangeEmployeeStatusInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CHANGE_STATUS, input);
      return changeEmployeeStatus(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleCheckDriverAssignable(
  request: ApiRequest<unknown>,
  deps: RegisterEmployeeDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof checkDriverAssignable>>>> {
  // read-only — no Idempotency-Key requirement (doc 40 §A4 exempts non-write endpoints; brief D1).
  return handle(
    () => checkDriverAssignable(request.ctx, CheckDriverAssignableInputSchema.parse(request.body), deps),
    deps,
    extractCorrelationId(request.body),
  );
}
