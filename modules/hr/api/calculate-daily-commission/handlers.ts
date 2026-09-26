// modules/hr/api/calculate-daily-commission/handlers.ts — WBS 3.13 part 2.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/hr/calculate-daily-commission.ts, an Idempotency-Key header required on the
// write (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope. Shape copied from register-employee/assign-driver-id's own handlers.ts.
//
// Error mapping (brief, Deliver's own final paragraph):
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - IdempotencyConflictError (SCR-PLAT-IDEM-01) maps to 409;
//   - CommissionAlreadyCalculatedError maps to 409 (a real conflict — the DB's own unique-violation
//     translated, same class as DuplicatePlateNoError/EmployeeAlreadyAssignedError);
//   - NoApplicableCommissionRuleError / AmbiguousCommissionRuleError map to 422 (brief: "422, a
//     data-completeness problem, not a conflict");
//   - EntityScopeAmbiguousError / EmployeeNotInCallerEntityError map to 422 (round-1 review
//     findings 1 and 5 — see ../../domain/calculate-daily-commission/errors.js's own header for
//     why each is 422, not a raw 404, within this Problem envelope);
//   - NotInternalActorError maps to 422 (part 2 round-2 finding 2 — a non-internal caller with a
//     real entity scope, translated from hr.commission_daily's own migration-0027 RLS write-policy
//     gate; same status as the expire-contract/RoleRequiredError precedent this class cites);
//   - MissingActorError maps to 422 (cross-module convention, same as every prior slice's own
//     handlers.ts);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, never crashes the caller, and is
//     logged server-side via deps.logger.error before the Problem is returned (CLAUDE.md · AGENT
//     CONSTRAINTS "No console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`);
//   - no literal 200 — HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR are named constants here,
//     alongside the imported PROBLEM_STATUS.
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): the write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to calculateDailyCommission as `idem` — the command itself runs its DB-writing transaction
// inside withIdempotentContext (packages/db/src/idempotency.ts). A replay never re-runs the
// command; a same-key/different-body call is a 409 IdempotencyConflictError caught by
// errorToApiFailure below. `entityId` is null on the idempotency key row — the command itself
// resolves the entity (same convention as register-employee's own buildIdem).

import { createHash } from 'node:crypto';

import { ZodError } from 'zod';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import { CalculateDailyCommissionInputSchema } from '@pg-eos/contracts/hr/calculate-daily-commission';
import { IdempotencyConflictError, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { calculateDailyCommission, type CalculateDailyCommissionDeps } from '../../application/calculate-daily-commission/index.js';
import {
  AmbiguousCommissionRuleError,
  CommissionAlreadyCalculatedError,
  EmployeeNotInCallerEntityError,
  EntityScopeAmbiguousError,
  MissingActorError,
  NoApplicableCommissionRuleError,
  NotInternalActorError,
} from '../../domain/calculate-daily-commission/errors.js';

const IDEMPOTENCY_ENDPOINT_CALCULATE = 'hr.calculate-daily-commission.calculate-daily-commission';

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

/** Builds the IdempotencyInput the write handler passes to calculateDailyCommission as `idem`.
 *  `entityId` is null — the command itself resolves the entity (same convention as
 *  register-employee's own buildIdem). Called only after requireIdempotencyKey already confirmed
 *  the header is present. */
function buildIdem(request: ApiRequest<unknown>, endpoint: string, parsedBody: unknown): IdempotencyInput {
  const key = findHeader(request.headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!key) {
    // Unreachable in practice — the handler calls requireIdempotencyKey first and returns before
    // reaching here when it is missing. Thrown, not silently defaulted, if that ever drifts.
    throw new Error('buildIdem: Idempotency-Key header missing (requireIdempotencyKey should have caught this).');
  }
  return { key, endpoint, requestHash: requestHashOf(parsedBody), entityId: null, successStatus: HTTP_STATUS_OK };
}

/** Reads `body.correlationId` without ever asserting `any` — used only to enrich the 500 log line
 *  below; calculateDailyCommission's own input also carries `correlationId`, but a 500 can happen
 *  before the body even parses, so this reads the raw, pre-validation body defensively. */
function extractCorrelationId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'correlationId' in body) {
    const value = (body as Record<string, unknown>)['correlationId'];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** Maps every typed error this use case can throw to its HTTP status. `title` is always
 *  `error.name`. An error NOT in this list is unknown — mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof IdempotencyConflictError || error instanceof CommissionAlreadyCalculatedError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof NoApplicableCommissionRuleError ||
    error instanceof AmbiguousCommissionRuleError ||
    error instanceof EntityScopeAmbiguousError ||
    error instanceof EmployeeNotInCallerEntityError ||
    error instanceof NotInternalActorError ||
    error instanceof MissingActorError
  ) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  // An unknown error's own message may carry SQL, table names or port internals — never sent to
  // the client. The server-side record is the deps.logger.error call in handle() below; the
  // response stays generic.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** Every unknown (500) error is logged via deps.logger.error before the Problem envelope is
 *  returned — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." The raw `error` value is
 *  passed under the `err` key so pino's own error serializer formats the stack trace; the HTTP
 *  response itself stays the generic UNKNOWN_ERROR_DETAIL — this is server-side only. */
async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: CalculateDailyCommissionDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'hr.calculate-daily-commission: unhandled error');
    }
    return failure;
  }
}

export async function handleCalculateDailyCommission(
  request: ApiRequest<unknown>,
  deps: CalculateDailyCommissionDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof calculateDailyCommission>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = CalculateDailyCommissionInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_CALCULATE, input);
      return calculateDailyCommission(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
