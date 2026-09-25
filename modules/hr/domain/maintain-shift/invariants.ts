// modules/hr/domain/maintain-shift/invariants.ts — WBS 5.5a part 2 (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). The application layer
// (../../application/maintain-shift/{assign-shift.ts,create-shift.ts,end-shift-assignment.ts})
// calls these BEFORE any DB write; a failed invariant throws a typed error from ./errors.ts.
// pg-tester adds property tests against these functions directly (P1, P2, P3 — see
// modules/hr/tests/maintain-shift/invariants.property.test.ts).
//
// doc 36 §5-4 #2: migration 0016's `shift_assignments_no_overlap` (exclusion constraint) and
// `shift_assignments_group_shift_fk` (composite FK) already enforce these two rules at the DB
// layer — this file enforces the SAME rules at the domain layer too (dual enforcement, not a new
// rule), so a caller gets a typed 422 instead of a raw `23P01`/`23503` constraint-violation
// Problem.

/** A single existing/candidate date range — `validTo: null` means open-ended/current (the same
 *  meaning hr.shift_assignments.valid_to IS NULL carries). */
export interface DateRange {
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** Inclusive-bounds interval intersection, `validTo === null` treated as unbounded — exactly what
 *  Postgres's `daterange(validFrom, validTo, '[]') && daterange(...)` computes (migration 0016's
 *  `shift_assignments_no_overlap`). ISO 8601 date strings (`YYYY-MM-DD`) sort lexicographically
 *  the same as they would numerically, so plain string comparison is exact here. */
function rangesOverlap(a: DateRange, b: DateRange): boolean {
  // standard closed-interval overlap: a.from <= b.to AND b.from <= a.to — a null validTo means
  // unbounded, so it can never fail its own side of the comparison.
  const aStartsBeforeOrAtBEnd = b.validTo === null || a.validFrom <= b.validTo;
  const bStartsBeforeOrAtAEnd = a.validTo === null || b.validFrom <= a.validTo;
  return aStartsBeforeOrAtBEnd && bStartsBeforeOrAtAEnd;
}

/** P1 / brief D4: true iff AT LEAST ONE row in `existing` genuinely intersects `candidate`, using
 *  the SAME inclusive-bounds, NULL-is-unbounded semantics as the DB's own
 *  `daterange(valid_from, valid_to, '[]') && daterange(...)` operator (migration 0016,
 *  `shift_assignments_no_overlap`). This is the domain-layer check that must run BEFORE the
 *  repository issues the INSERT (doc 36 §5-4 #2's "both, not one" — the DB exclusion constraint
 *  is belt-and-braces, not the only line of defence). */
export function overlaps(existing: readonly DateRange[], candidate: DateRange): boolean {
  return existing.some((row) => rangesOverlap(row, candidate));
}

/** P2 / brief D5 (mirrors migration 0016's composite FK `shift_assignments_group_shift_fk`): true
 *  iff the two ids differ. Only ever evaluated by the application layer when a `groupId` is
 *  actually supplied (the composite FK is MATCH SIMPLE — trivially satisfied when group_id IS
 *  NULL). */
export function groupShiftMismatch(groupShiftId: string, inputShiftId: string): boolean {
  return groupShiftId !== inputShiftId;
}

// migration 0016 chk_shifts_dow: `cardinality(days_of_week) > 0 and days_of_week <@ array[0..6]`.
const MIN_DAY_OF_WEEK = 0;
const MAX_DAY_OF_WEEK = 6;

/** P3, mirrors migration 0016's `chk_shifts_dow`: true iff `arr.length > 0` and every element is
 *  in [0, 6] (0=Sunday..6=Saturday). */
export function isValidDaysOfWeek(arr: readonly number[]): boolean {
  return arr.length > 0 && arr.every((day) => day >= MIN_DAY_OF_WEEK && day <= MAX_DAY_OF_WEEK);
}

// migration 0016 chk_shifts_grace_nonneg: `grace_minutes >= 0`.
const MIN_GRACE_MINUTES = 0;

/** pg-reviewer round-1 finding 6, mirrors migration 0016's `chk_shifts_grace_nonneg`: true iff
 *  `graceMinutes >= 0`. */
export function isValidGraceMinutes(graceMinutes: number): boolean {
  return graceMinutes >= MIN_GRACE_MINUTES;
}

// migration 0016 chk_shift_groups_type: `group_type in ('transport','warehouse','other')`.
export const VALID_GROUP_TYPES = ['transport', 'warehouse', 'other'] as const;
export const VALID_GROUP_TYPES_LIST = VALID_GROUP_TYPES.join(', ');

/** pg-reviewer round-1 finding 6, mirrors migration 0016's `chk_shift_groups_type`: true iff
 *  `groupType` is one of the three values the DB CHECK allows. */
export function isValidGroupType(groupType: string): boolean {
  return (VALID_GROUP_TYPES as readonly string[]).includes(groupType);
}

/** pg-reviewer round-1 findings 1/2, mirrors migration 0016's `chk_shift_assignments_valid_range`
 *  CHECK (`valid_to is null or valid_to >= valid_from`): true iff `validTo` is null (open-ended)
 *  or `validTo >= validFrom`. ISO 8601 date strings (`YYYY-MM-DD`) sort lexicographically the same
 *  as they would numerically, so plain string comparison is exact here (same reasoning as
 *  `rangesOverlap` above). */
export function isValidRange(validFrom: string, validTo: string | null): boolean {
  return validTo === null || validTo >= validFrom;
}
