// modules/sales/tests/manage-contract/invariants.property.test.ts — WBS 1.7, M02 sales.
//
// pg-reviewer fix round 2, finding 4: property tests (fast-check) for every invariant this slice's
// brief names as a pure domain/ check — modules/sales/domain/manage-contract/invariants.ts:
//   assertValidStartDate(startDate, today)      -> InvalidStartDateError iff startDate < today
//   assertValidEndDate(endDate, startDate)       -> InvalidEndDateError iff endDate !== null && endDate < startDate
//   assertContractExpirable(endDate, asOfDate)   -> ContractNotYetExpirableError iff endDate === null || !(endDate < asOfDate)
//   assertContractUsableForOrder(status)         -> ContractNotActiveError{status} iff status !== 'active'
// Follows modules/sales/tests/manage-quote/margin.property.test.ts's shape: fast-check, independent
// reference logic (never a copy of production's own code shape).
//
// ANTI-VACUOUS-TEST RULE (pg-reviewer flagged this pattern before, WBS 1.2/1.4/1.6): the date-based
// reference checks below compare via `Date.parse`/millisecond arithmetic, a genuinely DIFFERENT
// mechanism than production's own lexicographic ISO-string comparison — a real off-by-one or
// wrong-operand bug in production disagrees with this independent calculation; a cosmetic
// implementation-shape difference does not.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertAccountQualified,
  assertContractExpirable,
  assertContractNotExpiredByDate,
  assertContractUsableForOrder,
  assertPriceListApplicable,
  assertPriceListAssignable,
  assertSlaAssignable,
  assertValidEndDate,
  assertValidStartDate,
  todayIso,
  type AccountQualificationInput,
  type PriceListCandidate,
} from '../../domain/manage-contract/invariants.js';
import {
  AccountNotFoundError,
  AccountNotQualifiedError,
  ContractExpiredByDateError,
  ContractNotActiveError,
  ContractNotYetExpirableError,
  IllegalTransitionError,
  InvalidEndDateError,
  InvalidStartDateError,
  PriceListNotApplicableError,
} from '../../domain/manage-contract/errors.js';
import { CONTRACT_STATUS, type ContractStatus } from '../../domain/manage-contract/machine.js';

// A bounded universe of 'YYYY-MM-DD' strings, generated from a day-offset integer so every value is
// a genuinely valid calendar date (never a hand-built out-of-range string) — arithmetic comparisons
// below use `Date.parse`, INDEPENDENT of whatever string-comparison production uses internally.
const EPOCH_MS = Date.parse('2020-01-01');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const dayOffsetArb = fc.integer({ min: 0, max: 3650 }); // ~10 years of distinct calendar days.

function isoDateFromOffset(offsetDays: number): string {
  const date = new Date(EPOCH_MS + offsetDays * ONE_DAY_MS);
  return date.toISOString().slice(0, 10);
}

const isoDateArb = dayOffsetArb.map(isoDateFromOffset);

/** Independent reference: strictly-before comparison via `Date.parse` millisecond arithmetic, never
 *  string comparison (production's own mechanism, per invariants.ts's own comment). */
function referenceIsBefore(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}

describe('assertValidStartDate — property: throws InvalidStartDateError iff startDate is strictly before today', () => {
  it('agrees with an independent Date.parse-based comparison for arbitrary date pairs', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (startDate, today) => {
        const shouldThrow = referenceIsBefore(startDate, today);
        if (shouldThrow) {
          expect(() => assertValidStartDate(startDate, today)).toThrow(InvalidStartDateError);
        } else {
          expect(() => assertValidStartDate(startDate, today)).not.toThrow();
        }
      }),
    );
  });

  it('a startDate equal to today never throws (>= today is the rule, not > today)', () => {
    fc.assert(
      fc.property(isoDateArb, (today) => {
        expect(() => assertValidStartDate(today, today)).not.toThrow();
      }),
    );
  });
});

describe('assertValidEndDate — property: throws InvalidEndDateError iff endDate is non-null and strictly before startDate', () => {
  it('a null endDate never throws, for any startDate', () => {
    fc.assert(
      fc.property(isoDateArb, (startDate) => {
        expect(() => assertValidEndDate(null, startDate)).not.toThrow();
      }),
    );
  });

  it('agrees with an independent Date.parse-based comparison for arbitrary non-null endDate/startDate pairs', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (endDate, startDate) => {
        const shouldThrow = referenceIsBefore(endDate, startDate);
        if (shouldThrow) {
          expect(() => assertValidEndDate(endDate, startDate)).toThrow(InvalidEndDateError);
        } else {
          expect(() => assertValidEndDate(endDate, startDate)).not.toThrow();
        }
      }),
    );
  });

  it('an endDate equal to startDate never throws (>= startDate is the rule)', () => {
    fc.assert(
      fc.property(isoDateArb, (startDate) => {
        expect(() => assertValidEndDate(startDate, startDate)).not.toThrow();
      }),
    );
  });
});

describe('assertContractExpirable — property: throws ContractNotYetExpirableError iff endDate is null or not strictly before asOfDate', () => {
  it('a null endDate always throws, for any asOfDate', () => {
    fc.assert(
      fc.property(isoDateArb, (asOfDate) => {
        expect(() => assertContractExpirable(null, asOfDate)).toThrow(ContractNotYetExpirableError);
      }),
    );
  });

  it('agrees with an independent Date.parse-based comparison for arbitrary non-null endDate/asOfDate pairs', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (endDate, asOfDate) => {
        const isExpirable = referenceIsBefore(endDate, asOfDate);
        if (isExpirable) {
          expect(() => assertContractExpirable(endDate, asOfDate)).not.toThrow();
        } else {
          expect(() => assertContractExpirable(endDate, asOfDate)).toThrow(ContractNotYetExpirableError);
        }
      }),
    );
  });

  it('an endDate equal to asOfDate throws (strictly-before is the rule, not <=)', () => {
    fc.assert(
      fc.property(isoDateArb, (asOfDate) => {
        expect(() => assertContractExpirable(asOfDate, asOfDate)).toThrow(ContractNotYetExpirableError);
      }),
    );
  });
});

describe('assertContractUsableForOrder — property: throws ContractNotActiveError{status} for every non-active status, never for active', () => {
  const statusArb: fc.Arbitrary<ContractStatus> = fc.constantFrom(...Object.values(CONTRACT_STATUS));

  it('agrees with an independent reference over the whole enum: throws iff status !== "active", and carries that exact status', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const referenceShouldThrow = status !== CONTRACT_STATUS.ACTIVE;
        if (referenceShouldThrow) {
          try {
            assertContractUsableForOrder(status);
            throw new Error(`expected ContractNotActiveError for status ${status}`);
          } catch (error) {
            expect(error).toBeInstanceOf(ContractNotActiveError);
            expect((error as ContractNotActiveError).status).toBe(status);
          }
        } else {
          expect(() => assertContractUsableForOrder(status)).not.toThrow();
        }
      }),
    );
  });
});

// --- pg-reviewer fix round 3, finding 2 — property tests for the THREE invariants round 1 added,
// none of which had one before (assertContractNotExpiredByDate, assertPriceListApplicable,
// assertSlaAssignable). Same independent-reference-logic approach as the four properties above. ---

const CONTRACT_ID_FIXTURE = '00000000-0000-4000-8000-000000000001'; // opaque — never asserted on its own value, only echoed.

describe('assertContractNotExpiredByDate — property: throws ContractExpiredByDateError iff endDate is non-null and strictly before asOfDate', () => {
  it('a null endDate never throws, for any asOfDate', () => {
    fc.assert(
      fc.property(isoDateArb, (asOfDate) => {
        expect(() => assertContractNotExpiredByDate(CONTRACT_ID_FIXTURE, null, asOfDate)).not.toThrow();
      }),
    );
  });

  it('agrees with an independent Date.parse-based comparison, and the thrown error carries the exact contractId/endDate', () => {
    fc.assert(
      fc.property(isoDateArb, isoDateArb, (endDate, asOfDate) => {
        const shouldThrow = referenceIsBefore(endDate, asOfDate);
        if (shouldThrow) {
          try {
            assertContractNotExpiredByDate(CONTRACT_ID_FIXTURE, endDate, asOfDate);
            throw new Error('expected ContractExpiredByDateError');
          } catch (error) {
            expect(error).toBeInstanceOf(ContractExpiredByDateError);
            expect((error as ContractExpiredByDateError).contractId).toBe(CONTRACT_ID_FIXTURE);
            expect((error as ContractExpiredByDateError).endDate).toBe(endDate);
          }
        } else {
          expect(() => assertContractNotExpiredByDate(CONTRACT_ID_FIXTURE, endDate, asOfDate)).not.toThrow();
        }
      }),
    );
  });

  it('an endDate equal to asOfDate never throws (strictly-before is the rule, not <=)', () => {
    fc.assert(
      fc.property(isoDateArb, (asOfDate) => {
        expect(() => assertContractNotExpiredByDate(CONTRACT_ID_FIXTURE, asOfDate, asOfDate)).not.toThrow();
      }),
    );
  });
});

describe('assertSlaAssignable — property: throws IllegalTransitionError iff status === "terminated"', () => {
  const statusArb: fc.Arbitrary<ContractStatus> = fc.constantFrom(...Object.values(CONTRACT_STATUS));

  it('agrees with an independent reference over the whole enum: throws ONLY for terminated', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const referenceShouldThrow = status === CONTRACT_STATUS.TERMINATED;
        if (referenceShouldThrow) {
          expect(() => assertSlaAssignable(status)).toThrow(IllegalTransitionError);
        } else {
          expect(() => assertSlaAssignable(status)).not.toThrow();
        }
      }),
    );
  });
});

// Two opaque, DISTINCT tokens per axis (entity/client/segment) — enough to exercise every
// match/mismatch/null combination the formula branches on, without a real UUID's noise.
const ENTITY_A = 'entity-a';
const ENTITY_B = 'entity-b';
const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';
const SEGMENT_A = 'segment-a';
const SEGMENT_B = 'segment-b';

const entityTokenArb = fc.constantFrom(ENTITY_A, ENTITY_B);
const accountTokenArb = fc.constantFrom(ACCOUNT_A, ACCOUNT_B);
const clientTokenArb = fc.option(fc.constantFrom(ACCOUNT_A, ACCOUNT_B), { nil: null });
const segmentTokenArb = fc.option(fc.constantFrom(SEGMENT_A, SEGMENT_B), { nil: null });
const priceListStatusArb = fc.constantFrom('draft', 'active', 'expired');

const priceListCandidateArb: fc.Arbitrary<PriceListCandidate> = fc.record({
  entityId: entityTokenArb,
  clientId: clientTokenArb,
  segmentId: segmentTokenArb,
  isInternal: fc.boolean(),
  status: priceListStatusArb,
});

const priceListParamsArb = fc.record({
  entityId: entityTokenArb,
  accountId: accountTokenArb,
  accountSegmentId: segmentTokenArb,
});

/** Independent reference: each of the four gating conditions is computed as its own named boolean
 *  and combined via `.every()` over an ARRAY of checks — a different shape than production's own
 *  single `&&`-chained boolean expression (invariants.ts), same formula (pg-reviewer fix round 1,
 *  finding 3). */
function referencePriceListApplicable(
  priceList: PriceListCandidate | null,
  params: { readonly entityId: string; readonly accountId: string; readonly accountSegmentId: string | null },
): boolean {
  if (priceList === null) return false;
  const checks = [
    priceList.entityId === params.entityId,
    priceList.isInternal === false,
    priceList.status === 'active',
    priceList.clientId === null || priceList.clientId === params.accountId,
    priceList.segmentId === null || priceList.segmentId === params.accountSegmentId,
  ];
  return checks.every((check) => check);
}

describe('assertPriceListApplicable — property: agrees with an independent per-condition reference', () => {
  it('a null priceList always throws PriceListNotApplicableError', () => {
    fc.assert(
      fc.property(priceListParamsArb, (params) => {
        expect(() => assertPriceListApplicable(null, params)).toThrow(PriceListNotApplicableError);
      }),
    );
  });

  it('agrees with referencePriceListApplicable (different code shape, same formula) for arbitrary candidates/params', () => {
    fc.assert(
      fc.property(priceListCandidateArb, priceListParamsArb, (priceList, params) => {
        const referenceApplicable = referencePriceListApplicable(priceList, params);
        if (referenceApplicable) {
          expect(() => assertPriceListApplicable(priceList, params)).not.toThrow();
        } else {
          expect(() => assertPriceListApplicable(priceList, params)).toThrow(PriceListNotApplicableError);
        }
      }),
    );
  });
});

// --- mutation-coverage gap fill: assertAccountQualified, todayIso, assertPriceListAssignable had NO
// property test in this file even though they exist verbatim in domain/manage-contract/invariants.ts
// (reused from manage-quote's own INV-C2-1-style check, Master decision 2). ---

describe('assertAccountQualified — property: AccountNotFoundError iff null, else AccountNotQualifiedError iff closed/no CR', () => {
  const ACCOUNT_STATUS_CLOSED = 'closed';
  const statusStringArb = fc.constantFrom('active', 'closed', 'suspended');
  const crNumberArb = fc.option(fc.string({ minLength: 1 }), { nil: null });

  it('a null account always throws AccountNotFoundError', () => {
    expect(() => assertAccountQualified(null)).toThrow(AccountNotFoundError);
  });

  it('agrees with an independent reference for every (status, crNumber) combination', () => {
    fc.assert(
      fc.property(statusStringArb, crNumberArb, (status, crNumber) => {
        const account: AccountQualificationInput = { status, crNumber };
        const shouldThrow = status === ACCOUNT_STATUS_CLOSED || crNumber === null;
        if (shouldThrow) {
          expect(() => assertAccountQualified(account)).toThrow(AccountNotQualifiedError);
        } else {
          expect(() => assertAccountQualified(account)).not.toThrow();
        }
      }),
    );
  });

  it('closed status with a non-null crNumber still throws (either condition alone is sufficient)', () => {
    expect(() => assertAccountQualified({ status: 'closed', crNumber: 'CR-1' })).toThrow(AccountNotQualifiedError);
  });

  it('non-closed status with a null crNumber still throws (either condition alone is sufficient)', () => {
    expect(() => assertAccountQualified({ status: 'active', crNumber: null })).toThrow(AccountNotQualifiedError);
  });

  it('active status with a non-null crNumber never throws', () => {
    expect(() => assertAccountQualified({ status: 'active', crNumber: 'CR-1' })).not.toThrow();
  });
});

describe('todayIso — property: always the first 10 characters of clockNow.toISOString()', () => {
  it('agrees with an independent string-slicing reference for arbitrary dates', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }),
        (clockNow) => {
          const iso = clockNow.toISOString();
          const expected = `${iso.slice(0, 4)}-${iso.slice(5, 7)}-${iso.slice(8, 10)}`;
          expect(todayIso(clockNow)).toBe(expected);
          expect(todayIso(clockNow)).toHaveLength(10);
        },
      ),
    );
  });

  it('a known fixed date produces the exact expected string', () => {
    expect(todayIso(new Date('2025-03-14T23:59:59.999Z'))).toBe('2025-03-14');
  });
});

describe('assertPriceListAssignable — property: throws IllegalTransitionError iff status is not price-list-assignable', () => {
  // Independent tag-membership reference — every status except the three terminal ones
  // (expired/renewed/terminated), per machine.ts's own CONTRACT_TAG_PRICE_LIST_ASSIGNABLE comment.
  const ASSIGNABLE_STATUSES = new Set<ContractStatus>([
    CONTRACT_STATUS.DRAFT,
    CONTRACT_STATUS.SIGNED,
    CONTRACT_STATUS.ACTIVE,
    CONTRACT_STATUS.SUSPENDED,
  ]);
  const statusArb: fc.Arbitrary<ContractStatus> = fc.constantFrom(...Object.values(CONTRACT_STATUS));

  it('agrees with an independent assignable-set reference over the whole enum', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        if (ASSIGNABLE_STATUSES.has(status)) {
          expect(() => assertPriceListAssignable(status)).not.toThrow();
        } else {
          expect(() => assertPriceListAssignable(status)).toThrow(IllegalTransitionError);
        }
      }),
    );
  });

  it('the thrown message names the exact non-assignable status', () => {
    expect(() => assertPriceListAssignable(CONTRACT_STATUS.EXPIRED)).toThrow(/"expired"/);
  });
});
