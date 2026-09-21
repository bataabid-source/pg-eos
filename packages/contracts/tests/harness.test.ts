// WBS 0.13 — REWORK round 1 of 2 (pg-tester). Encodes the brief's Gherkin scenario:
//   "The contract test harness runs"
// A route contract is registered in a fixture registry; the harness must accept a conforming
// request and response payload, and reject a violating payload while naming the failing path.
// The route's error response uses the shared Problem schema (D4) at one of the mandated status
// codes (409 — key reuse with a different body, doc 40 §A4) so the harness is proven against the
// same envelope every later module inherits.
//
// Round-2 rework additions (reviewer findings, docs/notes/0.13-contracts.brief.md rework round 1):
//   - finding 14: `params` and `query` validation were never exercised (only headers/body were),
//     and a status with no declared body schema was never proven not to throw — see the second
//     describe block below.
//   - finding 20: `ProblemSchema.status` is now `z.number().int()` — `assertResponse` must reject
//     a Problem body whose status is not an integer (e.g. 409.5). RED until pg-backend's round-2
//     change lands.

import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { ContractRegistry } from '../_shared/registry.js';
import { IdempotencyKeyHeader } from '../_shared/headers.js';
import { PROBLEM_STATUS, ProblemSchema } from '../_shared/problem.js';
import { assertRequest, assertResponse } from '../_harness/contract-test.js';

describe('Scenario: the contract test harness runs', () => {
  const registry = new ContractRegistry();
  const route = registry.registerRoute({
    method: 'POST',
    path: '/fixture/widgets',
    summary: 'Create a widget (fixture route for the contract-test harness)',
    request: {
      headers: z.object({ 'idempotency-key': IdempotencyKeyHeader }),
      body: z.object({ name: z.string().min(1) }),
    },
    responses: {
      201: { description: 'Created', body: z.object({ id: z.string(), name: z.string() }) },
      [PROBLEM_STATUS.CONFLICT]: { description: 'Idempotency-Key reuse', body: ProblemSchema },
    },
  });

  const conformingHeaders = { 'idempotency-key': 'fixture-idempotency-key-1' };

  it('accepts a request payload that conforms to the contract', () => {
    expect(() =>
      assertRequest(route, { headers: conformingHeaders, body: { name: 'Widget' } }),
    ).not.toThrow();
  });

  it('accepts a response payload that conforms to the contract', () => {
    expect(() =>
      assertResponse(route, 201, { id: 'fixture-widget-1', name: 'Widget' }),
    ).not.toThrow();
  });

  it('accepts a Problem error response that conforms to the declared 409 contract', () => {
    expect(() =>
      assertResponse(route, PROBLEM_STATUS.CONFLICT, {
        type: 'about:blank',
        title: 'Idempotency-Key reuse',
        status: PROBLEM_STATUS.CONFLICT,
        detail: 'The Idempotency-Key was reused with a different request body.',
        instance: '/fixture/widgets',
      }),
    ).not.toThrow();
  });

  it('rejects a request body that violates the contract, naming the failing path', () => {
    expect(() =>
      assertRequest(route, { headers: conformingHeaders, body: { name: '' } }),
    ).toThrow(/name/);
  });

  it('rejects a response payload that violates the contract, naming the failing path', () => {
    expect(() => assertResponse(route, 201, { id: 'fixture-widget-1' })).toThrow(/name/);
  });

  it('rejects a Problem error response that violates the declared 409 contract, naming the failing path', () => {
    expect(() =>
      assertResponse(route, PROBLEM_STATUS.CONFLICT, {
        type: 'about:blank',
        title: 'Idempotency-Key reuse',
      }),
    ).toThrow(/detail/);
  });

  it('rejects a Problem error response whose status is not an integer (finding 20)', () => {
    expect(() =>
      assertResponse(route, PROBLEM_STATUS.CONFLICT, {
        type: 'about:blank',
        title: 'Idempotency-Key reuse',
        status: 409.5,
        detail: 'The Idempotency-Key was reused with a different request body.',
        instance: '/fixture/widgets',
      }),
    ).toThrow();
  });
});

describe('Scenario: the contract test harness runs — params, query, and bodyless-response coverage (finding 14)', () => {
  const registry = new ContractRegistry();
  const route = registry.registerRoute({
    method: 'GET',
    path: '/fixture/widgets/{id}',
    summary:
      'Get a widget by id (fixture route exercising params/query/bodyless-response harness coverage)',
    request: {
      params: z.object({ id: z.string().min(1) }),
      query: z.object({ verbose: z.enum(['true', 'false']) }),
    },
    responses: {
      200: { description: 'ok', body: z.object({ id: z.string() }) },
      204: { description: 'No Content — nothing to validate against' },
    },
  });

  it('accepts a request whose params conform to the contract', () => {
    expect(() =>
      assertRequest(route, { params: { id: 'widget-1' }, query: { verbose: 'true' } }),
    ).not.toThrow();
  });

  it('rejects a request whose params violate the contract, naming the failing path', () => {
    expect(() =>
      assertRequest(route, { params: { id: '' }, query: { verbose: 'true' } }),
    ).toThrow(/id/);
  });

  it('accepts a request whose query conforms to the contract', () => {
    expect(() =>
      assertRequest(route, { params: { id: 'widget-1' }, query: { verbose: 'false' } }),
    ).not.toThrow();
  });

  it('rejects a request whose query violates the contract, naming the failing path', () => {
    expect(() =>
      assertRequest(route, { params: { id: 'widget-1' }, query: { verbose: 'maybe' } }),
    ).toThrow(/verbose/);
  });

  it('does not throw asserting a response for a status with no declared body schema', () => {
    expect(() => assertResponse(route, 204, undefined)).not.toThrow();
  });
});
