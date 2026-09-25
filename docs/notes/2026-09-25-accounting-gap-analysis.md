# Accounting spec (GM 2026-09-25) — gap analysis A0

Read-only analysis (Plan agent, opus, delegated by the Master; GM-named file). Sources: the GM spec `docs/notes/GM-2026-09-25-accounting-erp-spec.md` (quoted as "spec §n") and the repository at main. Citation shorthand: `01:` = `database/schema/01-Data-Model.sql`, `13:` = `13-Schema-Additions.sql`, `13B:` = `13B-Schema-Reference-Consolidation.sql`, `doc NN §x` = `docs/package/NN-*.md`.

One read-only query against the live DB on 2026-09-25 returned 5 entities (PCC, PDL, PGH holding, POR, PST), all `KWD`; `billing.gl_accounts` = 0 rows, `billing.journal_entries` = 0, `platform.approval_chains` = 8, `platform.thresholds` = 67.

**Counts: COVERED 3 · PARTIAL 33 · MISSING 3 · CONFLICT 6**

## §1 Coverage matrix

| # | spec section | status | evidence / what is missing |
|---|---|---|---|
| 1 | Legal structure / multi-company | PARTIAL | Exists: 5 legal entities as a tree in `platform.entities` (01:48-68, seed 01:1563-1572; doc 40 §A2 l.42); per-entity `entity_id` on invoices, gl_accounts, journals (01:1083, 01:1180, 01:1191) and employees (01:1269). Missing: fiscal periods; bank and cash accounts per entity; fixed-asset books. Customers are group-level ("One `sales.accounts` row per client across all entities", doc 40 l.46); vendors in `partners.partners` have no `entity_id` (13:15-28). See §4(c), §4(h). |
| 2 | Separation of entity / branch / station / warehouse / department / cost center | PARTIAL | Exists: entity (01:48), `platform.sites` with `kind` (0015:59), `wms.warehouses` (01:609), department as `hr.org_units` (01:1256). Missing: no branch table; station is free text `imile.shipments.station_code` (01:1318); cost center is free text `journal_lines.cost_center` (01:1210). No dimension model ties them. |
| 3 | CoA classes 1–9, format X-XX-XXX-XXX, extensible | CONFLICT | Spec: classes "1 — Assets … 9 — Control / Memorandum", format "X-XX-XXX-XXX". Doc 06 §6 (l.151-157): five groups 1–5, ranges "1000–1999" … "5000–5999"; `account_type` comment (01:1183) lists 5 types. Extensibility exists: the chart is data with a `parent_id` tree (01:1178-1187). |
| 4 | Double-entry engine and journal types | PARTIAL | Exists: `journal_lines` one-side CHECK (01:1212); `verify_journal_balance()` (01:1539-1547) is blocking guard G2 (doc 40 l.632; `scripts/guards-run.sh:104`). Missing: G2 detects an unbalanced entry after it is written — "لا يسمح النظام بترحيل قيد غير متوازن" is not enforced at post time; no entry types (manual/recurring/reversing/adjustment/accrual/prepayment/closing); only `reversed_by` (01:1198). |
| 5 | Fiscal year and periods open/closed/locked | MISSING | Only `platform.entities.fiscal_year_end` (01:62), nullable. No period table, no posting-date guard. The only month lock in the package is payroll (WBS 5.6, doc 38 l.185). |
| 6 | Extensible dimensions | CONFLICT | Spec: dimensions added "بدون إعادة بناء النظام". `journal_lines` has fixed `client_id`, `contract_id`, `cost_center text` (01:1208-1210). See §4(d). |
| 7 | company_id on every row, company access, group roles | COVERED | Doc 40 §A2 l.43; `identity.user_entities` (01:271), `platform.allowed_entities()` (01:327); entity-scope RLS (migrations 0003, 0007, 0025/D-181); FORCE RLS on journals (13B:3157-3159); CFO scope `all` (13B:551). |
| 8 | Native intercompany, auto counter-entry, due-from/to, elimination | PARTIAL | Exists: `is_intercompany`, `counterparty_entity_id` on billable_events and invoices (01:1070-1071, 01:1100-1101); `journal_entries.is_intercompany` (01:1196) without counterparty; entry patterns 1210/4900/5900/2110 (doc 06 §5-1 l.143, §10 l.246-251); WBS 4.12. Missing: automatic counter-leg, pairing, IC reconciliation. Transfer pricing still open (doc 06 l.263). |
| 9 | Consolidation separate from company books | PARTIAL | Doc 06 §5 l.132, doc 40 l.45, INV-C6-6 (l.318): elimination by filtering `is_intercompany`; R-17 reads `journal_lines` (doc 25 §5). Missing: a separate consolidation book, elimination entries, investment in subsidiaries, NCI. See §4(g). |
| 10 | Premium Storage | PARTIAL | Doc 38 Phase 2 (WMS, space); contracts WBS 1.7; revenue 4100/4200/4300 (doc 06 §6); `cost_allocations` basis `space` (doc 06 §9-1); stock client-owned (doc 40 l.224). No warehouse cost-center model; inventory accounting undecided (OD-16). |
| 11 | Premium Delivery | PARTIAL | WBS 3.1-3.13 (doc 38 l.120-132); fleet/fuel/maintenance 5.12; partner costs 4.15; custody ledger 3.10; failure/return 3.5 and `delivery_exceptions.is_billable` (doc 40 l.268). Missing: driver-settlement accounting; GL link for vehicle expenses. |
| 12 | COD accounting | PARTIAL | Exists: `tms.delivery_tasks.cod_amount/cod_collected` (01:887-888), `tms.payment_attempts` (13B:1263-1277), day close blocked on COD variance (INV-C4-7, doc 40 l.279), WBS 3.6, R-03 (doc 25 §5), `cod_variance` alert (13B:2862-2868). Missing: settlement record (collector, dates, remitted, shortage, status), clearing accounts, automatic journals, duplicate-settlement guard. |
| 13 | Premium Order | PARTIAL | POR entity (01:1571); outbound orders WBS 2.11; revenue 4300 (doc 06 §6). POR revenue recognition not described in the package (unverified). |
| 14 | Premium CC | PARTIAL | WBS 5.1, 5.2 (internal transfer price + external package); revenue 4600 (doc 06 §6); doc 40 l.306. No GL link for telecom/software costs. |
| 15 | Accounts Receivable | PARTIAL | Invoices, receipts, allocations, credit notes (01:1081-1175); aging/reminders WBS 4.9; group credit limit WBS 1.8. Missing: debit notes, customer statement, per-entity customer accounts (§4(h)). |
| 16 | Accounts Payable | PARTIAL | Only partner invoices with auto-matching (`partners.partner_invoices`, 13:106; WBS 4.15); PO invoice fields as PO columns (13:507). Missing: vendor bills, payments, allocation, vendor statement, AP aging. |
| 17 | Purchasing PR→PO→GRN→bill, three-way match | PARTIAL | `admin.purchase_requests/vendor_quotes/purchase_orders` (13:461-514), CHECK `no_pay_before_match` (13:513), tiers (doc 11 §3-0), WBS 5.11. Goods receipt is only PO columns (`received_at`, `received_amount`, 13:506), not an entity. |
| 18 | Sales quote→order→delivery→invoice→receipt | PARTIAL | Quotes 1.6 → contracts 1.7 → events → invoice 4.4 → receipt 4.7 (doc 06 §7); no sales order (contracts + billable events); `discount_amt` (01:1094). Debit notes missing. |
| 19 | Banking | PARTIAL | WBS 4.7 "bank statement import + auto-match (I-08)"; `receipts.reconciled_by/at` (01:1147); CFO owns reconciliation (doc 23 l.27); alert N-21 (doc 40 l.180). Missing: bank / bank-account tables, bank transactions, transfers, outstanding items. |
| 20 | Cash / petty cash | PARTIAL | `admin.petty_cash` + transactions with `gl_account_id` (13:516-541). Driver custody WBS 3.10, no custody table found (unverified). Missing: main cash, cash count, transfers. |
| 21 | Fixed assets + configurable depreciation | PARTIAL | `admin.assets` with `purchase_value/date`, custody (13:543-569). Missing: categories, capitalization, depreciation, disposal, impairment, accumulated depreciation. |
| 22 | Expenses with approval | PARTIAL | Petty-cash `expense` needs a receipt (13:540); approval chains (13B:587). Missing: expense claims, recurring/prepaid/accrued. |
| 23 | Payroll separate, integrated, configurable | PARTIAL | WBS 5.6; doc 10 l.48 records `hr.payroll_runs/lines` not in 01/13/13B; commission/deductions from `hr.commission_rules` + thresholds (doc 40 l.344). No GL posting. |
| 24 | Audit trail; posted journals never deleted | PARTIAL | Hash-chained audit log (doc 40 §B2 l.119-145; ADR-0002). But `journal_lines` references entries `on delete cascade` (01:1204); REVOKE UPDATE/DELETE exists only on audit_log, stock_movements, work_order_events (01:144, 01:713, 13B:4268, 0007:114-116) — journal tables not covered, contrary to doc 40 P3 (l.30). |
| 25 | Configurable approval workflow engine | PARTIAL | `platform.approval_chains` (13B:587-598) as data; `admin.approval_requests/steps` (13:598-623). Chains carry no `entity_id`, unique per `(request_type, step_no)`; no expense or payment request types (13B:589). |
| 26 | Roles and permission levels | PARTIAL | 26 roles seeded as data (13B:546-572; doc 40 l.114); scopes entity/org_unit/self/… (doc 40 l.117); permissions module/object/action (01:244-251); `rbac.ts:6-21`. No counterpart for Group Admin, Finance Manager, Chief Accountant, AR/AP Accountant, Treasury, Station Manager, Auditor, Read Only. See §4(i). |
| 27 | Security | PARTIAL | Doc 36 §4-5 (ASVS L2, zero secrets, rate limits, Zod, SQLi impossible, CSP, encryption); doc 40 §B1 (OTP, revocable sessions, four-eyes). CSRF/XSS not named explicitly. Spec "Secure Password Hashing" vs doc 40 l.107 (no server-side password). |
| 28 | Normalized DB, constraints, immutable records, no orphans | PARTIAL | PK/FK/CHECK/unique throughout; no hard delete in financial schemas (doc 40 l.56). Journal immutability gap as #24. Line account not checked to belong to the entry's entity; `is_postable` not enforced (01:1185, 01:1205). |
| 29 | API segmentation and per-call checks | PARTIAL | Mechanism covered: modular monolith (doc 36 §1-1), Zod→OpenAPI (doc 36 l.96), RLS context per transaction (doc 36 §3-5). GL, AP, Banking, Assets, Payroll, Intercompany, Consolidation, Reporting modules do not exist. |
| 30 | Reporting engine, 21 reports, PDF/Excel/CSV | PARTIAL | Doc 06 §11, doc 25 §5: TB per entity, R-15 aging, R-16 IS per entity, R-17 consolidated IS, R-03 COD; output "شاشة + PDF + Excel" (doc 25 §6). Missing: BS, CF, SCE, GL report, AP aging, vendor/customer statements, branch/station/cost-center P&L, IC reconciliation, CSV. |
| 31 | IFRS readiness incl. IFRS 18 | MISSING | No IFRS mention in `docs/package/*.md` (grep). |
| 32 | XBRL as a separate layer | MISSING | No XBRL mention in `docs/package/*.md` (grep). |
| 33 | Kuwait localization as configurable rules | PARTIAL | Containers only: `entities.tax_number` (01:56), `invoices.tax_amt` (01:1095), per-entity `platform.settings` (01:72-82), `platform.thresholds` (13B:428). No tax/invoice/government rules. |
| 34 | Data-integrity preventions | PARTIAL | Covered: unique invoice numbers (01:1106), unique billing per event (01:1077), idempotency keys (0010:47), no negative stock (01:729), entity access (RLS). Missing: unbalanced entry refused at post, posting to closed period, account invalid for entity, invalid currency, invalid IC pair, duplicate COD settlement. |
| 35 | Multi-currency from day one, FX gains/losses | CONFLICT | Doc 06 §5 l.133 "عملة واحدة \| KWD · ثلاث خانات عشرية"; doc 40 §A3 l.53 "Money: `numeric(14,3)`, currency KWD"; `journal_lines` has no currency column (01:1202-1213). |
| 36 | Management dashboard with drill-down | PARTIAL | Profitability board (doc 06 §9-2); 6 KPI cards (WBS 6.3); every number clicks to its source (doc 25 §6). Missing: branch → station → department → account drill hierarchy. |
| 37 | Development rules; single source = GL | CONFLICT | Rules covered by CLAUDE.md and P2 (doc 40 l.29), but doc 06 §9-2 revenue source is "سطور الفواتير" and doc 25 §6 report source is "قاعدة البيانات مباشرة", not the GL. See §4(f). |
| 38 | Testing incl. automated debit = credit | PARTIAL | Test pyramid doc 36 §5-5; G2 blocking (doc 40 l.632), also in restore (`scripts/restore.sh:95`) and `tests/ops/tests/backup-restore.test.ts:200`. No IC/consolidation/period tests (features absent). |
| 39 | Eleven-phase implementation method | CONFLICT | See §4(a). |
| 40 | 14-step protocol per phase | PARTIAL | Doc 36 §5-1 slice order covers most steps; "Define accounting entries" and "Identify ambiguities" are not explicit steps. |
| 41 | Per-operation accounting documentation | PARTIAL | Doc 06 §7, §10 give Dr/Cr for revenue, receipt, intercompany — not in the spec's 9-field chain. |
| 42 | Code quality | COVERED | CLAUDE.md (boundaries lint, no magic numbers), CI gate ①. |
| 43 | Nine root documentation files | CONFLICT | See §4(b). |
| 44 | Never guess; raise an Open Decision | COVERED | CLAUDE.md "Never fabricate a number, name, or decision"; `[GM DECISION REQUIRED]` pattern (doc 06 l.263); D-178. |
| 45 | Definition of done | PARTIAL | Phase gates (doc 38 l.170), launch checklist WBS 7.12, backup/restore (`docs/RUNBOOK.md`, doc 26 §4-1). No period, consolidation or bank-reconciliation criteria. |

## §2 Reuse (as-is)

| Asset | Where | Reused for |
|---|---|---|
| `platform.entities` (holding + 4, `parent_id`, `base_currency`) | 01:48-68; live DB 5 rows | Legal entities; consolidation tree |
| `billing.gl_accounts` (per entity, `parent_id`, `is_postable`) | 01:1178-1187 | CoA rows (format/class added, §3 rows 1-2) |
| `billing.journal_entries / journal_lines` (one-side CHECK, `reversed_by`, `posted_at/by`) | 01:1189-1213 | GL core (extended, §3) |
| `billing.verify_journal_balance()` = G2 | 01:1539-1547; `database/schema/guards.sql:37-38`; `scripts/guards-run.sh:104` | Backstop behind a new post-time guard |
| `billing.invoices / receipts / receipt_allocations / credit_notes` | 01:1081-1175 | AR subledger |
| `billing.cost_allocations`, `billing.profitability`, `governance.budgets/budget_lines` | 01:1216-1250; 13B:3674-3700 | Cost-center P&L; budget vs actual |
| `billing.reject_holding_invoice()` | 01:1575; trigger 13B:3356-3359 | Holding-entity rule |
| `platform.audit_log` hash chain, ADR-0002 | 13B:178-235; `docs/adr/ADR-0002-audit-chain-seq.md` | Spec §24; posting under ADR-0002 rules |
| `platform.outbox` | 13B:131-145; doc 40 l.154 | Carrier for automatic journals |
| `platform.thresholds`, `platform.settings` | 13B:428-437; 01:72-82 | Configurable rules (tax, FX, depreciation) |
| `platform.approval_chains`, `admin.approval_requests/steps`, `identity.delegations`, `identity.sod_rules` | 13B:587-631; 13:598-623 | Spec §25 engine, extended |
| Identity RBAC (`has_perm`, `allowed_entities`, `user_entities`) | 01:271, 01:327; `packages/identity/src/rbac.ts:6-21` | Spec §7, §26 |
| `platform.next_doc_no()` | 01:99-121 | Journal, bill, payment numbering |
| `platform.decisions` (incl. `cod_variance`) | 13B:440-457 | Exception routing |
| `admin.purchase_*`, `petty_cash*`, `assets`, `partners.*` | 13:461-569; 13:15-125 | Seeds of spec §16, §17, §20, §21 |

## §3 Schema deltas — G-01 candidates

| # | Existing table / column, or new table | What the spec needs | Spec § |
|---|---|---|---|
| 1 | `billing.gl_accounts.code` (01:1181) | CHECK on X-XX-XXX-XXX; class 1–9 from the first segment | §3 |
| 2 | `billing.gl_accounts.account_type` (01:1183) | Values for Cost of Revenue, Other Income/Expense, Tax, Control/Memorandum | §3 |
| 3 | new `billing.fiscal_years`, new `billing.accounting_periods` | Fiscal year; periods open/closed/locked per entity | §5, §1 |
| 4 | `billing.journal_entries` (01:1189) | Period link; posting to closed/locked period refused | §5, §34 |
| 5 | `billing.journal_entries` (01:1189) | Entry type; approved by/at (posted_at/by exist, 01:1197) | §4, §24 |
| 6 | `billing.journal_entries/lines` | Balance enforced at commit (constraint trigger), not only G2 | §4, §34 |
| 7 | `billing.journal_lines.entry_id … on delete cascade` (01:1204); no REVOKE on journals | Posted entries immutable (doc 40 P3); cascade removed | §24, §28 |
| 8 | `billing.journal_lines.account_id` (01:1205) | Account in the entry's entity and `is_postable` | §34 |
| 9 | new `billing.dimension_types`, new `billing.line_dimensions` | Dimensions as data; backs the fixed `client_id/contract_id/cost_center` (01:1208-1210) | §6, §2 |
| 10 | `billing.journal_lines` | Transaction currency, functional currency, rate, base amount, foreign amount | §35 |
| 11 | new `billing.exchange_rates` | Rates; invalid-currency checks; realized/unrealized FX | §35, §34 |
| 12 | `billing.journal_entries.is_intercompany` (01:1196) | Counterparty entity; paired-leg link; self/unknown pair refused | §8, §34 |
| 13 | new `billing.intercompany_reconciliations` | Due-from/due-to reconciliation | §8, §30 |
| 14 | new `billing.consolidation_entries` (separate book) | Eliminations, investment in subsidiaries, NCI | §9 |
| 15 | `partners.partners` (13:15, no `entity_id`) | Vendors per company or a company mapping | §1, §16 |
| 16 | new `billing.vendor_bills`, `vendor_payments`, `vendor_payment_allocations` | AP bills, payments, allocation, statements, aging | §16 |
| 17 | `admin.purchase_orders.received_*` (13:506) → new `admin.goods_receipts` | Receipt as a record for three-way match | §17 |
| 18 | new `billing.bank_accounts`, `bank_transactions`, `bank_reconciliations` | Banking (statement import itself is WBS 4.7) | §19 |
| 19 | `admin.petty_cash` (13:516) + new `admin.cash_counts` | Main cash, custodians, transfers, count, reconciliation | §20 |
| 20 | `admin.assets` (13:543) + new `admin.asset_categories`, `admin.depreciation_runs` | Categories, capitalization, configurable depreciation, disposal, transfer, impairment | §21 |
| 21 | new `admin.expense_claims` | Expense claims through approval chains | §22 |
| 22 | `hr.payroll_runs/lines` (absent, doc 10 l.48) | Payroll module posting to the GL | §23 |
| 23 | new `tms.cod_settlements` | COD value, collector, dates, remitted, shortage, variance, status; unique per task. Clearing accounts are CoA data | §12, §34 |
| 24 | `platform.approval_chains` (13B:587-598) | Expense/PO/payment request types; entity scoping (need unverified) | §25 |
| 25 | `billing.credit_notes` (01:1162) → new `billing.debit_notes` | Debit notes | §15, §18 |
| 26 | new `billing.reporting_mappings` | Account → IFRS line / IFRS 18 category | §31 |
| 27 | new `billing.xbrl_taxonomies`, `billing.xbrl_mappings` | XBRL layer outside the engine | §32 |
| 28 | new `platform.tax_rules` (or `platform.settings` keys) | Configurable tax/invoice/government rules; none seeded (OD-01) | §33 |
| 29 | `identity.roles` seed (13B:546-572) — data, not schema | Spec roles with no counterpart (#26) | §26 |

## §4 Conflicts with project rules (recommendations; the GM decides)

**(a) Roadmap.** Spec §39 "Phase 1 … Phase 11" vs doc 38 l.14 (doc 38 defines phases 0–7), BOOTSTRAP-v4 l.299 ("no 18-phase roadmap; no separate Database phase"), D-176 ("قم بانهاء المراحل علي التوالي"). Recommend: map spec Phases 1–10 onto doc 38 rows (mostly Phase 4 sub-rows, some 3.x/5.x/7.x) in one doc 38 v4.6; spec Phase 11 = existing Phase 7. No new phase numbering.

**(b) Documentation.** Spec §43 nine root files vs CLAUDE.md "The package is the documentation … Never create a new numbered document." Recommend mapping, no new files: ARCHITECTURE → doc 36 + ADRs · DATABASE → 13B · ACCOUNTING_RULES → new doc 06 section in the spec §41 format · API → generated OpenAPI · SECURITY → doc 31 / doc 40 §B1 · TESTING → doc 36 §5-5 · DEPLOYMENT → `docs/RUNBOOK.md` · CHANGELOG → `docs/CHANGELOG.md` · README → existing · per-module → slice briefs.

**(c) CoA per company vs unified chart.** Spec §1 "كل شركة يجب أن تمتلك … Chart of Accounts" vs doc 06 §5 l.130 "دليل حسابات موحّد الهيكل | نفس الأرقام في الكيانات الخمسة" and doc 40 l.310 "uniform chart per entity". Reconcilable: the schema stores the chart per entity (`unique (entity_id, code)`, 01:1186). Recommend: per-entity rows from a mandatory shared template; entity-specific leaf accounts allowed. GM confirms leaf accounts may differ.

**(d) Dimensions vs entity_id-per-row.** Spec §6 vs doc 40 l.43 and fixed columns (01:1208-1210). Recommend: `entity_id` stays the hard column (RLS/SoD depend on it, 0003/0025); generic dimension tables (§3 row 9) for every other axis; `client_id`/`contract_id` kept as derived copies (P2 allows derivation).

**(e) Sequencing.** Spec Phase 1–2 first vs D-176 with Phase 2/3 rows open; 4.1 is DEFERRED-POST-PILOT (D-127), so 4.11 is blocked. Recommend: D-186-style reassignment — lane 2 takes the accounting core (4.1a → 4.1b → 4.19 → 4.20) after WBS 4.2, under its existing `billing` lock; pilot on a synthetic chart (D-127); the real chart stays 4.1 / lane A.

**(f) Single source = GL.** Spec §37 vs doc 06 §9-2 l.226 (revenue ← invoice lines), doc 25 §6 (source = database directly), R-15 reading `billing.invoices`. Recommend: financial statements read `journal_lines` only; subledger reports allowed only with a zero-row guard proving they tie to GL control accounts.

**(g) Elimination.** Spec §8/§9 (elimination entries; no mixing of company and consolidation accounts) vs INV-C6-6 l.318 and doc 06 l.145 (filter `is_intercompany`, "تُحذف كاملةً"). Recommend: a separate consolidation book with explicit elimination entries (§3 row 14); `is_intercompany` stays the selector.

**(h) Customers per company.** Spec §1 vs doc 40 l.46 (one `sales.accounts` row per client across entities; group credit hold, l.48). Recommend: keep the group customer master; per-entity AR subledger balances, no second customer table.

**(i) Role catalogue.** Spec §26 fifteen roles vs doc 40 l.114 (26 seeded codes; PRO = ACCOUNTANT, l.115). Recommend: map to existing codes (Group CFO → CFO, HR → HR_MGR, Warehouse Manager → WH_MGR, Super Admin → SYSADMIN); add only AUDITOR and READ_ONLY as data rows under four-eyes (l.111); rest → OD-18.

**(j) Entity count.** Doc 38 4.1 acceptance "Loaded for all four entities" (l.151) vs doc 06 §5 l.130 ("الكيانات الخمسة") and 5 live entities. Recommend: amend 4.1 to "five entities (PGH + 4)" in v4.6.

**(k) Currency.** Spec §35 vs doc 06 l.133 / doc 40 l.53 (KWD only). Recommend: build currency columns and rates now, run KWD-only until OD-08; amend doc 40 §A3 to "functional currency KWD; transaction currency recorded".

**(l) Passwords.** Spec §27 "Secure Password Hashing" vs doc 40 l.107 (no server-side password). Recommend: no change — passwordless (OTP + device-bound PIN hash, argon2id, doc 40 l.103) meets the intent.

## §5 Open Decisions (spec §44) — defaults are proposals only, nothing applied

| ID | Spec § | Question | Proposed default if the GM stays silent |
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
| OD-14 | §1 | Per-entity customer/vendor ownership (§4(h)) | Group master + per-entity subledger |
| OD-15 | §4 | Who posts manual journals, given doc 06 l.159 (no manual revenue entry) | Manual journals allowed except revenue accounts; CFO approval |
| OD-16 | §10 | Any inventory on PST's balance sheet (client-owned stock, doc 40 l.224)? | None; client stock not in the GL |
| OD-17 | §34 | Negative-inventory policy for group-owned stock | Keep `no_negative_stock` (01:729) |
| OD-18 | §26 | Which spec roles become new codes vs mappings (§4(i)) | Add AUDITOR, READ_ONLY; map the rest |

## §6 Proposals (not applied)

**ADR-0004 — General ledger as the single source of truth: per-entity books with periods, generic dimensions, multi-currency lines, paired intercompany legs, a separate consolidation book.**
- The GL (`billing.journal_*`) is the only source for financial statements; subledgers tie to control accounts through a zero-row guard.
- One posting service; automatic journals via an outbox subscriber; no module writes journal rows directly.
- Balance enforced at commit; G2 stays as backstop.
- Posted entries immutable (REVOKE UPDATE/DELETE, no cascade); corrections only by reversal/adjustment with an audit row (ADR-0002).
- Periods open/closed/locked per entity; the DB refuses posting into closed/locked periods.
- `entity_id` stays a hard column; every other axis is dimension data.
- Lines carry transaction/functional currency, rate, base and foreign amount; pilot KWD-only.
- Intercompany entries created with their paired leg in the same transaction; unpaired/self-paired refused.
- Consolidation in its own book of elimination entries; company books never changed by it.
- Tax, IFRS mapping, XBRL taxonomy, depreciation and payroll rules are configuration, never code.

**Proposed doc 38 v4.6 rows (137 → 154, plus amended rows)**

| ID | Task | Type | Deps | Lane | Owner | Acceptance |
|---|---|---|---|---|---|---|
| 4.1 (amend) | Chart of accounts — real data | 🧑 | 1.1 | A | CFO | Loaded for all **five** entities |
| 4.1a | CoA structure X-XX-XXX-XXX + class 1–9; synthetic pilot chart | 🤖 | 0.12 | 2 | CFO | Off-format code rejected by CHECK; no account-code literal in `modules/` |
| 4.1b | Dimensions: types + line dimensions | 🤖 | 4.1a | 2 | CFO | New dimension added with zero migration; undefined value rejected |
| 4.19 | Fiscal years + periods (open/closed/locked) | 🤖 | 4.1a | 2 | CFO | Posting into closed/locked period rejected by the DB |
| 4.20 | Posting engine: entry types, reversal/adjustment, balance at commit, posted immutable | 🤖 | 4.19, 4.1b | 2 | CFO | Unbalanced entry refused at commit; UPDATE/DELETE on posted refused; G2 = 0 |
| 4.11 (amend) | Journal entries auto-posted from billing events via outbox | 🤖 | 4.20, 4.4 | M | CFO | Zero unbalanced entries |
| 4.21 | Multi-currency lines + exchange rates | 🤖 | 4.20 | 2 | CFO | Line without currency or rate rejected |
| 4.12a | Intercompany pairing, due-from/to, IC reconciliation | 🤖 | 4.20 | M | CFO | Every IC entry has one paired leg; IC reconciliation difference 0 on seed |
| 4.12b | Consolidation book + elimination entries | 🤖 | 4.12a | M | CFO | Company ledgers unchanged; group P&L excludes intercompany |
| 4.22 | AP: vendor bills, payments, allocations, aging, statement | 🤖 | 4.20, 4.15 | M | CFO | Duplicate vendor bill reference rejected; overpayment rejected |
| 4.7a | Banking: accounts, transactions, transfers, reconciliation | 🤖 | 4.7, 4.20 | M | CFO | Reconciliation posts only when an adjustment exists |
| 3.6a | COD clearing, settlement, automatic journals | 🤖 | 3.6, 4.20 | 1 | CFO | COD never posts to revenue; second settlement of a task rejected |
| 4.23 | Statements from the GL: TB, GL, BS, IS, CF, SCE per entity + group; PDF/Excel/CSV | 🤖 | 4.20, 4.12b | M | CFO | Every total reproduces from `journal_lines` |
| 4.24 | Accounting-rules section in doc 06 (spec §41 format) | 🧑 | 4.20 | M | CFO | Every automatic journal has one rule row |
| 5.6a | Payroll → GL posting | 🤖 | 5.6, 4.20 | 2 | CFO | Locked month posts one balanced entry per entity |
| 5.11a | Fixed assets: categories, configurable depreciation, disposal, impairment | 🤖 | 5.11, 4.20 | 3 | CFO | Depreciation idempotent per period; method from configuration |
| 5.11b | Expense claims + recurring/prepaid/accrued | 🤖 | 5.11, 4.20 | 3 | CFO | Claim cannot post before its approval chain completes |
| 7.13 | IFRS mapping layer (IFRS 18 per OD-02) | 🤖 | 4.23 | M | CFO | Mapping change needs no deploy; unmapped accounts listed |
| 7.14 | XBRL layer: mapping, validation, export | 🤖 | 7.13 | M | CFO | Taxonomy swap is data only |

Phase 4 gate amendment: 4.11 zero rows · 4.18 signed · 4.20 immutability test green · 4.23 statements reproduce from the GL.
