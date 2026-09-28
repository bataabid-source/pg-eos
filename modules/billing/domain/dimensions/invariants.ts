// modules/billing/domain/dimensions/invariants.ts — WBS 4.1b PART 1 + PART 2 (lane 2).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random(). Part 1 scope is
// `billing.dimension_types` only (SCR-ACC-01 #9, ADR-0004 D1 6 / D2 (d)): the D-190 hybrid design
// requires a dimension type of kind 'reference' to carry a `source_table` from a closed
// whitelist, and a dimension type of kind 'list' to carry no `source_table` at all. This is
// checked BEFORE any DB write; the database CHECK constraint on `billing.dimension_types` is the
// race-safe backstop behind this pre-check (same discipline as
// modules/billing/domain/chart-of-accounts/invariants.ts's own isValidAccountCode).
//
// Part 2 (below the part-2 marker, migration 0038): the source tables that carry entity_id and the
// pure tag-acceptance rule billing.assert_dimension_value() enforces for both kinds (R1).

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

// --- WBS 4.1b PART 2 — line dimensions ----------------------------------------------------------

/** The subset of DIMENSION_SOURCE_TABLES whose rows carry their own `entity_id` (brief C2): a
 *  reference-kind tag on one of these must point at a row of the line's own entity. The other four
 *  (sales.accounts, partners.partners, imile.shipments, platform.entities) have no entity to scope
 *  against. Mirrors the static branches of billing.assert_dimension_value() (migration 0038). */
export const DIMENSION_SOURCE_TABLES_WITH_ENTITY_ID: readonly string[] = [
  'hr.employees',
  'tms.vehicles',
  'wms.warehouses',
  'platform.sites',
];

export interface DimensionValueTagFacts {
  readonly kind: DimensionTypeKind;
  /** list: a dimension_values row with this id AND this dimension_type_id exists; reference: the
   *  row exists in the type's source_table. */
  readonly valueExistsForType: boolean;
  /** list: dimension_values.is_active; reference: always true (source rows carry no such flag). */
  readonly valueIsActive: boolean;
  /** reference: the type's source_table is one of DIMENSION_SOURCE_TABLES_WITH_ENTITY_ID. */
  readonly sourceHasEntityId: boolean;
  /** reference with an entity-scoped source: the source row's entity_id equals the line's. */
  readonly belongsToLineEntity: boolean;
}

/** The D-190 rule billing.assert_dimension_value() enforces (lane default R1): a tag is acceptable
 *  iff the value exists for the type, is active, and — for a reference kind whose source table has
 *  entity_id — belongs to the line's entity. Pure: no I/O. */
export function isAcceptableDimensionValueTag(facts: DimensionValueTagFacts): boolean {
  const entityScopedReference = facts.kind === 'reference' && facts.sourceHasEntityId;
  return (
    facts.valueExistsForType &&
    facts.valueIsActive &&
    (!entityScopedReference || facts.belongsToLineEntity)
  );
}
