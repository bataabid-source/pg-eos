// modules/billing/tests/post-journal/errors.unit.test.ts — WBS 4.20 (lane 2), domain unit tests for
// modules/billing/domain/post-journal/errors.ts. Pure, no DB. Same discipline as
// ../accounting-periods/errors.unit.test.ts: `.name` (exact), `.message` (exact pass-through, incl. ''),
// instanceof Error, name uniqueness.
//
// Error classes the builder must export (each `constructor(message: string)`, `name` = class name):
//   StaleVersionError, MissingActorError, JournalEntryNotFoundError, UnbalancedEntryError,
//   InsufficientLinesError, AccountNotInEntityError, AccountNotPostableError,
//   ManualRevenueJournalRefusedError, ManualJournalApprovalRequiredError, AlreadyReversedError,
//   EntityNotInScopeError, PeriodNotOpenError, IllegalJournalTransitionError.

import { describe, expect, it } from 'vitest';

import {
  AccountNotInEntityError,
  AccountNotPostableError,
  AlreadyReversedError,
  EntityNotInScopeError,
  IllegalJournalTransitionError,
  InsufficientLinesError,
  JournalEntryNotFoundError,
  ManualJournalApprovalRequiredError,
  ManualRevenueJournalRefusedError,
  MissingActorError,
  PeriodNotOpenError,
  StaleVersionError,
  UnbalancedEntryError,
} from '../../domain/post-journal/errors.js';

const cases: ReadonlyArray<{ readonly ctor: new (message: string) => Error; readonly name: string }> = [
  { ctor: StaleVersionError, name: 'StaleVersionError' },
  { ctor: MissingActorError, name: 'MissingActorError' },
  { ctor: JournalEntryNotFoundError, name: 'JournalEntryNotFoundError' },
  { ctor: UnbalancedEntryError, name: 'UnbalancedEntryError' },
  { ctor: InsufficientLinesError, name: 'InsufficientLinesError' },
  { ctor: AccountNotInEntityError, name: 'AccountNotInEntityError' },
  { ctor: AccountNotPostableError, name: 'AccountNotPostableError' },
  { ctor: ManualRevenueJournalRefusedError, name: 'ManualRevenueJournalRefusedError' },
  { ctor: ManualJournalApprovalRequiredError, name: 'ManualJournalApprovalRequiredError' },
  { ctor: AlreadyReversedError, name: 'AlreadyReversedError' },
  { ctor: EntityNotInScopeError, name: 'EntityNotInScopeError' },
  { ctor: PeriodNotOpenError, name: 'PeriodNotOpenError' },
  { ctor: IllegalJournalTransitionError, name: 'IllegalJournalTransitionError' },
];

describe('post-journal errors — name, message, instanceof', () => {
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
    const names = cases.map((c) => new c.ctor('').name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(13);
  });
});
