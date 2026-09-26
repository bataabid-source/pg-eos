// modules/hr/domain/calculate-daily-commission/invariants.ts — WBS 3.13 part 1.
//
// domain/ layer: pure functions only — no I/O, no Date.now()/new Date(), no Math.random()
// (CLAUDE.md · AGENT CONSTRAINTS). This command performs ONE guarded insert, not a dispatched set
// of transitions — no state machine is built here (brief, Deliver: "no state machine: this command
// performs one insert guarded by preconditions ... same precedent as RegisterVehicle/
// AssignDriverId").
//
// `selectCommissionRule` is the pure tier-match/rule-selection logic (brief, Deliver): given a
// list of candidate hr.commission_rules rows — already pre-filtered by entity/applies_to='driver'/
// client_id-is-null/valid-window by the repository's own SQL — and a `deliveredCount`, return the
// ONE matching rule, or a discriminated "none" (zero matches) / "ambiguous" (more than one match,
// no tie-break invented — brief default 2) result. Never throws for any input.
//
// `computeGrossCommission` is the pure gross-commission calculation (round-1 review finding 4: was
// living in ../../application/calculate-daily-commission/calculate-daily-commission.ts, moved here
// so it is a plain, testable domain function) — brief default 3:
// `greatest(delivered_count * rate_per_unit, coalesce(min_daily, 0))`, exact-decimal arithmetic via
// @pg-eos/domain-kit's Money (numeric(14,3), never a float — packages/domain-kit/money.ts).

import { Money } from '@pg-eos/domain-kit';

const MIN_DAILY_FLOOR_DEFAULT = '0';

/** mirrors hr.commission_rules' tier_from/tier_to/rate_per_unit/min_daily columns
 *  (database/schema/13-Schema-Additions.sql:349-362). `tierTo === null` is the open-ended top tier
 *  (brief default 1). */
export interface CommissionRuleCandidate {
  readonly id: string;
  readonly tierFrom: number;
  readonly tierTo: number | null;
  readonly ratePerUnit: string;
  readonly minDaily: string | null;
}

export type CommissionRuleSelection =
  | { readonly kind: 'matched'; readonly rule: CommissionRuleCandidate }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly rules: readonly CommissionRuleCandidate[] };

/** A candidate rule "matches" deliveredCount when
 *  `deliveredCount >= tierFrom && (tierTo === null || deliveredCount < tierTo)` (brief default 1's
 *  own plain reading of `[tier_from, tier_to)`). */
function matchesTier(rule: CommissionRuleCandidate, deliveredCount: number): boolean {
  return deliveredCount >= rule.tierFrom && (rule.tierTo === null || deliveredCount < rule.tierTo);
}

/** Pure, no I/O — never throws for any input, including an empty rule list or an out-of-range
 *  deliveredCount (malformed input is data, not a crash, same discipline as
 *  modules/imile/domain/evaluate-dtl-problem/invariants.ts's own precedent — that file lives in
 *  modules/imile, not this module; corrected round-1 review finding 7 citation error). */
export function selectCommissionRule(
  rules: readonly CommissionRuleCandidate[],
  deliveredCount: number,
): CommissionRuleSelection {
  const matching = rules.filter((rule) => matchesTier(rule, deliveredCount));

  if (matching.length === 0) return { kind: 'none' };
  if (matching.length > 1) return { kind: 'ambiguous', rules: matching };

  const [rule] = matching;
  if (!rule) return { kind: 'none' };
  return { kind: 'matched', rule };
}

/** `greatest(delivered_count * rate_per_unit, coalesce(min_daily, 0))` (brief default 3) — pure,
 *  no I/O, exact-decimal arithmetic (Money, never a float). `minDaily` null means "no floor" (the
 *  column's own nullability), coalesced to `MIN_DAILY_FLOOR_DEFAULT` ('0') first. */
export function computeGrossCommission(
  deliveredCount: number,
  ratePerUnit: string,
  minDaily: string | null,
): Money {
  const tieredAmount = Money.of(ratePerUnit).multiply(String(deliveredCount));
  const minDailyFloor = Money.of(minDaily ?? MIN_DAILY_FLOOR_DEFAULT);
  return tieredAmount.compare(minDailyFloor) >= 0 ? tieredAmount : minDailyFloor;
}
