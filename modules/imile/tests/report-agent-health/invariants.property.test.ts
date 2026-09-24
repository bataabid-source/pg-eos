// modules/imile/tests/report-agent-health/invariants.property.test.ts — WBS 3.14.
//
// Property tests (fast-check) for the pure domain invariants in
// modules/imile/domain/report-agent-health/invariants.ts (CLAUDE.md TESTING: "property tests on
// every invariant").
//
// Expected new surface (RED until it exists):
//   modules/imile/domain/report-agent-health/errors.ts
//     - SessionInvalidWithoutReasonError, LastPullInFutureError.
//   modules/imile/domain/report-agent-health/invariants.ts
//     - `assertSessionValidHasReason(sessionValid: boolean, errorMessage: string | null |
//       undefined): void` — throws SessionInvalidWithoutReasonError iff sessionValid === false and
//       errorMessage is null/undefined/empty; never throws when sessionValid === true, regardless
//       of errorMessage. Pure: no I/O, no Date, no Math.random().
//     - `assertLastPullNotInFuture(lastPullAt: Date | null, reportedAt: Date): void` — throws
//       LastPullInFutureError iff lastPullAt is not null and lastPullAt > reportedAt; never throws
//       when lastPullAt is null or lastPullAt <= reportedAt.
//
// Reviewer finding 1 (2026-09-24, WBS 3.14 fix round): there is no cross-agentId "active session"
// exclusivity rule (doc 40 §C8's "single session — any other login drops it" describes ONE iMile
// account's OWN portal session, not exclusivity across agentIds — D-148/D-149,
// docs/notes/2026-09-24-imile-agent-scenario.md §5, §7). The property that modeled "sequence
// 01, 02, 01 leaves 01 active" (an exclusivity/supersession invariant against
// domain/report-agent-health/session-machine.ts) is REMOVED along with that file (reviewer finding
// 5: no domain/report-agent-health/machine.ts — a plain validated insert has no XState machine to
// model, since there is no state transition left once supersession is gone).
//
// packages/contracts/imile/report-agent-health.ts (pg-backend rewrites this from its current
// placeholder — see .claude/briefs/imile.brief.md) must export `ReportAgentHealthInputSchema`
// whose `pendingPushes` field rejects negative integers — INV: "pendingPushes never negative once
// validated" is exercised directly against that schema.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The modules under test — do not exist yet (RED).
import {
  assertLastPullNotInFuture,
  assertSessionValidHasReason,
} from '../../domain/report-agent-health/invariants.js';
import {
  LastPullInFutureError,
  SessionInvalidWithoutReasonError,
} from '../../domain/report-agent-health/errors.js';
import { ReportAgentHealthInputSchema } from '@pg-eos/contracts/imile/report-agent-health';

const nonEmptyReasonArb = fc.string({ minLength: 1 });
const emptyishReasonArb = fc.constantFrom<null | undefined | string>(null, undefined, '');

describe('assertSessionValidHasReason — property (doc 40 §C8 health heartbeat)', () => {
  it('never throws when sessionValid=true, regardless of errorMessage', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (errorMessage) => {
        expect(() => assertSessionValidHasReason(true, errorMessage)).not.toThrow();
      }),
    );
  });

  it('always throws SessionInvalidWithoutReasonError when sessionValid=false and no reason is given', () => {
    fc.assert(
      fc.property(emptyishReasonArb, (errorMessage) => {
        expect(() => assertSessionValidHasReason(false, errorMessage)).toThrow(SessionInvalidWithoutReasonError);
      }),
    );
  });

  it('never throws when sessionValid=false and a non-empty errorMessage is given', () => {
    fc.assert(
      fc.property(nonEmptyReasonArb, (errorMessage) => {
        expect(() => assertSessionValidHasReason(false, errorMessage)).not.toThrow();
      }),
    );
  });
});

// Bounded to a realistic operational window so `reportedAt +/- deltaMs` can never overflow
// JS's representable Date range (~year +/-271821). Near that extreme, adding a positive deltaMs
// can wrap to an Invalid Date, where both `>` and `<=` comparisons are false — a boundary no
// correct implementation could satisfy. year 2000-2100 with deltaMs capped at ~3 years in ms
// stays far short of any overflow while still exercising the real invariant.
const reportedAtArb = fc.date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2100-01-01T00:00:00.000Z'), noInvalidDate: true });
const deltaMsArb = fc.integer({ min: 0, max: 1_000_000 });
const positiveDeltaMsArb = fc.integer({ min: 1, max: 1_000_000 });

describe('assertLastPullNotInFuture — property (contract: lastPullAt cannot be after reportedAt)', () => {
  it('never throws when lastPullAt is null', () => {
    fc.assert(
      fc.property(reportedAtArb, (reportedAt) => {
        expect(() => assertLastPullNotInFuture(null, reportedAt)).not.toThrow();
      }),
    );
  });

  it('never throws when lastPullAt <= reportedAt', () => {
    fc.assert(
      fc.property(reportedAtArb, deltaMsArb, (reportedAt, deltaMs) => {
        const lastPullAt = new Date(reportedAt.getTime() - deltaMs);
        expect(() => assertLastPullNotInFuture(lastPullAt, reportedAt)).not.toThrow();
      }),
    );
  });

  it('always throws LastPullInFutureError when lastPullAt > reportedAt', () => {
    fc.assert(
      fc.property(reportedAtArb, positiveDeltaMsArb, (reportedAt, deltaMs) => {
        const lastPullAt = new Date(reportedAt.getTime() + deltaMs);
        expect(() => assertLastPullNotInFuture(lastPullAt, reportedAt)).toThrow(LastPullInFutureError);
      }),
    );
  });
});

describe('ReportAgentHealthInputSchema.pendingPushes — property (never negative once validated)', () => {
  it('rejects every negative integer', () => {
    fc.assert(
      fc.property(fc.integer({ max: -1 }), (pendingPushes) => {
        const result = ReportAgentHealthInputSchema.safeParse({
          agentId: 'IMILE-STATION-01',
          sessionValid: true,
          lastPullAt: null,
          pendingPushes,
          engineVersion: '1.0.0',
          correlationId: '00000000-0000-4000-8000-000000000001',
        });
        expect(result.success).toBe(false);
      }),
    );
  });

  it('accepts every non-negative integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (pendingPushes) => {
        const result = ReportAgentHealthInputSchema.safeParse({
          agentId: 'IMILE-STATION-01',
          sessionValid: true,
          lastPullAt: null,
          pendingPushes,
          engineVersion: '1.0.0',
          correlationId: '00000000-0000-4000-8000-000000000001',
        });
        expect(result.success).toBe(true);
      }),
    );
  });
});
