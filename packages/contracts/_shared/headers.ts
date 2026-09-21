// packages/contracts/_shared/headers.ts — WBS 0.13.
// Idempotency-Key header + shared params (brief "Deliver" list).
//
// doc 40 §A4: "Every write endpoint: requires Idempotency-Key header (400 without; 409 on key
// reuse with different body; replay returns prior result for 7 days)." This schema is the one
// piece of shared vocabulary every module's route contract reuses in `request.headers`.

import { z } from 'zod';

/** The canonical Idempotency-Key header field name (doc 40 §A4). Exported so nobody hand-rolls
 * the literal string — `_shared/registry.ts`'s invariant check matches this case-insensitively
 * (reviewer finding 5: a route declaring `'Idempotency-Key'`, capitalized, must not be flagged). */
export const IDEMPOTENCY_KEY_HEADER_NAME = 'Idempotency-Key';

/** The Idempotency-Key header value: a non-empty caller-supplied token. */
export const IdempotencyKeyHeader = z.string().min(1);
