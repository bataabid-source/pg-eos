// modules/billing/tests/dimensions/invariants.unit.test.ts — WBS 4.1b PART 1 (lane 2).
//
// Round-2 review finding 9: pure domain-layer unit tests — no DB, no I/O — for the surface no
// other test file in this module exercises DIRECTLY: `assertValidDimensionTypeKindSourcePair`
// (both accept and throw paths) and that the thrown `InvalidDimensionTypeKindSourcePairError`
// actually states what's allowed in its `.message`. Until this file, only DB-backed integration
// tests (./dimensions.test.ts, ./invariants.property.test.ts) exercised the concept indirectly,
// through the isValidDimensionTypeKindSourcePair boolean and live INSERTs — never the assert/throw
// function itself, and never the error message's own content.
//
// Precedent: modules/billing/tests/chart-of-accounts/invariants.unit.test.ts (same shape, same
// module, WBS 4.1a). These tests need no Postgres connection at all.
//
// STATUS: `modules/billing/domain/dimensions/invariants.ts` and `./errors.ts` exist and are GREEN
// — this file's assertions exercise real domain code directly, no DB connection required. (History:
// this file's domain layer landed ahead of migration 0030_2_dimensions.sql for part 1; that
// migration is now applied, and dimensions.test.ts / invariants.property.test.ts, which ARE
// DB-integration, are GREEN too — see their own headers.)

import { describe, expect, it } from 'vitest';

import {
  DIMENSION_SOURCE_TABLES,
  assertValidDimensionTypeKindSourcePair,
} from '../../domain/dimensions/invariants.js';
import { InvalidDimensionTypeKindSourcePairError } from '../../domain/dimensions/errors.js';

const UNWHITELISTED_SOURCE_TABLE = 'not_a_real_schema.not_a_real_table';

describe('assertValidDimensionTypeKindSourcePair — valid pairs do not throw', () => {
  it.each(DIMENSION_SOURCE_TABLES)(
    'does not throw for kind = reference, source_table = %s (whitelisted)',
    (sourceTable) => {
      expect(() => assertValidDimensionTypeKindSourcePair('reference', sourceTable)).not.toThrow();
    },
  );

  it('does not throw for kind = list, source_table = null', () => {
    expect(() => assertValidDimensionTypeKindSourcePair('list', null)).not.toThrow();
  });
});

describe('assertValidDimensionTypeKindSourcePair — invalid pairs throw InvalidDimensionTypeKindSourcePairError', () => {
  it('throws for kind = reference, source_table = null', () => {
    expect(() => assertValidDimensionTypeKindSourcePair('reference', null)).toThrow(
      InvalidDimensionTypeKindSourcePairError,
    );
  });

  it('throws for kind = reference, source_table = an unwhitelisted value', () => {
    expect(() =>
      assertValidDimensionTypeKindSourcePair('reference', UNWHITELISTED_SOURCE_TABLE),
    ).toThrow(InvalidDimensionTypeKindSourcePairError);
  });

  it('throws for kind = list, source_table = a non-null value', () => {
    expect(() =>
      assertValidDimensionTypeKindSourcePair('list', DIMENSION_SOURCE_TABLES[0] ?? 'sales.accounts'),
    ).toThrow(InvalidDimensionTypeKindSourcePairError);
  });

  it('the thrown error is a genuine Error with its own name, a non-empty message, and states every allowed source_table plus the list/null rule', () => {
    let caught: unknown;
    try {
      assertValidDimensionTypeKindSourcePair('reference', null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(InvalidDimensionTypeKindSourcePairError);
    const asError = caught as InvalidDimensionTypeKindSourcePairError;
    expect(asError.name).toBe('InvalidDimensionTypeKindSourcePairError');
    expect(asError.message.length).toBeGreaterThan(0);

    // The message must state what IS allowed — every whitelisted source_table for kind='reference'
    // and the kind='list' => null rule — not just what was rejected.
    for (const sourceTable of DIMENSION_SOURCE_TABLES) {
      expect(asError.message).toContain(sourceTable);
    }
    expect(asError.message).toContain('reference');
    expect(asError.message).toContain('list');
    expect(asError.message).toContain('null');
  });
});
