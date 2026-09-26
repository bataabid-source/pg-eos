// modules/catalog/tests/maintain-price-list/tier-ladder.unit.test.ts — WBS 1.2, M03 catalog.
//
// Deterministic boundary unit tests for validateTierLadder (INV-C1-3), added alongside
// tier-ladder.property.test.ts to raise Stryker's mutation score on tier-ladder.ts. Targets exact
// comparison boundaries (`>` vs `>=`, `===` vs `!==`), exact error-message substrings (string
// literal mutants), and branches the property tests exercise only probabilistically (empty input,
// zero-width tier, a non-last null tierTo, exact duplicate-count messages). Pure, no I/O.

import { describe, expect, it } from 'vitest';

import { validateTierLadder } from '../../domain/maintain-price-list/tier-ladder.js';
import { TierLadderError } from '../../domain/maintain-price-list/errors.js';

const ZERO = '0.000';

describe('validateTierLadder — empty input', () => {
  it('an empty lines array never throws (no groups to validate)', () => {
    expect(() => validateTierLadder([])).not.toThrow();
  });
});

describe('validateTierLadder — zero-width tier boundary (tierTo === tierFrom)', () => {
  it('throws when a tier`s tierTo equals its own tierFrom (not strictly greater)', () => {
    const serviceId = 'svc-zero-width';
    const lines = [{ serviceId, tierFrom: ZERO, tierTo: ZERO, freeUnits: ZERO }];
    expect(() => validateTierLadder(lines)).toThrow(TierLadderError);
    expect(() => validateTierLadder(lines)).toThrow(/not strictly greater than tierFrom/);
  });

  it('does NOT throw for the same boundary check when tierTo is exactly one unit greater', () => {
    const serviceId = 'svc-one-greater';
    const lines = [{ serviceId, tierFrom: ZERO, tierTo: '1.000', freeUnits: ZERO }];
    expect(() => validateTierLadder(lines)).not.toThrow();
  });
});

describe('validateTierLadder — a non-last tier with a null tierTo throws, by exact message', () => {
  it('a null tierTo on the FIRST of two tiers throws "only the LAST tier"', () => {
    const serviceId = 'svc-early-null';
    const lines = [
      { serviceId, tierFrom: ZERO, tierTo: null, freeUnits: ZERO },
      { serviceId, tierFrom: '50.000', tierTo: null, freeUnits: ZERO },
    ];
    expect(() => validateTierLadder(lines)).toThrow(TierLadderError);
    expect(() => validateTierLadder(lines)).toThrow(/only the LAST tier may have a null tierTo/);
  });
});

describe('validateTierLadder — exact error-message substrings for every violation kind', () => {
  it('non-zero start throws "must start at 0"', () => {
    const serviceId = 'svc-nonzero-start';
    const lines = [{ serviceId, tierFrom: '5.000', tierTo: null, freeUnits: ZERO }];
    expect(() => validateTierLadder(lines)).toThrow(/the first tier must start at 0/);
  });

  it('gap between tiers throws "no gap, no overlap"', () => {
    const serviceId = 'svc-gap';
    const lines = [
      { serviceId, tierFrom: ZERO, tierTo: '100.000', freeUnits: ZERO },
      { serviceId, tierFrom: '150.000', tierTo: null, freeUnits: ZERO },
    ];
    expect(() => validateTierLadder(lines)).toThrow(/no gap, no overlap/);
  });

  it('overlap between tiers also throws "no gap, no overlap" (same code path as gap)', () => {
    const serviceId = 'svc-overlap';
    const lines = [
      { serviceId, tierFrom: ZERO, tierTo: '100.000', freeUnits: ZERO },
      { serviceId, tierFrom: '50.000', tierTo: null, freeUnits: ZERO },
    ];
    expect(() => validateTierLadder(lines)).toThrow(/no gap, no overlap/);
  });

  it('duplicate tierFrom within one service throws "duplicate tierFrom"', () => {
    const serviceId = 'svc-dup';
    const lines = [
      { serviceId, tierFrom: ZERO, tierTo: '100.000', freeUnits: ZERO },
      { serviceId, tierFrom: ZERO, tierTo: '200.000', freeUnits: ZERO },
    ];
    expect(() => validateTierLadder(lines)).toThrow(/duplicate tierFrom/);
  });

  it('mixing a flat line with tiered lines throws "flat line" with the exact flat/total counts', () => {
    const serviceId = 'svc-mix';
    const lines = [
      { serviceId, tierFrom: null, tierTo: null, freeUnits: ZERO },
      { serviceId, tierFrom: ZERO, tierTo: '100.000', freeUnits: ZERO },
      { serviceId, tierFrom: '100.000', tierTo: null, freeUnits: ZERO },
    ];
    // 1 flat line among 3 total lines — pins the exact interpolated counts (arithmetic mutants).
    expect(() => validateTierLadder(lines)).toThrow(/found 1 flat line\(s\) among 3 total/);
  });

  it('two flat lines among three total lines pins the exact counts (2 flat / 3 total)', () => {
    const serviceId = 'svc-mix2';
    const lines = [
      { serviceId, tierFrom: null, tierTo: null, freeUnits: ZERO },
      { serviceId, tierFrom: null, tierTo: null, freeUnits: ZERO },
      { serviceId, tierFrom: ZERO, tierTo: null, freeUnits: ZERO },
    ];
    expect(() => validateTierLadder(lines)).toThrow(/found 2 flat line\(s\) among 3 total/);
  });

  it('negative freeUnits throws "freeUnits must be >= 0" naming the exact serviceId and value', () => {
    const serviceId = 'svc-negative';
    const lines = [{ serviceId, tierFrom: null, tierTo: null, freeUnits: '-1.000' }];
    expect(() => validateTierLadder(lines)).toThrow(/service svc-negative: freeUnits must be >= 0/);
    expect(() => validateTierLadder(lines)).toThrow(/got -1\.000/);
  });

  it('freeUnits of exactly 0 never throws (the boundary itself is acceptable)', () => {
    const serviceId = 'svc-zero-free';
    const lines = [{ serviceId, tierFrom: null, tierTo: null, freeUnits: ZERO }];
    expect(() => validateTierLadder(lines)).not.toThrow();
  });
});

describe('validateTierLadder — a single tiered (non-flat) line starting at 0 with null tierTo passes', () => {
  it('one tier, tierFrom 0, tierTo null — a valid single-tier ladder', () => {
    const serviceId = 'svc-single-tier';
    const lines = [{ serviceId, tierFrom: ZERO, tierTo: null, freeUnits: ZERO }];
    expect(() => validateTierLadder(lines)).not.toThrow();
  });
});

describe('validateTierLadder — a line with tierFrom null but tierTo NOT null is neither flat nor tiered', () => {
  it('throws "every tiered line must have a non-null tierFrom"', () => {
    const serviceId = 'svc-partial-null';
    const lines = [
      { serviceId, tierFrom: null, tierTo: '100.000', freeUnits: ZERO },
      { serviceId, tierFrom: '100.000', tierTo: null, freeUnits: ZERO },
    ];
    expect(() => validateTierLadder(lines)).toThrow(/every tiered line must have a non-null tierFrom/);
  });
});

describe('validateTierLadder — groups are keyed by serviceId, not merged across services', () => {
  it('the SAME tierFrom value is legal when it belongs to two DIFFERENT services', () => {
    const lines = [
      { serviceId: 'svc-A', tierFrom: ZERO, tierTo: null, freeUnits: ZERO },
      { serviceId: 'svc-B', tierFrom: ZERO, tierTo: null, freeUnits: ZERO },
    ];
    expect(() => validateTierLadder(lines)).not.toThrow();
  });
});
