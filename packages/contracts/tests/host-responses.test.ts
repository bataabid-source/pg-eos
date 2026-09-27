// packages/contracts/tests/host-responses.test.ts — X part 12 (a)+(b), revision 3
// (docs/notes/slice-briefs/_slice-X-part-12.brief.md, decisions 3 and 4).
//
// RED, and why it is the right RED: `withHostResponses` does not exist yet on
// `packages/contracts/_shared/route-responses.ts` — the named import below fails to resolve
// (a SyntaxError at module load under Node ESM), so every test in this file fails for that one
// reason. The last describe below additionally fails on its own merits even once the import
// resolves: the committed `packages/contracts/openapi/openapi.json` has not been regenerated with
// host statuses yet (it declares 501 only on the two otp-login operations today), so its derived
// 501 set will not yet match ALL_ROUTES' contractFirst-derived set until the builder both wires
// `withHostResponses` into `routes.ts` and regenerates the document.
//
// Every expected value below is derived from `ALL_ROUTES` itself (brief: "do not hardcode 12") —
// never a literal route count.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALL_ROUTES,
  PROBLEM_STATUS,
  ProblemSchema,
  type HttpMethod,
  type RouteDefinitionInput,
  type RouteResponseDefinition,
} from '../index.js';
// The module under test — `withHostResponses` does not exist yet. This is the RED.
import { withHostResponses } from '../_shared/route-responses.js';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TESTS_DIR, '..');
const OPENAPI_PATH = resolve(PACKAGE_ROOT, 'openapi', 'openapi.json');

// Host statuses (brief decision 3, "Quoted facts" — quoted verbatim from apps/api/src/http-
// status.ts so this browser-safe package never imports the host app): 401 UNAUTHORIZED,
// 413 PAYLOAD_TOO_LARGE, 415 UNSUPPORTED_MEDIA_TYPE, 501 NOT_IMPLEMENTED; 500 from api-kit
// (route-responses.ts's own local HTTP_STATUS_INTERNAL_SERVER_ERROR, same value named again here
// since this test file may not import api-kit either — packages may not depend on packages that
// depend on them, and api-kit depends on this package).
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
const HTTP_STATUS_NOT_IMPLEMENTED = 501;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

/** Every operation — GET included — declares these four (brief decision 3). */
const EVERY_OPERATION_HOST_STATUSES = [
  HTTP_STATUS_UNAUTHORIZED,
  PROBLEM_STATUS.FORBIDDEN,
  PROBLEM_STATUS.UNPROCESSABLE_ENTITY,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
] as const;

/** Only body-carrying methods declare these three; GET (bodyless, Fastify's own treatment) never
 * does (brief decision 3). */
const BODY_CARRYING_ONLY_HOST_STATUSES = [
  PROBLEM_STATUS.BAD_REQUEST,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
] as const;

const BODY_CARRYING_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const FIXTURE_PATH = '/fixture/host-responses/do-thing';

function fixtureRoute(overrides: Partial<RouteDefinitionInput> = {}): RouteDefinitionInput {
  return {
    method: 'POST',
    path: FIXTURE_PATH,
    summary: 'fixture route (host-responses.test.ts)',
    responses: { 200: { description: 'OK' } },
    ...overrides,
  };
}

/** True only when `definition` exists and carries the exact shared `ProblemSchema` body — never
 * an inlined copy (same convention `routes.test.ts` already asserts for 4xx/5xx bodies). */
function isProblemBody(definition: RouteResponseDefinition | undefined): boolean {
  return definition !== undefined && definition.body === ProblemSchema;
}

describe('Scenario: every operation declares 401, 403, 422 and 500; body-carrying operations also declare 400, 413 and 415; GET operations declare no 413/415', () => {
  it('adds 401, 403, 422 and 500 with a ProblemSchema body to a GET route', () => {
    const route = withHostResponses(fixtureRoute({ method: 'GET' }));

    for (const status of EVERY_OPERATION_HOST_STATUSES) {
      expect(isProblemBody(route.responses[status])).toBe(true);
    }
  });

  it('adds no 400, 413 or 415 to a GET route (Fastify treats GET as bodyless)', () => {
    const route = withHostResponses(fixtureRoute({ method: 'GET' }));

    for (const status of BODY_CARRYING_ONLY_HOST_STATUSES) {
      expect(route.responses[status]).toBeUndefined();
    }
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'adds 401, 403, 422, 500, 400, 413 and 415 with a ProblemSchema body to a %s route',
    (method) => {
      const route = withHostResponses(fixtureRoute({ method }));

      for (const status of [...EVERY_OPERATION_HOST_STATUSES, ...BODY_CARRYING_ONLY_HOST_STATUSES]) {
        expect(isProblemBody(route.responses[status])).toBe(true);
      }
    },
  );

  it('adds 501 only when the route is contractFirst', () => {
    const plain = withHostResponses(fixtureRoute());
    const contractFirst = withHostResponses(fixtureRoute({ contractFirst: true }));

    expect(plain.responses[HTTP_STATUS_NOT_IMPLEMENTED]).toBeUndefined();
    expect(isProblemBody(contractFirst.responses[HTTP_STATUS_NOT_IMPLEMENTED])).toBe(true);
  });
});

describe("Scenario: collision rule — a route's own 422/500 entry and otp-login's own 501 are kept, never duplicated", () => {
  it('keeps the route\'s own 422 entry object, not overridden by the host default', () => {
    const ownEntry: RouteResponseDefinition = { description: 'Own Unprocessable Entity', body: ProblemSchema };
    const route = withHostResponses(
      fixtureRoute({ responses: { 200: { description: 'OK' }, [PROBLEM_STATUS.UNPROCESSABLE_ENTITY]: ownEntry } }),
    );

    expect(route.responses[PROBLEM_STATUS.UNPROCESSABLE_ENTITY]).toBe(ownEntry);
  });

  it("keeps the route's own 500 entry object, not overridden by the host default", () => {
    const ownEntry: RouteResponseDefinition = { description: 'Own Internal Server Error', body: ProblemSchema };
    const route = withHostResponses(
      fixtureRoute({ responses: { 200: { description: 'OK' }, [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ownEntry } }),
    );

    expect(route.responses[HTTP_STATUS_INTERNAL_SERVER_ERROR]).toBe(ownEntry);
  });

  it("keeps identity/otp-login's own declared 501 entry, never duplicated, once withHostResponses is applied", () => {
    const otpLoginRoute = ALL_ROUTES.find((route) => route.path === '/identity/otp-login/request-otp-code');
    expect(otpLoginRoute).toBeDefined();
    const ownEntry = otpLoginRoute?.responses[HTTP_STATUS_NOT_IMPLEMENTED];
    expect(ownEntry).toBeDefined();

    const hosted = withHostResponses(otpLoginRoute as RouteDefinitionInput);

    expect(hosted.responses[HTTP_STATUS_NOT_IMPLEMENTED]).toBe(ownEntry);
  });
});

describe('Scenario: every ALL_ROUTES entry carries the host statuses', () => {
  it('every registered route, once withHostResponses is applied, declares every status this host can emit for it', () => {
    expect(ALL_ROUTES.length).toBeGreaterThan(0);

    for (const route of ALL_ROUTES) {
      const hosted = withHostResponses(route);

      for (const status of EVERY_OPERATION_HOST_STATUSES) {
        expect(isProblemBody(hosted.responses[status])).toBe(true);
      }

      const isBodyCarrying = BODY_CARRYING_METHODS.has(route.method);
      for (const status of BODY_CARRYING_ONLY_HOST_STATUSES) {
        if (isBodyCarrying) {
          expect(isProblemBody(hosted.responses[status])).toBe(true);
        } else if (status === PROBLEM_STATUS.BAD_REQUEST) {
          // GET: the HOST never adds 400 (brief decision 3 fixes 413/415 as the only statuses a
          // GET is exempt from; 400 is simply not in the host's add-list for GET). Some real GET
          // routes already declare their OWN 400 through readErrorResponses (their handlers map a
          // Zod contract failure to 400 themselves — e.g.
          // modules/fleet/api/assert-vehicle-assignable/handlers.ts) — withHostResponses must
          // leave that untouched, never add one where the route had none, never remove one the
          // route already had.
          expect(hosted.responses[status]).toBe(route.responses[status]);
        } else {
          expect(hosted.responses[status]).toBeUndefined();
        }
      }
    }
  });
});

interface OpenApiOperationLike {
  readonly responses?: Record<string, unknown>;
}

interface OpenApiDocumentLike {
  readonly paths: Record<string, Record<string, OpenApiOperationLike>>;
}

describe('Scenario: exactly the contract-first and held otp-login operations declare 501 in openapi.json', () => {
  it('the committed openapi.json 501 set equals the set derived from ALL_ROUTES, never a hardcoded 12', () => {
    const contractFirstOperations = ALL_ROUTES.filter((route) => route.contractFirst === true).map(
      (route) => `${route.method} ${route.path}`,
    );
    // Held until 2.16 part 1a-5 (apps/api's own NOT_MOUNTED_UNTIL_2_16_PART_1A_5 — not imported
    // here, packages may not depend on apps): derived from ALL_ROUTES' own identity/otp-login
    // paths, not hardcoded as "2".
    const otpLoginOperations = ALL_ROUTES.filter((route) => route.path.startsWith('/identity/otp-login/')).map(
      (route) => `${route.method} ${route.path}`,
    );
    const expected501Operations = new Set([...contractFirstOperations, ...otpLoginOperations]);
    expect(expected501Operations.size).toBeGreaterThan(0);

    const document = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDocumentLike;
    const actual501Operations = new Set<string>();
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (operation.responses && String(HTTP_STATUS_NOT_IMPLEMENTED) in operation.responses) {
          actual501Operations.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(actual501Operations).toEqual(expected501Operations);
  });
});
