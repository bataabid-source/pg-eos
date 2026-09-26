// modules/sales/tests/manage-contract/errors.unit.test.ts — WBS 1.7, M02 sales.
//
// Mutation-coverage gap fill: no pure test file previously constructed every typed error in
// domain/manage-contract/errors.ts directly. This file constructs EVERY error class, pins its exact
// `name`, exact `message`, every own property (including the ContractStatus-typed ones), and asserts
// every class's `name` is distinct from every other's.

import { describe, expect, it } from 'vitest';

import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  ContractExpiredByDateError,
  ContractNotActiveError,
  ContractNotFoundError,
  ContractNotPriceableError,
  ContractNotYetExpirableError,
  IllegalTransitionError,
  InvalidEndDateError,
  InvalidStartDateError,
  MissingActorError,
  PriceListNotApplicableError,
  RoleRequiredError,
  SlaNotEnabledError,
  StaleVersionError,
} from '../../domain/manage-contract/errors.js';
import { CONTRACT_STATUS } from '../../domain/manage-contract/machine.js';

describe('manage-contract errors — exact name/message/properties', () => {
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

  it('ContractNotFoundError', () => {
    const error = new ContractNotFoundError('no contract');
    expect(error.name).toBe('ContractNotFoundError');
    expect(error.message).toBe('no contract');
  });

  it('ContractNotPriceableError', () => {
    const error = new ContractNotPriceableError('no price list');
    expect(error.name).toBe('ContractNotPriceableError');
    expect(error.message).toBe('no price list');
  });

  it('PriceListNotApplicableError', () => {
    const error = new PriceListNotApplicableError('not applicable');
    expect(error.name).toBe('PriceListNotApplicableError');
    expect(error.message).toBe('not applicable');
  });

  it('ContractNotActiveError carries the exact status it was thrown with, for EVERY status value', () => {
    for (const status of Object.values(CONTRACT_STATUS)) {
      const error = new ContractNotActiveError(`status is ${status}`, status);
      expect(error.name).toBe('ContractNotActiveError');
      expect(error.message).toBe(`status is ${status}`);
      expect(error.status).toBe(status);
    }
  });

  it('ContractExpiredByDateError carries the exact contractId and endDate it was thrown with', () => {
    const error = new ContractExpiredByDateError('expired', 'contract-1', '2025-01-01');
    expect(error.name).toBe('ContractExpiredByDateError');
    expect(error.message).toBe('expired');
    expect(error.contractId).toBe('contract-1');
    expect(error.endDate).toBe('2025-01-01');
  });

  it('ContractNotYetExpirableError', () => {
    const error = new ContractNotYetExpirableError('not yet expirable');
    expect(error.name).toBe('ContractNotYetExpirableError');
    expect(error.message).toBe('not yet expirable');
  });

  it('SlaNotEnabledError', () => {
    const error = new SlaNotEnabledError('sla not enabled');
    expect(error.name).toBe('SlaNotEnabledError');
    expect(error.message).toBe('sla not enabled');
  });

  it('StaleVersionError', () => {
    const error = new StaleVersionError('stale version');
    expect(error.name).toBe('StaleVersionError');
    expect(error.message).toBe('stale version');
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

  it('InvalidStartDateError', () => {
    const error = new InvalidStartDateError('invalid start date');
    expect(error.name).toBe('InvalidStartDateError');
    expect(error.message).toBe('invalid start date');
  });

  it('InvalidEndDateError', () => {
    const error = new InvalidEndDateError('invalid end date');
    expect(error.name).toBe('InvalidEndDateError');
    expect(error.message).toBe('invalid end date');
  });

  it('RoleRequiredError', () => {
    const error = new RoleRequiredError('role required');
    expect(error.name).toBe('RoleRequiredError');
    expect(error.message).toBe('role required');
  });

  it('every error class has a name distinct from every other (no copy-pasted name string)', () => {
    const instances = [
      new AccountNotFoundError('m'),
      new AccountNotQualifiedError('m'),
      new ContractNotFoundError('m'),
      new ContractNotPriceableError('m'),
      new PriceListNotApplicableError('m'),
      new ContractNotActiveError('m', CONTRACT_STATUS.DRAFT),
      new ContractExpiredByDateError('m', 'c', 'd'),
      new ContractNotYetExpirableError('m'),
      new SlaNotEnabledError('m'),
      new StaleVersionError('m'),
      new IllegalTransitionError('m'),
      new MissingActorError('m'),
      new InvalidStartDateError('m'),
      new InvalidEndDateError('m'),
      new RoleRequiredError('m'),
    ];
    const names = instances.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
