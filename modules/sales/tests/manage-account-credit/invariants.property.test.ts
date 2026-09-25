// modules/sales/tests/manage-account-credit/invariants.property.test.ts — WBS 1.8, M02 sales.
//
// Property tests (fast-check) for the pure domain invariants in
// modules/sales/domain/manage-account-credit/invariants.ts (does not exist yet — RED).
//
// Expected new surface (brief, Master decisions 1-5):
//   assertCreditLimitValid(creditLimit: string): void
//     — throws InvalidCreditLimitError iff the numeric(14,3) string represents a NEGATIVE value;
//       accepts zero and any positive value (Master decision 5: "SetCreditLimit accepts zero").
//   assertAccountCreditOk(account: { creditHold: boolean; holdReason: string | null }): void
//     — throws AccountOnCreditHoldError{accountId, reason} iff account.creditHold === true;
//       returns (no throw) iff account.creditHold === false. A plain boolean predicate (Master
//       decision 1: "NOT the if/switch on state the rule forbids — a boolean flag flip, not a
//       multi-state enum").
//   assertOnHold(account: { creditHold: boolean }): void — used by ReleaseCreditHold: throws
//     NotOnHoldError iff account.creditHold === false; returns iff account.creditHold === true.
//
// ANTI-VACUOUS-TEST RULE (flagged repeatedly on 1.2/1.4/1.6/1.7's reviews): this file's own
// reference implementations below (`referenceCreditLimitValid`, `referenceAccountCreditOk`,
// `referenceOnHold`) are written independently from the production code they check against — they
// do NOT import or call the production `assert*` functions internally; the test only imports the
// production functions to assert their OBSERVABLE throw/no-throw behaviour against arbitrary
// fast-check-generated inputs, so a production implementation that merely mirrors this file's
// literal source would still be caught by a genuinely independent oracle.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test — does not exist yet (RED).
import {
  assertAccountCreditOk,
  assertCreditLimitValid,
  assertOnHold,
  assertReasonPresent,
} from '../../domain/manage-account-credit/invariants.js';
import {
  AccountOnCreditHoldError,
  InvalidCreditLimitError,
  InvalidReasonError,
  NotOnHoldError,
} from '../../domain/manage-account-credit/errors.js';

const ACCOUNT_ID_FIXTURE = '00000000-0000-4000-8000-000000018001';

// --- independent reference oracles (never call the production assert* functions) ----------------

/** numeric(14,3): sign optional, integer part 1-11 digits, optional '.' + 1-3 fractional digits.
 *  Checks the PARSED MAGNITUDE's sign, not the leading character — a bigint-based representation
 *  (Money, @pg-eos/domain-kit, mandatory per CLAUDE.md — never Number()/parseFloat()) has no
 *  negative zero, so "-0", "-0.000", etc. are magnitude-zero and therefore NOT negative, exactly
 *  like every other Money value in this codebase. A leading '-' with at least one nonzero digit
 *  IS negative. */
function referenceIsNegative(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('-')) return false;
  const digitsOnly = trimmed.slice(1).replace(/\D/g, '');
  return /[1-9]/.test(digitsOnly);
}

function referenceAccountCreditOk(creditHold: boolean): boolean {
  // "ok" (no throw) iff NOT on hold.
  return creditHold === false;
}

function referenceOnHold(creditHold: boolean): boolean {
  // assertOnHold is satisfied (no throw) iff the account IS on hold.
  return creditHold === true;
}

// numeric(14,3) fixture generator: an optional '-' sign, 1-11 integer digits (the full legal
// numeric(14,3) range — pg-reviewer fix round 2, finding 7b: previously capped at 6 digits), and
// optional 1-3 decimal digits — deliberately independent of any production regex.
const numericStringArb = fc
  .tuple(
    fc.boolean(), // negative?
    fc.integer({ min: 0, max: 99_999_999_999 }),
    fc.option(fc.integer({ min: 0, max: 999 }), { nil: undefined }),
  )
  .map(([negative, whole, frac]) => {
    // pg-reviewer fix round 2, finding 7a: the previous `negative && whole !== 0 ? '-' : negative ?
    // '-' : ''` was dead logic — both branches of the inner ternary produced '-', so it simplifies
    // to this. The "-0" zero-magnitude edge case is a REFERENCE-ORACLE concern (referenceIsNegative
    // above), not a generator concern — the generator is free to emit "-0"/"-0.000".
    const sign = negative ? '-' : '';
    const fracPart = frac === undefined ? '' : `.${String(frac).padStart(3, '0')}`;
    return `${sign}${whole}${fracPart}`;
  });

describe('assertCreditLimitValid — property (Master decision 2, 5)', () => {
  it('never throws for a non-negative numeric(14,3) string (zero and positive both legal)', () => {
    fc.assert(
      fc.property(numericStringArb.filter((v) => !referenceIsNegative(v)), (creditLimit) => {
        expect(() => assertCreditLimitValid(creditLimit)).not.toThrow();
      }),
    );
  });

  it('always throws InvalidCreditLimitError for a negative numeric(14,3) string', () => {
    fc.assert(
      fc.property(numericStringArb.filter(referenceIsNegative), (creditLimit) => {
        expect(() => assertCreditLimitValid(creditLimit)).toThrow(InvalidCreditLimitError);
      }),
    );
  });

  it('zero (in any of its legal textual forms) never throws', () => {
    for (const zero of ['0', '0.000', '0.0', '0.00']) {
      expect(() => assertCreditLimitValid(zero)).not.toThrow();
    }
  });
});

describe('assertAccountCreditOk — property (Master decision 1)', () => {
  it('agrees with the independent reference oracle for every boolean creditHold value', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.string({ minLength: 1 }), (creditHold, reason) => {
        const account = { accountId: ACCOUNT_ID_FIXTURE, creditHold, holdReason: creditHold ? reason : null };
        if (referenceAccountCreditOk(creditHold)) {
          expect(() => assertAccountCreditOk(account)).not.toThrow();
        } else {
          expect(() => assertAccountCreditOk(account)).toThrow(AccountOnCreditHoldError);
        }
      }),
    );
  });

  it('AccountOnCreditHoldError carries the account id and reason it was thrown with', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (reason) => {
        try {
          assertAccountCreditOk({ accountId: ACCOUNT_ID_FIXTURE, creditHold: true, holdReason: reason });
          throw new Error('expected AccountOnCreditHoldError to be thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(AccountOnCreditHoldError);
          if (error instanceof AccountOnCreditHoldError) {
            expect(error.accountId).toBe(ACCOUNT_ID_FIXTURE);
            expect(error.reason).toBe(reason);
          }
        }
      }),
    );
  });
});

describe('assertOnHold — property (Master decision 4, ReleaseCreditHold\'s own no-op guard)', () => {
  it('agrees with the independent reference oracle for every boolean creditHold value', () => {
    fc.assert(
      fc.property(fc.boolean(), (creditHold) => {
        const account = { creditHold };
        if (referenceOnHold(creditHold)) {
          expect(() => assertOnHold(account)).not.toThrow();
        } else {
          expect(() => assertOnHold(account)).toThrow(NotOnHoldError);
        }
      }),
    );
  });
});

// pg-reviewer fix round 1, finding 3: defence-in-depth for a caller that bypasses the contract
// boundary (packages/contracts/sales/manage-account-credit.ts's own `z.string().trim().min(1)`) and
// calls setCreditHold/releaseCreditHold directly with an empty or all-whitespace reason.
describe('assertReasonPresent — property (pg-reviewer fix round 1, finding 3)', () => {
  it('never throws for a string with at least one non-whitespace character', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        (reason) => {
          expect(() => assertReasonPresent(reason)).not.toThrow();
        },
      ),
    );
  });

  it('always throws InvalidReasonError for an empty or all-whitespace string', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', '\t', '\n'), { minLength: 0, maxLength: 8 }).map((chars) => chars.join('')),
        (reason) => {
          expect(() => assertReasonPresent(reason)).toThrow(InvalidReasonError);
        },
      ),
    );
  });

  it('the empty string itself always throws', () => {
    expect(() => assertReasonPresent('')).toThrow(InvalidReasonError);
  });
});
