# modules/billing/tests/gl-account-change-requests/gl-account-change-requests.feature — WBS 4.1a part 2
# + part 3.
#
# NOTE for whoever reads this file after scripts/new-slice.sh: the scaffolded copy of the golden
# slice's (wms/receive-inbound) own .feature/.test.ts content is REPLACED here — this slice is the
# maker/checker write path for billing.gl_accounts (docs/notes/slice-briefs/_slice-4.1a-part2.brief.md),
# not an inbound-order receiving flow.
#
# WBS 4.1a part 3 (docs/notes/slice-briefs/_slice-4.1a-part3.brief.md) widens `change_kind` to also
# carry 'deactivate'/'reactivate', backed by a real `billing.gl_accounts.is_active` column — see the
# new scenarios at the end of this file. Non-zero-balance enforcement is explicitly OUT of scope here
# (deferred to WBS 4.20/4.23, per the Master's own prior ruling) — this part enforces only the
# maker/checker path itself and the active-children rule.
#
# Every scenario below is exercised by ./gl-account-change-requests.test.ts (DB-level: table CHECKs,
# the shared code-format/account-type function, the composite FK, the partial unique indexes) and/or
# ./machine.unit.test.ts (the pure XState v5 status machine) and/or ./invariants.property.test.ts
# (domain <-> DB agreement) and/or ./invariants.unit.test.ts and ./contract.test.ts (part 3's new
# pure invariant and widened Zod refines).

Feature: GL account changes require a maker (ACCOUNTANT) and a checker (CFO) — WBS 4.1a part 2
  As a CFO and an ACCOUNTANT
  I want every change to billing.gl_accounts to go through a change-request row that a maker
    submits and a different checker approves or rejects
  So that no single person can create or modify the chart of accounts unilaterally

  Background:
    Given entity "PST" and an existing billing.gl_accounts chart (WBS 4.1a part 1)
    And billing.gl_account_change_requests carries change_kind in ('create','update','deactivate',
      'reactivate') — the latter two land in WBS 4.1a part 3, backed by billing.gl_accounts.is_active
    And requested_by/approved_by are never the same user (CHECK, and structurally via the
      pre-existing (CFO,ACCOUNTANT) identity.sod_rules row)

  Scenario: An ACCOUNTANT submits a create request; a gl_accounts row does NOT yet exist
    Given no billing.gl_accounts row exists yet for the proposed code
    When the ACCOUNTANT submits a change_kind='create' request with proposed_code/proposed_name_ar/
      proposed_account_type and status becomes 'pending_approval'
    Then no billing.gl_accounts row is written for that proposed code
    And the request row itself is the only trace of the proposal

  Scenario: The CFO approves a pending create request; the gl_accounts row is inserted in the SAME transaction
    Given a 'pending_approval' create request submitted by the ACCOUNTANT
    When the CFO approves it
    Then, in ONE transaction, a billing.gl_accounts row is inserted from the request's proposed_*
      columns AND the request row is updated to status='approved', approved_by=<CFO>, approved_at=<now>
    # Audit-row coverage (ONE platform.audit_log row naming both the CFO as user_id and the
    # ACCOUNTANT as requested_by in its new_value JSONB) is deferred to part 2b's real Approve
    # command — no Approve command exists yet in this part, so this scenario does not assert on
    # audit_log (round-1 finding 1: a scenario must not insert an audit row itself and then assert
    # what it just wrote).

  Scenario: The CFO rejects a pending request; no gl_accounts row is ever written; rejection_reason is required
    Given a 'pending_approval' request
    When the CFO rejects it without a rejection_reason
    Then the database CHECK (status='rejected' => rejection_reason is not null) rejects the write
    When the CFO rejects it WITH a rejection_reason
    Then the request row becomes status='rejected' and no billing.gl_accounts row is ever written for it

  Scenario: An off-format proposed_code is rejected by the shared code-format function's CHECK, same rule as gl_accounts itself
    Given a create request whose proposed_code does not match X-XX-XXX-XXX (class 1-9)
    When the request row is inserted
    Then it is rejected by billing.is_valid_gl_account_code()'s own CHECK — SQLSTATE 23514 (check_violation),
      the same shared function billing.gl_accounts.code itself is checked against (0028_2 refactored
      to call it)

  Scenario: A proposed_parent_id in a different entity is rejected (composite FK, not a CHECK — Master ruling)
    Given an existing billing.gl_accounts row that belongs to a DIFFERENT entity than the request's own entity_id
    When an update request proposes that row as proposed_parent_id
    Then it is rejected by the composite foreign key
      (proposed_parent_id, entity_id) references billing.gl_accounts (id, entity_id) —
      SQLSTATE 23503 (foreign_key_violation), NOT 23514 — structurally impossible to propose a
      parent outside the request's own entity

  Scenario: The same user cannot be both requested_by and approved_by (CHECK, and structurally via the pre-existing CFO/ACCOUNTANT sod_rules row)
    Given a request whose requested_by is user U
    When the same user U is written as approved_by (directly, at the row level)
    Then the database CHECK (approved_by is null or approved_by <> requested_by) rejects it —
      SQLSTATE 23514 — defense-in-depth behind identity.sod_rules' own (CFO,ACCOUNTANT) row, which
      already makes it structurally impossible for one identity to hold both roles

  Scenario: A second pending request for the same target_account_id (or the same proposed create code) is rejected by the partial unique index
    Given a first 'pending_approval' update request naming target_account_id T
    When a second 'pending_approval' request also names target_account_id T
    Then it is rejected by the partial unique index on (target_account_id) where status='pending_approval'
    Given a first 'pending_approval' create request proposing code C for entity_id E
    When a second 'pending_approval' create request also proposes code C for the SAME entity_id E
    Then it is rejected by the partial unique index on (entity_id, proposed_code) where
      status='pending_approval' and change_kind='create'

  Scenario: The requester cancels their own still-pending request; an approver-only or a non-owner cancel attempt is rejected
    Given a 'pending_approval' request submitted by the ACCOUNTANT (requested_by = A)
    When the ACCOUNTANT (A) cancels it
    Then the domain machine allows pending_approval -> cancelled and the status becomes 'cancelled'
    When a DIFFERENT user (the CFO, or any non-owner) attempts to cancel the SAME still-pending request
    Then the domain machine (or its ownership guard) rejects the attempt before any DB call —
      only the requester may cancel their own request

  Scenario: An illegal status transition (e.g. approved -> pending_approval) is rejected by the domain machine before it ever reaches the DB
    Given a request already in status 'approved' (or 'rejected'/'cancelled' — every terminal state)
    When any further transition event is sent to the domain machine
    Then it is rejected by the machine itself — IllegalTransitionError — before any DB call is made
    And the DB status CHECK is the backstop, never the primary enforcement

  # ── WBS 4.1a part 3 — deactivate/reactivate lifecycle (docs/notes/slice-briefs/_slice-4.1a-part3.brief.md) ──

  Scenario: A deactivate request follows the same maker/checker path as create/update
    Given an existing billing.gl_accounts row with is_active=true and no active children
    When an ACCOUNTANT submits a change_kind='deactivate' request naming that row as target_account_id
      and a CFO approves it
    Then, in ONE transaction, billing.gl_accounts.is_active is set to false for that row AND the
      request row becomes status='approved'
    And no other mutable column (name_ar/name_en/account_type/parent_id/is_postable) is touched by
      this write — deactivate/reactivate touch is_active ONLY

  Scenario: A reactivate request follows the same maker/checker path
    Given an existing billing.gl_accounts row with is_active=false
    When an ACCOUNTANT submits a change_kind='reactivate' request naming that row as target_account_id
      and a CFO approves it
    Then, in ONE transaction, billing.gl_accounts.is_active is set to true for that row AND the
      request row becomes status='approved'

  Scenario: Deactivating a gl_account that has an active child account is rejected by the database
    Given a billing.gl_accounts row P that is the parent_id of another billing.gl_accounts row C,
      and C.is_active is true
    When any write attempts to set P.is_active from true to false
    Then it is rejected — SQLSTATE 23514 (check_violation), the message naming P's own id
    And this check is unconditional (it fires even for current_user <> 'pgeos_app' — a data-integrity
      invariant, not a maker/checker four-eyes rule, so seed/import must obey it too)

  Scenario: Deactivating a gl_account whose children are already inactive succeeds
    Given a billing.gl_accounts row P that is the parent_id of another billing.gl_accounts row C,
      and C.is_active is already false
    When an approved deactivate request sets P.is_active from true to false
    Then the write succeeds — no active child blocks it

  Scenario: Reactivating an already-active account, or deactivating an already-inactive one, is rejected (direction mismatch)
    Given a billing.gl_accounts row whose current is_active value already matches the direction being
      requested (is_active=true and change_kind='reactivate', OR is_active=false and
      change_kind='deactivate')
    When the pure domain invariant isValidDeactivateReactivateDirection(changeKind, currentIsActive)
      is evaluated
    Then it returns false, and assertValidDeactivateReactivateDirection throws
      InvalidDeactivateReactivateDirectionError before any DB round-trip — the DB trigger's own
      old.is_active check is the backstop, never the primary enforcement

  Scenario: A deactivate/reactivate request cannot carry a proposedCode
    Given a change_kind='deactivate' or change_kind='reactivate' request
    When the request carries a non-null proposedCode
    Then it is rejected — by the DB CHECK chk_glc_requests_update_no_code (SQLSTATE 23514, the same
      rule that already forbids it for 'update') and by the widened Zod contract refine at the API
      boundary — deactivate/reactivate need no proposed_* column at all, the direction is implied
      entirely by change_kind + the target's current is_active
