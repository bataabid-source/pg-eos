# modules/billing/tests/accounting-periods/accounting-periods.feature — WBS 4.19 (lane 2).
#
# Acceptance (doc 38 v4.6 row 4.19, verbatim): "Posting into closed/locked period rejected by the DB"
# ADR-0004 lines served:
#   D1 5  — "Periods open/closed/locked per entity; the DB refuses posting into closed/locked periods."
#   D3 OD-12 — "Fiscal year end per entity; who closes, locks, reopens" — standing default
#              "Ask; CFO closes; reopen via Decision Inbox".
# SCR-ACC-01 rows served: #3 (new billing.fiscal_years, billing.accounting_periods) · #4
# (billing.journal_entries — period link; posting to closed/locked period refused).
# 4.19 pre-build review (2026-09-28) final design directives D1-D5, D8, D9 are cited inline below
# by their own id, wherever they change or narrow a default this file's Background/Scenarios rely on.
#
# Every `describe` title in ./accounting-periods.test.ts (and, for the two structural ones, also
# ./handlers.test.ts / ./invariants.property.integration.test.ts where noted) matches a Scenario title below
# EXACTLY (precedent: modules/billing/tests/dimensions/dimensions.feature).
#
# Every row used below is a synthetic/test fixture on the pilot chart (D-127) — no real fiscal
# year or period is ever composed by this slice; no fiscal-year end is seeded for any entity
# (OD-12 "Ask" default, recorded in the slice brief). Every integration test file picks its OWN
# synthetic fiscal year, strictly after any year already used by a previous file in the same run
# (4.19 pre-build review finding 1) — never 2026, never current_date.

Feature: Fiscal years and accounting periods (WBS 4.19)
  As the CFO (doc 38 v4.6 row 4.19 Owner)
  I want fiscal years and their accounting periods to move only through open -> closed -> locked,
    per entity, with the database itself refusing any posting into a closed or locked period
  So that the ledger of a closed period can never be silently changed (D1 5), and reopening a
    closed period always goes through the Decision Inbox, never a direct update (OD-12)

  Background:
    Given a synthetic pilot entity (D-127) and a second, different entity, each with their own
      fiscal year and their own accounting periods on the pilot chart — no real fiscal year or
      period is ever composed by this slice

  Scenario: A journal entry dated inside an open period of its entity is accepted
    Given an accounting period of the pilot entity in its default "open" status, covering a date
      range that includes a given entry_date
    When a billing.journal_entries row is inserted for the pilot entity with that entry_date
    Then the insert succeeds (D1 5: the DB refuses ONLY closed/locked periods, never an open one)

  Scenario: A journal entry dated inside a closed period is rejected by the database (not only the domain)
    Given an accounting period of the pilot entity that has been closed by the CFO (OD-12)
    When a billing.journal_entries row is inserted directly at the database, bypassing the
      application layer entirely, for the pilot entity with an entry_date inside that closed period
    Then the database itself refuses the insert with a CHECK/constraint-trigger violation
      (SQLSTATE 23514) — the acceptance line's own wording, "rejected by the DB", not merely by
      application code — and the SAME refusal happens through a genuine pgeos_app session, not
      only through the admin/superuser pool
    And an UPDATE of an existing journal entry's entry_date into that closed period, and a DELETE
      of a journal entry already dated inside it, are refused the same way
    And an entry on an open or uncovered date that is later UPDATED so its entry_date moves INTO
      the closed period is refused (D5: UPDATE checks both the old AND the new row)
    And changing an existing entry's entity_id to another entity whose OWN covering period for the
      SAME entry_date is closed is refused the same way (D5: the check follows entity_id too)
    And inserting, updating, or deleting a billing.journal_lines row of an entry dated inside the
      closed period is refused the same way (D5: the check reaches lines via their parent entry)

  Scenario: A journal entry dated inside a locked period is rejected by the database
    Given an accounting period of the pilot entity that has been closed and then locked by the CFO
      (D1 5: locked is reached only via closed)
    When a billing.journal_entries row is inserted directly at the database for the pilot entity
      with an entry_date inside that locked period
    Then the database itself refuses the insert (SQLSTATE 23514), exactly as for a closed period

  Scenario: Periods are per entity — closing a period of one entity leaves the other entities' periods open
    Given the pilot entity and a second, different entity, each with their own accounting period
      covering the SAME calendar date range
    When the pilot entity's period is closed by the CFO
    Then a journal entry dated inside that range is refused by the database for the pilot entity
    But a journal entry dated inside the SAME range is still accepted for the second entity, whose
      own covering period is still "open" (D1 5/D1 6: entity_id stays the hard scope)

  Scenario: Close is a CFO action (OD-12); every state change writes one outbox row and one audit row in the same transaction
    Given an open accounting period of the pilot entity
    When a caller who does not hold the CFO role attempts to close it, or to lock an already-closed
      one, or to create a fiscal year (4.19 pre-build review D2: create/close/lock are all CFO
      actions; only opening a period and requesting a reopen carry no role gate)
    Then every one of those requests is refused and nothing is written (no outbox row, no audit
      row, no status change), and the api layer maps each refusal to 403 with title "RoleRequiredError"
    And when the CFO closes the SAME period
    Then the period's status becomes "closed", exactly one platform.outbox row is written with
      event_type "billing.accounting_period.closed", and exactly one platform.audit_log row is
      written, in the same transaction as the status change
    And creating a fiscal year, opening a period, and locking a closed period each likewise write
      exactly one outbox row (billing.fiscal_year.created / billing.accounting_period.opened /
      billing.accounting_period.locked) and exactly one audit row

  Scenario: Reopen goes through the Decision Inbox (OD-12), never a direct update
    Given a closed accounting period of the pilot entity
    When any entity member requests that it be reopened (4.19 pre-build review D2: no role gate on
      the request itself)
    Then the period's status stays "closed" (the request alone never changes it), and exactly one
      platform.decisions row is inserted with kind "accounting_period_reopen", source_table
      "billing.accounting_periods", source_id equal to the period's id, status "open", context
      carrying periodVersion equal to the period's version at the moment of the request, and
      assigned_role read from the platform.approval_chains row seeded for
      ('accounting_period_reopen', step 1) by this slice's own migration (4.19 pre-build review D1
      — default "GM", never hard-coded independently of that row)
    And requesting a reopen of a period that is currently "open" or already "locked" is refused
      with a typed illegal-transition error, and files no decision row at all
    And a direct UPDATE of the period's status from "closed" to "open", issued at the database with
      no such decided/approved decision behind it, is refused (SQLSTATE 23514) — including once
      that same requester has approved their OWN request (self-approval never satisfies the check)
    And an approval by a DIFFERENT entity member who does not hold the chain's approver role (GM)
      is refused with a role error, and the period stays closed
    And once that platform.decisions row is decided with decision "approved" by a DIFFERENT user
      who holds the approver role (segregation of duties), applying that decision reopens the
      period — its status becomes "open", exactly one outbox row (billing.accounting_period.reopened)
      and one audit row are written
    But applying a decision approved by the SAME user who requested the reopen is refused (SoD),
      and the period stays "closed"
    And once the CFO closes that SAME period again, re-applying the very same decision a second
      time is refused as a stale replay (the decision's own recorded periodVersion no longer
      matches), and a direct database UPDATE by the very same approver is refused the same way
    And rolling the period's version back down to the decision's own recorded periodVersion, to try
      to defeat that stale-replay check, is itself refused (guard (a): a version decrease is never
      allowed), so the version never actually changes and the later status flip is refused too
    And applying an unknown decision id, a decision that is still "open" (not yet decided), or a
      decision that was decided "rejected", is refused as a typed illegal transition in every case —
      the period stays closed and nothing is written
    And a direct INSERT into platform.decisions of kind "accounting_period_reopen" whose own
      context claims a requestedBy DIFFERENT from the session's real caller is refused by the
      database (SQLSTATE 23514), and once a genuine reopen decision exists, its own kind, context,
      source_table, source_id, or entity_id can never be changed by an UPDATE (SQLSTATE 23514)

  Scenario: Stale version is rejected; idempotent replay returns the first result
    Given an open accounting period of the pilot entity at a known version
    When the CFO closes it with an expectedVersion that no longer matches the period's current
      version
    Then the request is refused with a version-conflict error and nothing is written
    And when the CFO closes a (different, still-open) period twice with the SAME Idempotency-Key
      and the SAME request body
    Then the second call returns the exact same result as the first, and the period's version is
      bumped exactly once (one billing.accounting_period.closed outbox row, not two)

  Scenario: RLS — a caller scoped to another entity cannot see or change this entity's periods
    Given a caller with no identity.user_entities row for the pilot entity (only for a different
      entity)
    When that caller queries billing.accounting_periods and billing.fiscal_years rows belonging to
      the pilot entity
    Then zero rows are returned for either table
    And when that caller attempts to UPDATE the pilot entity's own accounting_periods row
    Then the update affects zero rows, and the row is confirmed unchanged
    And when that caller attempts to INSERT a billing.accounting_periods row, or a billing.fiscal_years
      row, for the pilot entity
    Then both inserts are rejected by the row-level security policy
    And when that caller attempts to close one of the pilot entity's own periods (naming its real id)
    Then the request is refused as not found, exactly as if the period did not exist (RLS hides the
      row from the repository lookup entirely)

  Scenario: Design default (SCR-ACC-01 #4): a non-null period_id must be the actual covering period, else 23514
    Given two adjacent, non-overlapping open periods of the pilot entity
    When a billing.journal_entries row is inserted with an entry_date genuinely covered by the
      SECOND period, but period_id naming the FIRST period instead
    Then the database refuses the insert (SQLSTATE 23514), and the second period is left untouched
    And when a billing.journal_entries row is inserted with an entry_date covered by NO period at
      all, and period_id left null
    Then the insert succeeds (D5: an uncovered date with a null period_id is never refused)

  Scenario: Structural rules on fiscal_years and accounting_periods (D3/D4)
    Given the pilot entity's own fiscal years and accounting periods
    When the application's own createFiscalYear or openPeriod command hits one of these same
      structural refusals
    Then it surfaces as a typed error instead of a raw database error: FiscalYearOverlapError,
      PeriodOverlapError, PeriodOutsideFiscalYearError (each 23P01/23514 under the hood), or
      EntityNotInScopeError (42501 under the hood, for a caller not scoped to the target entity)
    And every status-changing UPDATE bumps the row's version by EXACTLY 1, or the database refuses
      it (SQLSTATE 23514) regardless of whether the edge itself would otherwise be legal — a
      version DECREASE is refused the same way, unconditionally
    When a second fiscal year is inserted for the SAME entity overlapping an existing one
    Then the insert is refused by an exclusion constraint (SQLSTATE 23P01)
    And when a second accounting period is inserted inside one fiscal year overlapping an existing
      period of the SAME entity
    Then the insert is refused by an exclusion constraint (SQLSTATE 23P01)
    And when an accounting period is inserted with a date range that falls outside its own fiscal
      year's range
    Then the insert is refused (SQLSTATE 23514)
    And when an accounting period is inserted naming a fiscal_year_id that belongs to a DIFFERENT entity
    Then the insert is refused by a foreign-key violation (SQLSTATE 23503)
    And when a fiscal year or an accounting period is inserted with start_date after end_date
    Then the insert is refused (SQLSTATE 23514)
    And when a genuine pgeos_app session attempts to UPDATE an accounting period's entity_id,
      fiscal_year_id, start_date, or end_date, or attempts to DELETE a period, or attempts to
      UPDATE or DELETE a fiscal year at all
    Then every one of those is refused by a permission error (SQLSTATE 42501), because the app
      role's grant is select/insert plus update(status, version) only on periods, and select/insert
      only on fiscal years
    And when the admin pool itself (bypassing every grant) attempts to change an accounting
      period's start_date or end_date
    Then the database still refuses it (SQLSTATE 23514) — those columns are immutable by a
      constraint trigger, not merely by grant
    And when the admin pool attempts to INSERT an accounting period with a status OTHER than "open"
    Then the insert is refused (SQLSTATE 23514)
    And, over the full 3x3 table of (from, to) status pairs reachable only through legal edges,
      every edge outside open->closed, closed->locked, closed->open (with a valid decision), and
      every same-status update, is refused (SQLSTATE 23514) at the database itself, independent of
      role
