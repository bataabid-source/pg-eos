// modules/hr/domain/confirm-commission/invariants.ts — WBS 3.13 part 4 (round-1 review finding 8).
//
// Pure domain logic: no I/O, no Date.now()/new Date() (CLAUDE.md · AGENT CONSTRAINTS) — `workDate`
// is passed in as an already-known string, never read from a clock here. Moved from
// ../../application/confirm-commission/confirm-commission.ts (round-1 review finding 8 — a pure
// invariant with no I/O belongs in domain/, not application/, same convention as
// ../dispute-commission/invariants.ts's own `isWithinDisputeWindow`).

/** the work_date's own month, first-of-month, `YYYY-MM-01` — matches the DB's own
 *  `date_trunc('month', work_date)::date` (brief decision 5), computed purely from the
 *  already-known `workDate` string (`YYYY-MM-DD`), never a `new Date()` construction. */
export function payrollPeriodOf(workDate: string): string {
  return `${workDate.slice(0, 7)}-01`;
}
