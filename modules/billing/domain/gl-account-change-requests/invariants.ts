// modules/billing/domain/gl-account-change-requests/invariants.ts — WBS 4.1a part 2.
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random() (CLAUDE.md · AGENT
// CONSTRAINTS). This slice's own NEW invariant is the change_kind/target_account_id pairing
// (brief's own three-valued-logic CHECK: "create" needs a null target, "update" needs a non-null
// one). The Master's ruling ("the proposed columns obey the same rules as gl_accounts... through
// ONE function... not a copy") means proposed_code/proposed_account_type are NOT re-validated here
// — a future Submit command (part 2b) reuses
// ../chart-of-accounts/invariants.ts's own `isValidAccountCode`/`assertValidAccountType`/
// `ALLOWED_ACCOUNT_TYPES` directly, exactly as pg-tester's own property test
// (../../tests/gl-account-change-requests/invariants.property.test.ts) proves against those
// functions, never a duplicate here. This file's DB-level counterpart is
// `billing.is_valid_gl_account_code`/`billing.is_valid_gl_account_type` (migration
// 0034_2_gl-account-change-requests.sql), the shared SQL functions called from BOTH tables' CHECKs.

import {
  SameApproverAsRequesterError,
  MissingRejectionReasonError,
  IncompleteCreateRequestError,
  IncompleteDecisionError,
  ProposedCodeOnUpdateError,
} from './errors.js';

/** True iff `changeKind`/`targetAccountId` obey the brief's own pairing rule:
 *  `create` requires a null target (nothing exists yet to target); `update` requires a non-null one
 *  (the existing billing.gl_accounts row being changed). Mirrors the DB CHECK verbatim so the
 *  application layer rejects a malformed Submit BEFORE any DB round-trip — pg-tester's own property
 *  test proves this function and the DB CHECK agree on every generated tuple. */
export function isValidChangeKindTargetPairing(
  changeKind: 'create' | 'update',
  targetAccountId: string | null,
): boolean {
  if (changeKind === 'create') return targetAccountId === null;
  return targetAccountId !== null;
}

/** True iff `approvedBy`/`requestedBy` obey the brief's own maker/checker row-level rule: a null
 *  `approvedBy` (not yet decided) is always fine; once set, it must differ from `requestedBy` — the
 *  same user can never be both maker and checker on one row. Mirrors the DB CHECK
 *  `approved_by is null or approved_by <> requested_by` verbatim (defense-in-depth alongside the
 *  pre-existing (CFO,ACCOUNTANT) `identity.sod_rules` row — pg-reviewer round-1 finding 11). */
export function isApproverDistinctFromRequester(approvedBy: string | null, requestedBy: string): boolean {
  return approvedBy === null || approvedBy !== requestedBy;
}

/** Throws `SameApproverAsRequesterError` iff `isApproverDistinctFromRequester` is false. */
export function assertApproverDistinctFromRequester(approvedBy: string | null, requestedBy: string): void {
  if (!isApproverDistinctFromRequester(approvedBy, requestedBy)) {
    throw new SameApproverAsRequesterError(
      `gl-account-change-request: approved_by (${approvedBy}) must not equal requested_by (${requestedBy}).`,
    );
  }
}

/** True iff `status`/`rejectionReason` obey the brief's own rule: any status other than `'rejected'`
 *  is fine regardless of `rejectionReason`; a `'rejected'` status requires a non-null
 *  `rejectionReason`. Mirrors the DB CHECK `status = 'rejected' => rejection_reason is not null`
 *  verbatim (pg-reviewer round-1 finding 11). */
export function isRejectionReasonPresentWhenRejected(status: string, rejectionReason: string | null): boolean {
  return status !== 'rejected' || rejectionReason !== null;
}

/** Throws `MissingRejectionReasonError` iff `isRejectionReasonPresentWhenRejected` is false. */
export function assertRejectionReasonPresentWhenRejected(status: string, rejectionReason: string | null): void {
  if (!isRejectionReasonPresentWhenRejected(status, rejectionReason)) {
    throw new MissingRejectionReasonError(
      `gl-account-change-request: status='rejected' requires a non-null rejection_reason.`,
    );
  }
}

/** True iff a `create` request carries every column `billing.gl_accounts` declares NOT NULL —
 *  `proposedCode`/`proposedNameAr`/`proposedAccountType`. An `update` request is unconstrained by
 *  this rule (its proposed_* columns only cover the mutable fields being changed). Without this
 *  check, an Approve of an incomplete `create` request would fail late — past the partial unique
 *  index on `(entity_id, proposed_code)` too (pg-reviewer round-1 finding 7). */
export function isCreateRequestComplete(
  changeKind: 'create' | 'update',
  proposedCode: string | null,
  proposedNameAr: string | null,
  proposedAccountType: string | null,
): boolean {
  return (
    changeKind !== 'create' ||
    (proposedCode !== null && proposedNameAr !== null && proposedAccountType !== null)
  );
}

/** Throws `IncompleteCreateRequestError` iff `isCreateRequestComplete` is false. */
export function assertCreateRequestComplete(
  changeKind: 'create' | 'update',
  proposedCode: string | null,
  proposedNameAr: string | null,
  proposedAccountType: string | null,
): void {
  if (!isCreateRequestComplete(changeKind, proposedCode, proposedNameAr, proposedAccountType)) {
    throw new IncompleteCreateRequestError(
      `gl-account-change-request: change_kind='create' requires non-null proposed_code, ` +
        `proposed_name_ar and proposed_account_type.`,
    );
  }
}

/** True iff `status`/`approvedBy`/`approvedAt` avoid the three-valued-logic trap pg-reviewer round-1
 *  finding 6 named: `status = 'approved'` with a null `approvedBy` or a null `approvedAt` is NOT a
 *  valid combination — an approved row must always have a checker AND a decision timestamp. Any
 *  other status is unconstrained by this rule. Mirrors the DB CHECK `chk_glc_requests_decision_
 *  complete` (`status <> 'approved' or approved_by is not null`) PLUS the `glc_approver_update`
 *  policy's own WITH CHECK (`status <> 'approved' or approved_at is not null`) verbatim — round-2
 *  finding 4. `decidedAt` is deliberately NOT part of this check: it stays DB-only (set via SQL
 *  `now()` in the same statement as the decision, never passed from the app — CLAUDE.md "No ...
 *  new Date() in domain/"), so the application layer has nothing of its own to validate there. */
export function isDecisionComplete(
  status: string,
  approvedBy: string | null,
  approvedAt: string | null,
): boolean {
  return status !== 'approved' || (approvedBy !== null && approvedAt !== null);
}

/** Throws `IncompleteDecisionError` iff `isDecisionComplete` is false. */
export function assertDecisionComplete(
  status: string,
  approvedBy: string | null,
  approvedAt: string | null,
): void {
  if (!isDecisionComplete(status, approvedBy, approvedAt)) {
    throw new IncompleteDecisionError(
      `gl-account-change-request: status='approved' requires a non-null approved_by and approved_at.`,
    );
  }
}

/** True iff `changeKind`/`proposedCode` obey the round-3 fix-4 rule: `code` is immutable
 *  post-creation, so a `change_kind='update'` request must never carry a `proposed_code` — the DB's
 *  own `billing.assert_gl_account_change_approved()` requires `new.code = old.code` on update and
 *  never reads `proposed_code` there, so a `proposed_code` on an update request would otherwise be
 *  silently meaningless rather than rejected up front. Mirrors the DB CHECK
 *  `chk_glc_requests_update_no_code` (migration 0034) verbatim. */
export function isProposedCodeOnlyForCreate(
  changeKind: 'create' | 'update',
  proposedCode: string | null,
): boolean {
  return changeKind === 'create' || proposedCode === null;
}

/** Throws `ProposedCodeOnUpdateError` iff `isProposedCodeOnlyForCreate` is false. */
export function assertProposedCodeOnlyForCreate(
  changeKind: 'create' | 'update',
  proposedCode: string | null,
): void {
  if (!isProposedCodeOnlyForCreate(changeKind, proposedCode)) {
    throw new ProposedCodeOnUpdateError(
      `gl-account-change-request: change_kind='update' must not carry a proposed_code (code is ` +
        `immutable post-creation).`,
    );
  }
}
