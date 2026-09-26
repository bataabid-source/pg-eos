// modules/sales/tests/manage-account-credit/errors.unit.test.ts — WBS 1.8, M02 sales.
//
// Mutation-coverage gap fill: no pure test file previously constructed every typed error in
// domain/manage-account-credit/errors.ts directly — StringLiteral/property mutants there survived.
// This file constructs EVERY error class, pins its exact `name`, exact `message` (including
// interpolation of falsy values like an empty-string reason), every own property, and asserts every
// class's `name` is distinct from every other's (a mutant that copy-pastes one class's `name` string
// onto another is caught here, not by an incidental `instanceof` check elsewhere).

import { describe, expect, it } from 'vitest';

import {
  AccountNotFoundError,
  AccountOnCreditHoldError,
  InvalidCreditLimitError,
  InvalidReasonError,
  MissingActorError,
  NotOnHoldError,
  RoleRequiredError,
  StaleVersionError,
} from '../../domain/manage-account-credit/errors.js';

describe('manage-account-credit errors — exact name/message/properties', () => {
  it('AccountNotFoundError', () => {
    const error = new AccountNotFoundError('no sales.accounts row visible');
    expect(error.name).toBe('AccountNotFoundError');
    expect(error.message).toBe('no sales.accounts row visible');
    expect(error).toBeInstanceOf(Error);
  });

  it('AccountOnCreditHoldError — carries accountId and reason exactly, including an EMPTY-STRING reason', () => {
    const error = new AccountOnCreditHoldError('on hold', 'acct-1', 'overdue invoice');
    expect(error.name).toBe('AccountOnCreditHoldError');
    expect(error.message).toBe('on hold');
    expect(error.accountId).toBe('acct-1');
    expect(error.reason).toBe('overdue invoice');

    // Falsy-but-legal value: reason === '' must round-trip as '', never coerced to undefined/null.
    const withEmptyReason = new AccountOnCreditHoldError('on hold', 'acct-2', '');
    expect(withEmptyReason.reason).toBe('');
    expect(withEmptyReason.accountId).toBe('acct-2');
  });

  it('NotOnHoldError', () => {
    const error = new NotOnHoldError('not on hold');
    expect(error.name).toBe('NotOnHoldError');
    expect(error.message).toBe('not on hold');
  });

  it('RoleRequiredError', () => {
    const error = new RoleRequiredError('CFO role required');
    expect(error.name).toBe('RoleRequiredError');
    expect(error.message).toBe('CFO role required');
  });

  it('StaleVersionError', () => {
    const error = new StaleVersionError('version mismatch');
    expect(error.name).toBe('StaleVersionError');
    expect(error.message).toBe('version mismatch');
  });

  it('MissingActorError', () => {
    const error = new MissingActorError('actor missing');
    expect(error.name).toBe('MissingActorError');
    expect(error.message).toBe('actor missing');
  });

  it('InvalidReasonError', () => {
    const error = new InvalidReasonError('reason must be a non-empty, non-whitespace-only string.');
    expect(error.name).toBe('InvalidReasonError');
    expect(error.message).toBe('reason must be a non-empty, non-whitespace-only string.');
  });

  it('InvalidCreditLimitError', () => {
    const error = new InvalidCreditLimitError('creditLimit must be non-negative');
    expect(error.name).toBe('InvalidCreditLimitError');
    expect(error.message).toBe('creditLimit must be non-negative');
  });

  it('every error class has a name distinct from every other (no copy-pasted name string)', () => {
    const instances = [
      new AccountNotFoundError('m'),
      new AccountOnCreditHoldError('m', 'a', 'r'),
      new NotOnHoldError('m'),
      new RoleRequiredError('m'),
      new StaleVersionError('m'),
      new MissingActorError('m'),
      new InvalidReasonError('m'),
      new InvalidCreditLimitError('m'),
    ];
    const names = instances.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
