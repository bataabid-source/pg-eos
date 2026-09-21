// packages/contracts/_shared/registry.ts — WBS 0.13.
// ContractRegistry: register schema · register route · invariant checks (brief "Deliver" list).
//
// This is the single source of truth an OpenAPI document (D1, D5) and the contract-test harness
// (_harness/contract-test.ts) both read from. No business route is authored here — a registry
// instance starts empty and modules register their own routes from their own WBS tasks.

import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import type {
  ZodObjectInput,
  ZodOpenApiObject,
  ZodOpenApiOperationObject,
  ZodOpenApiParameters,
  ZodOpenApiPathItemObject,
  ZodOpenApiPathsObject,
  ZodOpenApiResponsesObject,
} from 'zod-openapi';

import { IDEMPOTENCY_KEY_HEADER_NAME } from './headers.js';

/** HTTP methods a route contract may declare. doc 40 §A4 governs the four write methods; GET is
 * exempt from the Idempotency-Key invariant (doc 40 mandates it only for write endpoints). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Zod schemas for the parts of an HTTP request a route contract may declare. Parts a route does
 * not declare are not part of its contract — the harness ignores them. `headers`/`params`/`query`
 * are typed as `ZodObjectInput` — the exact object-input shape `zod-openapi` itself requires for
 * parameters — so registering a non-object schema in one of those three fields is a compile-time
 * error (reviewer finding 4), not a silent runtime omission. `body` legitimately takes any
 * `z.ZodType` (an array or scalar request body is valid JSON). */
export interface RouteRequestSchemas {
  headers?: ZodObjectInput;
  params?: ZodObjectInput;
  query?: ZodObjectInput;
  body?: z.ZodType;
}

/** One declared response: `description` is mandatory (OpenAPI requires it), `body` is optional
 * (e.g. a 204 has none). */
export interface RouteResponseDefinition {
  description: string;
  body?: z.ZodType;
}

export type RouteResponses = Record<number, RouteResponseDefinition>;

/** Input accepted by `ContractRegistry#registerRoute`. */
export interface RouteDefinitionInput {
  method: HttpMethod;
  path: string;
  summary: string;
  request?: RouteRequestSchemas;
  responses: RouteResponses;
}

/** The frozen route contract handed back by `registerRoute` — the harness and the OpenAPI
 * generator both consume exactly this shape. */
export interface RouteContract {
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly request?: RouteRequestSchemas;
  readonly responses: RouteResponses;
}

/** One registry-invariant violation. Today there is one invariant (doc 40 §A4); more may be added
 * to `checkInvariants` later without changing this shape. */
export interface RegistryInvariantViolation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly message: string;
}

/** The OpenAPI 3.1 document produced by `ContractRegistry#toOpenApiDocument`. */
export type OpenApiDocument = ReturnType<typeof createDocument>;

const WRITE_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Case-insensitive match target (finding 5) — derived from the one named constant in
// _shared/headers.ts so nobody hand-rolls the literal string in two places.
const IDEMPOTENCY_KEY_HEADER_FIELD_LOWER = IDEMPOTENCY_KEY_HEADER_NAME.toLowerCase();

// finding 11: every response status must be an integer in this range (RFC 9110 §15 / HTTP's own
// three-digit status-code space) — named constants, not magic numbers.
const HTTP_STATUS_CODE_MIN = 100;
const HTTP_STATUS_CODE_MAX = 599;

// D1: zod-openapi emits OpenAPI 3.1 directly.
const OPENAPI_VERSION = '3.1.0';
// Default taken (none of this is an ADR — recorded in CHANGELOG per BOOTSTRAP-v5 §2): the
// generated document's `info` object names the package itself; no business API is authored here.
const DOCUMENT_TITLE = '@pg-eos/contracts';
const DOCUMENT_VERSION = '0.0.0';

/** Finds the request's Idempotency-Key header field, matching the field name case-insensitively
 * (finding 5 — a route declaring `'Idempotency-Key'`, capitalized, must be recognized same as
 * `'idempotency-key'`). Returns the field's own schema so the caller can check whether it is
 * mandatory, or `undefined` if the header schema is missing, not a `z.object`, or declares no
 * matching field. */
function findIdempotencyKeyField(headers: ZodObjectInput | undefined): z.ZodType | undefined {
  if (!(headers instanceof z.ZodObject)) return undefined;

  for (const [field, schema] of Object.entries(headers.shape)) {
    if (field.toLowerCase() === IDEMPOTENCY_KEY_HEADER_FIELD_LOWER) return schema;
  }

  return undefined;
}

/** doc 40 §A4's Idempotency-Key invariant is satisfied only by a *mandatory* header field — an
 * `.optional()` field cannot produce the mandated 400 on a missing header, so it still counts as
 * a violation (finding 6). "Mandatory" is checked the same way Zod itself defines `isOptional`:
 * the field's own schema must reject `undefined`. */
function declaresIdempotencyKeyHeader(request: RouteRequestSchemas | undefined): boolean {
  const field = findIdempotencyKeyField(request?.headers);
  if (field === undefined) return false;

  return !field.safeParse(undefined).success;
}

function toRequestParams(request: RouteRequestSchemas | undefined): ZodOpenApiParameters | undefined {
  if (request === undefined) return undefined;

  const params: ZodOpenApiParameters = {};
  if (request.headers !== undefined) params.header = request.headers;
  if (request.params !== undefined) params.path = request.params;
  if (request.query !== undefined) params.query = request.query;

  return Object.keys(params).length > 0 ? params : undefined;
}

/** finding 11: throws when any `responses` key is not an integer in
 * `[HTTP_STATUS_CODE_MIN, HTTP_STATUS_CODE_MAX]`. */
function assertValidResponseStatuses(method: HttpMethod, path: string, responses: RouteResponses): void {
  for (const key of Object.keys(responses)) {
    const status = Number(key);
    const isValid =
      Number.isInteger(status) && status >= HTTP_STATUS_CODE_MIN && status <= HTTP_STATUS_CODE_MAX;
    if (isValid) continue;

    throw new Error(
      `${method} ${path}: response status "${key}" must be an integer in ` +
        `[${HTTP_STATUS_CODE_MIN}, ${HTTP_STATUS_CODE_MAX}].`,
    );
  }
}

/** finding 9: the key `registerRoute` deduplicates on — one registry instance may not register the
 * same method+path pair twice. */
function routeRegistrationKey(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}

function toResponses(responses: RouteResponses): ZodOpenApiResponsesObject {
  const result: ZodOpenApiResponsesObject = {};

  for (const key of Object.keys(responses)) {
    const definition = responses[Number(key)];
    if (definition === undefined) continue;

    const statusKey = key as `${1 | 2 | 3 | 4 | 5}${string}`;
    result[statusKey] = {
      description: definition.description,
      ...(definition.body !== undefined
        ? { content: { 'application/json': { schema: definition.body } } }
        : {}),
    };
  }

  return result;
}

function methodKey(method: HttpMethod): 'get' | 'post' | 'put' | 'patch' | 'delete' {
  switch (method) {
    case 'GET':
      return 'get';
    case 'POST':
      return 'post';
    case 'PUT':
      return 'put';
    case 'PATCH':
      return 'patch';
    case 'DELETE':
      return 'delete';
  }
}

function toOperation(route: RouteContract): ZodOpenApiOperationObject {
  const requestParams = toRequestParams(route.request);
  const body = route.request?.body;

  return {
    summary: route.summary,
    ...(requestParams !== undefined ? { requestParams } : {}),
    ...(body !== undefined
      ? { requestBody: { content: { 'application/json': { schema: body } } } }
      : {}),
    responses: toResponses(route.responses),
  };
}

function toPaths(routes: readonly RouteContract[]): ZodOpenApiPathsObject {
  const paths: ZodOpenApiPathsObject = {};

  for (const route of routes) {
    const existing: ZodOpenApiPathItemObject = paths[route.path] ?? {};
    paths[route.path] = { ...existing, [methodKey(route.method)]: toOperation(route) };
  }

  return paths;
}

export class ContractRegistry {
  private readonly routes: RouteContract[] = [];
  private readonly routesByRegistrationKey = new Map<string, RouteContract>();

  /** Registers a route and returns its frozen contract.
   *
   * Throws a plain `Error` (finding 9) when the same `method`+`path` pair is already registered
   * on this registry instance, and (finding 11) when any `responses` key is not an integer in
   * `[100, 599]`. The returned `RouteContract` — and its `responses` and `request`, if present —
   * are genuinely frozen (finding 12), not just typed `readonly`. */
  registerRoute(definition: RouteDefinitionInput): RouteContract {
    const registrationKey = routeRegistrationKey(definition.method, definition.path);
    if (this.routesByRegistrationKey.has(registrationKey)) {
      throw new Error(
        `Duplicate route registration: ${definition.method} ${definition.path} is already ` +
          'registered on this ContractRegistry.',
      );
    }

    assertValidResponseStatuses(definition.method, definition.path, definition.responses);

    const responses = Object.freeze({ ...definition.responses });
    const request =
      definition.request !== undefined ? Object.freeze({ ...definition.request }) : undefined;

    const route: RouteContract = Object.freeze({
      method: definition.method,
      path: definition.path,
      summary: definition.summary,
      ...(request !== undefined ? { request } : {}),
      responses,
    });

    this.routes.push(route);
    this.routesByRegistrationKey.set(registrationKey, route);
    return route;
  }

  /** Tags `schema` for zod-openapi's component/`$ref` mechanism (D1, finding 10): Zod's own
   * `.meta({id})` registers the schema so `toOpenApiDocument` emits one `components.schemas`
   * entry for it and `$ref`s it from every route request/response that reuses the returned
   * schema, instead of inlining it every time. Returns the tagged schema (Zod's `.meta()` clones
   * rather than mutates — see `_shared/problem.ts`) for the caller to use in place of the
   * original. */
  registerSchema(id: string, schema: z.ZodType): z.ZodType {
    return schema.meta({ id });
  }

  /** doc 40 §A4: every write endpoint (POST/PUT/PATCH/DELETE) must declare the Idempotency-Key
   * header in `request.headers`. GET is exempt. */
  checkInvariants(): RegistryInvariantViolation[] {
    const violations: RegistryInvariantViolation[] = [];

    for (const route of this.routes) {
      if (!WRITE_METHODS.has(route.method)) continue;
      if (declaresIdempotencyKeyHeader(route.request)) continue;

      violations.push({
        method: route.method,
        path: route.path,
        message:
          `${route.method} ${route.path} is a write endpoint and must declare the ` +
          'Idempotency-Key header (doc 40 §A4) in request.headers.',
      });
    }

    return violations;
  }

  /** Pure (no I/O): builds the OpenAPI 3.1 document from every registered route via zod-openapi
   * (D1). With zero routes registered this is still a valid, schema-conformant minimal document. */
  toOpenApiDocument(): OpenApiDocument {
    // The OpenAPI 3.1 meta-schema requires at least one of paths/components/webhooks — an empty
    // `paths` object (not an absent key) is what keeps a zero-route document schema-conformant.
    const document: ZodOpenApiObject = {
      openapi: OPENAPI_VERSION,
      info: { title: DOCUMENT_TITLE, version: DOCUMENT_VERSION },
      paths: toPaths(this.routes),
    };

    return createDocument(document);
  }
}
