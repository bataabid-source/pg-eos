// WBS 0.13 — REWORK round 1 of 2 (pg-tester). Finding 14: `_shared/headers.ts`'s `.min(1)` on
// IdempotencyKeyHeader was never exercised by any test — an empty string must be rejected. doc 40
// §A4: the Idempotency-Key header is a caller-supplied token; an empty token is not one.

import { describe, expect, it } from 'vitest';

import { IdempotencyKeyHeader } from '../_shared/headers.js';

describe('IdempotencyKeyHeader', () => {
  it('accepts a non-empty token', () => {
    expect(IdempotencyKeyHeader.safeParse('fixture-idempotency-key-1').success).toBe(true);
  });

  it('rejects an empty string (finding 14 — the .min(1) branch was never exercised)', () => {
    const result = IdempotencyKeyHeader.safeParse('');

    expect(result.success).toBe(false);
  });
});
