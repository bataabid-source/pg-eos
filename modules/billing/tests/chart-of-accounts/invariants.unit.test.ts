// modules/billing/tests/chart-of-accounts/invariants.unit.test.ts — WBS 4.1a (lane 2).
//
// Round-1 review finding 6: pure domain-layer unit tests — no DB, no I/O — for the surface no
// other test file in this module exercises directly: `assertValidAccountCode` (both accept and
// throw paths), `assertValidAccountType` (both accept and throw paths), the reject/throw branch of
// `accountClassFromCode` (a malformed code throws `InvalidAccountCodeError` rather than returning a
// value), and that `InvalidAccountCodeError`/`InvalidAccountTypeError` are thrown with the right
// type/shape (instanceof Error, `.name` set, non-empty `.message`).
//
// These tests need no Postgres connection at all — the domain layer is already built
// (modules/billing/domain/chart-of-accounts/{invariants,errors}.ts) — so every test in this file is
// GREEN independent of the DB-integration CHECK-constraint tests elsewhere in this module.

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_ACCOUNT_TYPES,
  accountClassFromCode,
  assertValidAccountCode,
  assertValidAccountType,
  isValidAccountCode,
} from '../../domain/chart-of-accounts/invariants.js';
import { InvalidAccountCodeError, InvalidAccountTypeError } from '../../domain/chart-of-accounts/errors.js';

const WELL_FORMED_CODE = '1-01-001-001'; // class 1, matches chart-of-accounts.test.ts's own VALID_CODE.
const MALFORMED_CODE = '1-1-001-001'; // second segment 1 digit, not 2 — one of chart-of-accounts.test.ts's own OFF_FORMAT_CODES.
const OUT_OF_CLASS_CODE = '0-01-001-001'; // first segment 0, outside 1-9.
const VALID_ACCOUNT_TYPE = 'asset';
const INVALID_ACCOUNT_TYPE = '_not_a_real_account_type_wbs_4_1a'; // matches chart-of-accounts.test.ts's own OUT_OF_LIST_ACCOUNT_TYPE.

describe('assertValidAccountCode', () => {
  it('does not throw for a well-formed X-XX-XXX-XXX code with class 1-9', () => {
    expect(() => assertValidAccountCode(WELL_FORMED_CODE)).not.toThrow();
  });

  it('throws InvalidAccountCodeError for a code that does not match the X-XX-XXX-XXX shape', () => {
    expect(() => assertValidAccountCode(MALFORMED_CODE)).toThrow(InvalidAccountCodeError);
  });

  it('throws InvalidAccountCodeError for a code whose first segment is outside class 1-9', () => {
    expect(() => assertValidAccountCode(OUT_OF_CLASS_CODE)).toThrow(InvalidAccountCodeError);
  });

  it('the thrown InvalidAccountCodeError is a genuine Error with its own name and a non-empty message', () => {
    let caught: unknown;
    try {
      assertValidAccountCode(MALFORMED_CODE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(InvalidAccountCodeError);
    const asError = caught as InvalidAccountCodeError;
    expect(asError.name).toBe('InvalidAccountCodeError');
    expect(asError.message.length).toBeGreaterThan(0);
    expect(asError.message).toContain(MALFORMED_CODE);
  });
});

describe('assertValidAccountType', () => {
  it.each(ALLOWED_ACCOUNT_TYPES)('does not throw for the allowed account_type %s', (accountType) => {
    expect(() => assertValidAccountType(accountType)).not.toThrow();
  });

  it('throws InvalidAccountTypeError for an account_type not in ALLOWED_ACCOUNT_TYPES', () => {
    expect(() => assertValidAccountType(INVALID_ACCOUNT_TYPE)).toThrow(InvalidAccountTypeError);
  });

  it('the thrown InvalidAccountTypeError is a genuine Error with its own name and a non-empty message', () => {
    let caught: unknown;
    try {
      assertValidAccountType(INVALID_ACCOUNT_TYPE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(InvalidAccountTypeError);
    const asError = caught as InvalidAccountTypeError;
    expect(asError.name).toBe('InvalidAccountTypeError');
    expect(asError.message.length).toBeGreaterThan(0);
    expect(asError.message).toContain(INVALID_ACCOUNT_TYPE);
  });

  it('does not throw for VALID_ACCOUNT_TYPE (sanity check, matches the DB-integration fixture literal)', () => {
    expect(() => assertValidAccountType(VALID_ACCOUNT_TYPE)).not.toThrow();
  });
});

describe('accountClassFromCode — reject/throw branch', () => {
  it('returns the first segment as a number for a well-formed code', () => {
    expect(accountClassFromCode(WELL_FORMED_CODE)).toBe(1);
  });

  it('throws InvalidAccountCodeError for a malformed code, rather than returning a value', () => {
    expect(() => accountClassFromCode(MALFORMED_CODE)).toThrow(InvalidAccountCodeError);
  });

  it('throws InvalidAccountCodeError for a code whose first segment is outside class 1-9', () => {
    expect(() => accountClassFromCode(OUT_OF_CLASS_CODE)).toThrow(InvalidAccountCodeError);
  });

  it('throws InvalidAccountCodeError for a code with no hyphens at all', () => {
    expect(() => accountClassFromCode('101001001')).toThrow(InvalidAccountCodeError);
  });

  it('the thrown error is a genuine Error with its own name and a non-empty message', () => {
    let caught: unknown;
    try {
      accountClassFromCode(MALFORMED_CODE);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(InvalidAccountCodeError);
    const asError = caught as InvalidAccountCodeError;
    expect(asError.name).toBe('InvalidAccountCodeError');
    expect(asError.message.length).toBeGreaterThan(0);
  });
});

describe('isValidAccountCode / accountClassFromCode agree (sanity, complements ./invariants.property.test.ts)', () => {
  it('isValidAccountCode(code) === true implies accountClassFromCode(code) does not throw', () => {
    expect(isValidAccountCode(WELL_FORMED_CODE)).toBe(true);
    expect(() => accountClassFromCode(WELL_FORMED_CODE)).not.toThrow();
  });

  it('isValidAccountCode(code) === false implies accountClassFromCode(code) throws', () => {
    expect(isValidAccountCode(MALFORMED_CODE)).toBe(false);
    expect(() => accountClassFromCode(MALFORMED_CODE)).toThrow(InvalidAccountCodeError);
  });
});
