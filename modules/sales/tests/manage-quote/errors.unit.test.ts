// modules/sales/tests/manage-quote/errors.unit.test.ts — WBS 1.6, M02 sales.
//
// Mutation-coverage gap fill: no pure test file previously constructed every typed error in
// domain/manage-quote/errors.ts directly. This file constructs EVERY error class, pins its exact
// `name` and `message`, and asserts every class's `name` is distinct from every other's.

import { describe, expect, it } from 'vitest';

import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  EmptyQuoteError,
  IllegalTransitionError,
  InvalidDiscountError,
  InvalidPriceExceptionError,
  InvalidValidUntilError,
  MarginOutOfRangeError,
  MissingActorError,
  QuoteFrozenError,
  QuoteNotFoundError,
  RoleRequiredError,
  ServiceNotFoundError,
  StaleVersionError,
} from '../../domain/manage-quote/errors.js';

describe('manage-quote errors — exact name/message', () => {
  it('AccountNotFoundError', () => {
    const error = new AccountNotFoundError('no account');
    expect(error.name).toBe('AccountNotFoundError');
    expect(error.message).toBe('no account');
  });

  it('AccountNotQualifiedError', () => {
    const error = new AccountNotQualifiedError('not qualified');
    expect(error.name).toBe('AccountNotQualifiedError');
    expect(error.message).toBe('not qualified');
  });

  it('QuoteNotFoundError', () => {
    const error = new QuoteNotFoundError('no quote');
    expect(error.name).toBe('QuoteNotFoundError');
    expect(error.message).toBe('no quote');
  });

  it('QuoteFrozenError', () => {
    const error = new QuoteFrozenError('quote frozen');
    expect(error.name).toBe('QuoteFrozenError');
    expect(error.message).toBe('quote frozen');
  });

  it('StaleVersionError', () => {
    const error = new StaleVersionError('stale version');
    expect(error.name).toBe('StaleVersionError');
    expect(error.message).toBe('stale version');
  });

  it('EmptyQuoteError', () => {
    const error = new EmptyQuoteError('empty quote');
    expect(error.name).toBe('EmptyQuoteError');
    expect(error.message).toBe('empty quote');
  });

  it('RoleRequiredError', () => {
    const error = new RoleRequiredError('role required');
    expect(error.name).toBe('RoleRequiredError');
    expect(error.message).toBe('role required');
  });

  it('InvalidPriceExceptionError', () => {
    const error = new InvalidPriceExceptionError('invalid exception');
    expect(error.name).toBe('InvalidPriceExceptionError');
    expect(error.message).toBe('invalid exception');
  });

  it('InvalidDiscountError', () => {
    const error = new InvalidDiscountError('invalid discount');
    expect(error.name).toBe('InvalidDiscountError');
    expect(error.message).toBe('invalid discount');
  });

  it('ServiceNotFoundError', () => {
    const error = new ServiceNotFoundError('no service');
    expect(error.name).toBe('ServiceNotFoundError');
    expect(error.message).toBe('no service');
  });

  it('IllegalTransitionError', () => {
    const error = new IllegalTransitionError('illegal transition');
    expect(error.name).toBe('IllegalTransitionError');
    expect(error.message).toBe('illegal transition');
  });

  it('MissingActorError', () => {
    const error = new MissingActorError('missing actor');
    expect(error.name).toBe('MissingActorError');
    expect(error.message).toBe('missing actor');
  });

  it('InvalidValidUntilError', () => {
    const error = new InvalidValidUntilError('invalid validUntil');
    expect(error.name).toBe('InvalidValidUntilError');
    expect(error.message).toBe('invalid validUntil');
  });

  it('MarginOutOfRangeError', () => {
    const error = new MarginOutOfRangeError('margin out of range');
    expect(error.name).toBe('MarginOutOfRangeError');
    expect(error.message).toBe('margin out of range');
  });

  it('every error class has a name distinct from every other (no copy-pasted name string)', () => {
    const instances = [
      new AccountNotFoundError('m'),
      new AccountNotQualifiedError('m'),
      new QuoteNotFoundError('m'),
      new QuoteFrozenError('m'),
      new StaleVersionError('m'),
      new EmptyQuoteError('m'),
      new RoleRequiredError('m'),
      new InvalidPriceExceptionError('m'),
      new InvalidDiscountError('m'),
      new ServiceNotFoundError('m'),
      new IllegalTransitionError('m'),
      new MissingActorError('m'),
      new InvalidValidUntilError('m'),
      new MarginOutOfRangeError('m'),
    ];
    const names = instances.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
