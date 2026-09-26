// modules/billing/domain/gl-account-change-requests/errors.ts — WBS 4.1a part 2.
//
// Typed errors for the gl_account_change_requests maker/checker write path
// (docs/notes/slice-briefs/_slice-4.1a-part2.brief.md). Every class sets `name` explicitly
// (CLAUDE.md · AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free
// at runtime. This slice ships domain + migration only this round (no application/api layer — see
// the brief's own part 2a/2b split note); these errors are the ones the domain layer
// (./machine.ts, ./invariants.ts) throws BEFORE any DB round-trip — WBS 4.1a part 3 adds
// InvalidDeactivateReactivateDirectionError and ActiveChildBlocksDeactivationError.

/** The gl_account_change_requests state machine (./machine.ts) rejected the requested event from
 *  the request's current status — e.g. CANCEL from 'approved', or SUBMIT from 'pending_approval'.
 *  The database's own `status` CHECK constraint is the backstop, never the only line of defence. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** `assertCancelAllowed` (./machine.ts): the CANCEL transition is legal from the request's current
 *  status, but the caller (`actorId`) is not the request's own `requestedBy` — only the requester
 *  may cancel their own still-pending request (the brief's own ownership scenario: "An approver-only
 *  or a non-owner cancel attempt is rejected"). Checked AFTER the machine-transition check, never
 *  before — a non-owner cancelling from a terminal state gets IllegalTransitionError instead. */
export class NotRequesterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotRequesterError';
  }
}

/** `assertApproverDistinctFromRequester` (./invariants.ts): the same user cannot be both
 *  `requested_by` and `approved_by` on a row — pg-reviewer round-1 finding 11's domain equivalent of
 *  the DB CHECK `approved_by is null or approved_by <> requested_by` (brief "Schema design", the
 *  maker/checker row-level CHECK; defense-in-depth alongside the pre-existing (CFO,ACCOUNTANT)
 *  sod_rules row). */
export class SameApproverAsRequesterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SameApproverAsRequesterError';
  }
}

/** `assertRejectionReasonPresentWhenRejected` (./invariants.ts): `status = 'rejected'` requires a
 *  non-null `rejection_reason` — pg-reviewer round-1 finding 11's domain equivalent of the DB CHECK
 *  `status = 'rejected' => rejection_reason is not null` (brief "Schema design"). */
export class MissingRejectionReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingRejectionReasonError';
  }
}

/** `assertCreateRequestComplete` (./invariants.ts): a `create` request must carry non-null
 *  `proposed_code`/`proposed_name_ar`/`proposed_account_type` — `billing.gl_accounts` declares these
 *  columns NOT NULL, so an Approve of an incomplete `create` request would fail late, past the
 *  partial unique index too (pg-reviewer round-1 finding 7). */
export class IncompleteCreateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteCreateRequestError';
  }
}

/** `assertDecisionComplete` (./invariants.ts): `status = 'approved'` with `approved_by is null` or
 *  `approved_at is null` is NOT a valid combination — a three-valued-logic trap the DB CHECK
 *  `chk_glc_requests_decision_complete` (approved_by) and the `glc_approver_update` policy's own
 *  WITH CHECK (approved_at) close (pg-reviewer round-1 finding 6, round-2 finding 4); this is their
 *  domain-level equivalent, checked before any DB round-trip. */
export class IncompleteDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteDecisionError';
  }
}

/** `assertProposedCodeOnlyForCreate` (./invariants.ts): only a `change_kind='create'` request may
 *  carry a `proposed_code`; any non-create kind — `update`, `deactivate` or `reactivate` (WBS 4.1a
 *  part 3) — must not. `code` is immutable post-creation (the DB's own
 *  `billing.assert_gl_account_change_approved()` requires `new.code = old.code` on update and never
 *  reads `proposed_code` there), so a `proposed_code` on a non-create request would be silently
 *  meaningless rather than rejected. The class keeps its original name for API stability. Domain-level equivalent of the DB CHECK
 *  `chk_glc_requests_update_no_code` (migration 0034, round-3 fix 4). */
export class ProposedCodeOnUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposedCodeOnUpdateError';
  }
}

/** `assertValidDeactivateReactivateDirection` (./invariants.ts, WBS 4.1a part 3): a `deactivate`
 *  request targets an account that is already inactive, or a `reactivate` request targets one that
 *  is already active. Domain-level counterpart of the `old.is_active` check in the DB trigger
 *  `billing.assert_gl_account_change_approved()`, checked before any DB round-trip. */
export class InvalidDeactivateReactivateDirectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDeactivateReactivateDirectionError';
  }
}

/** `assertDeactivationAllowed` (./invariants.ts, WBS 4.1a part 3): a `deactivate` request targets an
 *  account that has at least one active child account — an account cannot be deactivated while any
 *  child is still active; deactivate the children first. Domain-level counterpart of the
 *  active-children check in the DB trigger `billing.assert_gl_account_change_approved()` (migration
 *  0036), checked before any DB round-trip. */
export class ActiveChildBlocksDeactivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActiveChildBlocksDeactivationError';
  }
}
