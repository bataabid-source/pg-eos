# SLICE BRIEF — WBS 4.20 · Posting engine: entry types, reversal/adjustment, balance at commit, posted immutable

Task: 4.20 "Posting engine: entry types, reversal/adjustment, balance at commit, posted immutable"      Lane: 2      Lock: `billing` (whole module — lane 2's lock under ADR-0004 D2 (e); the Master records the task change in `tasks/LANE_LOCKS.md`)
Owner: CFO      Deps: 4.19, 4.1b (doc 38 v4.6)      Worktree: `../pg-eos-lane-2`
Model routing: pg-tester sonnet → pg-backend sonnet → pg-tester verify → pg-reviewer opus (mandatory BEFORE the migration: it touches the ledger's grants and the audit chain) → pg-scribe sonnet. Budget: brief ≤ 8 files / 1,000 lines, two review rounds (D-186).
Use case: `post-journal` — `scripts/new-slice.sh billing post-journal` (golden-slice replication; hand-made tree = review FAIL).

## Acceptance (doc 38 v4.6 row 4.20, verbatim)
"Unbalanced entry refused at commit; UPDATE/DELETE on posted refused; G2 = 0"
Phase 4 gate (doc 38 v4.6): "4.20 immutability test green".

## ADR-0004 decision lines this slice serves (verbatim)
- D1 2: "One posting service; automatic journals via an outbox subscriber; no module writes journal rows directly."
- D1 3: "Balance enforced at commit; G2 stays as backstop."
- D1 4: "Posted entries immutable (REVOKE UPDATE/DELETE, no cascade); corrections only by reversal/adjustment with an audit row (ADR-0002)."
- D2 (e): "lane 2 takes the accounting core (4.1a → 4.1b → 4.19 → 4.20) after WBS 4.2, under its existing `billing` lock".
- D3 OD-15: "Manual journals allowed except revenue accounts; CFO approval".
- Consequences 4: "**Existing defect fixed in 4.20:** the `journal_lines` → `journal_entries` `on delete cascade` (01:1204) and the missing REVOKE UPDATE/DELETE on the journal tables. Harmless today (0 journal rows); must be fixed before the first posting."
- Consequences 6: the accounting core touches `database/schema/*` and `packages/events` (frozen during any parallel phase) — any catalog or schema-file change is a Master task.

## SCR-ACC-01 rows (verbatim from A0 §3)
- #5 `billing.journal_entries` (01:1189) — "Entry type; approved by/at (posted_at/by exist, 01:1197)"
- #6 `billing.journal_entries/lines` — "Balance enforced at commit (constraint trigger), not only G2"
- #7 `billing.journal_lines.entry_id … on delete cascade` (01:1204); no REVOKE on journals — "Posted entries immutable (doc 40 P3); cascade removed"
- #8 `billing.journal_lines.account_id` (01:1205) — "Account in the entry's entity and `is_postable`"
Entry types named by A0 §1 row 4 (verbatim): "manual/recurring/reversing/adjustment/accrual/prepayment/closing".

## Read ONLY (workers) — 8 files, within the 8-file / 1,000-line budget
- `CLAUDE.md`
- `.claude/briefs/billing.brief.md` lines 1-100
- `docs/adr/ADR-0004-general-ledger-single-source.md` lines 19-29, 36-36, 48-49, 64-64, 88-94
- `docs/notes/SCR-ACC-01-accounting-core.md` lines 14-15, 20-23, 50-51, 55-55
- `database/schema/01-Data-Model.sql` lines 1176-1213, 1537-1547
- `database/migrations/0007_M_pgeos-app-role-entity-scope.sql` lines 108-116
- `database/migrations/0015_2_platform-sites.sql` lines 96-134
- `modules/wms/domain/receive-inbound/machine.ts`

Write ONLY: `modules/billing/{domain,application,infrastructure,api,tests}/post-journal/**` · `packages/contracts/billing/post-journal.ts` · `packages/i18n/<lang>/billing.json` (post-journal keys only) · `database/migrations/NNNN_2_post-journal.sql` (number issued by the Master) · `tests/**`. pg-tester writes only test files; builders never touch a test. Not `database/schema/*` (01:1204 is corrected by the forward migration, never by editing 01).

## Golden-slice counterparts (produced by `new-slice.sh`, edited in place — not reference reads)
`modules/wms/domain/receive-inbound/{machine.ts,errors.ts,invariants.ts}` → `modules/billing/domain/post-journal/*` · `modules/wms/application/receive-inbound/*` → `modules/billing/application/post-journal/*` · `modules/wms/infrastructure/receive-inbound/{repository.ts,ledger.ts,logger.ts}` → `modules/billing/infrastructure/post-journal/*` (`ledger.ts` is the append-only book counterpart) · `modules/wms/api/receive-inbound/*` → `modules/billing/api/post-journal/*` · `modules/wms/tests/receive-inbound/*` → `modules/billing/tests/post-journal/*` · `packages/contracts/wms/receive-inbound.ts` → `packages/contracts/billing/post-journal.ts`.

## RED tests (SCR-ACC-01 §3 — must exist before the migration file)
`modules/billing/tests/post-journal/post-journal.feature` · `modules/billing/tests/post-journal/post-journal.test.ts` · `modules/billing/tests/post-journal/journal-machine.unit.test.ts` · `modules/billing/tests/post-journal/invariants.property.test.ts`

Scenario (Gherkin outline — pg-tester writes the full `.feature`; every Then traces to the acceptance line or an ADR line above):
```gherkin
Feature: Posting engine (WBS 4.20)
  Scenario: A balanced entry posts through the posting service with one outbox row and one audit row in the same transaction
  Scenario: An unbalanced entry is refused at COMMIT by the deferred constraint trigger (#6), even when written line by line
  Scenario: UPDATE on a posted entry or its lines is refused for pgeos_app (REVOKE, #7)
  Scenario: DELETE on a posted entry or its lines is refused for pgeos_app (REVOKE, #7)
  Scenario: The journal_lines → journal_entries FK no longer cascades on delete — asserted from the catalog (`pg_constraint.confdeltype <> 'c'`), no DELETE runs on the shared DB (D-183) (#7 · 01:1204)
  Scenario: A line whose account belongs to another entity is refused (#8)
  Scenario: A line on an account with is_postable = false is refused (#8)
  Scenario: A correction is a reversal or adjustment entry, never an edit (D1 4)
  Scenario: A manual journal to a revenue account is refused; other manual journals need CFO approval (OD-15)
  Scenario: Posting into a closed or locked period is refused (4.19 carried)
  Scenario: G2 billing.verify_journal_balance() returns zero rows after the suite
  Scenario: Stale version is rejected; idempotent replay returns the first result
  Scenario: RLS — a caller scoped to another entity cannot post, see or reverse this entity's entries
```
Property test: for any generated set of lines, commit succeeds ⇔ sum(debit) = sum(credit) per entry, and G2 stays empty.

Contract: `packages/contracts/billing/post-journal.ts` — derive from 01:1188-1213 and SCR-ACC-01 #5–#8; no field that is not a column of the migration.
Screen/Board spec: none this slice (API + DB only; automatic posting from billing events is 4.11).
Deliver: the file list printed by `scripts/new-slice.sh billing post-journal` (paste it here when run) + `database/migrations/NNNN_2_post-journal.sql`, which: drops and re-adds the `journal_lines.entry_id` FK without `on delete cascade` · `revoke update, delete on billing.journal_entries, billing.journal_lines from pgeos_app` (0007:114-116 pattern) · adds the #5 entry-type and approval columns with classification rows · adds the #6 deferred constraint trigger (balance checked at commit) · adds the #8 trigger (account in the entry's entity and `is_postable`).
Migration number: requested — lane 2 lists it in `tasks/backlog/MIGRATION-REQUEST-2.md` with the RED paths above (D-179 batch); not issued.

## Defaults taken (recorded in CHANGELOG with the slice)
- Journal lifecycle states are not named in A0 or ADR-0004 and 01 has no status column. Default: the XState machine uses what the columns already express — posted (`posted_at`) and reversed (`reversed_by`) — plus the approval of #5 where OD-15 requires it; the edge list goes into the migration request and is fixed at the pre-migration review. No status column is invented.
- `reversed_by` (01:1198) is written on the ORIGINAL entry when it is reversed, which is an UPDATE. How every in-place write — `reversed_by`, the #5 approval columns, `posted_at/by` — coexists with REVOKE UPDATE (D1 4) is settled by pg-reviewer at the pre-migration review, before the migration is written. The worker does not choose, and D1 4 is not weakened.

Stop-and-ask if: any table, column or rule not in 01 / 13 / 13B / 019 / 40 or SCR-ACC-01 #5–#8 — STOP and report (G-01); never invent an entry type, an account or a posting rule.
