// modules/billing/domain/gl-account-change-requests/invariants.ts — WBS 4.1a part 2 (widened by
// part 3: `deactivate`/`reactivate` change kinds + the deactivate/reactivate direction invariant).
//
// domain/ layer: pure invariant checks — no I/O, no Date, no Math.random() (CLAUDE.md · AGENT
// CONSTRAINTS). This slice's own NEW invariant is the change_kind/target_account_id pairing
// (brief's own three-valued-logic CHECK, covering all four change kinds: "create" needs a null
// target; "update", "deactivate" and "reactivate" each need a non-null one). WBS 4.1a part 3 also
// adds the deactivate/reactivate direction rule and the active-children deactivation rule, each the
// domain counterpart of a check in `billing.assert_gl_account_change_approved()` (migration 0036).
// The Master's ruling ("the proposed columns obey the same rules as gl_accounts... through
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
  InvalidDeactivateReactivateDirectionError,
  ActiveChildBlocksDeactivationError,
} from './errors.js';

/** Every `change_kind` value `billing.gl_account_change_requests` accepts — `create`/`update`
 *  (WBS 4.1a part 2) plus `deactivate`/`reactivate` (WBS 4.1a part 3, the widened
 *  `chk_glc_requests_change_kind` CHECK). */
export type GlAccountChangeKind = 'create' | 'update' | 'deactivate' | 'reactivate';

/** True iff `changeKind`/`targetAccountId` obey the brief's own pairing rule:
 *  `create` requires a null target (nothing exists yet to target); every other change kind —
 *  `update`, `deactivate` AND `reactivate` (WBS 4.1a part 3) — requires a non-null one (the existing
 *  billing.gl_accounts row being changed, deactivated or reactivated). Mirrors the widened DB CHECK
 *  `chk_glc_requests_change_kind_target` (`change_kind <> 'create'` on the non-null branch) verbatim
 *  so the application layer rejects a malformed Submit BEFORE any DB round-trip — pg-tester's own
 *  property test proves this function and the DB CHECK agree on every generated tuple. */
export function isValidChangeKindTargetPairing(
  changeKind: GlAccountChangeKind,
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
 *  post-creation, so any non-`create` request — `update`, `deactivate` or `reactivate` (WBS 4.1a
 *  part 3) — must never carry a `proposed_code`. The DB's own
 *  `billing.assert_gl_account_change_approved()` requires `new.code = old.code` on update and never
 *  reads `proposed_code` there, so a `proposed_code` on a non-create request would otherwise be
 *  silently meaningless rather than rejected up front. Only `changeKind === 'create'` is exempted.
 *  Mirrors the DB CHECK `chk_glc_requests_update_no_code` (migration 0034) verbatim. */
export function isProposedCodeOnlyForCreate(
  changeKind: GlAccountChangeKind,
  proposedCode: string | null,
): boolean {
  return changeKind === 'create' || proposedCode === null;
}

/** Throws `ProposedCodeOnUpdateError` iff `isProposedCodeOnlyForCreate` is false. */
export function assertProposedCodeOnlyForCreate(
  changeKind: GlAccountChangeKind,
  proposedCode: string | null,
): void {
  if (!isProposedCodeOnlyForCreate(changeKind, proposedCode)) {
    throw new ProposedCodeOnUpdateError(
      `gl-account-change-request: only change_kind='create' may carry a proposed_code ('update', ` +
        `'deactivate' and 'reactivate' must not — code is immutable post-creation); got ` +
        `change_kind='${changeKind}'.`,
    );
  }
}

/** The `is_active` value the target account must CURRENTLY hold for each direction-constrained
 *  change kind (WBS 4.1a part 3): `deactivate` only from active, `reactivate` only from inactive.
 *  A kind absent from this table (`create`/`update`) is unconstrained by the direction rule. */
const REQUIRED_CURRENT_IS_ACTIVE: Readonly<Partial<Record<GlAccountChangeKind, boolean>>> = {
  deactivate: true,
  reactivate: false,
};

/** True iff `changeKind` is compatible with the target account's current `is_active` (WBS 4.1a
 *  part 3): `deactivate` requires `currentIsActive === true`; `reactivate` requires
 *  `currentIsActive === false`; any other change kind returns `true` (unconstrained). Pure — no I/O,
 *  no Date; `currentIsActive` is a plain parameter supplied by the caller, never fetched here. The
 *  DB trigger `billing.assert_gl_account_change_approved()`'s own `old.is_active` check is its
 *  backstop. */
export function isValidDeactivateReactivateDirection(
  changeKind: GlAccountChangeKind,
  currentIsActive: boolean,
): boolean {
  const required = REQUIRED_CURRENT_IS_ACTIVE[changeKind];
  return required === undefined || required === currentIsActive;
}

/** Throws `InvalidDeactivateReactivateDirectionError` iff `isValidDeactivateReactivateDirection` is
 *  false. */
export function assertValidDeactivateReactivateDirection(
  changeKind: GlAccountChangeKind,
  currentIsActive: boolean,
): void {
  if (!isValidDeactivateReactivateDirection(changeKind, currentIsActive)) {
    throw new InvalidDeactivateReactivateDirectionError(
      `gl-account-change-request: 'deactivate' requires the target account to currently be active ` +
        `(is_active=true); 'reactivate' requires it to currently be inactive (is_active=false); got ` +
        `change_kind='${changeKind}' with current is_active=${String(currentIsActive)}.`,
    );
  }
}

/** True iff a `deactivate` of the target account is allowed by the active-children rule (WBS 4.1a
 *  part 3): an account with at least one active child account cannot be deactivated — its children
 *  must be deactivated first. Returns `false` iff `hasActiveChild` is true, `true` otherwise. Pure —
 *  no I/O, no Date; `hasActiveChild` is a plain parameter supplied by the caller, never queried here.
 *  Domain counterpart of the active-children check in the DB trigger
 *  `billing.assert_gl_account_change_approved()` (migration 0036), which remains its backstop. */
export function isDeactivationAllowed(hasActiveChild: boolean): boolean {
  return !hasActiveChild;
}

/** Throws `ActiveChildBlocksDeactivationError` iff `isDeactivationAllowed` is false. */
export function assertDeactivationAllowed(hasActiveChild: boolean): void {
  if (!isDeactivationAllowed(hasActiveChild)) {
    throw new ActiveChildBlocksDeactivationError(
      `gl-account-change-request: 'deactivate' requires the target account to have no active child ` +
        `account — deactivate the children first.`,
    );
  }
}
