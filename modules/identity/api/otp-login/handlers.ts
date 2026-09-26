// modules/identity/api/otp-login/handlers.ts — WBS 2.16 part 1a-3.
//
// api/ layer: request in, response out — framework-free async functions, same shape as
// modules/wms/api/receive-inbound/handlers.ts (no NestJS app exists yet; a future controller wraps
// these one-to-one). Zod-validated input from packages/contracts/identity/otp-login.ts, an
// Idempotency-Key header required on both writes (CLAUDE.md · ARCHITECTURE), every typed error
// mapped to the RFC 9457 Problem envelope. No business logic lives here.
//
// NOT FOR MOUNTING YET (review round 1, finding 4). These handlers must not be mounted on any real
// transport until the G-16a limits (DECISION_LOG §1.8) exist somewhere enforcing them: OTP — 5
// attempts, resend 60 s, 5 per email per hour; lockout — 10 failures per 15 min; login — 5 per
// minute per IP, 20 per hour per email. None of them is enforced anywhere in this codebase today,
// and inventing that policy here is what CLAUDE.md forbids; tracked in MASTER_BACKLOG.
//
// ApiRequest carries NO `ctx`: the caller is, by definition, not yet authenticated. No RLS context
// is assembled anywhere in this module (review round 1, finding 3 — closed by Master task P6c):
// the whole pre-auth path runs inside @pg-eos/identity-mechanisms' requestLoginOtp /
// verifyLoginOtp flows, under that package's own internal context.
//
// OTP DELIVERY (brief, POST-P6c rules 1 and 5). No delivery channel exists for the OTP code yet
// (recorded gap, MASTER_BACKLOG): requestLoginOtp hands the code back and requestOtpCode discards
// it — never returned in a response, never logged, never stored. When a channel is built it MUST be
// invoked asynchronously (e.g. a queued job), never synchronously in this request path, so it adds
// nothing to the response latency. The residual timing difference between a known and an unknown
// email (the known path's write transaction) is login.ts's own documented design, not this layer's;
// this layer adds no further asymmetry.
//
// IDEMPOTENCY. Built here, once, from the Idempotency-Key header and the sha256 of the canonical
// parsed body, and passed to the command as a REQUIRED `idem`. request-otp-code hashes its whole
// parsed body; verify-otp-code hashes `{ email, correlationId }` only — the OTP code is a
// single-use secret, never reaches platform.idempotency_keys.request_hash, and login.ts's replay
// semantics depend on it being excluded (review round 1, finding 7).
//
// Error mapping:
//   - the Zod `.parse()` call is INSIDE the same try/catch as the command, so a bad body is a 400
//     Problem (title 'ZodError'), never an uncaught exception;
//   - InvalidOtpError -> 422 (the one rejection verifyOtpCode ever raises — uniform for an unknown
//     or inactive email, a wrong, expired or consumed code, and a replay that carries no token).
//     requestOtpCode raises no typed rejection at all: every email is a normal 200;
//   - NO 409: IdempotencyConflictError is absorbed inside login.ts on both flows (a surfaced 409
//     would itself be the enumeration oracle — login.ts header), so it never reaches this layer;
//     it is deliberately not mapped here. Should it ever surface, it is an unknown error (500);
//   - an UNKNOWN error -> 500 with a generic detail, logged via deps.logger.error (never
//     console.log) with `{ correlationId, err }`, never rethrown.

import { createHash } from 'node:crypto';

import { ZodError } from 'zod';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import {
  RequestOtpCodeInputSchema,
  VerifyOtpCodeInputSchema,
} from '@pg-eos/contracts/identity/otp-login';
import type { IdempotencyInput } from '@pg-eos/db';

import {
  requestOtpCode,
  verifyOtpCode,
  type OtpLoginDeps,
} from '../../application/otp-login/index.js';
import { InvalidOtpError } from '../../domain/otp-login/errors.js';

const IDEMPOTENCY_ENDPOINT_REQUEST_OTP_CODE = 'identity.otp-login.request-otp-code';
const IDEMPOTENCY_ENDPOINT_VERIFY_OTP_CODE = 'identity.otp-login.verify-otp-code';

export interface ApiHeaders {
  readonly [headerName: string]: string | undefined;
}

export interface ApiRequest<TBody> {
  readonly headers: ApiHeaders;
  readonly body: TBody;
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

/** Builds the IdempotencyInput each write handler passes to its command as `idem`. `entityId` is
 *  null — a login request has no entity scope. Called only after requireIdempotencyKey already
 *  confirmed the header is present. */
function buildIdem(request: ApiRequest<unknown>, endpoint: string, parsedBody: unknown): IdempotencyInput {
  const key = findHeader(request.headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!key) {
    // Unreachable in practice — every write handler calls requireIdempotencyKey first. Thrown, not
    // silently defaulted, if that ever drifts.
    throw new Error('buildIdem: Idempotency-Key header missing (requireIdempotencyKey should have caught this).');
  }
  return { key, endpoint, requestHash: requestHashOf(parsedBody), entityId: null, successStatus: HTTP_STATUS_OK };
}

/** Reads `body.correlationId` without asserting `any` — used only to enrich the 500 log line; a
 *  500 can happen before the body parses, so this reads the raw body defensively. */
function extractCorrelationId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'correlationId' in body) {
    const value = (body as Record<string, unknown>)['correlationId'];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** Maps every typed error this use case can throw to its HTTP status; `title` is always
 *  `error.name`. An error NOT in this list is unknown — 500, never rethrown. */
function errorToApiFailure(error: unknown): ApiFailure {
  if (error instanceof ZodError) {
    return problem(PROBLEM_STATUS.BAD_REQUEST, error.name, error.message);
  }
  if (error instanceof InvalidOtpError) {
    return problem(PROBLEM_STATUS.UNPROCESSABLE_ENTITY, error.name, error.message);
  }
  // An unknown error's own message may carry SQL, table names or an email — never sent to the
  // client. The server-side record is the deps.logger.error call in handle() below.
  return problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
}

/** Every unknown (500) error is logged via deps.logger.error before the Problem envelope is
 *  returned — the raw `error` under `err` so pino's serializer formats the stack. */
async function handle<TBody>(
  fn: () => Promise<TBody>,
  deps: OtpLoginDeps,
  correlationId: string | undefined,
): Promise<ApiResult<TBody>> {
  try {
    return { status: HTTP_STATUS_OK, body: await fn() };
  } catch (error) {
    const failure = errorToApiFailure(error);
    if (failure.status === HTTP_STATUS_INTERNAL_SERVER_ERROR) {
      deps.logger.error({ correlationId, err: error }, 'identity.otp-login: unhandled error');
    }
    return failure;
  }
}

export async function handleRequestOtpCode(
  request: ApiRequest<unknown>,
  deps: OtpLoginDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof requestOtpCode>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = RequestOtpCodeInputSchema.parse(request.body);
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_REQUEST_OTP_CODE, input);
      return requestOtpCode({ ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}

export async function handleVerifyOtpCode(
  request: ApiRequest<unknown>,
  deps: OtpLoginDeps,
): Promise<ApiResult<Awaited<ReturnType<typeof verifyOtpCode>>>> {
  const missingKey = requireIdempotencyKey(request.headers);
  if (missingKey) return missingKey;
  return handle(
    () => {
      const input = VerifyOtpCodeInputSchema.parse(request.body);
      // finding 7: the code is excluded from the hashed body.
      const idem = buildIdem(request, IDEMPOTENCY_ENDPOINT_VERIFY_OTP_CODE, {
        email: input.email,
        correlationId: input.correlationId,
      });
      return verifyOtpCode({ ...input, idem }, deps);
    },
    deps,
    extractCorrelationId(request.body),
  );
}
