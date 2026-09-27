// apps/api/src/server.ts — X part 5a (ADR-0006 §1, §3). The Fastify host.
//
// Pipeline for every mounted route (brief, pinned order): authenticate (session → subject, 401 on
// anything but an active internal user) → 501 for a contract-first route without a handlers file
// (registry mark, X part 12) and the NOT_MOUNTED_UNTIL_2_16_PART_1A_5 entries → entity scope
// (X-Entity-Id, 403/422) → the handler with `{ headers (no authorization), body (GET: query),
// ctx }`. The ctx is derived only from the session and the resolved entity — never from the body
// or a header — and lives only in the request.
// Idempotency-Key and Zod validation stay inside the handlers.

import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';

import {
  findHeader,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_OK,
  problem,
  UNKNOWN_ERROR_DETAIL,
  type ApiFailure,
  type ApiRequest,
} from '@pg-eos/api-kit';
import { ALL_ROUTES, PROBLEM_STATUS, type HttpMethod } from '@pg-eos/contracts';
import {
  createUserEntitiesLookup,
  EntityScopeForbiddenError,
  EntityScopeRequiredError,
  resolveActiveEntityId,
  type UserEntitiesLookup,
} from '@pg-eos/db';
import { verifySessionSubject } from '@pg-eos/identity-mechanisms';
import { childLogger } from '@pg-eos/logger';

import {
  authenticate,
  ctxFor,
  subjectCtxFor,
  UNAUTHORIZED_PROBLEM,
  type AuthenticatedSubject,
  type VerifySubject,
} from './auth.js';
import { normalizeHeaders } from './headers.js';
import {
  BODY_LIMIT_BYTES,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
} from './http-status.js';
import { buildRouteTable, type RouteTable } from './route-table.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated subject of THIS request, set by the onRequest hook before the body is
     *  parsed; request-scoped, never module-level. null until (or unless) authentication passes. */
    subject: AuthenticatedSubject | null;
  }
}

/** The result every handler returns (api-kit `ApiResult`), read structurally. */
export interface HostResult {
  readonly status: number;
  readonly body: unknown;
}

/** One route the host mounts: a handler already bound to its deps. */
export interface HostRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: (request: ApiRequest<unknown>) => Promise<HostResult>;
}

export interface BuildServerOptions {
  /** Default: `verifySessionSubject` (@pg-eos/identity-mechanisms). */
  readonly verifySubject?: VerifySubject;
  /** Default: `createUserEntitiesLookup` under the subject's own ctx (@pg-eos/db). */
  readonly lookupEntities?: UserEntitiesLookup;
  /** When given, IS the mounted table (ALL_ROUTES is not read). */
  readonly routes?: readonly HostRoute[];
  /** Forwarded to buildRouteTable when `routes` is omitted. */
  readonly modulesRoot?: URL;
}

const HEALTH_PATH = '/health';
const ENTITY_ID_HEADER = 'X-Entity-Id';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const TEXT_PLAIN_CONTENT_TYPE = 'text/plain';
const FASTIFY_CONTENT_PARSER_CODE_PREFIX = 'FST_ERR_CTP_';
const REDACTED_PATHS = ['req.headers.authorization'];

/** Fastify content-parser errors the host passes through with their own status (RFC 9457). */
const CLIENT_ERROR_PROBLEMS: ReadonlyMap<number, ApiFailure> = new Map([
  [
    PROBLEM_STATUS.BAD_REQUEST,
    problem(PROBLEM_STATUS.BAD_REQUEST, 'Bad Request', 'The request body is empty or not valid JSON. (Allowed: a non-empty JSON object.)'),
  ],
  [
    HTTP_STATUS_PAYLOAD_TOO_LARGE,
    problem(
      HTTP_STATUS_PAYLOAD_TOO_LARGE,
      'Payload Too Large',
      `The request body exceeds the size limit. (Allowed: a body of at most ${BODY_LIMIT_BYTES} bytes.)`,
    ),
  ],
  [
    HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
    problem(
      HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
      'Unsupported Media Type',
      'The request body media type is not supported. (Allowed: application/json.)',
    ),
  ],
]);

const INTERNAL_ERROR_PROBLEM = problem(HTTP_STATUS_INTERNAL_SERVER_ERROR, 'InternalServerError', UNKNOWN_ERROR_DETAIL);
const NOT_FOUND_PROBLEM = problem(
  HTTP_STATUS_NOT_FOUND,
  'Not Found',
  'No operation is registered at this method and path. (Allowed: a method and path listed in the OpenAPI document.)',
);
const ENTITY_FORBIDDEN_PROBLEM = problem(
  PROBLEM_STATUS.FORBIDDEN,
  'Entity Forbidden',
  'The X-Entity-Id header names no entity this user may act in. (Allowed: send X-Entity-Id naming one of your own entities, or omit it when you hold exactly one.)',
);
const ENTITY_REQUIRED_PROBLEM = problem(
  PROBLEM_STATUS.UNPROCESSABLE_ENTITY,
  'Entity Required',
  'This user holds zero or several entities. (Allowed: send X-Entity-Id naming one of them.)',
);

type TableEntry =
  | { readonly kind: 'mounted'; readonly route: HostRoute }
  | { readonly kind: 'unimplemented'; readonly method: HttpMethod; readonly path: string; readonly problem: ApiFailure };

function sendProblem(reply: FastifyReply, failure: ApiFailure): FastifyReply {
  return reply.status(failure.status).type(PROBLEM_CONTENT_TYPE).send(failure.body);
}

function isHostResult(value: unknown): value is HostResult {
  return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'number' && 'body' in value;
}

function isFastifyError(error: unknown): error is FastifyError {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

function clientErrorProblem(error: unknown): ApiFailure | undefined {
  if (!isFastifyError(error) || !error.code.startsWith(FASTIFY_CONTENT_PARSER_CODE_PREFIX)) return undefined;
  return error.statusCode === undefined ? undefined : CLIENT_ERROR_PROBLEMS.get(error.statusCode);
}

function tableEntries(table: RouteTable): TableEntry[] {
  return [
    ...table.mounted.map((entry): TableEntry => ({
      kind: 'mounted',
      route: {
        method: entry.method,
        path: entry.path,
        handler: async (request) => {
          const result = await entry.handler(request, entry.deps);
          if (!isHostResult(result)) {
            throw new Error(`handler ${entry.handlerName} for ${entry.path} returned no { status, body }`);
          }
          return result;
        },
      },
    })),
    ...table.unimplemented.map((entry): TableEntry => ({ kind: 'unimplemented', ...entry })),
  ];
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const verifySubject = options.verifySubject ?? verifySessionSubject;
  const lookupFor = (subject: AuthenticatedSubject): UserEntitiesLookup =>
    options.lookupEntities ?? createUserEntitiesLookup(subjectCtxFor(subject));

  const logger: FastifyBaseLogger = childLogger({ app: 'api' }).child({}, { redact: REDACTED_PATHS });
  // exposeHeadRoutes: false — no HEAD route beside the GET routes (ADR-0006 one-to-one).
  const app = Fastify({ loggerInstance: logger, bodyLimit: BODY_LIMIT_BYTES, exposeHeadRoutes: false });
  app.decorateRequest('subject', null);

  /** onRequest: the session is checked BEFORE Fastify parses the body, so an unauthenticated
   *  request never reaches the content parser (401, never 400/413/415). */
  const authenticateRequest = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const authentication = await authenticate(request.headers, verifySubject);
    if (!authentication.ok) return sendProblem(reply, authentication.problem);
    request.subject = authentication.subject;
    return undefined;
  };

  // JSON only (brief: default JSON parser) — text/plain is refused with 415.
  app.removeContentTypeParser(TEXT_PLAIN_CONTENT_TYPE);

  app.setErrorHandler((error, request, reply) => {
    const clientProblem = clientErrorProblem(error);
    if (clientProblem) return sendProblem(reply, clientProblem);
    request.log.error({ err: error }, 'api: unhandled error');
    return sendProblem(reply, INTERNAL_ERROR_PROBLEM);
  });

  app.setNotFoundHandler((_request, reply) => sendProblem(reply, NOT_FOUND_PROBLEM));

  app.get(HEALTH_PATH, async (_request, reply) => reply.status(HTTP_STATUS_OK).send({ status: 'ok' }));

  const mount = (entry: TableEntry): void => {
    const method = entry.kind === 'mounted' ? entry.route.method : entry.method;
    const path = entry.kind === 'mounted' ? entry.route.path : entry.path;
    app.route({
      method,
      url: path,
      onRequest: authenticateRequest,
      handler: async (request, reply) => {
        // Fail-closed: the hook sets the subject or has already replied 401.
        const subject = request.subject;
        if (subject === null) return sendProblem(reply, UNAUTHORIZED_PROBLEM);
        if (entry.kind === 'unimplemented') return sendProblem(reply, entry.problem);

        const headers = normalizeHeaders(request.headers);
        let entityId: string;
        try {
          entityId = await resolveActiveEntityId(
            findHeader(headers, ENTITY_ID_HEADER),
            subject.userId,
            lookupFor(subject),
          );
        } catch (error) {
          if (error instanceof EntityScopeForbiddenError) return sendProblem(reply, ENTITY_FORBIDDEN_PROBLEM);
          if (error instanceof EntityScopeRequiredError) return sendProblem(reply, ENTITY_REQUIRED_PROBLEM);
          throw error;
        }

        const apiRequest: ApiRequest<unknown> = {
          headers,
          body: method === 'GET' ? request.query : request.body,
          ctx: ctxFor(subject, entityId),
        };
        const result = await entry.route.handler(apiRequest);
        return reply.status(result.status).send(result.body);
      },
    });
  };

  if (options.routes) {
    for (const route of options.routes) mount({ kind: 'mounted', route });
  } else {
    const modulesRoot = options.modulesRoot;
    app.register(async () => {
      const table = await buildRouteTable(ALL_ROUTES, modulesRoot ? { modulesRoot } : {});
      for (const entry of tableEntries(table)) mount(entry);
    });
  }

  return app;
}
