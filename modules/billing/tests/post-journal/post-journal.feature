# modules/billing/tests/post-journal/post-journal.feature — WBS 4.20 (lane 2).
#
# Acceptance (doc 38 v4.6 row 4.20, verbatim): "Unbalanced entry refused at commit; UPDATE/DELETE on
# posted refused; G2 = 0". Phase 4 gate: "4.20 immutability test green".
# ADR-0004 lines served (ADR = docs/adr/ADR-0004-general-ledger-single-source.md):
#   D1 2 — "One posting service; automatic journals via an outbox subscriber; no module writes journal rows directly."
#   D1 3 — "Balance enforced at commit; G2 stays as backstop."
#   D1 4 — "Posted entries immutable (REVOKE UPDATE/DELETE, no cascade); corrections only by reversal/adjustment with an audit row (ADR-0002)."
#   D3 OD-15 — "Manual journals allowed except revenue accounts; CFO approval".
#   Consequences 4 — the journal_lines -> journal_entries `on delete cascade` (01:1204) and the missing REVOKE are fixed here.
# SCR-ACC-01 rows: #5 entry type + approval columns · #6 balance enforced at commit · #7 posted immutable,
#   cascade removed · #8 account in the entry's entity and is_postable.
# Settled design (pre-migration review, 2026-09-29) = "DESIGN" below: T1/T2 deferred balance triggers,
#   T3 account trigger, T4/T5 immutability triggers, T6 billing.mark_journal_reversed, T7 period-check
#   carve-out. DEFAULT F1: part 1 refuses EVERY manual journal (approved manual path = 4.20 part 2).
#
# Every `describe` title in ./post-journal.test.ts matches a Scenario title below EXACTLY (precedent:
# ../accounting-periods/accounting-periods.feature). D-183: no DELETE commits outside this suite's own
# afterAll, which removes only its own tracked rows — refusals are asserted from the catalog and from
# always-rolled-back transactions; no TRUNCATE is ever run.

Feature: Posting engine (WBS 4.20)
  As the CFO (doc 38 v4.6 row 4.20 Owner)
  I want every journal entry to be posted by one service, balanced at commit and immutable once posted
  So that the ledger is a single, append-only source and a correction is always a new entry (D1 2-4)

  Background:
    Given the pilot entity (PST), a second different entity (PCC), a synthetic fiscal year with open
      accounting periods for the pilot entity, and postable GL accounts of the pilot entity
    And each entity has its own platform.counters 'JE' row

  Scenario: A balanced entry posts through the posting service with one outbox row and one audit row in the same transaction
    Given a caller scoped to the pilot entity and a balanced entry of two lines with entry type "accrual"
    When PostJournal is called with a correlation id
    Then the entry exists with posted_at and posted_by set, version 1, entry_type "accrual", a doc_no from platform.next_doc_no (D1 2)
    And exactly one platform.outbox row "billing.journal_entry.posted" and one platform.audit_log row carry the correlation id (D1 4: audit row; ADR-0002)
    And the lines are stored with the given debit and credit decimal strings (no float)

  Scenario: An unbalanced entry is refused at COMMIT by the deferred constraint trigger (#6), even when written line by line
    Given a transaction that inserts an entry and then its lines one statement at a time, with sum(debit) <> sum(credit)
    When the transaction commits
    Then the commit is refused with SQLSTATE 23514 naming chk_journal_entry_balanced (D1 3, acceptance line 1)
    And no row of the entry persists
    And the same entry written line by line with sum(debit) = sum(credit) commits (the trigger checks at COMMIT, not per statement)
    And PostJournal with an unbalanced entry is refused by the domain with UnbalancedEntryError and writes nothing

  Scenario: UPDATE on a posted entry or its lines is refused for pgeos_app (REVOKE, #7)
    Given a posted entry with its lines
    Then pgeos_app holds no UPDATE and no TRUNCATE privilege on billing.journal_entries and billing.journal_lines (catalog, D1 4)
    And an UPDATE issued as pgeos_app on the entry and on a line is refused with SQLSTATE 42501 in a rolled-back transaction
    And the same UPDATE issued as the table owner is refused with SQLSTATE 23514 by the immutability trigger (T4, T5) in a rolled-back transaction
    And a statement-level BEFORE TRUNCATE trigger exists on each table (catalog; no TRUNCATE is ever run on the shared DB, D-183)

  Scenario: DELETE on a posted entry or its lines is refused for pgeos_app (REVOKE, #7)
    Given a posted entry with its lines
    Then pgeos_app holds no DELETE privilege on billing.journal_entries and billing.journal_lines (catalog, D1 4)
    And a DELETE issued as pgeos_app on the entry and on a line is refused with SQLSTATE 42501 in a rolled-back transaction
    And the same DELETE issued as the table owner is refused with SQLSTATE 23514 by the immutability trigger (T4, T5) in a rolled-back transaction
    And no DELETE commits outside this suite's own afterAll, which removes only its own tracked rows (D-183)

  Scenario: The journal_lines -> journal_entries FK no longer cascades on delete — asserted from the catalog (`pg_constraint.confdeltype <> 'c'`), no DELETE runs on the shared DB (D-183) (#7 · 01:1204)
    When pg_constraint is read for the foreign key from billing.journal_lines.entry_id to billing.journal_entries
    Then its confdeltype is not 'c' (Consequences 4)
    And the balance constraint triggers (T1, T2), the account trigger (T3), the immutability triggers (T4, T5) and billing.mark_journal_reversed (T6, SECURITY DEFINER, executable by pgeos_app and not by PUBLIC) exist in the catalog
    And the journal_lines RLS policy is scoped through its parent entry, and a unique partial index on reversed_by exists

  Scenario: A line whose account belongs to another entity is refused (#8)
    Given a GL account of the second entity and a caller scoped to both entities
    When a line of a pilot-entity entry references that account, through the database and through PostJournal
    Then the database refuses the line with SQLSTATE 23514 (T3)
    And PostJournal refuses it with AccountNotInEntityError and writes nothing

  Scenario: A line on an account with is_postable = false is refused (#8)
    Given a GL account of the pilot entity with is_postable = false
    When a line references that account, through the database and through PostJournal
    Then the database refuses the line with SQLSTATE 23514 (T3)
    And PostJournal refuses it with AccountNotPostableError and writes nothing

  Scenario: A correction is a reversal or adjustment entry, never an edit (D1 4)
    Given a posted entry
    When ReverseJournal is called with the entry's current version
    Then a new posted entry of type "reversing" exists whose lines mirror the original (same accounts, debit and credit swapped) and it balances
    And the original entry's reversed_by names it and its version is bumped by one, pgeos_app can set it only through billing.mark_journal_reversed (T6)
    And exactly one outbox row "billing.journal_entry.reversed" and at least one audit row carry the correlation id
    And billing.mark_journal_reversed, called as pgeos_app, is refused with SQLSTATE 23514 when the second entry is an "adjustment", when its lines do not mirror the original, when the expected version is stale, and for a caller scoped to another entity
    And a direct UPDATE of reversed_by by pgeos_app is refused (42501) and by the owner without the version bump is refused (23514)
    When AdjustJournal is called with new lines
    Then a new posted entry of type "adjustment" exists, the original entry is unchanged, and one outbox row "billing.journal_entry.adjusted" is written

  Scenario: A manual journal to a revenue account is refused; other manual journals need CFO approval (OD-15)
    Given the database CHECK constraints of the DESIGN
    Then a manual entry without approved_by is refused with SQLSTATE 23514
    And a manual entry that has approved_by and approved_at but touches an account of type "revenue" is refused with SQLSTATE 23514 (T3)
    And approved_by and approved_at must be both null or both set (23514)

  Scenario: Posting into a closed or locked period is refused (4.19 carried)
    Given an accounting period of the pilot entity that is closed, and another that is locked
    When PostJournal targets either period
    Then it is refused with PeriodNotOpenError and nothing is written (4.19, ADR-0004 D1 5)

  Scenario: Stale version is rejected; idempotent replay returns the first result
    Given a posted entry at version 1
    When ReverseJournal is called with expectedVersion 999 (the same constant the test sends)
    Then it is refused with StaleVersionError and nothing is written
    When PostJournal is called twice with the same Idempotency-Key and body
    Then the second result equals the first and exactly one entry and one outbox row exist

  Scenario: RLS — a caller scoped to another entity cannot post, see or reverse this entity's entries
    Given a caller scoped only to the second entity
    Then it sees zero journal_entries and zero journal_lines of the pilot entity
    And a direct INSERT of a pilot-entity entry is refused with SQLSTATE 42501
    And PostJournal for the pilot entity is refused with EntityNotInScopeError
    And ReverseJournal of a pilot-entity entry is refused with JournalEntryNotFoundError

  Scenario: Reversal of an entry in a closed period succeeds (T7)
    Given a posted entry in a period that has since been closed and an open period for the reversing entry
    When ReverseJournal targets the open period
    Then the reversal succeeds, the original is marked reversed, and the reversing entry sits in the open period (DESIGN T7)

  Scenario: A second reversal of the same entry is refused
    Given an entry that has already been reversed
    When ReverseJournal is called again with the entry's now-current version
    Then it is refused with AlreadyReversedError and nothing is written (DESIGN: guard "not already reversed"; unique reversed_by index)

  Scenario: An entry with zero lines is refused at commit
    Given a transaction that inserts an entry and no line
    When the transaction commits
    Then the commit is refused with SQLSTATE 23514 naming chk_journal_entry_balanced (DESIGN T1: at least two lines)
    And PostJournal with zero lines is refused with InsufficientLinesError

  Scenario: Part 1 refuses every manual journal — revenue with a typed error, otherwise approval required
    Given DEFAULT F1 of the DESIGN
    When PostJournal is called with entry type "manual" and a line on a revenue account
    Then it is refused with ManualRevenueJournalRefusedError (OD-15)
    When PostJournal is called with entry type "manual" and no revenue account
    Then it is refused with ManualJournalApprovalRequiredError (OD-15: CFO approval; approved path is 4.20 part 2)
    And nothing is written in either case

  Scenario: Other-entity lines are invisible
    Given a posted pilot-entity entry with lines and a caller scoped only to the second entity
    Then a select on billing.journal_lines by entry id returns zero rows (DESIGN: journal_lines policy scoped via the parent entry)
    And a caller scoped to the pilot entity sees the same lines

  Scenario: G2 billing.verify_journal_balance() returns zero rows after the suite
    When guard G2 billing.verify_journal_balance() is called after every entry this file posted
    Then it returns zero rows (D1 3: "G2 stays as backstop")
