// modules/billing/tests/accounting-periods/invariants.unit.property.test.ts — WBS 4.19 (lane 2).
//
// 4.19 pre-build review finding 20: a PURE fast-check property test, no DB, no I/O, no Date/
// Math.random() inside the domain code under test (CLAUDE.md · AGENT CONSTRAINTS) — exercises
// `modules/billing/domain/accounting-periods/invariants.ts`'s own `findCoveringPeriod` and
// `isPostingAccepted` against an INDEPENDENT reference implementation written directly in this
// file (never importing the real one back), so a mutation of the real file's date-range or
// period_id comparison is caught here, counting toward the domain/ >= 90% mutation gate (doc 40
// Part F G16), without needing the database at all.
//
// D5 (4.19 pre-build review, restated as a pure function): given a period whose [startDate,
// endDate] contains entryDate for the SAME entityId ("the covering period"):
//   - periodId is non-null: accepted iff a covering period EXISTS, its id === periodId, AND its
//     status === 'open'. (A non-null periodId naming the wrong period, or naming one when there is
//     no covering period at all, is refused — SCR-ACC-01 #4.)
//   - periodId is null/undefined: accepted iff there is NO covering period, OR the covering
//     period's status === 'open'.
//
// Surface this file exercises — modules/billing/domain/accounting-periods/invariants.ts (STATUS:
// GREEN, no database involved):
//   - `type Period = { id: string; entityId: string; startDate: string; endDate: string; status:
//     'open' | 'closed' | 'locked' }` (ISO 'YYYY-MM-DD' strings — lexicographic order, same
//     discipline as packages/contracts/billing/accounting-periods.ts's own `isOrderedRange`; no
//     `Date` object anywhere in the domain function).
//   - `findCoveringPeriod(periods: readonly Period[], entityId: string, date: string): Period |
//     undefined` — the period of `entityId` whose [startDate, endDate] contains `date`.
//   - `isPostingAccepted(periods: readonly Period[], input: { entityId: string; entryDate: string;
//     periodId?: string | null }): boolean` — the rule above.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { findCoveringPeriod, isPostingAccepted, type Period } from '../../domain/accounting-periods/invariants.js';

const ENTITY_A = 'entity-a';
const ENTITY_B = 'entity-b';
const STATUSES = ['open', 'closed', 'locked'] as const;
const WINDOW_DAYS = 60;
const MAX_PERIODS = 4;

function dayToIso(day: number): string {
  // A pure, deterministic day-offset -> ISO date string, base year 2000 (arbitrary, unused by any
  // assertion beyond ordering) — no `Date` object needed even here, matching the domain function's
  // own string-only discipline, though this IS a test file (Date use would be permitted here too).
  const base = Date.UTC(2000, 0, 1);
  const ms = base + day * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Tiles [0, WINDOW_DAYS-1] into `n` CONSECUTIVE, NON-OVERLAPPING blocks for `entityId`, one period
 *  per block, each carrying its own generated status — same tiling discipline as
 *  ./invariants.property.integration.test.ts's own buildTiledPeriods, but pure (in-memory, no DB). */
function tilePeriods(entityId: string, n: number, statuses: ReadonlyArray<(typeof STATUSES)[number]>): Period[] {
  const blockLength = Math.floor(WINDOW_DAYS / n);
  const periods: Period[] = [];
  for (let i = 0; i < n; i += 1) {
    const startOffset = i * blockLength;
    const endOffset = i === n - 1 ? WINDOW_DAYS - 1 : (i + 1) * blockLength - 1;
    periods.push({
      id: `${entityId}-period-${i}`,
      entityId,
      startDate: dayToIso(startOffset),
      endDate: dayToIso(endOffset),
      status: statuses[i] ?? 'open',
    });
  }
  return periods;
}

// The reference oracle compares on the ORIGINAL day-offset integers (never re-parsing the ISO
// strings it already built) — avoids any dependency on the same string-comparison logic the real
// function itself must implement.
interface OffsetPeriod extends Period {
  readonly startOffset: number;
  readonly endOffset: number;
}

function tileOffsetPeriods(entityId: string, n: number, statuses: ReadonlyArray<(typeof STATUSES)[number]>): OffsetPeriod[] {
  const blockLength = Math.floor(WINDOW_DAYS / n);
  const periods: OffsetPeriod[] = [];
  for (let i = 0; i < n; i += 1) {
    const startOffset = i * blockLength;
    const endOffset = i === n - 1 ? WINDOW_DAYS - 1 : (i + 1) * blockLength - 1;
    periods.push({
      id: `${entityId}-period-${i}`,
      entityId,
      startDate: dayToIso(startOffset),
      endDate: dayToIso(endOffset),
      status: statuses[i] ?? 'open',
      startOffset,
      endOffset,
    });
  }
  return periods;
}

function referenceCoveringOffset(periods: readonly OffsetPeriod[], entityId: string, dayOffset: number): OffsetPeriod | undefined {
  return periods.find((p) => p.entityId === entityId && dayOffset >= p.startOffset && dayOffset <= p.endOffset);
}

function referenceIsPostingAccepted(
  periods: readonly OffsetPeriod[],
  input: { entityId: string; dayOffset: number; periodId: string | null },
): boolean {
  const covering = referenceCoveringOffset(periods, input.entityId, input.dayOffset);
  if (input.periodId !== null) {
    if (!covering) return false;
    if (covering.id !== input.periodId) return false;
    return covering.status === 'open';
  }
  if (!covering) return true;
  return covering.status === 'open';
}

describe('findCoveringPeriod — pure, matches an independent reference oracle', () => {
  it('for any generated tiled period set and any date offset, findCoveringPeriod agrees with the reference oracle', () => {
    const countArb = fc.integer({ min: 1, max: MAX_PERIODS });
    const statusArb = fc.constantFrom(...STATUSES);
    const statusesArb = fc.array(statusArb, { minLength: MAX_PERIODS, maxLength: MAX_PERIODS });
    const dayOffsetArb = fc.integer({ min: -10, max: WINDOW_DAYS + 10 });
    const entityArb = fc.constantFrom(ENTITY_A, ENTITY_B);

    fc.assert(
      fc.property(countArb, statusesArb, dayOffsetArb, entityArb, (n, statusesFull, dayOffset, entityId) => {
        const statuses = statusesFull.slice(0, n);
        const periods = tileOffsetPeriods(entityId, n, statuses);
        const expected = referenceCoveringOffset(periods, entityId, dayOffset);
        const actual = findCoveringPeriod(periods, entityId, dayToIso(dayOffset));
        expect(actual?.id).toBe(expected?.id);
      }),
      { numRuns: 200 },
    );
  });

  it('a period of a DIFFERENT entityId is never returned as covering, even when its date range matches', () => {
    const periods: Period[] = tilePeriods(ENTITY_A, 1, ['open']);
    expect(findCoveringPeriod(periods, ENTITY_B, periods[0]?.startDate as string)).toBeUndefined();
  });
});

describe('isPostingAccepted — pure, matches an independent reference oracle (D5)', () => {
  it('for any generated tiled period set, any date offset, any entity, and any periodId choice (null | covering id | some other existing id), isPostingAccepted agrees with the reference oracle', () => {
    const countArb = fc.integer({ min: 1, max: MAX_PERIODS });
    const statusArb = fc.constantFrom(...STATUSES);
    const statusesArb = fc.array(statusArb, { minLength: MAX_PERIODS, maxLength: MAX_PERIODS });
    const dayOffsetArb = fc.integer({ min: -10, max: WINDOW_DAYS + 10 });
    const entityArb = fc.constantFrom(ENTITY_A, ENTITY_B);
    const periodIdChoiceArb = fc.constantFrom<'null' | 'covering' | 'other'>('null', 'covering', 'other');

    fc.assert(
      fc.property(countArb, statusesArb, dayOffsetArb, entityArb, periodIdChoiceArb, (n, statusesFull, dayOffset, entityId, choice) => {
        const statuses = statusesFull.slice(0, n);
        const periods = tileOffsetPeriods(entityId, n, statuses);
        const covering = referenceCoveringOffset(periods, entityId, dayOffset);

        let periodId: string | null;
        if (choice === 'null') periodId = null;
        else if (choice === 'covering') periodId = covering ? covering.id : null;
        else periodId = `${entityId}-some-other-period-id`; // never a real id in `periods`.

        const expected = referenceIsPostingAccepted(periods, { entityId, dayOffset, periodId });
        const actual = isPostingAccepted(periods, { entityId, entryDate: dayToIso(dayOffset), periodId });
        expect(actual).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('a null periodId with NO covering period at all is always accepted (D5: "not refused by this slice")', () => {
    const periods = tilePeriods(ENTITY_A, 1, ['locked']);
    const uncoveredDate = dayToIso(WINDOW_DAYS + 5);
    expect(isPostingAccepted(periods, { entityId: ENTITY_A, entryDate: uncoveredDate, periodId: null })).toBe(true);
  });

  it('a non-null periodId naming a real period that does NOT cover entryDate is refused, even if that real period is open', () => {
    const periods = tilePeriods(ENTITY_A, 2, ['open', 'closed']);
    const secondPeriod = periods[1] as Period;
    // entryDate falls inside the FIRST (open) block, but periodId names the SECOND period.
    const entryDateInFirstBlock = periods[0]?.startDate as string;
    expect(
      isPostingAccepted(periods, { entityId: ENTITY_A, entryDate: entryDateInFirstBlock, periodId: secondPeriod.id }),
    ).toBe(false);
  });
});
