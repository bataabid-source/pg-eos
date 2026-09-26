// modules/billing/domain/dimensions/errors.ts — WBS 4.1b PART 1 (lane 2).
//
// Typed errors for the `dimensions` use case, part 1 scope: `billing.dimension_types` only
// (SCR-ACC-01 #9, D-190 hybrid design). `billing.line_dimensions` and every value concept
// (UnknownDimensionTypeError from the pre-rescope draft) are part 2's — dropped here entirely.

/** ./invariants.ts's `assertValidDimensionTypeKindSourcePair`: the (kind, sourceTable) pair does
 *  not satisfy the D-190 hybrid-design rule (kind='reference' requires a whitelisted
 *  sourceTable; kind='list' requires sourceTable to be null). Thrown BEFORE any DB write; the
 *  database CHECK constraint on `billing.dimension_types` is the race-safe backstop behind this
 *  pre-check (same discipline as chart-of-accounts/invariants.ts's isValidAccountCode). */
export class InvalidDimensionTypeKindSourcePairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDimensionTypeKindSourcePairError';
  }
}
