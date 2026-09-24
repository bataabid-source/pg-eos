// modules/platform/api/evaluate-alerts/handlers.ts — WBS 5.13 part 1, replicated (shape only)
// from the golden slice's handlers.ts (modules/wms/api/receive-inbound/handlers.ts). Scoped, per
// the build brief, to the AcknowledgeAlert handler only — EvaluateAlertRules is the pg-boss job
// body / internal trigger in part 1, not an HTTP write endpoint.
//
// api/ layer: request in, response out. No NestJS app exists yet anywhere in this workspace —
// framework-free async functions: Zod-validated input from
// packages/contracts/platform/evaluate-alerts.ts, an Idempotency-Key header required (CLAUDE.md ·
// ARCHITECTURE), every typed domain error mapped to the RFC 9457 Problem envelope.
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command call, so a bad body
//     produces a 400 Problem instead of an uncaught ZodError;
//   - ActionLinkMissingError -> 400 (a bad request-shaped domain invariant, doc 40 §B6);
//   - StaleVersionError and AlertAlreadyAcknowledgedError -> 409 (both are "someone else already
//     changed this row" conflicts), alongside IdempotencyConflictError (SCR-PLAT-IDEM-01);
//   - RoleRequiredError -> 403 (PROBLEM_STATUS carries no 403 — HTTP_STATUS_FORBIDDEN is a local
//     constant here, same discipline as HTTP_STATUS_OK/HTTP_STATUS_INTERNAL_SERVER_ERROR below);
//   - MissingActorError -> 422 (the golden slice's own mapping for this error —
//     modules/wms/api/receive-inbound/handlers.ts ~L211-216);
//   - AlertLogNotFoundError -> 404 (HTTP_STATUS_NOT_FOUND, a local constant — same discipline as
//     HTTP_STATUS_FORBIDDEN);
//   - an UNKNOWN error maps to a 500 Problem — never rethrown, logged server-side via
//     deps.logger.error before the Problem is returned (CLAUDE.md · AGENT CONSTRAINTS "No
//     console.log — pino");
//   - `title` is always `error.name` (or `'ZodError'` / `'InternalServerError'`).
//
// IDEMPOTENCY (SCR-PLAT-IDEM-01): the write handler builds an IdempotencyInput from the required
// header plus a sha256 hash of the CANONICAL (stable-key-order) parsed body, and passes it to
// acknowledgeAlert as `idem` — the command itself runs the whole thing inside
// withIdempotentContext (packages/db/src/idempotency.ts). A replay never re-runs the command; a
// same-key/different-body call is a 409 IdempotencyConflictError caught by errorToApiFailure below.

import { createHash } from 'node:crypto';

import { ZodError } from 'zod';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import { AcknowledgeAlertInputSchema } from '@pg-eos/contracts/platform/evaluate-alerts';
import { IdempotencyConflictError, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { acknowledgeAlert, type EvaluateAlertsDeps } from '../../application/evaluate-alerts/index.js';
import {
  ActionLinkMissingError,
  AlertAlreadyAcknowledgedError,
  AlertLogNotFoundError,
  MissingActorError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/evaluate-alerts/errors.js';

// REPLACE-ON-COPY: this use case's own idempotency endpoint identifier for its one write command.
const IDEMPOTENCY_ENDPOINT_ACKNOWLEDGE = 'platform.evaluate-alerts.acknowledge-alert';

export interface ApiHeaders {
  readonly [headerName: string]: string | undefined;
}

export interface ApiRequest<TBody> {
  readonly headers: ApiHeaders;
  readonly body: TBody;
  readonly ctx: WithContextCtx;
}

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
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

/** Builds the IdempotencyInput the write handler passes to its command as `idem`. `entityId` is
 *  null — platform.alert_rules/alert_log are not entity-scoped (platform brief §2). Called only
 *  after requireIdempotencyKey already confirmed the header is present. */
function buildIdem(request: ApiRequest<unknown>, endpoint: string, parsedBody: unknown): IdempotencyInput {
  const key = findHeader(request.headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!key) {
    // Unreachable in practice — requireIdempotencyKey already returned before reaching here when
    // the header is missing. Thrown, not silently defaulted, if that ever drifts.
    throw new Error('buildIdem: Idempotency-Key header missing (requireIdempotencyKey should have caught this).');
  }
  return { key, endpoint, requestHash: requestHashOf(parsedBody), entityId: null, successStatus: HTTP_STATUS_OK };
}

/** Reads `body.correlationId` without ever asserting `any` — used only to enrich the 500 log line
 *  below; a 500 can happen before the body even parses, so this reads the raw, pre-validation body
 *  defensively. */
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
  if (error instanceof ActionLinkMissingError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (
    error instanceof StaleVersionError ||
    error instanceof AlertAlreadyAcknowledgedError ||
    error instanceof IdempotencyConflictError
  ) {
    return problem(PROBLEM_STATUS.CONFLICT, error.name, error.message);
  }
  if (error instanceof RoleRequiredError) {
    return problem(HTTP_STATUS_FORBIDDEN, error.name, error.message);
  }
  if (error instanceof MissingActorError) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  if (error instanceof AlertLogNotFoundError) {
    return problem(HTTP_STATUS_NOT_FOUND, error.name, error.message);
  }
  // An unknown error's own message may carry SQL or table names — never sent to the client. The
  // server-side record is the deps.logger.error call in handle() below; the response stays generic.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** Every unknown (500) error is logged via deps.logger.error before the Problem envelope is
 *  returned — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." */
async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: EvaluateAlertsDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'platform.evaluate-alerts: unhandled error');
    }
    return failure;
  }
}

export async function handleAcknowledgeAlert(
  request: ApiRequest<unknown>,
  deps: EvaluateAlertsDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof acknowledgeAlert>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = AcknowledgeAlertInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_ACKNOWLEDGE, input);
      return acknowledgeAlert({ ...input, idem }, request.ctx, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
