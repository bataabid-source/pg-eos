// modules/billing/domain/dimensions/invariants.ts — WBS 4.1b PART 1 (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). Part 1 scope is
// `billing.dimension_types` only (SCR-ACC-01 #9, ADR-0004 D1 6 / D2 (d)): the D-190 hybrid design
// requires a dimension type of kind 'reference' to carry a `source_table` from a closed
// whitelist, and a dimension type of kind 'list' to carry no `source_table` at all. This is
// checked BEFORE any DB write; the database CHECK constraint on `billing.dimension_types` is the
// race-safe backstop behind this pre-check (same discipline as
// modules/billing/domain/chart-of-accounts/invariants.ts's own isValidAccountCode).
//
// `billing.line_dimensions` and every value concept (the pre-rescope draft's
// isKnownDimensionType/assertKnownDimensionType/UnknownDimensionTypeError) are part 2's job, once
// line_dimensions exists — dropped from this surface entirely.

import { InvalidDimensionTypeKindSourcePairError } from './errors.js';

export type DimensionTypeKind = 'list' | 'reference';

/** The closed whitelist of tables a 'reference'-kind dimension type may point at (D-190 hybrid
 *  design, Schema design — part 1, brief — verbatim). */
export const DIMENSION_SOURCE_TABLES: readonly string[] = [
  'sales.accounts',
  'partners.partners',
  'hr.employees',
  'tms.vehicles',
  'wms.warehouses',
  'platform.sites',
  'imile.shipments',
  'platform.entities',
];

/** True iff `(kind, sourceTable)` satisfies the D-190 hybrid-design rule:
 *  - kind = 'reference' => sourceTable is non-null AND a member of DIMENSION_SOURCE_TABLES.
 *  - kind = 'list' => sourceTable is null. */
export function isValidDimensionTypeKindSourcePair(
  kind: DimensionTypeKind,
  sourceTable: string | null,
): boolean {
  if (kind === 'reference') {
    return sourceTable !== null && DIMENSION_SOURCE_TABLES.includes(sourceTable);
  }
  return sourceTable === null;
}

/** Throws `InvalidDimensionTypeKindSourcePairError` iff
 *  `!isValidDimensionTypeKindSourcePair(kind, sourceTable)`. Checked BEFORE any DB write — never
 *  relies on the DB's own CHECK-constraint error alone. */
export function assertValidDimensionTypeKindSourcePair(
  kind: DimensionTypeKind,
  sourceTable: string | null,
): void {
  if (!isValidDimensionTypeKindSourcePair(kind, sourceTable)) {
    throw new InvalidDimensionTypeKindSourcePairError(
      `(kind: ${kind}, sourceTable: ${sourceTable === null ? 'null' : sourceTable}) does not ` +
        `satisfy the D-190 hybrid-design rule (kind='reference' requires a sourceTable from the ` +
        `closed whitelist; kind='list' requires sourceTable to be null). (Allowed: ` +
        `${DIMENSION_SOURCE_TABLES.join(', ')} for kind='reference', or null for kind='list')`,
    );
  }
}
