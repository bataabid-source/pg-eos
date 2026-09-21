// packages/contracts/_shared/problem.ts — WBS 0.13.
// Problem schema (D4) + the mandated status codes (brief "Deliver" list).
//
// D4 (docs/notes/0.13-contracts.brief.md): doc 40 fixes the status codes (400/409/422) but not the
// error body. Default taken here, recorded in CHANGELOG per BOOTSTRAP-v5 §2: a minimal RFC 9457
// "Problem Details for HTTP APIs" envelope, shared so every module inherits one error shape.

import { z } from 'zod';

/** The stable component id `ProblemSchema` is tagged with (reviewer finding 10). Zod's own
 * `.meta({id})` is zod-openapi's registration mechanism (D1) — `createDocument` then emits this
 * schema once under `components.schemas` and `$ref`s it from every route that reuses it, instead
 * of inlining it every time. */
const PROBLEM_SCHEMA_ID = 'Problem';

/** RFC 9457 Problem envelope (D4). All five fields are required so a caller cannot omit `detail`
 * and still satisfy the contract — see tests/harness.test.ts's rejection case. `status` is an
 * integer (finding 20) — an HTTP status code has no fractional part. */
export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string(),
  })
  .meta({ id: PROBLEM_SCHEMA_ID });

export type Problem = z.infer<typeof ProblemSchema>;

/**
 * doc 40 §A4 — the three status codes this slice's write-endpoint rules fix. No other numbers:
 *   400 BAD_REQUEST            — write endpoint called without an Idempotency-Key header.
 *   409 CONFLICT               — Idempotency-Key reused with a different body, or a stale
 *                                 `version` on a mutable aggregate.
 *   422 UNPROCESSABLE_ENTITY   — illegal state transition.
 */
export const PROBLEM_STATUS = {
  BAD_REQUEST: 400,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
} as const;
