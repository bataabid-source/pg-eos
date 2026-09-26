# modules/billing/tests/gl-account-change-requests/gl-account-change-requests.feature — WBS 4.1a part 2.
#
# NOTE for whoever reads this file after scripts/new-slice.sh: the scaffolded copy of the golden
# slice's (wms/receive-inbound) own .feature/.test.ts content is REPLACED here — this slice is the
# maker/checker write path for billing.gl_accounts (docs/notes/slice-briefs/_slice-4.1a-part2.brief.md),
# not an inbound-order receiving flow. `deactivate`/`reactivate` are OUT OF SCOPE this part (deferred
# to WBS 4.1a part 3 — a real `billing.gl_accounts.is_active` column) — `change_kind` is only
# 'create'/'update' here.
#
# Every scenario below is exercised by ./gl-account-change-requests.test.ts (DB-level: table CHECKs,
# the shared code-format/account-type function, the composite FK, the partial unique indexes) and/or
# ./machine.unit.test.ts (the pure XState v5 status machine) and/or ./invariants.property.test.ts
# (domain <-> DB agreement).

Feature: GL account changes require a maker (ACCOUNTANT) and a checker (CFO) — WBS 4.1a part 2
  As a CFO and an ACCOUNTANT
  I want every change to billing.gl_accounts to go through a change-request row that a maker
    submits and a different checker approves or rejects
  So that no single person can create or modify the chart of accounts unilaterally

  Background:
    Given entity "PST" and an existing billing.gl_accounts chart (WBS 4.1a part 1)
    And billing.gl_account_change_requests carries change_kind in ('create','update') only —
      'deactivate'/'reactivate' are deferred to WBS 4.1a part 3
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
