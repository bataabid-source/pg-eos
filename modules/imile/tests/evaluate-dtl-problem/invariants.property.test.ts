// modules/imile/tests/evaluate-dtl-problem/invariants.property.test.ts — WBS 3.17 (part 1).
//
// Property tests (fast-check) for the G0-completeness invariant in
// modules/imile/domain/evaluate-dtl-problem/invariants.ts — the ONLY mechanical domain logic this
// slice builds (brief, Design: "Only G0 (completeness) is mechanical domain logic ... G1-G4 are
// NOT reimplemented as domain rules"). This file never asserts G1-G4 pass/fail LOGIC — that is
// entirely delegated to the DtlContentAnalysisPort (see ./evaluate-dtl-problem.test.ts).
//
// Expected new surface (RED until it exists):
//   modules/imile/domain/evaluate-dtl-problem/invariants.ts
//     - `isG0Complete(raw: unknown): boolean` — pure, no I/O, no Date.now()/new Date(),
//       no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). Never throws for ANY input, same
//       "malformed input is data, not a crash" discipline as pull-shipments'
//       `validatePortalRecord`. Completeness (doc 07 §5-2, "G0: اكتمال البيانات (صورة · نص ·
//       توقيت)" — completeness of evidence/text/timing) = evidence_urls non-empty AND
//       (customer_text OR driver_text present) AND raised_at present (brief, Design line).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import { isG0Complete } from '../../domain/evaluate-dtl-problem/invariants.js';

const nonEmptyTextArb = fc.string({ minLength: 1, maxLength: 200 });
const evidenceUrlArb = fc.webUrl();

describe('isG0Complete — property (pure, no I/O)', () => {
  it('never throws for arbitrary garbage input', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => isG0Complete(raw)).not.toThrow();
      }),
    );
  });

  it('is always false when evidence_urls is empty AND there is no customer_text AND no driver_text — regardless of raised_at', () => {
    const raisedAtArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
    );
    fc.assert(
      fc.property(raisedAtArb, (raisedAt) => {
        const record = {
          evidence_urls: [],
          customer_text: null,
          driver_text: null,
          raised_at: raisedAt,
        };
        expect(isG0Complete(record)).toBe(false);
      }),
    );
  });

  it('is always false whenever raised_at is missing, even with evidence and text present', () => {
    fc.assert(
      fc.property(
        fc.array(evidenceUrlArb, { minLength: 1, maxLength: 3 }),
        nonEmptyTextArb,
        fc.constantFrom(undefined, null),
        (evidenceUrls, customerText, missingRaisedAt) => {
          const record = {
            evidence_urls: evidenceUrls,
            customer_text: customerText,
            driver_text: null,
            raised_at: missingRaisedAt,
          };
          expect(isG0Complete(record)).toBe(false);
        },
      ),
    );
  });

  it('is always true when evidence_urls has at least one URL, at least one of customer_text/driver_text is present, and raised_at is present', () => {
    const textPickArb = fc.oneof(
      fc.record({ customer_text: nonEmptyTextArb, driver_text: fc.constant(null) }),
      fc.record({ customer_text: fc.constant(null), driver_text: nonEmptyTextArb }),
      fc.record({ customer_text: nonEmptyTextArb, driver_text: nonEmptyTextArb }),
    );
    fc.assert(
      fc.property(
        fc.array(evidenceUrlArb, { minLength: 1, maxLength: 5 }),
        textPickArb,
        fc.date({ noInvalidDate: true }),
        (evidenceUrls, textPick, raisedAtDate) => {
          const record = {
            evidence_urls: evidenceUrls,
            customer_text: textPick.customer_text,
            driver_text: textPick.driver_text,
            raised_at: raisedAtDate.toISOString(),
          };
          expect(isG0Complete(record)).toBe(true);
        },
      ),
    );
  });

  it('is always false when evidence_urls is non-empty but neither customer_text nor driver_text is present, even with raised_at', () => {
    fc.assert(
      fc.property(
        fc.array(evidenceUrlArb, { minLength: 1, maxLength: 3 }),
        fc.date({ noInvalidDate: true }),
        (evidenceUrls, raisedAtDate) => {
          const record = {
            evidence_urls: evidenceUrls,
            customer_text: null,
            driver_text: null,
            raised_at: raisedAtDate.toISOString(),
          };
          expect(isG0Complete(record)).toBe(false);
        },
      ),
    );
  });

  // pg-reviewer review-round 3 finding 2: the review-round 2 finding 5 domain fix (a blank
  // string is not evidence and not a timestamp — matching the contract's own non-empty rule,
  // review-round 1 finding 10) had no property test of its own; removing `.every(isNonEmptyString)`
  // or the raised_at tightening would have left every existing test green.
  it('is always false when evidence_urls contains at least one blank entry, even alongside real URLs', () => {
    fc.assert(
      fc.property(
        fc.array(evidenceUrlArb, { minLength: 0, maxLength: 3 }),
        fc.array(evidenceUrlArb, { minLength: 0, maxLength: 3 }),
        nonEmptyTextArb,
        fc.date({ noInvalidDate: true }),
        (before, after, customerText, raisedAtDate) => {
          const record = {
            evidence_urls: [...before, '', ...after],
            customer_text: customerText,
            driver_text: null,
            raised_at: raisedAtDate.toISOString(),
          };
          expect(isG0Complete(record)).toBe(false);
        },
      ),
    );
  });

  it('is always false when raised_at is a blank string, even with evidence and text present', () => {
    fc.assert(
      fc.property(
        fc.array(evidenceUrlArb, { minLength: 1, maxLength: 3 }),
        nonEmptyTextArb,
        (evidenceUrls, customerText) => {
          const record = {
            evidence_urls: evidenceUrls,
            customer_text: customerText,
            driver_text: null,
            raised_at: '',
          };
          expect(isG0Complete(record)).toBe(false);
        },
      ),
    );
  });
});
