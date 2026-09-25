// modules/wms/api/take-occupancy-snapshot/handlers.ts — WBS 2.14 (lane 2).
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace
// (`apps/` is empty) — framework-free async functions: Zod-validated input from
// packages/contracts/wms/take-occupancy-snapshot.ts, an Idempotency-Key header required on this
// write (CLAUDE.md · ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem
// envelope. Same shape as ../count-inventory/handlers.ts.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem (BAD_REQUEST) instead of an uncaught ZodError;
//   - WarehouseNotFoundError, ServiceNotFoundError, RoleRequiredError, MissingActorError all map
//     to 422 (PROBLEM_STATUS has no 404, same as ../count-inventory/handlers.ts);
//   - IdempotencyConflictError maps to 409 — no StaleVersionError exists here (brief D1: no
//     version column on this aggregate);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, logged server-side via
//     deps.logger.error before the Problem is returned (CLAUDE.md · AGENT CONSTRAINTS "No
//     console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`).
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): the write handler below builds an IdempotencyInput from the
// required header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes
// it to the command as `idem` — the command itself runs the whole thing inside
// withIdempotentContext (packages/db/src/idempotency.ts).

import { createHash } from 'node:crypto';

import { ZodError } from 'zod';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import { TakeOccupancySnapshotInputSchema } from '@pg-eos/contracts/wms/take-occupancy-snapshot';
import { IdempotencyConflictError, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { takeOccupancySnapshot, type TakeOccupancySnapshotDeps } from '../../application/take-occupancy-snapshot/index.js';
import { MissingActorError, RoleRequiredError, ServiceNotFoundError, WarehouseNotFoundError } from '../../domain/take-occupancy-snapshot/errors.js';

const IDEMPOTENCY_ENDPOINT_TAKE_SNAPSHOT = 'wms.take-occupancy-snapshot.take-occupancy-snapshot';

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

function requestHashOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

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
 *  `error.name`. PROBLEM_STATUS has no 404, so WarehouseNotFoundError/ServiceNotFoundError map to
 *  422 alongside every other business-rule rejection. An error NOT in this list is unknown —
 *  mapped to 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof IdempotencyConflictError) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (
    error instanceof RoleRequiredError ||
    error instanceof WarehouseNotFoundError ||
    error instanceof ServiceNotFoundError ||
    error instanceof MissingActorError
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
  deps: TakeOccupancySnapshotDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'wms.take-occupancy-snapshot: unhandled error');
    }
    return failure;
  }
}

export async function handleTakeOccupancySnapshot(
  request: ApiRequest<unknown>,
  deps: TakeOccupancySnapshotDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof takeOccupancySnapshot>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = TakeOccupancySnapshotInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_TAKE_SNAPSHOT, input);
      return takeOccupancySnapshot(request.ctx, { ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
