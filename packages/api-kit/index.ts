// packages/api-kit/index.ts — the framework-free api/ helper set every use-case handlers.ts shares
// (docs/STREAMS.md §Enablement item 5). Extracted verbatim from the golden slice
// modules/wms/api/receive-inbound/handlers.ts; semantics unchanged. Node-only (node:crypto):
// imported by modules/*/api/**, never by apps/.

import { createHash } from 'node:crypto';

import { IDEMPOTENCY_KEY_HEADER_NAME, PROBLEM_STATUS, type Problem } from '@pg-eos/contracts';
import type { IdempotencyInput, WithContextCtx } from '@pg-eos/db';

export interface ApiHeaders {
  readonly [headerName: string]: string | undefined;
}

export interface ApiRequest<TBody> {
  readonly headers: ApiHeaders;
  readonly body: TBody;
  readonly ctx: WithContextCtx;
}

export const HTTP_STATUS_OK = 200;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

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
export const PROBLEM_TYPE_BASE = 'https://pg-eos.local/problems/';

export const UNKNOWN_ERROR_DETAIL =
  'An unexpected error occurred. (Allowed: retry, or report it with the correlationId.)';

/** Case-insensitive header lookup. */
export function findHeader(headers: ApiHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) return headers[key];
  }
  return undefined;
}

/** The RFC 9457 Problem envelope; `type` is PROBLEM_TYPE_BASE + the kebab-cased title. */
export function problem(status: number, title: string, detail: string): ApiFailure {
  return {
    status,
    body: { type: `${PROBLEM_TYPE_BASE}${title.toLowerCase().replace(/\s+/g, '-')}`, title, status, detail, instance: '' },
  };
}

/** doc 40 §A4: every write endpoint requires the Idempotency-Key header. Returns a 400 Problem
 *  when it is absent, `undefined` (meaning "continue") otherwise. The 409-on-mismatch and the
 *  replay of the prior result are handled by `buildIdem` plus packages/db's
 *  `withIdempotentContext`. */
export function requireIdempotencyKey(headers: ApiHeaders): ApiFailure | undefined {
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
export function canonicalize(value: unknown): unknown {
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
export function requestHashOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

/** Builds the IdempotencyInput every write handler passes to its command as `idem`. `entityId` is
 *  null — the command itself resolves the entity. Only the headers are read, so a request shape
 *  without `ctx` (identity/otp-login, pre-authentication) is accepted too. Called only after
 *  requireIdempotencyKey already confirmed the header is present. */
export function buildIdem(
  request: Pick<ApiRequest<unknown>, 'headers'>,
  endpoint: string,
  parsedBody: unknown,
): IdempotencyInput {
  const key = findHeader(request.headers, IDEMPOTENCY_KEY_HEADER_LOWER);
  if (!key) {
    throw new Error('buildIdem: Idempotency-Key header missing (requireIdempotencyKey should have caught this).');
  }
  return { key, endpoint, requestHash: requestHashOf(parsedBody), entityId: null, successStatus: HTTP_STATUS_OK };
}

/** Reads `body.correlationId` from the raw, pre-validation body without asserting `any` — used
 *  only to enrich the 500 log line. */
export function extractCorrelationId(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'correlationId' in body) {
    const value = (body as Record<string, unknown>)['correlationId'];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}
