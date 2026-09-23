# MASTER_BACKLOG — PG-EOS

**Generated from `docs/package/38-WBS.md` (Document 38 v4.0) by `scripts/gen-backlog.py` — IDs, type markers, dependencies, lanes, owners and acceptance criteria are copied verbatim; doc 38 governs on any difference.**

Eight phases (0–7) + cross-cutting X-tasks = **132 tasks**. No 18-phase roadmap, no separate database phase (BOOTSTRAP-v4 §8).

| Status | Meaning |
|---|---|
| `TODO` | dependencies not all DONE |
| `READY` | every dependency DONE with a hash; lane free → `/resume` may pick it |
| `ACTIVE` | claimed in `tasks/LANE_LOCKS.md`; one per lane |
| `WAITING_GM` | 🧑 / 🔧 lane-A task: runbook or script produced, waits for the GM; never blocks a code lane |
| `BLOCKED` | REAL BLOCKER recorded in `docs/PROJECT_STATE.md` |
| `DONE @ <hash>` | acceptance criterion passed, pg-reviewer PASS, gates green — written by pg-scribe in the same commit |

Type: 🧑 human decision/data · 🤖 AI-buildable slice · 🔧 infra · ✅ verification. Lane: **A** GM/manual · **B · C · 1 · 2 · 3** parallel build lanes · **M** Master (serial). Deps govern over Lane.

---

## Phase 0 — Foundation

| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| 0.1 | ✅ **Done** — all domains owned by filled positions; SoD satisfied (CFO / PRO-collections / GM) | 🧑 | — | **A** | GM | — | DONE (pre-build, GM) |
| 0.2 | ✅ Cloud decision **tiered**: Tier 0 Oracle Always Free (doc 42) → Tier 2 GCP Doha. **Decide: PAYG upgrade, region, Tunnel** (doc 42 §11) | 🧑 | — | **A** | GM | Three decisions recorded | WAITING_GM |
| 0.3 | Oracle tenancy: account, MFA, compartment `premium-production`, IAM user `deployer`, break-glass | 🔧 | 0.2 | **A** | SYSADMIN | Break-glass credentials in physical safe; MFA on root | WAITING_GM |
| 0.4 | Initialise monorepo (pnpm, Turborepo, TypeScript strict, ESLint boundaries) | 🔧 | — | **B** | SYSADMIN | `pnpm build` green; cross-module import fails lint | DONE @ 05674b5 |
| 0.5 | VCN + NSG + A1.Flex VM (reserved IP) + Ubuntu hardening + Docker + `/opt/premium` layout + Cloudflare (Tunnel or Origin cert) — doc 42 §2–§5 | 🔧 | 0.3 | **A** | SYSADMIN | `docker compose up` serves `app/api/portal` over HTTPS; no public 5432/22 | WAITING_GM |
| 0.6 | CI pipeline — **seven named gates ①–⑦ (doc 36 §4-3): STATIC · UNIT · INTEGRATION · ACCEPTANCE · GUARDS · SECURITY · BUILD** | 🔧 | 0.4, 0.5 | **M** | SYSADMIN | A deliberately failing test blocks deploy; gate ⑤ runs G1–G18 | TODO |
| 0.7 | Tier 0 monitoring: Netdata/node_exporter, postgres_exporter, Uptime Kuma, backup healthcheck, alerts to GM + `DEPUTY_SYSADMIN` — doc 42 §7. The per-module Grafana board required by doc 36 §4-1 is task X.3, built with each module | 🔧 | 0.5 | **A** | SYSADMIN | Disk > 80% and container restart alerts fire in test | WAITING_GM |
| 0.8 | `backup.sh` to OCI Object Storage (14/8/6) + lifecycle rules + **first actual `restore.sh` test** — doc 42 §6 | 🔧 | 0.5 | **A** | SYSADMIN | Restore into `pgeos_restore`; guard functions return 0 | WAITING_GM |
| 0.9 | `platform` schema from 01 + 13B: entities, settings, counters, `next_doc_no`, **`platform.outbox`** (`domain_events` dropped), **`platform.audit_log` partitioned monthly, PK `(id, occurred_at)`, with the eleven v4 columns of doc 40 §B2 and the `audit_hash_chain` trigger** | 🤖 | 0.4 | **B** | SYSADMIN | 100 concurrent `next_doc_no` calls → 100 unique numbers; `platform.verify_audit_chain()` returns zero rows and detects a deliberately tampered row | DONE @ aa46787 — two rival WIP branches from the same night (`0217e85` on `claude/postgresql-16-254336`, `f127ab2` on `claude/resume-4c8ecc`) are **unmerged and stay unmerged**; catalogued with their reusable assets (pgbench G13 governing form, `platform.doc_no_probe` migration, savepoint tamper test, 0.9 Gherkin) in `docs/notes/0.9-abandoned-wip.md` @ `1577a12`. Never merge, never delete. |
| 0.10 | `platform`: thresholds, feature flags, automation rules, decisions table | 🤖 | 0.9 | **B** | SYSADMIN | Threshold change takes effect without redeploy | DONE @ 8914f30 |
| 0.11 | `packages/db`: Drizzle + `withContext()` + lint rule | 🤖 | 0.9 | **B** | SYSADMIN | `db.` outside `withContext()` fails build | DONE @ e138ba2 |
| 0.12 | `packages/events`: outbox relay + subscriber registry | 🤖 | 0.9 | **B** | SYSADMIN | Event written in same tx as state; relay at-least-once; subscriber idempotent | DONE @ 4164eb0 |
| 0.13 | `packages/contracts`: Zod → OpenAPI generation | 🤖 | 0.4 | **C** | SYSADMIN | OpenAPI spec generated; contract test harness runs | DONE @ 335b5db |
| 0.14 | `packages/domain-kit`: Money, Quantity, Clock, IdGenerator | 🤖 | 0.4 | **C** | SYSADMIN | Domain tests deterministic across 1,000 runs | DONE @ a8f4899 |
| 0.15 | Document engine: templates, bindings, Chromium PDF, bilingual RTL | 🤖 | 0.9 | **M** | SYSADMIN | Arabic/English PDF renders correctly; entity header auto-applied | DONE @ 954ff3a |
| 0.16 | Column sensitivity classification: `identity.column_classification` + deploy guard, **and classify every column of 01/13/13B/019 (G6 owner: SYSADMIN, doc 22 D02)** | 🤖 | 0.9 | **M** | SYSADMIN | Unclassified column fails deploy **and** G6 returns 0 on the applied schema; every later migration classifies its own columns (review point 4) | DONE @ a021126 |
| 0.17 | M01 Identity: OTP login, sessions (revocable), roles, permissions, `user_entities`, **structure editor (roles, permission matrix, domain owners, approval chains, delegations, SoD rules)** | 🤖 | 0.11 | **M** | SYSADMIN | Every role logs in and sees only its scope; SoD-violating role assignment rejected; structure editable without deploy | DONE (mechanisms) @ c90dd6e — OTP generation/verification, session issuance/verification/revocation, RBAC permission check, SoD-aware role assignment built and reviewed as packages/identity/ (@pg-eos/identity-mechanisms). Deferred → 2.9 / first slice after 2.9 (GM 2026-09-22, docs/notes/0.17-sequencing-decision-request.md): login API endpoints, admin "structure editor" UI (roles, permission matrix, domain owners, approval chains, delegations, SoD rules screen). |
| 0.18 | **RLS enabled on every operational table in 01/13/13B/019** (the patterns in 01 §11 and 13B §12 generalised) + **client isolation test** (ID tampering) | ✅ | 0.17 | **M** | SYSADMIN | **G7 returns 0** · User A returns zero rows from B's data on direct ID substitution, with no error | DONE @ `f03e160` (phase 1 partial @ `428a565`). **Delivered:** `tests/isolation` workspace (`@pg-eos/isolation-tests`, 43/43), G14 runner wired into `scripts/guards-run.sh` + turbo, eslint scoped. **Phase 2 — D-002 (GM "نفذ الاصلاحات", 2026-09-23), migration `0003_M_rls-scr-01-02.sql`:** SCR-RLS-01 Option B — `entity_scope` becomes `platform.is_internal() and entity_id = any(platform.allowed_entities())` on billing.invoices · tms.delivery_tasks · wms.outbound_orders · wms.occupancy_snapshots · wms.space_allocations · wms.space_reservations · wms.work_orders (precondition refuses to overwrite a drifted predicate; re-runnable); Option C — `identity.enforce_client_users_hold_no_entities()` (SECURITY DEFINER, `search_path = pg_catalog, pg_temp`) + triggers `user_entities_reject_client_user` / `users_reject_client_with_entities`, SQLSTATE 23514. SCR-RLS-02 Option A — RLS + `entity_scope` on the `platform.audit_log` partitioned parent; Option B — G7 widened to `relkind in ('r','p')` in `guards.sql` · `apply.sh` · **doc 40 Part F row G7 and its prose**; Option C — 13B auto-policy loop `relkind in ('r','p')`. **Acceptance met:** G7 = 0 (widened) · zero rows on direct ID substitution, no error, including the dual-role user. **Carried forward (do not re-open here):** (1) `entity_scope` is `FOR ALL`/`USING`-only, so it also governs INSERT — under a non-superuser runtime a portal user's audited action is rejected, and every internal reader and writer of the seven tables must pass `isInternal: true` (`platform.is_internal()` is GUC-only, false when unset) → decide with the 0.5/0.6 role design; (2) Option B was NOT extended to `wms.inbound_orders` / `cc.tickets` / `13-Schema-Additions.sql:702-708` (not vulnerable today — no client policy — but a client policy added later re-opens the hole silently); (3) no guard detects the SCR-RLS-01 permissive-composition class — the SCR §1 enumeration query is the candidate; a new guard changes doc 40 Part F and needs its own G-01; (4) `identity.users.user_type` has no CHECK, so Option C only binds the literal `'client'`; (5) the SCR-RLS-02 test's audit fixture row is deleted only while it is the chain tail — a concurrent writer leaves a permanent `_rls_isolation_fixture` row (G8-safe, deliberately outside the prefix sweep); (6) 0.17 `identity.users` fixture leftover; (7) runtime still connects as superuser (0.5/0.6); (8) turbo `test` task caches DB-touching integration tests and is unhashed on `PG*`. |
| 0.19 | Admin app shell: navigation, Decision Inbox, empty-state component, design system | 🤖 | 0.17 | **M** | SYSADMIN | Inbox renders; empty state shows "what's missing + owner" | DEFERRED → 2.9 (GM 2026-09-22, `docs/notes/0.17-sequencing-decision-request.md`: acceptance criterion is a rendered screen — no mechanism-only subset exists under the Phase-0 rule) |
| 0.20 | Runbook v1 (deploy, rollback, restore, secrets rotation) — drafted as soon as 0.6 is green, sealed only after 0.8 restore succeeds | 🧑 (draft 🤖) | 0.6, 0.8 | **A** | SYSADMIN | Eight procedures written and tested once | WAITING_GM |

**Phase gate:** 0.8 restore succeeded · 0.18 isolation **DONE** (G7 = 0, D-002 applied) · 0.16 classification complete (G6 = 0) · 0.1 owners named · 0.2 three cloud decisions recorded.

---

## Phase 1 — Commercial Core

| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| 1.1 | Enter entity legal data (CR, tax, address, logo) for PCC/PST/PDL/POR | 🧑 | 0.9 | **A** | Admin Mgr | Zero document with incomplete header | WAITING_GM |
| 1.2 | M03 `catalog`: categories, services (7 categories), segments, price lists, exceptions | 🤖 | 0.13 | **1** | CFO | Price below floor rejected from UI, API and import | TODO |
| 1.3 | **Data gate M03:** floor price + standard cost for every active service | 🧑 | 1.2 | **A** | CFO | Scorecard = 100% | WAITING_GM |
| 1.4 | Pricing engine: exception → contract → segment → list → pending | 🤖 | 1.2 | **1** | CFO | Tiered pricing matches manual calc on 3 cases; unpriced event stays pending | TODO |
| 1.5 | M02 `sales`: accounts, contacts, leads, opportunities, activities | 🤖 | 0.13 | **1** | SALES_MGR | One account per client across entities; duplicate detection fires | TODO |
| 1.6 | M02: quotes with approval flow (rep → sales mgr → CFO → GM on exception) | 🤖 | 1.4, 1.5 | **1** | CFO | Sent quote is frozen; edit creates new version | TODO |
| 1.7 | M02: contracts, price annexes, SLA definitions, billing flags (DL-11/12/13/14/18) | 🤖 | 1.6 | **1** | CFO | Order on expired contract rejected | TODO |
| 1.8 | Group-level credit limit and hold | 🤖 | 1.5 | **1** | CFO | Hold blocks orders in all four entities | TODO |
| 1.9 | Customer 360 screen | 🤖 | 1.7 | **1** | SALES_MGR | Shows contracts, readiness gaps with owners, finance, profitability placeholder | TODO |
| 1.10 | **Data gate M02:** all current clients with CR and contact | 🧑 | 1.5 | **A** | CFO | Scorecard = 100% | WAITING_GM |
| 1.11 | Scenario S6 (multi-entity) and S10 (price exception) pass | ✅ | 1.8 | **M** | CFO | Playwright green | TODO |

**Phase gate:** 1.3 and 1.10 gates met · 1.11 green.

---

## Phase 2 — Warehouse (PST · WH1)

| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| 2.1 | Register **WH1**, its zones and its **8 space blocks** — **doc 19 §4 + `019-Warehouse-WH1-Setup.sql`** (the file generates exactly what 19 §4 describes; nothing is entered by hand) | 🤖 | 0.9 | **2** | WH_MGR | Blocks are `P-A` 288 · `P-A1` 12 · `G-B` 906 · `G-C` 45 · `M-B` 906 · `M-C` 45 · `T-B` 906 · `T-C` 45; storage capacity 3,153; 3,301.641 m³ | DONE @ <pending> — proof slice: modules/wms scaffold + wh1-setup.{feature,test.ts} 29/29 (blocks · zones · totals · verify_wh1 · whole-table WH1 check, all doc-19 literals with line cites, numeric equality). No schema change. Whole-table orphan check to be narrowed by the slice that registers a second warehouse. |
| 2.2 | Field survey: aisles, positions per aisle, numbering direction | 🧑 | — | **A** | WH_MGR | Map sums to exactly 3,153 | WAITING_GM |
| 2.3 | Generate the **3,330** codes: 3,153 storage + 30 operational + 147 structural (blocked, prefix `X-`), in the seven-character format of doc 19 §4 | 🤖 | 2.1, 2.2 | **2** | WH_MGR | Count = **3,153 storage locations (capacity)**. Sellable = capacity − the 7% operational buffer entered as `space_blocks_out_of_service` rows with reason `operational_buffer` = **2,932**. Structural blocked with reason | TODO |
| 2.4 | Set `max_weight_kg` (1,000 pallet / 750 shelf) and `max_volume_cbm` per location | 🤖 | 2.3 | **2** | WH_MGR | Over-weight put-away rejected | TODO |
| 2.5 | Print and apply **3,330 labels** — 3,153 storage + 30 operational (white, section colour) + 147 structural (**black background, white text**, prefix `X-`); 5% random scan audit | 🧑 | 2.3 | **A** | WH_MGR | Audit ≥ 99% match | WAITING_GM |
| 2.6 | `wms.skus` with client ownership, dimensions, storage conditions, tracking policy | 🤖 | 1.5 | **2** | WH_MGR | Cross-client SKU mix rejected | TODO |
| 2.7 | **Data gate M04 (SKUs):** ≥95% of active SKUs complete | 🧑 | 2.6 | **A** | WH_MGR | Scorecard ≥ 95% | WAITING_GM |
| 2.8 | Stock ledger + derived balance + `verify_balance_integrity()` | 🤖 | 0.12 | **2** | WH_MGR | Zero rows after 1,000 random movements; property test green | TODO |
| 2.9 | **GOLDEN SLICE — Receive inbound order** (PDA + state machine + ledger + event + GRN + billable events) | 🤖 | 2.4, 2.6, 2.8, 0.15 | **M** | WH_MGR + GM review | Full human review; becomes the template | TODO |
| 2.10 | Put-away with automatic location suggestion (A2) | 🤖 | 2.9 | **1** | WH_MGR | Suggestion respects conditions, ABC, capacity, client assignment | TODO |
| 2.11 | Outbound order: ten-condition check, FEFO allocation, pick sequence (A3) | 🤖 | 2.9, 1.8 | **1** | WH_MGR | Each of ten conditions has a failing test with the correct message | TODO |
| 2.12 | Pick → check (checker ≠ picker) → pack → load slices | 🤖 | 2.11 | **1** | WH_MGR | Self-check rejected | TODO |
| 2.13 | Inventory count: blind, recount mandatory, adjustment by approval | 🤖 | 2.8 | **2** | WH_MGR | System qty invisible to counter | TODO |
| 2.14 | Daily occupancy snapshot + overflow (ST-12) billable event | 🤖 | 2.8 | **2** | WH_MGR | Overflow event generated on exceed | TODO |
| 2.15 | Space management: allocations, reservations, `check_space_available()` guard | 🤖 | 2.1, 1.7 | **2** | SALES_MGR | Over-allocation raises with exact available qty | TODO |
| 2.16 | PDA app: nine screens, offline queue (**72 h**), sync, kiosk mode, shared-device PIN login (doc 40 §D4) | 🤖 | 2.9–2.13 | **M** | WH_MGR | Scan response ≤ 1.0 s; shift cannot close with queue > 0 | TODO |
| 2.17 | Warehouse Grafana board | 🔧 | 2.16 | **M** | SYSADMIN | Board live | TODO |
| 2.18 | Scenarios S1, S2, S18 pass | ✅ | 2.16 | **M** | WH_MGR | Playwright green | TODO |
| 2.19 | Super-user sign-off + 90-min PDA training delivered | 🧑 | 2.18 | **A** | WH_MGR | Sign-off recorded | WAITING_GM |

**Phase gate:** 2.5, 2.7 gates met · 2.18 green · 2.19 signed.

---

## Phase 3 — Delivery & iMile

| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| 3.1 | `tms.vehicles`, documents, hard gate on expired docs | 🤖 | 0.9 | **1** | FLEET_MGR | Expired-doc vehicle cannot be assigned | TODO |
| 3.2 | **Data gate M09:** all vehicles with valid documents | 🧑 | 3.1 | **A** | FLEET_MGR | Scorecard = 100% | WAITING_GM |
| 3.3 | `hr.employees` (drivers), documents, hard gate | 🤖 | 0.9 | **2** | HR_MGR | Expired-doc driver cannot be assigned | TODO |
| 3.4 | Delivery tasks, routes, POD (GPS + signature/photo + server timestamp), exceptions | 🤖 | 2.12, 3.1 | **1** | DEL_MGR | POD without GPS rejected | TODO |
| 3.5 | Failure-reason tree **7 parents × 25 children** with `counts_against_driver` and conditional auto-attribution — **exactly three reasons count against the driver** (`door_not_opened`, `building_not_found`, `shift_time_exhausted`); breakdown and accident never do | 🤖 | 3.4 | **1** | DEL_MGR | "No answer" without two logged contact attempts flagged; `tms.failure_reasons` holds 7 + 25 rows | TODO |
| 3.6 | COD reconciliation + day-close gates (five) | 🤖 | 3.4 | **1** | CFO | Day cannot close with COD variance | TODO |
| 3.7 | Driver app: core (login, device binding, tasks, offline, scan-to-deliver) | 🤖 | 3.4 | **1** | DEL_MGR | Delivery ≤ 6 taps, ≤ 45 s in lab | TODO |
| 3.8 | Driver app: contact layer (pluggable provider, `direct` mode, contact_log) | 🤖 | 3.7 | **1** | DEL_MGR | Customer number never stored on device | TODO |
| 3.9 | Driver app: payment engine (cash live, link behind flag, partial rejected) | 🤖 | 3.7 | **1** | CFO | Link delivery impossible without gateway ref | TODO |
| 3.10 | Driver app: custody ledger, watermark, daily earnings, notifications | 🤖 | 3.7 | **1** | DEL_MGR | Custody > 0 blocks day close; watermark contains server time | TODO |
| 3.11 | Driver app: ranking with six admin settings | 🤖 | 3.10 | **1** | GM | `linked_to_penalty` off by default | TODO |
| 3.12 | `imile.driver_ids` + time-bounded assignments + termination trigger | 🤖 | 3.3 | **2** | DEL_MGR | `verify_attribution()` zero rows; terminated driver's ID auto-released | TODO |
| 3.13 | Commission engine (daily, frozen snapshot, 48-h dispute) | 🤖 | 3.12 | **2** | HR_MGR | Attribution through assignment table only | TODO |
| 3.14 | iMile station agent (dedicated account, remote UI operator, health reporting) | 🤖 | 0.12 | **3** | DEL_MGR | Pull every 10 min; stop > 15 min alerts | TODO |
| 3.15 | Sorting engine: scan → cage/zone/driver in < 1 s | 🤖 | 3.14, 2.16 | **3** | DEL_MGR | ≥ 95% sorted by scan without intervention (lab) | TODO |
| 3.16 | Dispatch plan engine (adjacency, capacity, rotation, exclusions) + **ADR-27 earned autonomy**: `imile.dispatch_autonomy`, the seven-check quality gate in `sorting_plans.quality_gate`, `edits_pct`, and the eight `dispatch.*` thresholds | 🤖 | 3.15 | **3** | DEL_MGR | ≥ 95% drivers with ≤ 3 zones on seed data; auto-approval impossible before the gate passes and autonomy is earned | TODO |
| 3.17 | DTL live audit engine (G0–G4, OCR) + auditor screen + nightly reconciliation at 01:40 + **ADR-27 `imile.dtl_rule_autonomy`** (the eight `dtl.*` thresholds; 5% daily random re-review) + **ADR-28 `imile.driver_trust`** (nightly 01:40, weights sum 1.00, fraud → 0, cold start → 0.70, never shown to the driver and never linked to pay or penalty) | 🤖 | 3.14 | **3** | DEL_MGR | Rule accuracy tracked; open > 24 h escalates; `reject` is never auto-closed | TODO |
| 3.18 | Daily station inventory (PDA, blind, discrepancy explanation) | 🤖 | 2.16, 3.14 | **3** | DEL_MGR | 500 shipments ≤ 45 min; zero unexplained | TODO |
| 3.19 | Weekly capacity report to iMile | 🤖 | 3.16 | **3** | GM | Auto-generated | TODO |
| 3.20 | Scenarios S3, S4, S15, S16 pass | ✅ | 3.18 | **M** | DEL_MGR | Playwright green | TODO |
| 3.21 | Driver app lab test (doc 34 protocol) — must beat iMile by ≥ 2 taps | ✅ | 3.10 | **M** | DEL_MGR | Median from 3 drivers recorded | TODO |
| 3.22 | Driver training (60 min, 6 languages) + super-user sign-off | 🧑 | 3.21 | **A** | DEL_MGR | Sign-off recorded | WAITING_GM |

**Phase gate:** 3.2 data gate (Lane A) · full station day from PG-EOS · zero audit problem > 24 h · 3.21 target met.

---

## Phase 4 — Finance & Billing

| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| 4.1 | Chart of accounts (uniform structure per entity) | 🧑 | 1.1 | **A** | CFO | Loaded for all four entities | WAITING_GM |
| 4.2 | `billing.billable_events` with unique (source, service) index | 🤖 | 0.12, 1.4 | **M** | CFO | Same event cannot bill twice | TODO |
| 4.3 | Billing subscribers: WMS, TMS, CC, iMile events → billable events | 🤖 | 4.2, 2.14, 3.4 | **M** | CFO | Every closed operation produces its events | TODO |
| 4.4 | Invoice generation: monthly aggregation, `doc_no` only at approval (DB constraint) | 🤖 | 4.3, 0.15 | **M** | CFO | Draft has no number; approved cannot be edited | TODO |
| 4.5 | Auto-approval under threshold; human above | 🤖 | 4.4, 0.10 | **M** | CFO | Threshold change effective without deploy | TODO |
| 4.6 | Invoice PDF + detail sheet (every line → events → evidence) | 🤖 | 4.4 | **M** | CFO | Disputed line opens its events in one click | TODO |
| 4.7 | Receipts, allocation, bank statement import + auto-match (I-08) | 🤖 | 4.4 | **M** | ACCOUNTANT | Unmatched go to accountant queue; CFO ≠ ACCOUNTANT enforced | TODO |
| 4.8 | Credit notes (GM approval only) | 🤖 | 4.4 | **M** | GM | Requires original invoice reference | TODO |
| 4.9 | Aging, reminders (−3, 0, +7, +15, +30), automatic group-level hold | 🤖 | 4.7, 1.8 | **M** | CFO | Hold blocks all entities | TODO |
| 4.10 | SLA measurement + penalty line on invoice | 🤖 | 1.7, 3.4 | **M** | CFO | Computed from data, appears as invoice line | TODO |
| 4.11 | Journal entries auto-posted; `verify_journal_balance()` | 🤖 | 4.1, 4.4 | **M** | CFO | Zero unbalanced entries | TODO |
| 4.12 | Intercompany: flagged transactions, transfer pricing list, consolidation elimination | 🤖 | 4.11 | **M** | CFO | Group P&L excludes intercompany | TODO |
| 4.13 | Cost allocation + profitability per client/contract | 🤖 | 4.11, 3.13 | **M** | COST_ANALYST | Margin computed monthly | TODO |
| 4.14 | Lost-revenue report | 🤖 | 4.3 | **M** | CFO | Unpriced and non-contracted events listed with estimated value | TODO |
| 4.15 | Partners: contracts, price lines, payable events, invoice matching (≤2% auto) | 🤖 | 4.2 | **M** | CFO | Invoice line without our event rejected | TODO |
| 4.16 | Month-end (three steps under P11) | 🤖 | 4.5–4.14 | **M** | CFO | Full cycle runs on seed data | TODO |
| 4.17 | Scenarios **S8, S11, S19, S20** pass — S19 and S20 are written out in doc 40 Part E v4 from doc 12 (س19، س20) | ✅ | 4.16 | **M** | CFO | Playwright green | TODO |
| 4.18 | **First real automated invoice matches operations** | ✅ | 4.17 | **M** | CFO | Signed by CFO | TODO |

**Phase gate:** 4.11 zero rows · 4.18 signed.

---

## Phase 5 — Support Modules

| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| 5.1 | M06 Call center: queues, agents, calls, tickets, SLA, ticket ↔ shipment link | 🤖 | 3.4 | **1** | CC_MGR | Agent cannot see another queue's tickets (RLS) | TODO |
| 5.2 | CC billing (internal transfer price, external package + overage) | 🤖 | 5.1, 4.3 | **1** | CFO | Scenario S5 green | TODO |
| 5.3 | M08 HR: org units, teams, attendance from biometrics (I-04), leaves | 🤖 | 3.3 | **2** | HR_MGR | Attendance auto-imported; unmatched to manual queue | TODO |
| 5.4 | Biometric credentials entered by GM; hourly sync | 🧑 | 5.3 | **A** | GM | Sync runs; **auto-absence disabled until data complete** | WAITING_GM |
| 5.5 | Shifts and rest rotation (A3) | 🤖 | 5.3 | **2** | OPS_DIR | Rotation fair; exceptions logged | TODO |
| 5.6 | Payroll ledger (auto-calc, CFO approval, month lock) | 🤖 | 5.3, 3.13 | **2** | CFO | Locked month immutable | TODO |
| 5.7 | Penalty schedule (**77 items**, `is_fraud` flagged on CLI-02/03/04/06/09 · ATT-07/08 · WRK-08), Art. 35–41 guards, **hierarchical authority enforced by trigger on `hr.disciplinary_cases.signed_by` with `routed_to` recorded** (supervisor D1–D2, manager D1–D3, GM D1–D4, dismissal GM only), grievance to the level above the signer, hash-chained | 🤖 | 5.3 | **2** | GM | `select count(*) from hr.penalty_schedule` = 77; deduction without Art. 37 steps rejected; Art. 35 15-day limit enforced; 5-day cap enforced; signer outside authority auto-routed up, never silently rejected | TODO |
| 5.8 | Recruitment cases (**17 stages with fixed English codes per doc 10 v4 / 13B check constraint**, owner per stage, SLA, cost tracking, `due_at` maintained by trigger — not a generated column) | 🤖 | 5.3 | **2** | PRO | Stage without owner impossible; a stage code outside the 17 is rejected by the check constraint; escalation fires on day 11 (7-day SLA + `recruitment.escalate_pct` = 50) | TODO |
| 5.9 | Government transactions module | 🤖 | 5.8 | **2** | PRO | Overdue auto-flags | TODO |
| 5.10 | Housing: properties, units, rooms, beds, assignments, maintenance, inspections | 🤖 | 5.3 | **1** | HOUSING_SUP | Bed = unit of assignment; clearance blocked until bed released | TODO |
| 5.11 | Administrative: purchase requests, three-way match, petty cash, assets/custody, approvals, correspondence | 🤖 | 4.1 | **3** | Admin Mgr | PO paid without match impossible | TODO |
| 5.12 | Fleet: maintenance plans (km-based), orders, accidents, fuel ledger (I-03 import) | 🤖 | 3.1 | **3** | FLEET_MGR | Fuel entry without odometer rejected; anomaly > 20% flagged | TODO |
| 5.13 | Alerts engine (**22 rules — N-01…N-18 plus N-19…N-22 from doc 23 §4**), report catalog (24), scheduled delivery | 🤖 | 0.10 | **M** | SYSADMIN | Alert without action link impossible; no alert targets an unfilled position | TODO |
| 5.14 | M13 Governance: budgets/variance, KPI tree, OKRs, risk register, NCR, policies, board pack, decisions | 🤖 | 4.11 | **3** | GM | Board pack generates from live data | TODO |
| 5.15 | **Data gates M08, M09 (documents 100%)** | 🧑 | 5.3, 3.1 | **A** | HR_MGR, FLEET_MGR | Scorecards = 100% | WAITING_GM |
| 5.16 | Scenarios S13, S14, S17 pass | ✅ | 5.11 | **M** | HR_MGR | Playwright green | TODO |
| 5.17 | **One full payroll month computed and reviewed** | ✅ | 5.6 | **M** | CFO | Signed | TODO |

**Phase gate:** 5.15 gates · 5.17 signed.

---

## Phase 6 — Client & Manager Apps

| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| 6.1 | Client Portal (separate app): 12 screens, 4 client roles, onboarding | 🤖 | 2.11, 3.4, 4.6 | **1** | GM | RLS isolation test green (direct ID tampering) | TODO |
| 6.2 | Client API v1 (I-09): orders, status, inventory, tracking, webhooks | 🤖 | 6.1 | **1** | SYSADMIN | Idempotent by `client_ref`; rate-limited | TODO |
| 6.3 | Premium Decisions app: inbox, six KPI cards, search/trace, decide-from-notification | 🤖 | 0.19, 5.13 | **2** | GM | Decision resolved from push notification without opening app | TODO |
| 6.4 | Trace screen (doc 31 §6): one input, unified timeline, causation tree, signed PDF export | 🤖 | 0.12 | **2** | SYSADMIN | Full trace ≤ 2 s | TODO |
| 6.5 | WhatsApp templates (5) + provider (I-05), SMS fallback (I-06) | 🤖 | 3.8 | **3** | SYSADMIN | Quiet hours enforced | TODO |
| 6.6 | Three real clients onboarded and operating | 🧑 | 6.1 | **A** | GM | Client readiness checklists complete | WAITING_GM |
| 6.7 | Scenarios S7, S9, S12 pass | ✅ | 6.3 | **M** | GM | Playwright green | TODO |

**Phase gate:** 6.1 isolation · 6.6 three clients live (Lane A) · 6.7 green.

---

## Phase 7 — Hardening & Launch

| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |
|---|---|---|---|---|---|---|---|
| 7.1 | Penetration test (external) | ✅ | 6.7 | **M** | SYSADMIN | No critical/high findings open | TODO |
| 7.2 | Load test on three-year seed volume against doc 25 SLOs — **on Tier 1 infrastructure** (Tier 0 RPO 24 h is not launch-grade; Tier ≥ 1 targets RPO ≤ 1 h / RTO ≤ 4 h) | ✅ | 6.7 | **M** | SYSADMIN | All SLOs met on Tier ≥ 1 | TODO |
| 7.3 | Mutation testing ≥ 75% on `domain/` across all modules | ✅ | 6.7 | **M** | SYSADMIN | Stryker report | TODO |
| 7.4 | All **20** scenarios (S1–S20) green in CI | ✅ | 6.7 | **M** | SYSADMIN | **20/20** | TODO |
| 7.5 | Manual fallback kits in four locations; **one manual-mode drill executed** | 🧑 | 5.13 | **A** | OPS_DIR | Drill report | WAITING_GM |
| 7.6 | Deputy system owner (`DEPUTY_SYSADMIN`) named and trained on the runbook | 🧑 | 0.20 | **A** | GM | Deputy executes a restore unassisted | WAITING_GM |
| 7.7 | Legal holds: automatic on disputed photos before enabling 60-day deletion | 🤖 | 6.4 | **M** | SYSADMIN | Hold prevents deletion in test | TODO |
| 7.8 | Penalty schedule submitted to labour authority; approval flag | 🧑 | 5.7 | **A** | PRO | Flag set only on written approval | WAITING_GM |
| 7.9 | Data-residency legal review closed | 🧑 | — | **A** | GM | Written opinion on file | WAITING_GM |
| 7.10 | ~~Structural verification~~ → **Closed (verified; drawing + licence on file)** | 🧑 | — | **A** | GM | ✅ | WAITING_GM |
| 7.11 | Adoption metrics live (weekly active 100%, screens unused 30 d) | 🤖 | 5.13 | **M** | GM | Report scheduled | TODO |
| 7.12 | Launch checklist (doc 28 §11, 18 items) all ticked | ✅ | 7.1–7.11 | **M** | GM | Signed | TODO |

---

## Cross-Cutting (runs throughout)

| ID | Task | Cadence | Lane | Owner | Status |
|---|---|---|---|---|---|
| X.1 | Weekly 15-minute data meeting; monthly MDM scorecard | Weekly / monthly | **A** | GM | CONTINUOUS |
| X.2 | Decision log updated on every recorded decision | Continuous | **A** | GM | CONTINUOUS |
| X.3 | Grafana board built with each module (not after) — doc 36 §4-1 requires one board per module | Per module | **M** | SYSADMIN | CONTINUOUS |
| X.4 | Ten-point human review on every AI slice (doc 36 §5-4) | Per slice | **M** | Module owner | CONTINUOUS |
| X.5 | iMile app lab study — fill 19-criteria table when screenshots arrive | Once | **A** | DEL_MGR | CONTINUOUS |
| X.6 | Formal API request to iMile; agent retired when granted | Once | **A** | GM | CONTINUOUS |

---

## Staged (not in doc 38 — enter this file only after GM approval)

| ID | Task | Source | File | Status |
|---|---|---|---|---|
| 2.20 | Warehouse work orders & VAS (SCR-WO-01) | D-12 | `tasks/proposed/2.20-work-orders.md` | WAITING_GM |
| 5.18 | Focus boards on `platform.my_work` (SCR-FB-01) | D-15 | `tasks/proposed/5.18-focus-boards.md` | WAITING_GM |
| 6.2b | Client store connectors (I-12) | D-11 | `tasks/proposed/6.2b-store-connectors.md` | WAITING_GM (option choice) |
| SC-01 | Sales commission activation (SCR-SC-01) | D-14 | `tasks/proposed/SC-01-sales-commission.md` | WAITING_GM (model + rates) |

**Rows: 132** (expected 132 — `--check` fails otherwise).
