// packages/contracts/tests/routes.test.ts — Master task, docs/STREAMS.md §Enablement item 6.
//
// Asserts the aggregate shape of every module's ROUTES registration (routes.ts / index.ts):
//   - the registered route count equals an explicit fixture list (not a modules/ scan at test
//     time — the brief's own instruction) of every `IDEMPOTENCY_ENDPOINT_*` identifier found under
//     modules/**/api/**/handlers.ts (68, one POST route each) plus the four read-only GET routes
//     this Master task registers (fleet/assert-vehicle-assignable, hr/register-employee's
//     check-driver-assignable, wms/process-outbound's generate-pick-list, wms/receive-inbound's
//     suggest-location);
//   - every POST route declares the Idempotency-Key header (doc 40 §A4 — also covered structurally
//     by registry-invariants.test.ts's own checkInvariants() property test; this file additionally
//     proves it for the REAL production routes, not just fixtures);
//   - every route's 4xx response body is the shared Problem component ($ref, not an inlined copy).

import { describe, expect, it } from 'vitest';

import { registry } from '../index.js';
import { ALL_ROUTES } from '../routes.js';

// One row per contract file that has a matching modules/<module>/api/<usecase>/handlers.ts,
// written out explicitly (not scanned) — the POST count is that file's own
// `IDEMPOTENCY_ENDPOINT_*` identifier count, the GET count is its read-only (no Idempotency-Key)
// handler count.
const ROUTE_COUNTS_BY_USE_CASE: ReadonlyArray<{
  readonly usecase: string;
  readonly post: number;
  readonly get: number;
}> = [
  { usecase: 'catalog/maintain-price-list', post: 6, get: 0 },
  { usecase: 'fleet/assert-vehicle-assignable', post: 0, get: 1 },
  { usecase: 'fleet/register-vehicle', post: 1, get: 0 },
  { usecase: 'hr/calculate-daily-commission', post: 1, get: 0 },
  { usecase: 'hr/confirm-commission', post: 1, get: 0 },
  { usecase: 'hr/dispute-commission', post: 1, get: 0 },
  { usecase: 'hr/maintain-shift', post: 4, get: 0 },
  { usecase: 'hr/register-employee', post: 3, get: 1 },
  { usecase: 'identity/otp-login', post: 2, get: 0 },
  { usecase: 'imile/assign-driver-id', post: 1, get: 0 },
  { usecase: 'imile/evaluate-dtl-problem', post: 1, get: 0 },
  { usecase: 'imile/pull-shipments', post: 1, get: 0 },
  { usecase: 'imile/report-agent-health', post: 1, get: 0 },
  { usecase: 'platform/evaluate-alerts', post: 1, get: 0 },
  { usecase: 'platform/maintain-site', post: 2, get: 0 },
  { usecase: 'sales/manage-account-credit', post: 3, get: 0 },
  { usecase: 'sales/manage-contract', post: 8, get: 0 },
  { usecase: 'sales/manage-quote', post: 9, get: 0 },
  { usecase: 'wms/count-inventory', post: 4, get: 0 },
  { usecase: 'wms/manage-space', post: 2, get: 0 },
  { usecase: 'wms/process-outbound', post: 9, get: 1 },
  { usecase: 'wms/receive-inbound', post: 5, get: 1 },
  { usecase: 'wms/schedule-inbound', post: 1, get: 0 },
  { usecase: 'wms/take-occupancy-snapshot', post: 1, get: 0 },
];

const EXPECTED_POST_COUNT = ROUTE_COUNTS_BY_USE_CASE.reduce((sum, row) => sum + row.post, 0);
const EXPECTED_GET_COUNT = ROUTE_COUNTS_BY_USE_CASE.reduce((sum, row) => sum + row.get, 0);
const EXPECTED_TOTAL_COUNT = EXPECTED_POST_COUNT + EXPECTED_GET_COUNT;

describe('Scenario: every module use case with a handlers.ts registers its own routes', () => {
  it('registers exactly 68 POST routes (one per IDEMPOTENCY_ENDPOINT_* identifier) and 4 GET routes', () => {
    expect(EXPECTED_POST_COUNT).toBe(68);
    expect(EXPECTED_GET_COUNT).toBe(4);
    expect(ALL_ROUTES.filter((route) => route.method === 'POST').length).toBe(EXPECTED_POST_COUNT);
    expect(ALL_ROUTES.filter((route) => route.method === 'GET').length).toBe(EXPECTED_GET_COUNT);
    expect(ALL_ROUTES.length).toBe(EXPECTED_TOTAL_COUNT);
  });

  it('registers every route on the shared production registry exactly once', () => {
    const document = registry.toOpenApiDocument();
    let registeredCount = 0;
    for (const pathItem of Object.values(document.paths ?? {})) {
      registeredCount += Object.keys(pathItem).length;
    }
    expect(registeredCount).toBe(EXPECTED_TOTAL_COUNT);
  });
});

describe('Scenario: every POST route declares the Idempotency-Key header', () => {
  it('holds for every registered write route', () => {
    const postRoutes = ALL_ROUTES.filter((route) => route.method === 'POST');
    expect(postRoutes.length).toBeGreaterThan(0);

    for (const route of postRoutes) {
      const headers = route.request?.headers;
      expect(headers, `${route.method} ${route.path} must declare request.headers`).toBeDefined();
    }

    // The registry's own invariant (doc 40 §A4) is the authoritative check — zero violations means
    // every POST/PUT/PATCH/DELETE route above declares a MANDATORY Idempotency-Key header field.
    expect(registry.checkInvariants()).toEqual([]);
  });
});

describe('Scenario: every 4xx response references the shared Problem component', () => {
  it('every route with a 4xx or 5xx response $refs #/components/schemas/Problem, never an inlined copy', () => {
    const document = registry.toOpenApiDocument();
    let checkedResponseCount = 0;

    for (const pathItem of Object.values(document.paths ?? {})) {
      for (const operation of Object.values(pathItem)) {
        if (typeof operation !== 'object' || operation === null || !('responses' in operation)) continue;
        const responses = (operation as { responses?: Record<string, unknown> }).responses ?? {};

        for (const [status, response] of Object.entries(responses)) {
          const statusCode = Number(status);
          if (statusCode < 400) continue;

          const schema = (
            response as {
              content?: { 'application/json'?: { schema?: unknown } };
            }
          ).content?.['application/json']?.schema;

          expect(schema, `status ${status} must carry a Problem body`).toEqual({
            $ref: '#/components/schemas/Problem',
          });
          checkedResponseCount += 1;
        }
      }
    }

    expect(checkedResponseCount).toBeGreaterThan(0);
  });
});
