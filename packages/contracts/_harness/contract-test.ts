// packages/contracts/_harness/contract-test.ts — WBS 0.13.
// The reusable contract-test harness later slices import (brief "Deliver" list).
//
// Validates requests/responses against a registered RouteContract using Zod's own safeParse, and
// throws a plain Error naming the failing field/path on any violation (doc 40 §A4 / brief
// Scenario: "The contract test harness runs").

import { core, z } from 'zod';
import type { ZodObjectInput } from 'zod-openapi';
import type { RouteContract } from '../_shared/registry.js';

/** The parts of a request `assertRequest` can validate. Parts the route did not declare in its
 * contract are ignored. */
export interface RequestAssertionInput {
  headers?: unknown;
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

function assertConforms(schema: z.ZodType, value: unknown, label: string): void {
  const result = schema.safeParse(value);
  if (result.success) return;

  const detail = result.error.issues
    .map((issue) => {
      const path = core.toDotPath(issue.path);
      return `${path.length > 0 ? path : label}: ${issue.message}`;
    })
    .join('; ');

  throw new Error(`Contract violation in ${label}: ${detail}`);
}

/** `RouteRequestSchemas`'s `headers`/`params`/`query` are typed as zod-openapi's `ZodObjectInput`
 * (registry.ts, reviewer finding 4) — the generic core schema interface zod-openapi itself
 * requires for parameters, which does not expose classic Zod's `.safeParse`. Every schema actually
 * registered through `ContractRegistry#registerRoute` is a classic Zod schema built with
 * `z.object(...)` (the only object-schema constructor this codebase uses), so narrowing back to
 * `z.ZodType` here reflects a real invariant, not an unsound cast. */
function asZodType(schema: ZodObjectInput): z.ZodType {
  return schema as z.ZodType;
}

/** Validates the given request parts against `route.request`'s schemas. Parts the route did not
 * declare are ignored. Throws a plain Error naming the failing field/path on any violation. */
export function assertRequest(route: RouteContract, request: RequestAssertionInput): void {
  if (route.request?.headers !== undefined) {
    assertConforms(asZodType(route.request.headers), request.headers, 'request.headers');
  }
  if (route.request?.params !== undefined) {
    assertConforms(asZodType(route.request.params), request.params, 'request.params');
  }
  if (route.request?.query !== undefined) {
    assertConforms(asZodType(route.request.query), request.query, 'request.query');
  }
  if (route.request?.body !== undefined) {
    assertConforms(route.request.body, request.body, 'request.body');
  }
}

/** Validates `body` against `route.responses[status].body`. Throws a plain Error naming the
 * failing field/path on any violation. A status with no declared body schema is not checked. */
export function assertResponse(route: RouteContract, status: number, body: unknown): void {
  const definition = route.responses[status];
  if (definition?.body === undefined) return;

  assertConforms(definition.body, body, `response[${status}].body`);
}
