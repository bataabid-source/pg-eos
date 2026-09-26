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
  isValidDeactivateReactivateDirection,
  assertValidDeactivateReactivateDirection,
  isDeactivationAllowed,
  assertDeactivationAllowed,
} from '../../domain/gl-account-change-requests/invariants.js';
import {
  SameApproverAsRequesterError,
  MissingRejectionReasonError,
  IncompleteCreateRequestError,
  IncompleteDecisionError,
  ProposedCodeOnUpdateError,
  InvalidDeactivateReactivateDirectionError,
  ActiveChildBlocksDeactivationError,
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

  // WBS 4.1a part 3: the changeKind parameter type widens to also accept 'deactivate' | 'reactivate'
  // (body unchanged — the else branch already requires a non-null target for anything not 'create').
  it('returns true for deactivate/reactivate + a non-null target_account_id', () => {
    expect(isValidChangeKindTargetPairing('deactivate', REQUESTER_UUID)).toBe(true);
    expect(isValidChangeKindTargetPairing('reactivate', REQUESTER_UUID)).toBe(true);
  });

  it('returns false for deactivate/reactivate + a null target_account_id', () => {
    expect(isValidChangeKindTargetPairing('deactivate', null)).toBe(false);
    expect(isValidChangeKindTargetPairing('reactivate', null)).toBe(false);
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

  // WBS 4.1a part 3: isProposedCodeOnlyForCreate's changeKind parameter type widens to also accept
  // 'deactivate' | 'reactivate' — body unchanged (only changeKind === 'create' is exempted, so any
  // other kind, including the two new ones, still requires a null proposedCode).
  it('returns true for change_kind=deactivate/reactivate with a null proposedCode', () => {
    expect(isProposedCodeOnlyForCreate('deactivate', null)).toBe(true);
    expect(isProposedCodeOnlyForCreate('reactivate', null)).toBe(true);
  });

  it('returns false for change_kind=deactivate/reactivate with a non-null proposedCode', () => {
    expect(isProposedCodeOnlyForCreate('deactivate', '1-01-001-001')).toBe(false);
    expect(isProposedCodeOnlyForCreate('reactivate', '1-01-001-001')).toBe(false);
  });

  it('assertProposedCodeOnlyForCreate throws ProposedCodeOnUpdateError when a deactivate/reactivate request carries a proposedCode', () => {
    expect(() => assertProposedCodeOnlyForCreate('deactivate', '1-01-001-001')).toThrow(ProposedCodeOnUpdateError);
    expect(() => assertProposedCodeOnlyForCreate('reactivate', '1-01-001-001')).toThrow(ProposedCodeOnUpdateError);
  });
});

// --- isValidDeactivateReactivateDirection / assertValidDeactivateReactivateDirection (WBS 4.1a part 3) --
// New pure invariant (no I/O, no Date — CLAUDE.md · AGENT CONSTRAINTS): the counterpart the DB
// trigger's own `old.is_active` check backstops. `currentIsActive` is a plain boolean parameter,
// never fetched inside this function.

describe('isValidDeactivateReactivateDirection / assertValidDeactivateReactivateDirection', () => {
  it('returns true for deactivate when currentIsActive is true', () => {
    expect(isValidDeactivateReactivateDirection('deactivate', true)).toBe(true);
  });

  it('returns false for deactivate when currentIsActive is false (already inactive)', () => {
    expect(isValidDeactivateReactivateDirection('deactivate', false)).toBe(false);
  });

  it('returns true for reactivate when currentIsActive is false', () => {
    expect(isValidDeactivateReactivateDirection('reactivate', false)).toBe(true);
  });

  it('returns false for reactivate when currentIsActive is true (already active)', () => {
    expect(isValidDeactivateReactivateDirection('reactivate', true)).toBe(false);
  });

  it('returns true for create/update regardless of currentIsActive (unconstrained)', () => {
    expect(isValidDeactivateReactivateDirection('create', true)).toBe(true);
    expect(isValidDeactivateReactivateDirection('create', false)).toBe(true);
    expect(isValidDeactivateReactivateDirection('update', true)).toBe(true);
    expect(isValidDeactivateReactivateDirection('update', false)).toBe(true);
  });

  it('assertValidDeactivateReactivateDirection does not throw when the invariant holds', () => {
    expect(() => assertValidDeactivateReactivateDirection('deactivate', true)).not.toThrow();
    expect(() => assertValidDeactivateReactivateDirection('reactivate', false)).not.toThrow();
    expect(() => assertValidDeactivateReactivateDirection('create', false)).not.toThrow();
    expect(() => assertValidDeactivateReactivateDirection('update', true)).not.toThrow();
  });

  it('assertValidDeactivateReactivateDirection throws InvalidDeactivateReactivateDirectionError with a non-empty message when deactivating an already-inactive account', () => {
    let caught: unknown;
    try {
      assertValidDeactivateReactivateDirection('deactivate', false);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(InvalidDeactivateReactivateDirectionError);
    const asError = caught as InvalidDeactivateReactivateDirectionError;
    expect(asError.name).toBe('InvalidDeactivateReactivateDirectionError');
    expect(asError.message.length).toBeGreaterThan(0);
  });

  it('assertValidDeactivateReactivateDirection throws InvalidDeactivateReactivateDirectionError when reactivating an already-active account', () => {
    let caught: unknown;
    try {
      assertValidDeactivateReactivateDirection('reactivate', true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(InvalidDeactivateReactivateDirectionError);
    const asError = caught as InvalidDeactivateReactivateDirectionError;
    expect(asError.name).toBe('InvalidDeactivateReactivateDirectionError');
    expect(asError.message.length).toBeGreaterThan(0);
  });
});

// --- isDeactivationAllowed / assertDeactivationAllowed (WBS 4.1a part 3, fix round finding 2) ------
// New pure invariant (no I/O, no Date — CLAUDE.md · AGENT CONSTRAINTS): the domain counterpart of the
// active-children check in the DB trigger `billing.assert_gl_account_change_approved()` (migration
// 0036), which remains its backstop. `hasActiveChild` is a plain boolean parameter, never queried
// inside this function.

describe('isDeactivationAllowed / assertDeactivationAllowed', () => {
  it('returns true when hasActiveChild is false (no active child blocks the deactivation)', () => {
    expect(isDeactivationAllowed(false)).toBe(true);
  });

  it('returns false when hasActiveChild is true (an active child blocks the deactivation)', () => {
    expect(isDeactivationAllowed(true)).toBe(false);
  });

  it('assertDeactivationAllowed does not throw when the invariant holds (hasActiveChild=false)', () => {
    expect(() => assertDeactivationAllowed(false)).not.toThrow();
  });

  it('assertDeactivationAllowed throws ActiveChildBlocksDeactivationError with a non-empty message when hasActiveChild=true', () => {
    let caught: unknown;
    try {
      assertDeactivationAllowed(true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(ActiveChildBlocksDeactivationError);
    const asError = caught as ActiveChildBlocksDeactivationError;
    expect(asError.name).toBe('ActiveChildBlocksDeactivationError');
    expect(asError.message.length).toBeGreaterThan(0);
  });
});
