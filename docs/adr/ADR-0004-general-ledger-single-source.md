# ADR-0004 — General ledger as the single source of truth: per-entity books with periods, generic dimensions, multi-currency lines, paired intercompany legs, a separate consolidation book

**Status:** Accepted — GM decision **D-187** (2026-09-25)
**Date:** 2026-09-25
**Approved by:** GM — verbatim: "قرار GM على استبيان A0: اعتماد كل التوصيات (a–l) وكل الافتراضات (OD-01…OD-18). ابدأ A1 (ADR-0004)." (relayed by the session «تقييم المشروع والمسار القادم», which the GM designated as the channel of his directives on 2026-09-25; recorded as D-187)
**Reviewed & accepted: opus** — authored on opus by the Master; pg-reviewer (opus) review recorded in `docs/CHANGELOG.md`.
**References:** GM specification `docs/notes/GM-2026-09-25-accounting-erp-spec.md` (45 sections, verbatim) · gap analysis A0 `docs/notes/2026-09-25-accounting-gap-analysis.md` (commit `2c57971`), §1–§6 · `database/schema/01-Data-Model.sql` 48-68 (`platform.entities`), 1178-1213 (`billing.gl_accounts`, `journal_entries`, `journal_lines`), 1539-1547 (`verify_journal_balance`) · `docs/package/06-Sales-CRM-and-Accounting.md` §5 (l.130-133), §6 (l.151-157), §9-2 (l.226), §10 · `docs/package/40-Build-Specification-EN.md` §A1 P2/P3 (l.29-30), §A2 (l.42-48), §A3 (l.53), INV-C6-6 (l.318) · `docs/package/38-WBS.md` 4.1 (l.151) · `docs/adr/ADR-0002-audit-chain-seq.md` · `docs/package/BOOTSTRAP-v4.md` l.299 · doc 38 l.14 · doc 40 l.103, l.107, l.111, l.115, l.224, l.310, l.344 · doc 06 l.159, l.263 · doc 25 §6 · 01:729, 01:1186, 01:1204 · migrations 0003, 0025 · ADR-0001, ADR-0003 · D-127, D-176, D-186, D-187 (`docs/DECISION_LOG.md`)

## Context (السياق)

- The GM issued a 45-section enterprise accounting and ERP specification on 2026-09-25 (`docs/notes/GM-2026-09-25-accounting-erp-spec.md`) and directed (spec l.3-4, verbatim) "قم بجدوله وصياغه هذه الاوامر بشكل مناسب للمشروع باحترافيه ودفه صارمه واصدارها لماستر في الوقت المناسب".
- Gap analysis A0 (`docs/notes/2026-09-25-accounting-gap-analysis.md`, `2c57971`) measured it against the package and the schema: COVERED 3 · PARTIAL 33 · MISSING 3 · CONFLICT 6. The facts below are A0's; this ADR adds no new analysis.
- A general ledger already exists as tables — `billing.gl_accounts` per entity with a `parent_id` tree, `journal_entries` / `journal_lines` with a one-side CHECK and `reversed_by` (01:1178-1213) — and G2 `verify_journal_balance()` detects an unbalanced entry after it is written (01:1539-1547). `billing.gl_accounts` and `billing.journal_entries` hold 0 rows on the live database (A0 header, 2026-09-25).
- Missing today (A0 §1): fiscal periods (§5), IFRS (§31) and XBRL (§32) layers; balance enforcement at post time (§4); immutability of posted journals — `journal_lines` references entries `on delete cascade` (01:1204) and no REVOKE UPDATE/DELETE covers the journal tables, contrary to doc 40 P3 "Ledgers … are append-only; corrections by counter-entry" (A0 §1 row 24).
- The spec conflicts with six package rules (A0 §1 rows 3, 6, 35, 37, 39, 43) and raises twelve reconciliation points (A0 §4 (a)–(l)) and eighteen open decisions (A0 §5 OD-01…OD-18). The GM adopted every A0 recommendation and every A0 default (D-187).

## Decision (القرار)

### D1 — Architecture (A0 §6, verbatim)
1. The GL (`billing.journal_*`) is the only source for financial statements; subledgers tie to control accounts through a zero-row guard.
2. One posting service; automatic journals via an outbox subscriber; no module writes journal rows directly.
3. Balance enforced at commit; G2 stays as backstop.
4. Posted entries immutable (REVOKE UPDATE/DELETE, no cascade); corrections only by reversal/adjustment with an audit row (ADR-0002).
5. Periods open/closed/locked per entity; the DB refuses posting into closed/locked periods.
6. `entity_id` stays a hard column; every other axis is dimension data.
7. Lines carry transaction/functional currency, rate, base and foreign amount; pilot KWD-only.
8. Intercompany entries created with their paired leg in the same transaction; unpaired/self-paired refused.
9. Consolidation in its own book of elimination entries; company books never changed by it.
10. Tax, IFRS mapping, XBRL taxonomy, depreciation and payroll rules are configuration, never code.

### D2 — Resolutions of the twelve A0 §4 points (A0 wording)
- (a) **Roadmap.** Map spec Phases 1–10 onto doc 38 rows (mostly Phase 4 sub-rows, some 3.x/5.x/7.x) in one doc 38 v4.6; spec Phase 11 = existing Phase 7. No new phase numbering.
- (b) **Documentation.** Mapping, no new files: ARCHITECTURE → doc 36 + ADRs · DATABASE → 13B · ACCOUNTING_RULES → new doc 06 section in the spec §41 format · API → generated OpenAPI · SECURITY → doc 31 / doc 40 §B1 · TESTING → doc 36 §5-5 · DEPLOYMENT → `docs/RUNBOOK.md` · CHANGELOG → `docs/CHANGELOG.md` · README → existing · per-module → slice briefs.
- (c) **CoA per company.** Per-entity rows from a mandatory shared template; entity-specific leaf accounts allowed (the schema already stores the chart per entity, `unique (entity_id, code)`, 01:1186). GM confirms leaf accounts may differ (adopted, D-187).
- (d) **Dimensions.** `entity_id` stays the hard column (RLS/SoD depend on it, 0003/0025); generic dimension tables (A0 §3 row 9) for every other axis; `client_id`/`contract_id` kept as derived copies (P2 allows derivation).
- (e) **Sequencing.** D-186-style reassignment — lane 2 takes the accounting core (4.1a → 4.1b → 4.19 → 4.20) after WBS 4.2, under its existing `billing` lock; pilot on a synthetic chart (D-127); the real chart stays 4.1 / lane A.
- (f) **Single source = GL.** Financial statements read `journal_lines` only; subledger reports allowed only with a zero-row guard proving they tie to GL control accounts.
- (g) **Elimination.** A separate consolidation book with explicit elimination entries (A0 §3 row 14); `is_intercompany` stays the selector.
- (h) **Customers per company.** Keep the group customer master; per-entity AR subledger balances, no second customer table.
- (i) **Role catalogue.** Map to existing codes (Group CFO → CFO, HR → HR_MGR, Warehouse Manager → WH_MGR, Super Admin → SYSADMIN); add only AUDITOR and READ_ONLY as data rows under four-eyes (doc 40 l.111); the rest per OD-18.
- (j) **Entity count.** Amend 4.1 to "five entities (PGH + 4)" in v4.6.
- (k) **Currency.** Build currency columns and rates now, run KWD-only until OD-08; amend doc 40 §A3 to "functional currency KWD; transaction currency recorded".
- (l) **Passwords.** No change — passwordless (OTP + device-bound PIN hash, argon2id, doc 40 l.103) meets the intent.

### D3 — Applied defaults (A0 §5, verbatim)
Applied until the GM supplies the value; no rate, date, percentage or account is seeded. Each is reversible by a later GM line.

| ID | Spec § | Question | Standing default |
|---|---|---|---|
| OD-01 | §33 | Which taxes apply to each entity, from what date? | None configured; `tax_amt` 0; tax-rule store empty |
| OD-02 | §31 | IFRS 18 categories, account → line mapping, adoption date | Mapping layer built empty; CFO fills it; date unverified |
| OD-03 | §23 | Statutory payroll elements and rates | All configurable; none seeded beyond doc 40 l.344 |
| OD-04 | §33 | Which government filings; which XBRL taxonomy | Nothing built until named; 7.14 blocked |
| OD-05 | §13 | Recognise at invoice approval (doc 06 §7) or accrue unbilled events? | Keep doc 06 §7; unbilled events as a report |
| OD-06 | §8 | Transfer-pricing basis, reviewer, frequency (open, doc 06 l.263) | 4.12a builds the mechanism; no IC invoice without an internal price |
| OD-07 | §21 | Depreciation method, life, residual, convention per category | Configurable engine; no category seeded |
| OD-08 | §35 | Functional currency per entity; FX policy | KWD for all five; no revaluation until foreign transactions exist |
| OD-09 | §9 | PGH ownership % per subsidiary; consolidation method | Not asserted; NCI hook inactive until data supplied |
| OD-10 | §3 | Adopt X-XX-XXX-XXX + 9 classes over doc 06 §6? | Adopt the spec format; doc 06 §6 codes mapped |
| OD-11 | §12 | COD collected for clients / iMile: liability to whom, cleared when? | Never revenue; clearing until settled to the owner |
| OD-12 | §5 | Fiscal year end per entity; who closes, locks, reopens | Ask; CFO closes; reopen via Decision Inbox |
| OD-13 | §9 | Investment in subsidiaries: carrying basis in PGH books | Open; elimination template-only |
| OD-14 | §1 | Per-entity customer/vendor ownership (D2 (h)) | Group master + per-entity subledger |
| OD-15 | §4 | Who posts manual journals, given doc 06 l.159 (no manual revenue entry) | Manual journals allowed except revenue accounts; CFO approval |
| OD-16 | §10 | Any inventory on PST's balance sheet (client-owned stock, doc 40 l.224)? | None; client stock not in the GL |
| OD-17 | §34 | Negative-inventory policy for group-owned stock | Keep `no_negative_stock` (01:729) |
| OD-18 | §26 | Which spec roles become new codes vs mappings (D2 (i)) | Add AUDITOR, READ_ONLY; map the rest |

## Alternatives rejected (البدائل المرفوضة)

| Alternative | Why rejected |
|---|---|
| (a) Run the spec's eleven phases as a separate roadmap | Doc 38 defines the phases (0–7); D-176 "finish phases in order"; BOOTSTRAP-v4 l.299 "no 18-phase roadmap; no separate Database phase" |
| (b) Create the nine root documentation files | CLAUDE.md DOCUMENTATION: the package is the documentation; no new numbered document |
| (c) A separately structured chart per company | Doc 06 §5 l.130 and doc 40 l.310 require one structure; the per-entity rows already give each company its own chart |
| (d) Replace `entity_id` with a dimension | RLS and SoD depend on the column (0003/0025) |
| (e) Accounting core first, pausing Phase 2/3 rows | D-176; the reassignment to lane 2 after 4.2 keeps both moving |
| (f) Reports keep reading invoice lines / the database directly | Spec §37 forbids report logic that differs from the GL |
| (g) Eliminate by filtering flagged rows only (INV-C6-6) | Spec §8/§9 require explicit elimination entries kept apart from company books |
| (h) A second, per-entity customer table | Breaks the group credit hold (doc 40 l.48) |
| (i) Seed all fifteen spec roles as new codes | Duplicates existing codes; staffing collapses PRO = ACCOUNTANT (doc 40 l.115) |
| (j) Keep "four entities" in 4.1 | The live DB and doc 06 §5 have five |
| (k) Stay single-currency in the schema | Spec §35 requires multi-currency from day one; running KWD-only needs no columns dropped |
| (l) Store hashed passwords | Doc 40 l.107: no credential stored server-side as a password; the OTP + PIN design meets the intent |

## Consequences (الأثر)

Listed, not applied — each lands through its own mechanism (A2: G-01 requests, doc 38 v4.6, package amendments; then slices):
1. **Doc 38 v4.6 rows** exactly as A0 §6 proposes: 4.1 (amend: five entities) · 4.1a CoA structure + synthetic pilot chart · 4.1b dimensions · 4.19 fiscal years + periods · 4.20 posting engine (entry types, reversal/adjustment, balance at commit, posted immutable) · 4.11 (amend: auto-post via outbox; deps 4.20, 4.4) · 4.21 multi-currency · 4.12a intercompany pairing + reconciliation · 4.12b consolidation book · 4.22 AP · 4.7a banking · 3.6a COD clearing and settlement · 4.23 statements from the GL · 4.24 accounting-rules section in doc 06 · 5.6a payroll → GL · 5.11a fixed assets · 5.11b expense claims · 7.13 IFRS mapping · 7.14 XBRL — with the IDs, dependencies, lanes and acceptance lines of A0 §6; Phase 4 gate amended per A0 §6.
2. **G-01 candidates** = A0 §3 rows 1–29, each a schema-change request under EXECUTION-MASTER-v4 §1.11 before any migration.
3. **Package amendments needed:** doc 38 4.1 "four entities" → five (D2 (j)); doc 40 §A3 "functional currency KWD; transaction currency recorded" (D2 (k)); doc 06 §5/§6 chart structure and format per OD-10; doc 06 §9-2 and doc 25 §6 report sources → `journal_lines` with a tie-out guard (D2 (f)).
4. **Existing defect fixed in 4.20:** the `journal_lines` → `journal_entries` `on delete cascade` (01:1204) and the missing REVOKE UPDATE/DELETE on the journal tables. Harmless today (0 journal rows); must be fixed before the first posting.
5. **Unchanged:** ADR-0001, ADR-0002 (the posting service writes its audit row under ADR-0002's rules), ADR-0003. D-127 (synthetic pilot data) and D-176 (phase order) remain in force, with the D2 (e) exception for lane 2's accounting core after 4.2. No code, schema, migration or package document changes with this ADR.
6. **Risks:** the accounting core touches `database/schema/*` and `packages/events` (frozen during any parallel phase, CLAUDE.md PARALLEL LANES) through a new posting path and an outbox subscriber; each row is built under the D-186 budget (≤ 8 files / 1,000 lines, two review rounds). Open decisions stay open behind their defaults (D3) until the GM supplies values.

## Status (الحالة)

Accepted — 2026-09-25 (D-187).
