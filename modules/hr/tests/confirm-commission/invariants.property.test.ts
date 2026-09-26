// modules/hr/tests/confirm-commission/invariants.property.test.ts — WBS 3.13 part 4, round-5 fix
// round, finding 8.
//
// Property tests (fast-check) for `payrollPeriodOf` — the brief's own Deliver list requires this
// file (modules/hr/tests/{confirm-commission}/invariants.property.test.ts) and it was MISSING
// entirely before this fix round.
//
// `payrollPeriodOf` lives in modules/hr/domain/confirm-commission/invariants.ts (pure domain
// logic, CLAUDE.md · ARCHITECTURE: no Math.random()/new Date() in domain/, this function needs
// neither — a pure string-slice of an already-known YYYY-MM-DD workDate), built and GREEN.
//
// Surface this file pins (once GREEN and built):
//   modules/hr/domain/confirm-commission/invariants.ts
//     - payrollPeriodOf(workDate: string): string — the work_date's own month, first-of-month,
//       `YYYY-MM-01` (brief decision 5), matching the DB's own `date_trunc('month', work_date)::date`
//       — a pure string operation on an already-known `YYYY-MM-DD` date, never a `new Date()`
//       construction.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — built and GREEN.
import { payrollPeriodOf } from '../../domain/confirm-commission/invariants.js';

/** Independent oracle: plain string zero-padding of (year, month) into `YYYY-MM-01` — never
 *  routed through the function under test (no shared helper, no Date object of any kind), so this
 *  never merely re-derives the same string-slice logic it is meant to verify against. */
function expectedPayrollPeriod(year: number, month1To12: number): string {
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month1To12).padStart(2, '0');
  return `${yyyy}-${mm}-01`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

describe('payrollPeriodOf — property (pure, the work_date\'s own month, first-of-month, YYYY-MM-01)', () => {
  it('returns exactly the first day of the given work_date\'s own calendar month, for an arbitrary spread of dates including month boundaries and leap-year February', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }), // 28 is valid in every month, including non-leap Feb.
        (year, month, day) => {
          const workDate = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
          expect(payrollPeriodOf(workDate)).toBe(expectedPayrollPeriod(year, month));
        },
      ),
    );
  });

  it('never throws for any well-formed YYYY-MM-DD work_date in the property\'s own range', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (year, month, day) => {
          const workDate = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
          expect(() => payrollPeriodOf(workDate)).not.toThrow();
        },
      ),
    );
  });

  // concrete boundary examples (brief scenario: "payroll_period is set to the work_date's own
  // month" — the 1st and the last day of a month must both map to the SAME first-of-month).
  it('concrete: the 1st of a month maps to itself', () => {
    expect(payrollPeriodOf('2024-05-01')).toBe('2024-05-01');
  });

  it('concrete: the last day of a 31-day month maps to that month\'s own first day', () => {
    expect(payrollPeriodOf('2024-05-31')).toBe('2024-05-01');
  });

  it('concrete: the last day of a 30-day month maps to that month\'s own first day', () => {
    expect(payrollPeriodOf('2024-04-30')).toBe('2024-04-01');
  });

  it('concrete: leap-year February 29 (2024 is a leap year) maps to 2024-02-01', () => {
    expect(payrollPeriodOf('2024-02-29')).toBe('2024-02-01');
  });

  it('concrete: non-leap-year February 28 (2023) maps to 2023-02-01', () => {
    expect(payrollPeriodOf('2023-02-28')).toBe('2023-02-01');
  });

  it('concrete: a December work_date stays in the SAME year (no accidental year rollover)', () => {
    expect(payrollPeriodOf('2024-12-15')).toBe('2024-12-01');
  });

  it('concrete: a January work_date stays in the SAME year (no accidental year rollback)', () => {
    expect(payrollPeriodOf('2024-01-15')).toBe('2024-01-01');
  });
});
