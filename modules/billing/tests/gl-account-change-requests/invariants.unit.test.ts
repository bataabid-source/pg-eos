// modules/billing/tests/gl-account-change-requests/invariants.unit.test.ts — WBS 4.1a part 2.
//
// Fix round finding 12: pure domain-layer unit tests — no DB, no I/O — for
// modules/billing/domain/gl-account-change-requests/invariants.ts, exercised directly. Until this
// file, only the DB-backed integration suite (./gl-account-change-requests.test.ts) and the
// domain/DB agreement property test (./invariants.property.test.ts) exercised these functions
// indirectly, through live INSERTs — never the assert/throw functions themselves, and never each
// thrown error's own `.message`/`.name`.
//
// Precedent: modules/billing/tests/dimensions/invariants.unit.test.ts (same shape, same module,
// WBS 4.1b part 1) and modules/billing/tests/chart-of-accounts/invariants.unit.test.ts.

import { describe, expect, it } from 'vitest';

import {
  isValidChangeKindTargetPairing,
  isApproverDistinctFromRequester,
  assertApproverDistinctFromRequester,
  isRejectionReasonPresentWhenRejected,
  assertRejectionReasonPresentWhenRejected,
  isCreateRequestComplete,
  assertCreateRequestComplete,
  isDecisionComplete,
  assertDecisionComplete,
  isProposedCodeOnlyForCreate,
  assertProposedCodeOnlyForCreate,
} from '../../domain/gl-account-change-requests/invariants.js';
import {
  SameApproverAsRequesterError,
  MissingRejectionReasonError,
  IncompleteCreateRequestError,
  IncompleteDecisionError,
  ProposedCodeOnUpdateError,
} from '../../domain/gl-account-change-requests/errors.js';

const REQUESTER_UUID = '00000000-0000-4000-8000-0000004a3a01';
const APPROVER_UUID = '00000000-0000-4000-8000-0000004a3a02';
const APPROVED_AT = '2026-01-01T00:00:00.000Z';

// --- isValidChangeKindTargetPairing --------------------------------------------------------------

describe('isValidChangeKindTargetPairing', () => {
  it('returns true for create + null target_account_id', () => {
    expect(isValidChangeKindTargetPairing('create', null)).toBe(true);
  });

  it('returns false for create + a non-null target_account_id', () => {
    expect(isValidChangeKindTargetPairing('create', REQUESTER_UUID)).toBe(false);
  });

  it('returns true for update + a non-null target_account_id', () => {
    expect(isValidChangeKindTargetPairing('update', REQUESTER_UUID)).toBe(true);
  });

  it('returns false for update + a null target_account_id', () => {
    expect(isValidChangeKindTargetPairing('update', null)).toBe(false);
  });
});

// --- isApproverDistinctFromRequester / assertApproverDistinctFromRequester ------------------------

describe('isApproverDistinctFromRequester / assertApproverDistinctFromRequester', () => {
  it('returns true when approvedBy is null (not yet decided)', () => {
    expect(isApproverDistinctFromRequester(null, REQUESTER_UUID)).toBe(true);
  });

  it('returns true when approvedBy differs from requestedBy', () => {
    expect(isApproverDistinctFromRequester(APPROVER_UUID, REQUESTER_UUID)).toBe(true);
  });

  it('returns false when approvedBy equals requestedBy', () => {
    expect(isApproverDistinctFromRequester(REQUESTER_UUID, REQUESTER_UUID)).toBe(false);
  });

  it('assertApproverDistinctFromRequester does not throw when the invariant holds', () => {
    expect(() => assertApproverDistinctFromRequester(APPROVER_UUID, REQUESTER_UUID)).not.toThrow();
    expect(() => assertApproverDistinctFromRequester(null, REQUESTER_UUID)).not.toThrow();
  });

  it('assertApproverDistinctFromRequester throws SameApproverAsRequesterError with a non-empty message when the same user is both', () => {
    let caught: unknown;
    try {
      assertApproverDistinctFromRequester(REQUESTER_UUID, REQUESTER_UUID);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(SameApproverAsRequesterError);
    const asError = caught as SameApproverAsRequesterError;
    expect(asError.name).toBe('SameApproverAsRequesterError');
    expect(asError.message.length).toBeGreaterThan(0);
    expect(asError.message).toContain(REQUESTER_UUID);
  });
});

// --- isRejectionReasonPresentWhenRejected / assertRejectionReasonPresentWhenRejected --------------

describe('isRejectionReasonPresentWhenRejected / assertRejectionReasonPresentWhenRejected', () => {
  it('returns true for any status other than rejected, regardless of rejectionReason', () => {
    expect(isRejectionReasonPresentWhenRejected('draft', null)).toBe(true);
    expect(isRejectionReasonPresentWhenRejected('pending_approval', null)).toBe(true);
    expect(isRejectionReasonPresentWhenRejected('approved', null)).toBe(true);
    expect(isRejectionReasonPresentWhenRejected('cancelled', null)).toBe(true);
  });

  it('returns false for status=rejected with a null rejectionReason', () => {
    expect(isRejectionReasonPresentWhenRejected('rejected', null)).toBe(false);
  });

  it('returns true for status=rejected with a non-null rejectionReason', () => {
    expect(isRejectionReasonPresentWhenRejected('rejected', 'duplicate code')).toBe(true);
  });

  it('assertRejectionReasonPresentWhenRejected does not throw when the invariant holds', () => {
    expect(() => assertRejectionReasonPresentWhenRejected('draft', null)).not.toThrow();
    expect(() => assertRejectionReasonPresentWhenRejected('rejected', 'a reason')).not.toThrow();
  });

  it('assertRejectionReasonPresentWhenRejected throws MissingRejectionReasonError with a non-empty message when rejected without a reason', () => {
    let caught: unknown;
    try {
      assertRejectionReasonPresentWhenRejected('rejected', null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(MissingRejectionReasonError);
    const asError = caught as MissingRejectionReasonError;
    expect(asError.name).toBe('MissingRejectionReasonError');
    expect(asError.message.length).toBeGreaterThan(0);
  });
});

// --- isCreateRequestComplete / assertCreateRequestComplete -----------------------------------------

describe('isCreateRequestComplete / assertCreateRequestComplete', () => {
  it('returns true for change_kind=update regardless of the proposed_* columns', () => {
    expect(isCreateRequestComplete('update', null, null, null)).toBe(true);
  });

  it('returns true for change_kind=create when every required proposed_* column is non-null', () => {
    expect(isCreateRequestComplete('create', '1-01-001-001', 'اسم', 'asset')).toBe(true);
  });

  it.each([
    [null, 'اسم', 'asset'],
    ['1-01-001-001', null, 'asset'],
    ['1-01-001-001', 'اسم', null],
  ])('returns false for change_kind=create when a required column is null (%s, %s, %s)', (code, nameAr, accountType) => {
    expect(isCreateRequestComplete('create', code, nameAr, accountType)).toBe(false);
  });

  it('assertCreateRequestComplete does not throw when the invariant holds', () => {
    expect(() => assertCreateRequestComplete('create', '1-01-001-001', 'اسم', 'asset')).not.toThrow();
    expect(() => assertCreateRequestComplete('update', null, null, null)).not.toThrow();
  });

  it('assertCreateRequestComplete throws IncompleteCreateRequestError with a non-empty message when a create request is incomplete', () => {
    let caught: unknown;
    try {
      assertCreateRequestComplete('create', null, null, null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(IncompleteCreateRequestError);
    const asError = caught as IncompleteCreateRequestError;
    expect(asError.name).toBe('IncompleteCreateRequestError');
    expect(asError.message.length).toBeGreaterThan(0);
  });
});

// --- isDecisionComplete / assertDecisionComplete ----------------------------------------------------

describe('isDecisionComplete / assertDecisionComplete', () => {
  it('returns true for any status other than approved, regardless of approvedBy/approvedAt', () => {
    expect(isDecisionComplete('draft', null, null)).toBe(true);
    expect(isDecisionComplete('pending_approval', null, null)).toBe(true);
    expect(isDecisionComplete('rejected', null, null)).toBe(true);
    expect(isDecisionComplete('cancelled', null, null)).toBe(true);
  });

  it('returns false for status=approved with a null approvedBy (the three-valued-logic trap)', () => {
    expect(isDecisionComplete('approved', null, APPROVED_AT)).toBe(false);
  });

  it('returns false for status=approved with a non-null approvedBy but a null approvedAt (round-2 finding 4: the glc_approver_update WITH CHECK also requires approved_at)', () => {
    expect(isDecisionComplete('approved', APPROVER_UUID, null)).toBe(false);
  });

  it('returns false for status=approved with both approvedBy and approvedAt null', () => {
    expect(isDecisionComplete('approved', null, null)).toBe(false);
  });

  it('returns true for status=approved with a non-null approvedBy and a non-null approvedAt', () => {
    expect(isDecisionComplete('approved', APPROVER_UUID, APPROVED_AT)).toBe(true);
  });

  it('assertDecisionComplete does not throw when the invariant holds', () => {
    expect(() => assertDecisionComplete('draft', null, null)).not.toThrow();
    expect(() => assertDecisionComplete('approved', APPROVER_UUID, APPROVED_AT)).not.toThrow();
  });

  it('assertDecisionComplete throws IncompleteDecisionError with a non-empty message when approved without an approver', () => {
    let caught: unknown;
    try {
      assertDecisionComplete('approved', null, APPROVED_AT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(IncompleteDecisionError);
    const asError = caught as IncompleteDecisionError;
    expect(asError.name).toBe('IncompleteDecisionError');
    expect(asError.message.length).toBeGreaterThan(0);
  });

  it('assertDecisionComplete throws IncompleteDecisionError when approved with an approver but a null approvedAt', () => {
    let caught: unknown;
    try {
      assertDecisionComplete('approved', APPROVER_UUID, null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(IncompleteDecisionError);
    const asError = caught as IncompleteDecisionError;
    expect(asError.name).toBe('IncompleteDecisionError');
    expect(asError.message.length).toBeGreaterThan(0);
  });
});

// --- isProposedCodeOnlyForCreate / assertProposedCodeOnlyForCreate (round-3 fix 4) ------------------

describe('isProposedCodeOnlyForCreate / assertProposedCodeOnlyForCreate', () => {
  it('returns true for change_kind=create regardless of proposedCode (null or set)', () => {
    expect(isProposedCodeOnlyForCreate('create', null)).toBe(true);
    expect(isProposedCodeOnlyForCreate('create', '1-01-001-001')).toBe(true);
  });

  it('returns true for change_kind=update with a null proposedCode', () => {
    expect(isProposedCodeOnlyForCreate('update', null)).toBe(true);
  });

  it('returns false for change_kind=update with a non-null proposedCode', () => {
    expect(isProposedCodeOnlyForCreate('update', '1-01-001-001')).toBe(false);
  });

  it('assertProposedCodeOnlyForCreate does not throw when the invariant holds', () => {
    expect(() => assertProposedCodeOnlyForCreate('create', '1-01-001-001')).not.toThrow();
    expect(() => assertProposedCodeOnlyForCreate('update', null)).not.toThrow();
  });

  it('assertProposedCodeOnlyForCreate throws ProposedCodeOnUpdateError with a non-empty message when an update request carries a proposedCode', () => {
    let caught: unknown;
    try {
      assertProposedCodeOnlyForCreate('update', '1-01-001-001');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(ProposedCodeOnUpdateError);
    const asError = caught as ProposedCodeOnUpdateError;
    expect(asError.name).toBe('ProposedCodeOnUpdateError');
    expect(asError.message.length).toBeGreaterThan(0);
  });
});
