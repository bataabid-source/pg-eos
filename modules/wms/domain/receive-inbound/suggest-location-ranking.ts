// modules/wms/domain/receive-inbound/suggest-location-ranking.ts — WBS 2.9, THE GOLDEN SLICE.
//
// domain/ layer: pure ranking of an already-computed, already-filtered candidate set. No I/O, no
// Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). doc 40 §C3 "A2: conditions, ABC,
// proximity to shipping, capacity, client assignment" — ABC-class weighting was added in WBS 2.10
// (doc 40 gives no formula; see the WBS 2.10 note below for the default taken).
//
// The capacity CHECK itself (whether a location has enough remaining weight/volume headroom) is
// NOT pure — it needs a DB read of current wms.stock_balance load, same reason WBS 2.4's
// evaluateLocationLimits keeps that arithmetic in SQL (../../src/stock-ledger/domain.ts). The
// caller (../../infrastructure/receive-inbound/*) computes `remainingCapacityRatio` in SQL and
// passes an already-filtered set here; only the ORDER is decided in this file.
//
// WBS 2.10 (docs/notes/slice-briefs/_slice-2.10.brief.md, Master decisions 1-3): doc 40 gives no
// ABC formula, so the default taken (batched GM question) is: for abc_class 'A' (fast movers),
// proximity to shipping outranks capacity headroom; for 'B'/'C'/null, 2.9's own capacity-first
// order is UNCHANGED. `abc_class` is a per-CALL constant (one call = one skuId), never a
// per-candidate comparison field — it lives in the ranking function's own parameter, not in
// `RankableLocationCandidate` as a compared field (it IS carried on the candidate so the caller
// can read it back on the output, but the comparator/rankLocationCandidates never read
// `a.abcClass`/`b.abcClass` themselves, only the explicit third parameter below).

/** wms.skus.abc_class (char(1)) — passed through verbatim, `null` when unset. */
export type AbcClass = 'A' | 'B' | 'C' | null;

/** One already-filtered storage-location candidate, ready to be ranked. */
export interface RankableLocationCandidate {
  readonly locationId: string;
  readonly clientAssignedMatch: boolean;
  /** Caller-computed (SQL) fraction of remaining headroom, 0..1, higher = more room. */
  readonly remainingCapacityRatio: number;
  readonly positionNo: number;
  /** The candidate's SKU's abc_class — the same value on every candidate of one call (WBS 2.10). */
  readonly abcClass: AbcClass;
}

/**
 * Total order: clientAssignedMatch (true first, UNCHANGED) then, depending on `abcClass` (WBS
 * 2.10 Master decision 2):
 *   - `'A'`: positionNo (lower first, nearer the door) THEN remainingCapacityRatio (higher first)
 *     — proximity outranks capacity for a fast mover.
 *   - `'B'` / `'C'` / `null`: remainingCapacityRatio (higher first) THEN positionNo (lower first)
 *     — 2.9's own order, UNCHANGED.
 * A plain `Array.prototype.sort` comparator, exported so a caller can assert sortedness
 * independently of rankLocationCandidates's own implementation.
 */
export function compareLocationCandidates(
  a: RankableLocationCandidate,
  b: RankableLocationCandidate,
  abcClass: AbcClass,
): number {
  if (a.clientAssignedMatch !== b.clientAssignedMatch) {
    return a.clientAssignedMatch ? -1 : 1;
  }
  if (abcClass === 'A') {
    if (a.positionNo !== b.positionNo) {
      return a.positionNo < b.positionNo ? -1 : 1;
    }
    if (a.remainingCapacityRatio !== b.remainingCapacityRatio) {
      return a.remainingCapacityRatio > b.remainingCapacityRatio ? -1 : 1;
    }
    return 0;
  }
  if (a.remainingCapacityRatio !== b.remainingCapacityRatio) {
    return a.remainingCapacityRatio > b.remainingCapacityRatio ? -1 : 1;
  }
  if (a.positionNo !== b.positionNo) {
    return a.positionNo < b.positionNo ? -1 : 1;
  }
  return 0;
}

/** Returns a NEW array (never mutates `candidates`), sorted by compareLocationCandidates for the
 *  given `abcClass` — the caller's one skuId's own abc_class, threaded straight through. */
export function rankLocationCandidates(
  candidates: readonly RankableLocationCandidate[],
  abcClass: AbcClass,
): readonly RankableLocationCandidate[] {
  return [...candidates].sort((a, b) => compareLocationCandidates(a, b, abcClass));
}
