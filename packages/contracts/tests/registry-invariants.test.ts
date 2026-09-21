// WBS 0.13 — REWORK round 1 of 2 (pg-tester). Encodes the brief's Gherkin scenario:
//   "A write endpoint without Idempotency-Key fails the registry guard"
// and the single registry-owned invariant the module brief lists (doc 40 §A4, copied in the
// brief): every write endpoint (POST · PUT · PATCH · DELETE) requires an Idempotency-Key header.
//
// Round-2 rework additions (reviewer findings, docs/notes/0.13-contracts.brief.md rework round 1):
//   - finding 14: an explicit assertion that GET is exempt (nothing previously caught WRITE_METHODS
//     being accidentally widened to include GET).
//   - finding 5: the header-field-name check is case-insensitive — "Idempotency-Key" (capitalized)
//     must not be flagged.
//   - finding 6: an `.optional()` Idempotency-Key header field still violates the invariant.
//   - finding 19: fast-check is now a real devDependency (Master decision, package.json is not
//     this worker's file) — the invariant is additionally property-tested over every
//     (method, hasValidHeader) combination, not just the four write methods enumerated below. The
//     enumerated cases are kept per the rework brief ("still correct, just not properties").

import { z } from 'zod';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ContractRegistry } from '../_shared/registry.js';
import type { HttpMethod } from '../_shared/registry.js';
import { IdempotencyKeyHeader } from '../_shared/headers.js';

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

describe('Scenario: a write endpoint without Idempotency-Key fails the registry guard', () => {
  it('fails the invariant check and names the offending route and method for a POST route missing Idempotency-Key', () => {
    const registry = new ContractRegistry();
    registry.registerRoute({
      method: 'POST',
      path: '/fixture/orders',
      summary: 'Create an order (fixture route, missing Idempotency-Key)',
      request: { body: z.object({ note: z.string() }) },
      responses: { 201: { description: 'Created' } },
    });

    const violations = registry.checkInvariants();
    const offender = violations.find(
      (violation) => violation.method === 'POST' && violation.path === '/fixture/orders',
    );

    expect(offender).toBeDefined();
    expect(offender?.message.toLowerCase()).toContain('idempotency-key');
  });

  it('does not flag a POST route that declares the Idempotency-Key header', () => {
    const registry = new ContractRegistry();
    registry.registerRoute({
      method: 'POST',
      path: '/fixture/orders',
      summary: 'Create an order (fixture route, with Idempotency-Key)',
      request: {
        headers: z.object({ 'idempotency-key': IdempotencyKeyHeader }),
        body: z.object({ note: z.string() }),
      },
      responses: { 201: { description: 'Created' } },
    });

    const violations = registry.checkInvariants();

    expect(violations.some((violation) => violation.path === '/fixture/orders')).toBe(false);
  });

  for (const method of WRITE_METHODS) {
    it(`flags a fixture ${method} route registered without the Idempotency-Key header`, () => {
      const registry = new ContractRegistry();
      const path = `/fixture/${method.toLowerCase()}-without-key`;
      registry.registerRoute({
        method,
        path,
        summary: `${method} fixture route without Idempotency-Key`,
        responses: { 200: { description: 'ok' } },
      });

      const violations = registry.checkInvariants();

      expect(
        violations.some(
          (violation) =>
            violation.method === method &&
            violation.path === path &&
            violation.message.toLowerCase().includes('idempotency-key'),
        ),
      ).toBe(true);
    });

    it(`does not flag a fixture ${method} route registered with the Idempotency-Key header`, () => {
      const registry = new ContractRegistry();
      const path = `/fixture/${method.toLowerCase()}-with-key`;
      registry.registerRoute({
        method,
        path,
        summary: `${method} fixture route with Idempotency-Key`,
        request: { headers: z.object({ 'idempotency-key': IdempotencyKeyHeader }) },
        responses: { 200: { description: 'ok' } },
      });

      const violations = registry.checkInvariants();

      expect(violations.some((violation) => violation.path === path)).toBe(false);
    });
  }
});

describe('Scenario: GET routes are exempt from the Idempotency-Key invariant (finding 14)', () => {
  it('does not flag a GET route that omits the Idempotency-Key header', () => {
    const registry = new ContractRegistry();
    registry.registerRoute({
      method: 'GET',
      path: '/fixture/get-without-key',
      summary: 'GET fixture route without Idempotency-Key (must not be flagged — GET is exempt)',
      responses: { 200: { description: 'ok' } },
    });

    const violations = registry.checkInvariants();

    expect(violations.some((violation) => violation.path === '/fixture/get-without-key')).toBe(
      false,
    );
  });
});

describe('Scenario: the Idempotency-Key header check is case-insensitive on the field name (finding 5)', () => {
  it('does not flag a POST route that declares the header as "Idempotency-Key" (capitalized)', () => {
    const registry = new ContractRegistry();
    registry.registerRoute({
      method: 'POST',
      path: '/fixture/capitalized-header',
      summary: 'POST fixture route with a capitalized Idempotency-Key header field name',
      request: { headers: z.object({ 'Idempotency-Key': IdempotencyKeyHeader }) },
      responses: { 201: { description: 'Created' } },
    });

    const violations = registry.checkInvariants();

    expect(violations.some((violation) => violation.path === '/fixture/capitalized-header')).toBe(
      false,
    );
  });
});

describe('Scenario: an optional Idempotency-Key header field still violates the invariant (finding 6)', () => {
  it('flags a POST route whose Idempotency-Key header field is declared .optional()', () => {
    const registry = new ContractRegistry();
    registry.registerRoute({
      method: 'POST',
      path: '/fixture/optional-header',
      summary: 'POST fixture route with an optional Idempotency-Key header field',
      request: { headers: z.object({ 'idempotency-key': IdempotencyKeyHeader.optional() }) },
      responses: { 201: { description: 'Created' } },
    });

    const violations = registry.checkInvariants();

    expect(
      violations.some(
        (violation) =>
          violation.path === '/fixture/optional-header' &&
          violation.message.toLowerCase().includes('idempotency-key'),
      ),
    ).toBe(true);
  });
});

describe('Property: checkInvariants flags a route iff it is a write method with no valid Idempotency-Key header (finding 19)', () => {
  it('holds for every method and header-presence combination', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<HttpMethod>(...ALL_METHODS),
        fc.boolean(),
        (method: HttpMethod, hasValidHeader: boolean) => {
          const propertyRegistry = new ContractRegistry();
          const path = `/fixture/property/${method.toLowerCase()}/${String(hasValidHeader)}`;

          propertyRegistry.registerRoute({
            method,
            path,
            summary: 'fast-check fixture route (finding 19 property test)',
            ...(hasValidHeader
              ? { request: { headers: z.object({ 'idempotency-key': IdempotencyKeyHeader }) } }
              : {}),
            responses: { 200: { description: 'ok' } },
          });

          const flagged = propertyRegistry
            .checkInvariants()
            .some((violation) => violation.method === method && violation.path === path);

          const isWriteMethod = (WRITE_METHODS as readonly HttpMethod[]).includes(method);

          expect(flagged).toBe(isWriteMethod && !hasValidHeader);
        },
      ),
    );
  });
});
