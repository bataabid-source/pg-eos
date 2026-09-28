// modules/billing/domain/accounting-periods/invariants.ts — WBS 4.19 (lane 2).
//
// domain/ layer: pure posting rule, no I/O, no Date (ISO 'YYYY-MM-DD' strings order
// lexicographically — same discipline as packages/contracts/billing/accounting-periods.ts's own
// isOrderedRange). The database enforces the same rule itself (billing.assert_posting_period(),
// migration 0040 — 4.19 pre-build review D5); this is its pure statement:
//   - the covering period is the period of the SAME entity whose [startDate, endDate] contains
//     the entry date (no two periods of one entity overlap, so there is at most one);
//   - a non-null periodId is accepted only if it IS the covering period and that period is open;
//   - a null periodId is accepted when no period covers the date, or the covering period is open.

import { PERIOD_STATUS, type PeriodStatus } from './machine.js';

export interface Period {
  readonly id: string;
  readonly entityId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: PeriodStatus;
}

export interface PostingCandidate {
  readonly entityId: string;
  readonly entryDate: string;
  readonly periodId?: string | null | undefined;
}

/** The period of `entityId` whose [startDate, endDate] contains `date`, if any. */
export function findCoveringPeriod(periods: readonly Period[], entityId: string, date: string): Period | undefined {
  return periods.find((period) => period.entityId === entityId && period.startDate <= date && date <= period.endDate);
}

/** True iff the database accepts a posting of `input` given `periods` (D5, see header). */
export function isPostingAccepted(periods: readonly Period[], input: PostingCandidate): boolean {
  const covering = findCoveringPeriod(periods, input.entityId, input.entryDate);
  const periodId = input.periodId ?? null;
  if (covering === undefined) return periodId === null;
  if (periodId !== null && periodId !== covering.id) return false;
  return covering.status === PERIOD_STATUS.OPEN;
}
