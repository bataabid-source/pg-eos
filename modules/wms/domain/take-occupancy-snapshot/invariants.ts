// modules/wms/domain/take-occupancy-snapshot/invariants.ts — WBS 2.14 (lane 2).
//
// domain/ layer: pure invariant checks and computations — no I/O, no Date.now()/Math.random(),
// injected Date values only (CLAUDE.md · AGENT CONSTRAINTS). The application layer
// (../../application/take-occupancy-snapshot/take-occupancy-snapshot.ts) calls these against rows
// the repository already read. pg-tester's property tests (P1/P2,
// ../../tests/take-occupancy-snapshot/invariants.property.test.ts) exercise these directly.

/** One occupied location for a client — the repository (../../infrastructure/
 *  take-occupancy-snapshot/repository.ts) returns one of these per DISTINCT (client, location) it
 *  finds occupied (a positive `wms.stock_balance` row) in the target warehouse; `occupied` is
 *  always `true` for a row the repository returns (the query itself already filters to occupied
 *  locations), kept as an explicit field so `countOccupiedLocations` stays a general-purpose,
 *  independently-testable pure function (P2) rather than one hard-wired to that query shape. */
export interface OccupiedLocationRow {
  readonly type: string;
  readonly occupied: boolean;
}

/** P1 (brief): the excess of `occupied` over `contracted` — `occupied - contracted` when
 *  `occupied` is strictly greater, else `0` (never negative — a client within or exactly at
 *  capacity has no overflow). Brief D3/D4. */
export function overflowQty(occupied: number, contracted: number): number {
  return occupied > contracted ? occupied - contracted : 0;
}

/** P2 (brief): counts the rows whose `occupied` flag is `true`, additionally filtered to
 *  `type === opts.typeFilter` when a typeFilter is supplied. Brief D2: `pallets_occupied` is this
 *  count with `typeFilter: 'pallet'`; `locations_used` is this count with no typeFilter (every
 *  location_type). */
export function countOccupiedLocations(
  rows: readonly OccupiedLocationRow[],
  opts?: { readonly typeFilter?: string },
): number {
  const typeFilter = opts?.typeFilter;
  return rows.filter((row) => row.occupied && (typeFilter === undefined || row.type === typeFilter)).length;
}

// Asia/Kuwait carries a fixed UTC+3 offset year-round (no DST) — a plain, deterministic shift, no
// timezone-database dependency needed for this single, unchanging offset.
const KUWAIT_UTC_OFFSET_MINUTES = 3 * 60;

/** Brief D6: `snapshotDate` defaults to the injected Clock's own business date (Asia/Kuwait) when
 *  the caller omits it. Pure: takes the instant as a parameter (from `deps.clock.now()` at the
 *  call site), never reads the wall clock itself. Returns `YYYY-MM-DD`. */
export function businessDateOf(instant: Date): string {
  const shifted = new Date(instant.getTime() + KUWAIT_UTC_OFFSET_MINUTES * 60_000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
