// modules/billing/tests/accounting-periods/errors.unit.test.ts — domain unit tests for
// modules/billing/domain/accounting-periods/errors.ts (WBS 4.19, lane 2; Stryker mutation gate,
// doc 40 Part F G16).
//
// Pure, no DB, no I/O. Constructs EVERY error class this slice's application layer throws
// (../../application/accounting-periods/*, see ./accounting-periods.test.ts and
// ./period-machine.unit.test.ts for where each one is raised) and pins `.name` (exact string),
// `.message` (exact pass-through, including the empty string), `instanceof Error`, and name
// uniqueness across the file — same discipline as
// modules/billing/tests/dimensions/line-dimensions.test.ts's own error surface.

import { describe, expect, it } from 'vitest';

import {
  EntityNotInScopeError,
  FiscalYearNotFoundError,
  FiscalYearOverlapError,
  IllegalPeriodTransitionError,
  MissingActorError,
  PeriodNotFoundError,
  PeriodOutsideFiscalYearError,
  PeriodOverlapError,
  RoleRequiredError,
  SelfApprovalNotAllowedError,
  StaleVersionError,
} from '../../domain/accounting-periods/errors.js';

const cases: ReadonlyArray<{ readonly ctor: new (message: string) => Error; readonly name: string }> = [
  { ctor: StaleVersionError, name: 'StaleVersionError' },
  { ctor: RoleRequiredError, name: 'RoleRequiredError' },
  { ctor: MissingActorError, name: 'MissingActorError' },
  { ctor: IllegalPeriodTransitionError, name: 'IllegalPeriodTransitionError' },
  { ctor: PeriodNotFoundError, name: 'PeriodNotFoundError' },
  { ctor: FiscalYearNotFoundError, name: 'FiscalYearNotFoundError' },
  { ctor: SelfApprovalNotAllowedError, name: 'SelfApprovalNotAllowedError' },
  // Close review round 1 (VERIFY) finding (c): the four new typed structural errors.
  { ctor: FiscalYearOverlapError, name: 'FiscalYearOverlapError' },
  { ctor: PeriodOverlapError, name: 'PeriodOverlapError' },
  { ctor: PeriodOutsideFiscalYearError, name: 'PeriodOutsideFiscalYearError' },
  { ctor: EntityNotInScopeError, name: 'EntityNotInScopeError' },
];

describe('accounting-periods errors — name, message, instanceof', () => {
  it.each(cases)('$name carries the exact name and the exact message given', ({ ctor, name }) => {
    const err = new ctor('a distinctive message for ' + name);
    expect(err.name).toBe(name);
    expect(err.message).toBe('a distinctive message for ' + name);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ctor);
  });

  it.each(cases)('$name carries the empty-string message unchanged', ({ ctor, name }) => {
    const err = new ctor('');
    expect(err.name).toBe(name);
    expect(err.message).toBe('');
  });

  it('every name above is unique (no copy/paste collision)', () => {
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(11);
  });
});
