// modules/hr/tests/maintain-shift/invariants.property.test.ts — WBS 5.5a part 2 (lane 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/hr/domain/maintain-shift/invariants.ts — one property per invariant the brief names
// (CLAUDE.md TESTING; docs/notes/slice-briefs/_slice-5.5a-part2.brief.md, "Property tests" section,
// P1/P2/P3 verbatim). Pure functions only: no I/O, no Date, no Math.random() (CLAUDE.md · AGENT
// CONSTRAINTS "No Math.random() / new Date() in domain/ — inject generator and clock" — these
// functions take plain date strings, never touch the clock themselves).
//
// Expected new surface (RED until it exists):
//   modules/hr/domain/maintain-shift/invariants.ts
//     - `overlaps(existing: ReadonlyArray<{ validFrom: string; validTo: string | null }>,
//        candidate: { validFrom: string; validTo: string | null }): boolean` — brief D4/P1: true
//       iff AT LEAST ONE row in `existing` genuinely intersects `candidate`, using the SAME
//       inclusive-bounds, NULL-is-unbounded semantics as the DB's own
//       `daterange(valid_from, valid_to, '[]') && daterange(...)` (migration 0016,
//       shift_assignments_no_overlap). This is the domain-layer check that must run BEFORE the
//       repository issues the INSERT (doc 36 §5-4 #2's "both, not one" — the DB exclusion
//       constraint is belt-and-braces, not the only line of defence).
//     - `groupShiftMismatch(groupShiftId: string, inputShiftId: string): boolean` — brief D5/P2:
//       true iff the two ids differ. Only ever evaluated by the application layer when a `groupId`
//       is actually supplied (composite FK shift_assignments_group_shift_fk, MATCH SIMPLE, is
//       trivially satisfied when group_id IS NULL).
//     - `isValidDaysOfWeek(arr: readonly number[]): boolean` — brief P3, mirrors migration 0016's
//       `chk_shifts_dow`: true iff `arr.length > 0` and every element is in [0, 6].

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import {
  groupShiftMismatch,
  isValidDaysOfWeek,
  isValidGraceMinutes,
  isValidGroupType,
  isValidRange,
  overlaps,
  VALID_GROUP_TYPES,
} from '../../domain/maintain-shift/invariants.js';

// --- date helpers (TEST FILE ONLY — domain/ itself must never call `new Date()`) -------------------

/** day-number arbitrary — small, dense range so intersections/adjacencies are exercised often. */
const dayArb = fc.integer({ min: 0, max: 60 });

const BASE_MS = Date.UTC(2026, 0, 1); // 2026-01-01, arbitrary fixed epoch for this test file only.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isoOfDay(day: number): string {
  return new Date(BASE_MS + day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** a single (validFrom, validTo) day-number pair, validFrom <= validTo when both are numbers;
 *  `openEnded` nulls out validTo roughly a third of the time, matching a real open-ended
 *  hr.shift_assignments row (valid_to IS NULL = current). */
const dayRangeArb = fc
  .tuple(dayArb, dayArb, fc.boolean())
  .map(([a, b, openEnded]): { readonly from: number; readonly to: number | null } => {
    const [from, to] = a <= b ? [a, b] : [b, a];
    return { from, to: openEnded ? null : to };
  });

const boundedDayRangeArb = fc
  .tuple(dayArb, dayArb)
  .map(([a, b]): { readonly from: number; readonly to: number } => (a <= b ? { from: a, to: b } : { from: b, to: a }));

function toIsoRange(range: { readonly from: number; readonly to: number | null }): {
  readonly validFrom: string;
  readonly validTo: string | null;
} {
  return { validFrom: isoOfDay(range.from), validTo: range.to === null ? null : isoOfDay(range.to) };
}

/** the oracle: inclusive-bounds interval intersection, NULL treated as unbounded — exactly what
 *  Postgres's `daterange(validFrom, validTo, '[]') && daterange(...)` computes. Day-number math,
 *  never string comparison (ISO 8601 dates DO sort lexicographically the same as numerically, but
 *  the oracle is deliberately independent of that coincidence). */
function referenceRangesOverlap(
  a: { readonly from: number; readonly to: number | null },
  b: { readonly from: number; readonly to: number | null },
): boolean {
  const aTo = a.to ?? Number.POSITIVE_INFINITY;
  const bTo = b.to ?? Number.POSITIVE_INFINITY;
  return a.from <= bTo && b.from <= aTo;
}

// --- P1: overlaps(existing, candidate) ⇔ a genuine date-range intersection ------------------------

describe('overlaps — property (P1, brief D4 — mirrors shift_assignments_no_overlap)', () => {
  it('for any set of existing ranges and a candidate, overlaps() agrees with the reference interval-intersection oracle', () => {
    fc.assert(
      fc.property(fc.array(dayRangeArb, { maxLength: 8 }), dayRangeArb, (existingRanges, candidateRange) => {
        const expected = existingRanges.some((r) => referenceRangesOverlap(r, candidateRange));
        const actual = overlaps(existingRanges.map(toIsoRange), toIsoRange(candidateRange));
        expect(actual).toBe(expected);
      }),
    );
  });

  it('covers an open-ended EXISTING assignment (validTo null) against a bounded candidate', () => {
    fc.assert(
      fc.property(dayArb, boundedDayRangeArb, (existingFrom, candidate) => {
        const existing = { from: existingFrom, to: null as number | null };
        const expected = referenceRangesOverlap(existing, candidate);
        const actual = overlaps([toIsoRange(existing)], toIsoRange(candidate));
        expect(actual).toBe(expected);
      }),
    );
  });

  it('covers an open-ended CANDIDATE (validTo null) against a bounded existing assignment', () => {
    fc.assert(
      fc.property(boundedDayRangeArb, dayArb, (existing, candidateFrom) => {
        const candidate = { from: candidateFrom, to: null as number | null };
        const expected = referenceRangesOverlap(existing, candidate);
        const actual = overlaps([toIsoRange(existing)], toIsoRange(candidate));
        expect(actual).toBe(expected);
      }),
    );
  });

  it('covers BOTH open-ended: two current (valid_to IS NULL) rows for the same employee always overlap', () => {
    fc.assert(
      fc.property(dayArb, dayArb, (existingFrom, candidateFrom) => {
        const existing = { from: existingFrom, to: null as number | null };
        const candidate = { from: candidateFrom, to: null as number | null };
        // two unbounded ranges ALWAYS intersect, regardless of their start days.
        expect(overlaps([toIsoRange(existing)], toIsoRange(candidate))).toBe(true);
      }),
    );
  });

  it('covers BOTH bounded: two closed ranges', () => {
    fc.assert(
      fc.property(boundedDayRangeArb, boundedDayRangeArb, (existing, candidate) => {
        const expected = referenceRangesOverlap(existing, candidate);
        const actual = overlaps([toIsoRange(existing)], toIsoRange(candidate));
        expect(actual).toBe(expected);
      }),
    );
  });

  it('an empty existing set never overlaps anything', () => {
    fc.assert(
      fc.property(dayRangeArb, (candidate) => {
        expect(overlaps([], toIsoRange(candidate))).toBe(false);
      }),
    );
  });

  it('adjacent, non-touching ranges (candidate strictly after existing ends) never overlap', () => {
    fc.assert(
      fc.property(boundedDayRangeArb, fc.integer({ min: 1, max: 30 }), (existing, gap) => {
        const candidate = { from: existing.to + gap, to: existing.to + gap + 5 };
        expect(overlaps([toIsoRange(existing)], toIsoRange(candidate))).toBe(false);
      }),
    );
  });
});

// --- P2: groupShiftMismatch(groupShiftId, inputShiftId) ⇔ groupShiftId ≠ inputShiftId --------------

describe('groupShiftMismatch — property (P2, brief D5 — mirrors shift_assignments_group_shift_fk)', () => {
  it('is false when the ids are the same value', () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        expect(groupShiftMismatch(id, id)).toBe(false);
      }),
    );
  });

  it('is true iff the two ids differ', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        expect(groupShiftMismatch(a, b)).toBe(a !== b);
      }),
    );
  });
});

// --- P3: isValidDaysOfWeek(arr) ⇔ arr.length > 0 ∧ every element ∈ [0,6] ---------------------------

describe('isValidDaysOfWeek — property (P3, mirrors chk_shifts_dow)', () => {
  it('is true iff non-empty and every element is within [0, 6]', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -3, max: 9 }), { maxLength: 10 }), (arr) => {
        const expected = arr.length > 0 && arr.every((n) => n >= 0 && n <= 6);
        expect(isValidDaysOfWeek(arr)).toBe(expected);
      }),
    );
  });

  it('an empty array is always invalid', () => {
    expect(isValidDaysOfWeek([])).toBe(false);
  });

  it('any array whose every element is in [0,6] is valid, non-empty only', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 }), (arr) => {
        expect(isValidDaysOfWeek(arr)).toBe(true);
      }),
    );
  });

  it('any array containing an out-of-range element is invalid', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 6 })),
        fc.oneof(fc.integer({ min: -100, max: -1 }), fc.integer({ min: 7, max: 100 })),
        (validPart, badElement) => {
          expect(isValidDaysOfWeek([...validPart, badElement])).toBe(false);
        },
      ),
    );
  });
});

// --- pg-reviewer round-1 finding 6: isValidGraceMinutes(graceMinutes) ⇔ graceMinutes >= 0 -----------
// mirrors migration 0016's chk_shifts_grace_nonneg CHECK (`grace_minutes >= 0`).

describe('isValidGraceMinutes — property (finding 6a, mirrors chk_shifts_grace_nonneg)', () => {
  it('is true iff graceMinutes >= 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (graceMinutes) => {
        expect(isValidGraceMinutes(graceMinutes)).toBe(graceMinutes >= 0);
      }),
    );
  });

  it('every non-negative integer is valid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), (graceMinutes) => {
        expect(isValidGraceMinutes(graceMinutes)).toBe(true);
      }),
    );
  });

  it('every negative integer is invalid', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100000, max: -1 }), (graceMinutes) => {
        expect(isValidGraceMinutes(graceMinutes)).toBe(false);
      }),
    );
  });
});

// --- pg-reviewer round-1 finding 6: isValidGroupType(groupType) ⇔ groupType ∈ VALID_GROUP_TYPES -----
// mirrors migration 0016's chk_shift_groups_type CHECK (`group_type in ('transport','warehouse','other')`).

describe('isValidGroupType — property (finding 6b, mirrors chk_shift_groups_type)', () => {
  it('is true for every value in VALID_GROUP_TYPES (transport/warehouse/other)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_GROUP_TYPES), (groupType) => {
        expect(isValidGroupType(groupType)).toBe(true);
      }),
    );
  });

  it('is false for any string not in VALID_GROUP_TYPES', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !(VALID_GROUP_TYPES as readonly string[]).includes(s)),
        (groupType) => {
          expect(isValidGroupType(groupType)).toBe(false);
        },
      ),
    );
  });
});

// --- pg-reviewer round-2 finding 2: isValidRange(validFrom, validTo) property test -----------------
// mirrors migration 0016's chk_shift_assignments_valid_range CHECK (`valid_to is null or
// valid_to >= valid_from`). true iff validTo is null (open-ended, always valid) OR validTo >=
// validFrom — INCLUDING the boundary case validTo === validFrom (same-day range, must be valid).

describe('isValidRange — property (round-2 finding 2, mirrors chk_shift_assignments_valid_range)', () => {
  it('is true iff validTo is null or validTo >= validFrom, over generated ISO dates', () => {
    fc.assert(
      fc.property(dayArb, fc.option(dayArb, { nil: null }), (fromDay, toDay) => {
        const validFrom = isoOfDay(fromDay);
        const validTo = toDay === null ? null : isoOfDay(toDay);
        const expected = validTo === null || toDay! >= fromDay;
        expect(isValidRange(validFrom, validTo)).toBe(expected);
      }),
    );
  });

  it('an open-ended range (validTo null) is always valid, regardless of validFrom', () => {
    fc.assert(
      fc.property(dayArb, (fromDay) => {
        expect(isValidRange(isoOfDay(fromDay), null)).toBe(true);
      }),
    );
  });

  it('the boundary case validTo === validFrom (same-day range) is always valid', () => {
    fc.assert(
      fc.property(dayArb, (day) => {
        const iso = isoOfDay(day);
        expect(isValidRange(iso, iso)).toBe(true);
      }),
    );
  });

  it('any validTo strictly before validFrom is invalid', () => {
    fc.assert(
      fc.property(boundedDayRangeArb, ({ from, to }) => {
        fc.pre(to > from);
        // swap: validFrom = the later day, validTo = the earlier day -> validTo < validFrom.
        expect(isValidRange(isoOfDay(to), isoOfDay(from))).toBe(false);
      }),
    );
  });

  it('any validTo on or after validFrom is valid', () => {
    fc.assert(
      fc.property(boundedDayRangeArb, ({ from, to }) => {
        expect(isValidRange(isoOfDay(from), isoOfDay(to))).toBe(true);
      }),
    );
  });
});
