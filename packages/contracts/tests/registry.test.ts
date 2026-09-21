// WBS 0.13 — REWORK round 1 of 2 (pg-tester). Coverage for `ContractRegistry#registerRoute`'s own
// guarantees that are not the Idempotency-Key invariant (that invariant, and its case-sensitivity
// / optional-header edge cases, live in tests/registry-invariants.test.ts):
//   - duplicate method+path rejection (reviewer finding 9)
//   - out-of-range response-status rejection (finding 11)
//   - the returned RouteContract being frozen (finding 12)
//   - the schema-registration mechanism, `registerSchema` (finding 10) — the unit-level contract
//     only; the OpenAPI-document $ref/dedup behaviour it produces is asserted in
//     tests/openapi-document.test.ts (finding 10 also names that file).
//
// None of registerRoute's duplicate/status-range guard or ContractRegistry#registerSchema exist
// yet — this file is RED until pg-backend's round-2 implementation lands
// (docs/notes/0.13-contracts.brief.md rework round 1).

import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { ContractRegistry } from '../_shared/registry.js';
import { IdempotencyKeyHeader } from '../_shared/headers.js';

describe('ContractRegistry#registerRoute — duplicate method+path (finding 9)', () => {
  it('throws a plain Error naming the method and path when the same method+path pair is registered twice', () => {
    const registry = new ContractRegistry();
    registry.registerRoute({
      method: 'GET',
      path: '/fixture/duplicate',
      summary: 'first registration',
      responses: { 200: { description: 'ok' } },
    });

    expect(() =>
      registry.registerRoute({
        method: 'GET',
        path: '/fixture/duplicate',
        summary: 'second registration of the same method+path',
        responses: { 200: { description: 'ok' } },
      }),
    ).toThrow(/GET \/fixture\/duplicate/);
  });

  it('does not throw when the same path is registered under a different method', () => {
    const registry = new ContractRegistry();
    registry.registerRoute({
      method: 'GET',
      path: '/fixture/duplicate-method-differs',
      summary: 'GET registration',
      responses: { 200: { description: 'ok' } },
    });

    expect(() =>
      registry.registerRoute({
        method: 'POST',
        path: '/fixture/duplicate-method-differs',
        summary: 'POST registration of the same path',
        request: { headers: z.object({ 'idempotency-key': IdempotencyKeyHeader }) },
        responses: { 201: { description: 'Created' } },
      }),
    ).not.toThrow();
  });
});

describe('ContractRegistry#registerRoute — response status must be an integer in [100,599] (finding 11)', () => {
  it('throws when a responses key is above 599', () => {
    const registry = new ContractRegistry();

    expect(() =>
      registry.registerRoute({
        method: 'GET',
        path: '/fixture/status-above-range',
        summary: 'fixture route with an invalid response status',
        responses: { 999: { description: 'invalid' } },
      }),
    ).toThrow();
  });

  it('throws when a responses key is below 100', () => {
    const registry = new ContractRegistry();

    expect(() =>
      registry.registerRoute({
        method: 'GET',
        path: '/fixture/status-below-range',
        summary: 'fixture route with an invalid response status',
        responses: { 99: { description: 'invalid' } },
      }),
    ).toThrow();
  });

  it('does not throw for response statuses at the boundaries of the valid range', () => {
    const registry = new ContractRegistry();

    expect(() =>
      registry.registerRoute({
        method: 'GET',
        path: '/fixture/status-boundaries',
        summary: 'fixture route with boundary response statuses',
        responses: {
          100: { description: 'lower boundary' },
          599: { description: 'upper boundary' },
        },
      }),
    ).not.toThrow();
  });
});

describe('ContractRegistry#registerRoute — the returned RouteContract is frozen (finding 12)', () => {
  it('is reported frozen by Object.isFrozen', () => {
    const registry = new ContractRegistry();
    const route = registry.registerRoute({
      method: 'GET',
      path: '/fixture/frozen',
      summary: 'fixture route to prove the returned contract is frozen',
      responses: { 200: { description: 'ok' } },
    });

    expect(Object.isFrozen(route)).toBe(true);
  });

  it('throws when a caller attempts to mutate the returned contract', () => {
    const registry = new ContractRegistry();
    const route = registry.registerRoute({
      method: 'GET',
      path: '/fixture/frozen-mutation',
      summary: 'fixture route to prove mutation is rejected',
      responses: { 200: { description: 'ok' } },
    });

    // Testing a runtime guarantee TypeScript's own `readonly` would otherwise stop us from even
    // attempting — a narrow local cast, not `any` (round-2 rework instructions, finding 12).
    const mutable = route as { responses: unknown };

    expect(() => {
      mutable.responses = {};
    }).toThrow(TypeError);
  });
});

describe('ContractRegistry#registerSchema — named, reusable schema registration (finding 10)', () => {
  it('returns a Zod schema that still validates the same values as the schema it was given', () => {
    const registry = new ContractRegistry();
    const widgetSchema = z.object({ id: z.string() });

    const registered = registry.registerSchema('FixtureWidget', widgetSchema);

    expect(registered.safeParse({ id: 'w1' }).success).toBe(true);
    expect(registered.safeParse({}).success).toBe(false);
  });
});
