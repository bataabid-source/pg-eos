// modules/billing/domain/dimensions/errors.ts — WBS 4.1b PART 1 + PART 2 (lane 2).
//
// Typed errors for the `dimensions` use case (SCR-ACC-01 #9, D-190 hybrid design). Part 1:
// `billing.dimension_types`. Part 2 (below the part-2 marker): the dimension-value write path
// (migration 0038) — stale version, not found, illegal transition, missing actor.

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

// --- WBS 4.1b PART 2 — dimension values (list kind) -------------------------------------------

/** A write command was called without `ctx.userId` — every write names its actor (audit row,
 *  outbox actor_id). */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** DeactivateDimensionValue: the caller's `expectedVersion` no longer matches the locked row's
 *  `version` (optimistic lock). Exposes both numbers so the caller can re-read and retry. */
export class StaleVersionError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(message: string, expectedVersion: number, actualVersion: number) {
    super(message);
    this.name = 'StaleVersionError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** No `billing.dimension_values` row is visible to the caller for this id — it does not exist, or
 *  RLS (entity_scope) hides it from a caller scoped to another entity. */
export class DimensionValueNotFoundError extends Error {
  readonly dimensionValueId: string;

  constructor(message: string, dimensionValueId: string) {
    super(message);
    this.name = 'DimensionValueNotFoundError';
    this.dimensionValueId = dimensionValueId;
  }
}

/** ./machine.ts refused the requested event from the value's current status (e.g. DEACTIVATE on an
 *  already inactive value). The message names the FROM state and the allowed events. */
export class IllegalDimensionValueTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalDimensionValueTransitionError';
  }
}
