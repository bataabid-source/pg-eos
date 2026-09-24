// modules/wms/domain/receive-inbound/suggest-location-ranking.ts — WBS 2.9, THE GOLDEN SLICE.
//
// domain/ layer: pure ranking of an already-computed, already-filtered candidate set. No I/O, no
// Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). doc 40 §C3 "A2: conditions, ABC,
// proximity to shipping, capacity, client assignment" — no ABC-class weighting: doc 40 gives no
// formula (recorded as a follow-up, not a G-01 invention, per the slice brief).
//
// The capacity CHECK itself (whether a location has enough remaining weight/volume headroom) is
// NOT pure — it needs a DB read of current wms.stock_balance load, same reason WBS 2.4's
// evaluateLocationLimits keeps that arithmetic in SQL (../../src/stock-ledger/domain.ts). The
// caller (../../infrastructure/receive-inbound/*) computes `remainingCapacityRatio` in SQL and
// passes an already-filtered set here; only the ORDER is decided in this file.

/** One already-filtered storage-location candidate, ready to be ranked. */
export interface RankableLocationCandidate {
  readonly locationId: string;
  readonly clientAssignedMatch: boolean;
  /** Caller-computed (SQL) fraction of remaining headroom, 0..1, higher = more room. */
  readonly remainingCapacityRatio: number;
  readonly positionNo: number;
}

/**
 * Total order: clientAssignedMatch (true first) > remainingCapacityRatio (higher first) >
 * positionNo (lower first, nearer the door). A plain `Array.prototype.sort` comparator, exported
 * so a caller can assert sortedness independently of rankLocationCandidates's own implementation.
 */
export function compareLocationCandidates(
  a: RankableLocationCandidate,
  b: RankableLocationCandidate,
): number {
  if (a.clientAssignedMatch !== b.clientAssignedMatch) {
    return a.clientAssignedMatch ? -1 : 1;
  }
  if (a.remainingCapacityRatio !== b.remainingCapacityRatio) {
    return a.remainingCapacityRatio > b.remainingCapacityRatio ? -1 : 1;
  }
  if (a.positionNo !== b.positionNo) {
    return a.positionNo < b.positionNo ? -1 : 1;
  }
  return 0;
}

/** Returns a NEW array (never mutates `candidates`), sorted by compareLocationCandidates. */
export function rankLocationCandidates(
  candidates: readonly RankableLocationCandidate[],
): readonly RankableLocationCandidate[] {
  return [...candidates].sort(compareLocationCandidates);
}
