// modules/wms/domain/schedule-inbound/invariants.ts — WBS 2.9b (lane 2).
//
// Pure domain invariants — no I/O, no Math.random(), no `new Date()`/`Date.now()` internally
// (CLAUDE.md: "No Math.random() / new Date() in domain/ — inject generator and clock"); every
// timestamp is a parameter. docs/notes/slice-briefs/_slice-2.9b.brief.md D1/D3/D4, migration
// 0023_2_schedule-inbound.sql's own CHECK lists.
//
// isNonEmptyReason is ALSO imported by ../../application/receive-inbound/cancel-inbound.ts (the
// WBS 2.9b scoped-grant extension, D3's mandatory `cancelReason`) — recorded default: the brief
// names no shared home for this predicate, and domain/receive-inbound/invariants.ts is not in
// this slice's Write ONLY list, so it is placed here instead, flagged in the closing report.

/** D1 ("must be in the future"): true iff `candidate` is strictly after `now`. An equal timestamp
 *  is NOT future. */
export function isFutureTimestamp(candidate: Date, now: Date): boolean {
  return candidate.getTime() > now.getTime();
}

// migration 0023 CHECK chk_inbound_orders_vehicle_type.
const VALID_VEHICLE_TYPES = ['container_20', 'container_40', 'truck', 'trailer', 'van', 'pickup', 'other'] as const;

/** D4: true when `value` is null/undefined (the field is optional, D6) OR is one of the closed
 *  list; false for any other non-empty string. */
export function isValidVehicleType(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return (VALID_VEHICLE_TYPES as readonly string[]).includes(value);
}

/** D3 (CancelInbound.cancelReason mandatory, min length 1): true iff `value` is a string of
 *  length >= 1; false for null/undefined/empty string. */
export function isNonEmptyReason(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length >= 1;
}

// migration 0023 CHECKs — round-1 review finding 3: dual enforcement (domain + DB), same
// belt-and-braces discipline as isValidVehicleType/chk_inbound_orders_vehicle_type above, for the
// four logistics-term columns SCR-WMS-INB-01 §8 also constrains.
const VALID_HANDOVER_POINTS = ['premium_warehouse', 'client_site'] as const;
const VALID_TRANSPORT_BY = ['client', 'premium'] as const;
const VALID_LABOUR_BY = ['client', 'premium', 'shared'] as const;

/** chk_inbound_orders_handover_point: null/undefined (optional, D6) or one of the closed list. */
export function isValidHandoverPoint(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return (VALID_HANDOVER_POINTS as readonly string[]).includes(value);
}

/** chk_inbound_orders_transport_by: null/undefined (optional, D6) or one of the closed list. */
export function isValidTransportBy(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return (VALID_TRANSPORT_BY as readonly string[]).includes(value);
}

/** chk_inbound_orders_labour_by: null/undefined (optional, D6) or one of the closed list. */
export function isValidLabourBy(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return (VALID_LABOUR_BY as readonly string[]).includes(value);
}

/** chk_inbound_orders_labour_count: null/undefined (optional, D6) or >= 0. */
export function isNonNegativeLabourCount(value: number | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return value >= 0;
}
