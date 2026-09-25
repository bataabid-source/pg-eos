// modules/imile/domain/pull-shipments/invariants.ts — WBS 3.14 (part 2).
//
// domain/ layer: pure functions only — no I/O, no Date.now()/new Date(), no Math.random()
// (CLAUDE.md · AGENT CONSTRAINTS). The application layer
// (../../application/pull-shipments/pull-shipments.ts) calls these for every portal record BEFORE
// any DB write. pg-tester's property tests exercise these directly
// (../../tests/pull-shipments/invariants.property.test.ts).

/** One shipment record as reported by the iMile portal. Field shapes derive from
 *  `imile.shipments` (database/schema/01-Data-Model.sql:1315-1339) — never a column not on that
 *  table (brief, Contract line). Every field beyond `tracking_no` is optional/nullable: the
 *  portal payload is untrusted external data until `validatePortalRecord` below normalizes it. */
export interface PortalShipmentRecord {
  readonly tracking_no: string;
  readonly merchant?: string | null;
  readonly zone_code?: string | null;
  readonly area?: string | null;
  readonly recipient_phone?: string | null;
  readonly is_cod?: boolean | null;
  readonly cod_amount?: string | null;
  readonly is_fresh?: boolean | null;
  readonly imile_status?: string | null;
  readonly raw?: unknown;
}

/** The iMile-sourced columns this use case is allowed to write (brief, Contract line and Key
 *  design points: "NEVER touch internal_status/cage_code/driver_code/delivery_task_id"). Shared
 *  by `iMileFieldsChanged` below and by the application layer when it builds an update payload. */
export const IMILE_SOURCED_FIELD_KEYS = [
  'merchant',
  'zone_code',
  'area',
  'recipient_phone',
  'is_cod',
  'cod_amount',
  'is_fresh',
  'imile_status',
] as const;

export type IMileSourcedFieldKey = (typeof IMILE_SOURCED_FIELD_KEYS)[number];
export type IMileSourcedFields = Pick<PortalShipmentRecord, IMileSourcedFieldKey>;

// imile.shipments.is_fresh is `boolean not null default false` — unlike every other iMile-sourced
// column here, it has NO null state in the database. A portal record that omits is_fresh must
// therefore normalize to `false`, never to `null` — comparing it as `null` against a stored `false`
// would read as "changed" on every single pull cycle for such a row (reviewer finding 4,
// 2026-09-25). ../../application/pull-shipments/pull-shipments.ts uses this same constant when it
// builds both sides of the comparison AND the DB write payload.
export const IS_FRESH_DEFAULT = false;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Validates one raw portal record. Returns null iff `raw` is not an object, or its `tracking_no`
 *  is missing/not a non-empty string — a malformed record is data, not a crash (brief, Scenario
 *  "A malformed portal record is skipped, not fatal"). Never throws for ANY input, including
 *  primitives, null, arrays and garbage objects. */
export function validatePortalRecord(raw: unknown): PortalShipmentRecord | null {
  if (!isPlainObject(raw)) return null;
  const trackingNo = raw['tracking_no'];
  if (!isNonEmptyString(trackingNo)) return null;

  return {
    tracking_no: trackingNo,
    merchant: asStringOrNull(raw['merchant']),
    zone_code: asStringOrNull(raw['zone_code']),
    area: asStringOrNull(raw['area']),
    recipient_phone: asStringOrNull(raw['recipient_phone']),
    is_cod: asBooleanOrNull(raw['is_cod']),
    cod_amount: asStringOrNull(raw['cod_amount']),
    is_fresh: asBooleanOrNull(raw['is_fresh']),
    imile_status: asStringOrNull(raw['imile_status']),
    raw: raw['raw'],
  };
}

/** The subset of IMILE_SOURCED_FIELD_KEYS that actually differ between the locally-known row and
 *  the freshly-validated portal record — used by
 *  ../../application/pull-shipments/pull-shipments.ts to narrow the update's before/after audit
 *  row to genuinely changed fields only (reviewer finding 3, round 2, 2026-09-25: the audit row
 *  must not claim "only ... changed" while actually carrying the whole 8-field bag). `is_fresh`
 *  normalizes missing/null to `false` on both sides (IS_FRESH_DEFAULT) — it is
 *  `boolean not null default false` in the database, so `null` is never a real state for it
 *  (reviewer finding 4). Every other field normalizes missing/null to `null` — nullable columns,
 *  so "no value" on either side compares equal. */
export function iMileChangedFieldKeys(
  existing: IMileSourcedFields,
  incoming: IMileSourcedFields,
): readonly IMileSourcedFieldKey[] {
  return IMILE_SOURCED_FIELD_KEYS.filter((key) => {
    if (key === 'is_fresh') {
      return (existing.is_fresh ?? IS_FRESH_DEFAULT) !== (incoming.is_fresh ?? IS_FRESH_DEFAULT);
    }
    return (existing[key] ?? null) !== (incoming[key] ?? null);
  });
}

/** True iff at least one iMile-sourced field (IMILE_SOURCED_FIELD_KEYS) differs between the
 *  locally-known row and the freshly-validated portal record. Never inspects internal_status,
 *  cage_code, driver_code or delivery_task_id — those are not iMile-sourced (brief, Contract
 *  line). Delegates to `iMileChangedFieldKeys` so the two never drift apart. */
export function iMileFieldsChanged(existing: IMileSourcedFields, incoming: IMileSourcedFields): boolean {
  return iMileChangedFieldKeys(existing, incoming).length > 0;
}
