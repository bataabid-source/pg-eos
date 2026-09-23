# DECISION_LOG — PG-EOS

**Seeded from `docs/package/EXECUTION-MASTER-v4.md` PART 1 (Mandate Decisions Register, §1.1–§1.16) per BOOTSTRAP-v4 §8.** EXECUTION-MASTER-v4 governs on any difference; this file is the working log that grows from here.

**Rules**
- A new decision is appended in the working log below as one row: `| D-NNN | date | decision | rationale | source (GM / ADR / SCR) |`. The GM then writes it into EXECUTION-MASTER-v4 Part 1 (documents are edited in the package, never re-derived).
- An ADR is filed only for a decision that CHANGES the architecture (CLAUDE.md · DOCUMENTATION). Everything else lives here and in `docs/CHANGELOG.md`.
- Decisions still owed by the GM are NOT recorded here as open markers — they are listed in `docs/package/D-blueprints/09-Gap-Register.md` (22 GM decisions) and in `tasks/proposed/`; each already has a temporary value applied in v4. This file therefore carries zero open-decision markers (acceptance check, PROJECT-SETUP-GUIDE §4).

---

## Seed — EXECUTION-MASTER-v4 PART 1 (verbatim)


Every open item that blocks a WBS task is closed here. Values are defaults in `platform.thresholds` / `platform.settings` unless marked FIXED. Rationale in one line. (Items 4 and 6 of doc 29 §11 are superseded by doc 38 and doc 40 §B5; item 1 is recorded in §1.4 below.)

### 1.1 Commercial (docs 04, 06, 17, 29)

| Item | Decision | Rationale |
|---|---|---|
| Service floor price (data gate M03) | **Rule:** `min_price = standard_cost × 1.15` until CFO overrides per service | Removes the gate deadlock; 15% is the minimum margin |
| Minimum contract margin | **15%** warning; **< 10% requires GM** | Doc 29 §5-3 |
| DL-11/12/13/14/18 billing | **Contract flag, default OFF**; every off-contract occurrence lands in Lost Revenue report | Bill what the contract says; expose the rest |
| PCC pricing model | **Package + overage** (CC-01…CC-15) | Predictable for client, upside for us |
| Invoice auto-approve threshold | **≤ 500 KWD** auto; CFO above | Doc 29 §7 |
| Purchase approval tiers | **≤ 100 auto · 100–500 department manager · 500–2,000 CFO · > 2,000 GM** (KWD) | Doc 11 |
| Credit note | **Never auto**; GM only | FIXED |
| Space reservation max | **30 days** without contract; longer needs CFO | Prevents phantom blocking |
| ST-14 reserved-unused space | **Billed** — mandatory clause in every storage contract | Otherwise our cost |
| Operational buffer excluded from sale | **7%** of capacity | Doc 17 |
| Overflow (ST-12) | **Automatic billing + alert**; no approval needed | Revenue leak otherwise |
| Client sees detailed locations in portal | **No** (setting, per client) | Security default |
| Partner named to client | **No** | Doc 09 |
| Partner liability cap | **min(3 × monthly billing, contract value)**; insurance by partner | Standard back-to-back |
| Partner invoice matching tolerance | **2 %** of the expected amount (`partner.match_tolerance_pct`); above it the invoice is held for CFO | Recorded in v4: the value was already used consistently in 40 §C6, 29 §5-3, 09 and S20, but had no entry in this register |
| Segment upgrade | Auto after 3 months; downgrade manual | Doc 06 |

**No self-approval** is a real constraint (`requester_id <> approver_id`), never `check (true)`. Where a requesting department has no filled manager, the approver is the requesting department's manager (WH_MGR / DEL_MGR / SALES_MGR / FLEET_MGR as applicable), then CFO, then GM; the unfilled positions `OPS_DIR` and `HR_MGR` never appear as approvers. HR approvals (housing-deduction exemption, D4 penalties, recruitment) go to GM.

### 1.2 Operations (docs 07, 17, 19, 30, 35)

| Item | Decision | Rationale |
|---|---|---|
| Location numbering direction | **Position 01 at the door end; aisle 1 on the pallet side** | Worker enters and counts up |
| PDA devices | **Existing + 20% spare**; industrial Android with laser scanner (Zebra TC-series or Honeywell CT-series class) | Doc 30 §6 |
| Checker ≠ picker | **Always enforced**; supervisor override logged with reason | FIXED |
| Quarantine decision | **WH_MGR**, 48-h client window | Doc 03 |
| Driver contact provider | `direct` at launch; **masked** evaluated at Phase 3 exit | Doc 35 §1-2 |
| Payment gateway | **Deferred to Phase 4 exit**; engine built now, flag hidden | Doc 35 §2-3 |
| Zone difficulty coefficient | Computed from 90 days of data at Phase 3 + 90 d; **1.0 until then** | No guessing |
| Driver commission | **0.300 KWD per delivered shipment (FIXED base)**; quality bonus +0.050 when first-attempt ≥ 85% and no COD variance in the month; deductions housing 23 · phone 5 · residency 12 (thresholds) | Doc 10 · doc 35 |
| Peer ranking | enabled · band · no peer names · basis success_rate · bonus-linked OFF · penalty-linked **OFF (FIXED)** | Doc 35 §8-3 |
| Failure reasons counted against the driver | **Three only**, of the 25 sub-reasons, exactly as named in doc 35 §4-1: (1) **«لم يفتح الباب» — door not opened**, counted only when two logged contact attempts are absent; (2) **«لم أجد المبنى» — building not found**, counted only when the recorded location is > 300 m from the address; (3) **«نفاد وقت الوردية» — shift time ran out**, counted as time mismanagement except on supervisor override. **Vehicle breakdown and accident are NOT counted against the driver** — they are attributed to the fleet / to the investigation outcome | FIXED (consistent with "no accident is charged before an investigation", §1.3) |
| Failed-delivery custody held by the driver | **Alert at 24 h** (`driver.custody.alert_hours = 24`) · **escalation to DEL_MGR at 48 h** (`driver.custody.escalate_hours = 48`) and penalty CLI-08 becomes applicable; both seeded in 13B | Doc 35 §7 is the operational source; doc 40 carried a single `escalate_hours = 24` inside an `e.g.` list — split and unified in v4 (OPS-42). GM may change either in `platform.thresholds` |
| Sorting automation level | **A3** (shortest route respecting fixed appointments) — already A3; doc 40 §C8 and doc 07 are corrected from A2 | FIXED |
| iMile station agent | Dedicated account; remote UI operator; **formal API request drafted by pg-scribe in Phase 3, sent by GM** | Doc 23 |
| Document-expiry alert ladder | **90 / 45 / 30 / 15 days** — one ladder everywhere | Doc 40 §C7 |

### 1.3 HR, Housing, Fleet (docs 10, 14, 15, 27)

| Item | Decision | Rationale |
|---|---|---|
| Housing deduction | **23 KWD**, pro-rated; exemption by **GM with a recorded reason** | Existing practice |
| Housing cost allocated to client profitability | **Yes** | True cost of labour-heavy clients |
| Housing homogeneity | **By shift first, then team** | Sleep conflict is the real problem |
| Housing unit of assignment | **The bed**; occupancy is computed from `bed_assignments`, never from `beds.status` | Only assignment is evidence |
| Maintenance SLA | **4 h emergency · 24 h high · 48 h normal** | Doc 14 |
| Minimum occupancy before lease review | **70%** | Idle rent |
| Fleet preventive intervals (defaults, per vehicle type editable) | Oil/filters **5,000 km or 90 d** · brakes **20,000 km** · tyres **40,000 km** · statutory inspection per law | Industry defaults |
| Accident charge to driver | **Only after investigation; capped at insurance deductible** | Doc 27 §3 |
| Penalty schedule | As doc 15 — **77 items**, codes unique; hierarchical authority (supervisor D1–D2 · manager D1–D3 · GM D1–D4; dismissal GM only), out-of-authority signer auto-routes **up** and the routing is recorded; **warning banner until the labour-authority approval flag is set** | FIXED |
| Auto-absence from biometrics | **Disabled until attendance data ≥ 95% complete for 30 days** | Prevents mass wrong penalties |
| Recruitment | **17 stages** with fixed English codes, beginning at `work_permit` (doc 40 S13), constrained by a `check` in 13B | Doc 10 |
| Recruitment cost amortisation | Over contract length, to assigned client | Doc 10 |

### 1.4 Platform, Security, Continuity (docs 22, 23, 25, 26, 31)

| Item | Decision | Rationale |
|---|---|---|
| Alerts / reports | **22 alerts (N-01…N-22), 24 reports** — N-19…N-22 are the four monitoring conditions doc 23 §4 imposes: manual queue > 20 items or > 48 h · WhatsApp bounce rate > 5% · bank reconciliation late > 7 days · any integration with no successful run for 24 h | Doc 25 + doc 23 §4 |
| Alert completeness | Every alert row carries `source_query` (SQL over 01/13/13B/019), `action_label` and `action_link` (a screen path from doc 29 §6). An alert without an action link is invalid | Doc 40 §B6 |
| Quiet hours | **22:00–07:00** except emergencies (agent down, COD variance). **Fire is not a system alert** — it is an operational exception handled by declaring manual mode | Doc 25 · doc 26 |
| Automation target (P11) | **≥ 80% of processes at A2/A3** | Doc 29 §10 |
| Availability target | **99.5% business hours** | Doc 40 Part G |
| Continuity by tier | **Tier 0** (Phases 0–3, Oracle Always Free): RPO **24 h** / RTO **4 h**; backup retention **14 daily · 8 weekly · 6 monthly**. **Tier 2** (from Phase 4, GCP or paid OCI): RPO **≤ 1 h** / RTO **≤ 4 h**; retention 30 · 12 · 12. Tier numbers are always written with the tier name | Doc 42 §6 · doc 40 Part G |
| Tier 0 shape | **ARM A1 · 4 OCPU / 24 GB** — the whole Always Free quota in one VM; **zero inbound ports** (Cloudflare Tunnel only) | Doc 42 §11 |
| Tier 1 definition | **Paid OCI resources on the same PAYG account** (database split to its own VM + a read replica); size decided at the trigger. No paid resource without a written GM instruction | Doc 42 §0 |
| Tier 1/2 trigger | **Any of:** before Phase 4 · > 40 concurrent users · a 7-day p95 breach | Doc 42 §11 |
| Reporting read path | Read replica for reports is a **Tier 1/2** target; at Tier 0 reports run on the same server outside peak hours | Doc 40 §B6 · doc 36 §4-4 |
| WhatsApp / SMS provider | **Twilio** (already connected to the GM's workspace); templates **T1–T5 are defined in doc 35 §1-3**; doc 23 refers to them | Doc 23 I-05/06 |
| Bank statement | **CSV/MT940 import**, matched by **CFO** (CFO also owns I-08) | Doc 23 I-08 |
| Integration tables | `platform.integration_config` = the contract and policy · `platform.integration_queue` = the manual queue · `platform.integration_runs` = the run log. No duplication | Doc 23 · doc 01 |
| Client API | **Phase 6**, `/v1` | Doc 40 §C10 |
| Photo retention | 60 days with **automatic `legal_hold`** on any photo linked to dispute/complaint/penalty — built in Phase 6 before deletion is enabled; `tms.proof_of_delivery` carries `legal_hold`, `retain_until`, `sha256` | Doc 31 §8 |
| Audit hash chain | **Enabled** — `platform.audit_log` is monthly-partitioned with a SHA-256 chain (`prev_hash` / `row_hash`) and the eleven columns of doc 40 §B2; primary key `(id, occurred_at)` | Doc 31 · doc 40 §B2 |
| Event table | **`platform.outbox` is the governing event table** (doc 40 §B3, doc 36 §3-1); it carries `entity_id` and is under RLS. `platform.domain_events` is deleted | Doc 40 §B3 |
| Thresholds vs settings | Both remain: `platform.thresholds` = numeric limits the GM edits without a deploy; `platform.settings` = textual/boolean settings | Doc 40 §B5 |
| Manual-mode declaration | **GM**, or WH_MGR / DEL_MGR for their own scope; channel: WhatsApp group `PG-EOS-OPS` | Doc 26 |
| First manual-mode drill | **After the Phase 2 gate** | Doc 26 |
| Roles | **26 roles** = the 25 of doc 40 §B1 + `DEPUTY_SYSADMIN`, seeded in 13B | Doc 40 §B1 + §1.7 |
| Deputy system owner | **Role created now (`DEPUTY_SYSADMIN`)**; person assigned by GM before Phase 4 | Cannot be delegated further |
| Separation of duties | **Four pairs everywhere:** (CFO, ACCOUNTANT) · (SALES_MGR, CFO) · (WH_OP, WH_SUP) · (PRO, CFO). Delegation never bypasses SoD (ADR-16c) | §1.6 |
| Document series (`platform.counters`) | Receipts **`RCT`** only (`RCP` / `RC` removed) · government fees **`GOV`** · invoices **`INV`** | §1.6 |
| Break-glass credentials | Physical safe at head office; GM + CFO know location | Doc 26 |
| Data residency | Tier 0 holds seed/test data only; **legal opinion required before real client data on Tier 0/2** — WBS 7.9 | §6.2 item 4 · WBS 7.9 |
| Language switcher | **ar / en** in admin; 6 languages in field apps | Doc 40 closing note (i18n ar, en, hi, ur, bn, am) · doc 29 §6 · D-001 |
| Owners' view | **KPIs and margins; no payroll, no per-employee data** | Doc 29 §6 |

**Nothing remains open that blocks any WBS task. The two items outside the mandate — naming the deputy and sending the iMile letter — are GM signatures, not decisions.**

---

### 1.5 Entity tree — Premium Group Holding (applied to doc 01, doc 40 §A2)

- `PGH` Premium Group Holding (`entity_kind = holding`, own CR) is the root; PCC/PST/PDL/POR are `operating` children via `parent_id`.
- Holding carries shared costs, executive employees, framework contracts. Shared costs allocated monthly to the four operating entities (`billing.cost_allocations`, revenue-share default).
- DB trigger `billing.reject_holding_invoice()` forbids any non-intercompany invoice on the holding.

### 1.6 Ownership by position and separation of duties (doc 22 §2-1–2-3)

- All 12 master-data domains owned by filled positions: GM (=SYSADMIN) · CFO · SALES_MGR · WH_MGR · DEL_MGR · FLEET_MGR · HOUSING_SUP+PRO.
- Price floors and standard costs approved by GM + CFO; SALES_MGR maintains the catalog only.
- PRO = collections (receipts, series `RCT`); CFO approves invoices and **reconciles bank accounts (CFO owns I-08)**. Government-fee custody uses series `GOV`, separate from `RCT`.
- `identity.sod_rules` defaults: (CFO,ACCOUNTANT) · (SALES_MGR,CFO) · (WH_OP,WH_SUP) · **(PRO,CFO)**. Enforced by trigger. **Delegation never bypasses SoD** (ADR-16c).
- Penalty authority is hierarchical from `hr.employees.reports_to`: supervisor D1–D2 · managers D1–D3 · GM D1–D4 (dismissal GM only). Out-of-authority signer auto-routes up — the schema enforces this through `hr.disciplinary_cases.signed_by` plus a trigger that compares the penalty degree with the signer's position ceiling and **re-routes upward instead of rejecting silently** (recording `routed_to`). Grievance goes one level above the signer.
- Roles, permission matrix, domain owners, approval chains, delegations (≤ 90 days, mandatory end), SoD rules are **data**, editable from the UI by SYSADMIN/GM; changes audited; SoD rule deactivation requires GM + reason.

### 1.7 G-06 · Role concentration — accepted with compensating controls

- GM = SYSADMIN: create `DEPUTY_SYSADMIN`; four-eyes on permission/secret/SoD/approval-chain changes (second approver = DEPUTY_SYSADMIN **or CFO** — active from day one); GM's SYSADMIN actions tagged in audit and monthly report.
- PRO = ACCOUNTANT: PRO never holds CFO; separate receipt series; CFO reconciles both cash streams.
- Four-role permission matrix: HOUSING_SUP (housing.* rw; hr.employees read code/name/unit; maintenance requests; no payroll/commercial) · CLIENT_ADMIN (all portal, manage users, approve orders) · CLIENT_CREATOR (create ASN/outbound draft; view; cannot approve; no invoices) · CLIENT_VIEWER (read-only ops; no invoices) · CLIENT_FINANCE (invoices/statement/aging only).

### 1.8 G-16a · Authentication limits

OTP 6 digits · TTL 5 min · single-use · 5 attempts · resend 60 s · 5/email/hour. Lockout 10 fails/15 min → 15→30→60 min; 3 lockouts/24 h → alert. Rate limits: login 5/min/IP + 20/h/email; internal API 300/min/user; client key 100/min; field sync 60/min/device. CORS explicit origins only, credentials true, preflight 600 s. Sessions: internal 6 h; field apps access 1 h + refresh 30 d device-bound.

### 1.9 G-07 · Field-app authentication (two device models)

- **PDA — shared device:** registered asset (device→registry); any authorised worker; one active session per device; switch needs no approval; login = employee code + 6-digit PIN (hash cached **on the registered device only** after first online login); OTP re-verify weekly online; offline window 72 h.
- **Driver app — personal device:** one device per driver (device→user); enrol with OTP once → 30-day refresh; new device = supervisor approval; offline 7 days.
- **Common:** device signing key; every queued op stamped with acting user_id + device signature + op timestamp; accepted if token valid **at op time**; revoked device's queue quarantined for supervisor review; shift start online (face) with `offline_start` fallback flag.
- **Shift-close amendment:** ending a session with a pending queue is allowed (handover); shift close finalises automatically when the worker's last op syncs; no shift is marked closed with queue > 0.
- Doc 40 §B1 is amended to read: "No passwords stored on the server; the PDA caches a PIN hash locally per G-07."

### 1.10 G-17 · Cloud (doc 42 §11)

PAYG tenancy (Always Free resources, $1 budget alert) · `me-jeddah-1`, fallback `me-dubai-1` · Cloudflare Tunnel, zero inbound ports · Tier-0 RPO 24 h for Phases 0–3 · Tier-1 trigger: before Phase 4, or > 40 concurrent users, or 7-day p95 breach. Tier 0 shape: ARM A1, **4 OCPU / 24 GB**; backup retention at Tier 0 **14 / 8 / 6**.

### 1.11 G-01 · Schema-change rule

Approve if within docs **01 / 13 / 13B / 019**. Approve an addition only for (i) real schema gap, (ii) unsolvable technical constraint, (iii) doc 40 requirement not modelled. Reject new business rules inside slices — they belong in `platform.thresholds` or a recorded GM decision. GM-issued DDL needs no SCR.

### 1.12 ADR-27 · Earned autonomy — DTL auto-close and dispatch auto-approve

- **DTL:** `accept`/`reclassify` auto-closable; `reject` always human. Conditions (all): confidence ≥ 0.90 · not G3 · COD ≤ 20.000 · driver_trust ≥ 0.80 · objective evidence · rule at level 1. Promotion 0→1: 14 consecutive days accuracy ≥ 0.97 on ≥ 50 cases. Demotion: any day < 0.95. Daily 5% random re-review. `closed_by = 'engine'` marked.
- **Sorting:** already A3 — no change.
- **Dispatch:** auto-approve when the 7-check quality gate passes (100% assigned or overflow ≤ 3% with carried list; ≥ 95% drivers ≤ 3 zones; zero exclusion/capacity violations; rotation; adjacency; valid docs + active ID) AND earned (14 plans, ≥ 90% unchanged acceptance). Demotion: 2 consecutive plans > 20% edited, or first-attempt rate drops > 10 pts vs 30-day mean. Override window until first cage handover. `approved_by_kind = 'engine'`.
- **Schema objects (as created in 13B):** tables `imile.dtl_rule_autonomy` · `imile.dispatch_autonomy` · `imile.driver_trust` · `imile.coverage_areas` (the last from the doc 07 description, replacing the prose "Coverage_Areas"); columns `imile.dtl_problems.closed_by` and `imile.sorting_plans.approved_by_kind` / `quality_gate` / `edits_pct`. (`sorting_plans.approved_by` stays `uuid` for the human approver; `approved_by_kind ∈ {human, engine}` carries the engine case — 13B decision ق-6.)
- **16 thresholds (8 `dtl.*` + 8 `dispatch.*`) as seeded in 13B** — the addendum said "14 thresholds"; the literal extraction of every numeric value stated in this section yields 16. Nothing was invented and nothing dropped.

| # | Threshold key (13B) | Value | Unit | Meaning |
|---|---|---|---|---|
| 1 | `dtl.auto_close.min_confidence` | 0.900 | ratio | Auto-close requires engine confidence ≥ 0.90 |
| 2 | `dtl.auto_close.max_cod_kwd` | 20.000 | KWD | Auto-close requires COD ≤ 20.000 |
| 3 | `dtl.auto_close.min_driver_trust` | 0.800 | ratio | Auto-close requires driver trust ≥ 0.80 |
| 4 | `dtl.promotion.consecutive_days` | 14.000 | days | Promotion 0→1 requires 14 consecutive days |
| 5 | `dtl.promotion.min_accuracy` | 0.970 | ratio | Promotion requires accuracy ≥ 0.97 |
| 6 | `dtl.promotion.min_cases` | 50.000 | count | Promotion requires ≥ 50 cases in the window |
| 7 | `dtl.demotion.accuracy_floor` | 0.950 | ratio | Any day below 0.95 ⇒ immediate demotion |
| 8 | `dtl.review.random_sample_pct` | 5.000 | pct | Daily random re-review of 5% of auto-closures |
| 9 | `dispatch.gate.max_overflow_pct` | 3.000 | pct | Quality gate — unassigned overflow ≤ 3% with a carried list |
| 10 | `dispatch.gate.min_drivers_zone_cap_pct` | 95.000 | pct | Quality gate — ≥ 95% of drivers within the zone cap |
| 11 | `dispatch.gate.max_zones_per_driver` | 3.000 | count | Quality gate — ≤ 3 zones per driver |
| 12 | `dispatch.promotion.min_plans` | 14.000 | count | Autonomy earned after 14 plans |
| 13 | `dispatch.promotion.min_unchanged_pct` | 90.000 | pct | Promotion requires ≥ 90% unchanged acceptance |
| 14 | `dispatch.demotion.consecutive_plans` | 2.000 | count | Two consecutive plans over the edit cap ⇒ demotion |
| 15 | `dispatch.demotion.max_edits_pct` | 20.000 | pct | Plan edit cap 20% |
| 16 | `dispatch.demotion.first_attempt_drop_pts` | 10.000 | points | First-attempt rate dropping > 10 pts vs the 30-day mean ⇒ demotion |

### 1.13 ADR-28 · driver_trust_score

`trust = 1 − (0.35·p1 + 0.25·p2 + 0.20·p3 + 0.10·p4 + 0.10·p5)` clamped [0,1]; trailing 90 days; nightly 01:40. p1 DTL rejection rate (den ≥10) · p2 attributed-failure rate (≥10) · p3 no-answer claims with < 2 contacts (≥5) · p4 deliveries > 300 m (≥20) · p5 COD-variance days (≥10). Hard rules: open fraud-type case (CLI-02/03/04/06/09, ATT-07/08, WRK-08 — flagged by `hr.penalty_schedule.is_fraud`) → 0; cold start < 30 deliveries → 0.70. Table `imile.driver_trust` (history 24 months). Weights sum to 1.00 — enforced by the `weights_sum_one` check constraint in 13B. Never shown to the driver as a composite; never linked to pay or penalty.

### 1.14 Blockers 1–5 (Phase 0) and simplification rules

- Code exists only in Git; nothing is "delivered in chat." Rebuild lost work from tasks; never search for zips.
- Code track and infra track are independent; develop on local Docker; infra tasks 0.3/0.5/0.7/0.8 are GM-manual and marked WAITING_GM.
- ADR only for architecture changes; else CHANGELOG. No new numbered documents; working notes in `docs/notes/`.
- No permission requests for routine operations. One question per blocker with a stated default, then proceed.
- A blocker is only: acceptance test cannot run, or a missing decision touching money/permissions/legal.
- **DONE requires the commit hash of the passing acceptance test in PROJECT_STATE.md.** No hash → not done.
- Never soften a rule (no "unless the pattern is clear"); **copy the AGENT CONSTRAINTS block of BOOTSTRAP-v4 §6 verbatim** into every agent file.

### 1.15 Configurability

All numeric limits above are `platform.thresholds` rows (GM edits without deploy). What is **not** configurable: reject stays human; G3 never auto; trust never linked to pay/penalty; dismissal GM-only. Those change only by recorded ADR.

### 1.16 Decisions taken in the v4 audit

Recorded as decisions (what was decided, and why). They are not instructions to agents; the operating instruction is BOOTSTRAP-v4.

| # | Decision | Reason |
|---|---|---|
| R-02a | `platform.outbox` is the governing event table; `platform.domain_events` is deleted; outbox carries `entity_id` and is under RLS | Doc 40 §B3 and doc 36 §3-1 name only `outbox`; two event tables produced a hard stop at the first slice |
| R-02b | `platform.audit_log` is monthly-partitioned with a SHA-256 chain (`prev_hash`/`row_hash`) and the eleven columns of doc 40 §B2; key `(id, occurred_at)` | Guards G8 and G10 referenced columns that did not exist; the chain was unverifiable |
| R-02c | Guard identifiers are fixed: G3 uses the real signature `imile.verify_attribution(current_date - 30, current_date)`; G8 calls `platform.verify_audit_chain()`; G10 checks `platform.audit_log.reason` for `reject|override`; G9 is a defined sample query (the last 1,000 outbox writes each have an audit row with the same `correlation_id`); `billing.verify_unpriced_events()` becomes **G18, report-only** | Three guards were prose, not SQL; one had no identifier and could not be referenced in CI |
| R-02d | `platform.thresholds` and `platform.settings` both remain, with the doc 40 §B5 split | They hold different value types; merging them would lose the GM-editable numeric contract |
| R-03 | Tier 0 = **zero inbound ports** (Cloudflare Tunnel only), ARM A1 **4 OCPU / 24 GB**, RPO 24 h / RTO 4 h, retention 14/8/6; Tier 1 redefined as paid OCI on the same PAYG account (DB on its own VM + read replica); migrations live in `database/migrations`; `docs/package/` is the complete package | Doc 42 recorded the Tunnel decision in §11 but left §2–§5 opening 22/80/443 — an agent executing in order would have exposed SSH to the internet |
| R-04 | 26 roles (25 + `DEPUTY_SYSADMIN`); four SoD pairs; CFO owns bank reconciliation and I-08; unfilled positions never approve; purchase tiers 100/500/2,000 KWD; series `RCT` · `GOV` · `INV` | Role and approval values differed across documents; an unfilled position in an approval chain is an un-executable chain |
| R-05 | Penalty schedule = **77 items**; Article 35 constraint written as the document states it (penalty signed within 15 days of the offence being proven); hierarchical signing authority enforced in the schema with upward re-routing; commission 0.300 + 0.050 with deductions 23 / 5 / 12; recruitment = 17 stages; housing by bed, homogeneity by shift then team, exemption by GM with reason, occupancy from `bed_assignments` | The count, the constraint direction and the commission status ("open decision") were each wrong in at least one document |
| R-06 | Three driver-attributed failure reasons (§1.2) and 25 sub-reasons; sorting A3; one document-expiry ladder 90/45/30/15; `imile.coverage_areas` becomes a table; doc 19 §4 governs warehouse coding (WH1, 7-character code); 019 rebuilt as `019-Warehouse-WH1-Setup.sql`; PDA and driver-app authentication numbers as in §1.9 | Attribution rules contradicted the "no charge before investigation" principle; the warehouse counts had one governing source and several copies |
| R-07 | 22 alerts / 24 reports; every alert carries `source_query`, `action_label`, `action_link`; Twilio for SMS/WhatsApp with templates T1–T5 defined in doc 35 §1-3; `integration_config` / `integration_queue` / `integration_runs` split; photo retention with `legal_hold` | Doc 23 §4 imposed four monitoring conditions with no alert behind them; the alert table could not be seeded without the three columns |
| R-08 | **Decided: 20 acceptance scenarios (S1–S20).** Doc 12 (lines 345–398 of v3) already carried the full operational content of S19 (iMile month-end attribution and partner deduction) and S20 (partner invoice matching at 2 % tolerance); both were written into doc 40 Part E in Gherkin from that content only, and the count is 20 in 40 Part E/F (G15 = 20/20), 36, 38 (4.17, 7.4), 00, 05, 12, 28, 29. The lane plan is derived from doc 38's `Lane` column — doc 38 is the single source of sequencing | Two scenarios were required by a phase gate but defined nowhere; the lane plan and the WBS disagreed in ten places because the sequence was written twice |

---

---

## Working log (append-only)

| # | Date | Decision | Rationale | Source |
|---|---|---|---|---|
| D-000 | 2026-09-21 | Repository initialised from package v4 + claude-kit: `docs/package/`, `database/schema/`, `tasks/MASTER_BACKLOG.md` and this log seeded before BOOTSTRAP-001 | The `/resume` pre-check reported them missing; seeding them outside the bootstrap session saves that session's quota | GM (setup) |
| D-001 | 2026-09-21 | **Amharic (`am`) added as a sixth field-app i18n language.** Field apps ship `ar, en, hi, ur, bn, am`; the admin console stays **ar / en** | Ethiopian workforce in delivery and warehouse operations. A PDA step or a training card in a language the worker does not read is not a control — doc 28 §4 | GM directive, raised as **SCR-I18N-01** under EXECUTION-MASTER-v4 §1.11 (G-01); governing edits in doc 40 closing note · EXEC §1.4 · doc 38 / 3.22 — see `docs/notes/SCR-I18N-01-amharic.md` |
| D-002 | 2026-09-23 | **RLS composition fixed: SCR-RLS-01 Options B + C, SCR-RLS-02 Options A + B + C.** `entity_scope` gated on `platform.is_internal()` on the seven client-scoped tables; a `user_type = 'client'` user can never hold `identity.user_entities` (triggers); RLS + `entity_scope` on the `platform.audit_log` partitioned parent; **guard G7 widened to `relkind in ('r','p')` — a change to doc 40 Part F row G7** and to the 13B auto-policy loop | Both defects reproduced live by WBS 0.18: a dual-role portal user read another client's invoice (1 row); a NOBYPASSRLS role with no entity access read all 8 audit rows through the parent while G7 = 0 | GM ("نفذ الاصلاحات", 2026-09-23), raised under EXECUTION-MASTER-v4 §1.11 (G-01); migration `database/migrations/0003_M_rls-scr-01-02.sql`; notes `docs/notes/SCR-RLS-01-*.md`, `SCR-RLS-02-*.md` |
| D-105 | 2026-09-23 | Canonical database image is `postgres:16` (Debian/glibc) for both dev and Tier 0 — one image, no musl variant | Removes glibc/musl divergence in Arabic character classification for `pg_trgm` (SCR-TRGM-01) | GM (Task X directive, 2026-09-23) |
| D-106 | 2026-09-23 | One-off slice briefs (`_slice-0.17`, `_slice-1.5`, `_slice-2.1`, `_slice-2.8`, `0.18-isolation`) moved from `.claude/briefs/` to `docs/notes/slice-briefs/`; `.claude/briefs/` holds only the 15 generated module briefs + `_TEMPLATE` | Keeps `.claude/briefs/` to its generated, ≤120-line module-brief contract; one-off slice briefs are working notes, not module briefs | GM (Task X directive, 2026-09-23) |
| D-107 | 2026-09-23 | `turbo.json`: `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` moved from `globalPassThroughEnv` to `globalEnv`; `cache: false` set on `@pg-eos/db#test`, `@pg-eos/platform#test`, `@pg-eos/wms#test`, `@pg-eos/sales#test` | DB-touching test tasks must not be cached across differing DB connection env; `@pg-eos/isolation-tests` already followed this pattern | GM (Task X directive, 2026-09-23) |
| D-108 | 2026-09-23 | `infra/docker/docker-compose.yml` pgAdmin password defaults to `${PGADMIN_PASSWORD:-pgadmin-dev}` (tools profile only); `infra/docker/.env.example` added | No hardcoded credential in a versioned compose file, even for a local-only dev tool | GM (Task X directive, 2026-09-23) |
| D-109 | 2026-09-23 | No rename; a two-line note added to `.claude/briefs/identity.brief.md` and mirrored in `scripts/gen-briefs.py` so regeneration preserves it | Clarifies an identity-brief point without changing the brief's generated surface | GM (Task X directive, 2026-09-23) |
| D-111 | 2026-09-23 | `tasks/MASTER_BACKLOG.md` header line begins "**132 doc-38 tasks + X.1–X.6 CONTINUOUS + 0.19 DEFERRED**"; `scripts/gen-backlog.py` `HEADER` constant and `--check` verify the header, X.1–X.6 CONTINUOUS and 0.19 DEFERRED | Backlog header and generator must agree on how X.1–X.6 and 0.19 are counted inside the 132 | GM (Task X directive, 2026-09-23) |
| D-112 | 2026-09-23 | Bookkeeping for the GM decisions batch (D-105…D-109, D-111): `docs/PROJECT_STATE.md`, `tasks/MASTER_BACKLOG.md`, `SETUP-STATUS-AR.md`, `README-KIT.md`, `docs/CHANGELOG.md` synced; previous-task hash 1.5 @ `f790da7` recorded | Closes the record-keeping loop for Task X per the GIT rule (previous task's hash recorded inside the next task's commit) | GM (Task X directive, 2026-09-23) |
| D-103 | 2026-09-23 | WBS 2.6 (`wms.skus`) authorized to start ahead of 1.2 (blocked — no apps/API for its acceptance) and 3.x (no TMS/HR assignment path yet). Executed @ `e38370e` | Keeps the build moving inside the still-open Phase-0 gate without skipping a blocked dependency chain | GM (Task X directive, 2026-09-23) |
| D-104 | 2026-09-23 | Phase-0 gate stays open; WBS 2.9 (golden slice) does not start before 0.2, 0.5, 0.6, 0.8 all close; no NestJS/XState/pg-boss dependency is added before 0.8 closes | Golden slice must be built once, correctly, on a closed foundation | GM (Task X directive, 2026-09-23) |
| D-110 | 2026-09-23 | Historic commits whose first line does not match `type(WBS): description` are not rewritten | History is not rewritten to satisfy a rule introduced after the fact | GM (Task X directive, 2026-09-23) |
| D-113 | 2026-09-23 | The 0.18 carried-forward item (runtime DB connection still superuser; `entity_scope` `FOR ALL`/`USING` only) is resolved inside WBS 0.5 — an app role `pgeos_app` without `BYPASSRLS`, with a `USING`/`WITH CHECK` split — not resolved now | Defers the fix to the task that owns the runtime role, avoids an out-of-scope schema change under Task X | GM (Task X directive, 2026-09-23) |
| D-114 | 2026-09-23 | Guards G15–G17 are built with WBS 0.6 | Aligns guard delivery with the CI task that will run them | GM (Task X directive, 2026-09-23) |
| D-116 | 2026-09-23 | The WBS 2.6 G-01 item (`wms.skus` has no `entity_id`) is CLOSED: no `entity_id` added, `outbox_business_needs_entity` not weakened; the `platform.audit_log`-only row this slice writes is the correct, final behaviour; any future SKU-related event is published by the entity-owning context (inventory/warehouse), never by the SKU aggregate | `wms.skus` is client-owned but not entity-owned, same design as `sales.accounts`; the constraint is correct as written | GM (Task X directive, 2026-09-23) |
| D-117 | 2026-09-23 | Standing permission: after two review FAILs the Master switches to `/model opus` for the fix step only, then returns; recorded in `docs/MODEL_ROUTING.md`. The 2.6 fix that ran on sonnet (session was on an explicit user-set `/model claude-sonnet-5`, no switch made) is accepted as already recorded in `docs/CHANGELOG.md`, not redone | Gives the Master a mechanism to escalate without abandoning an in-progress session, while being honest about a past deviation | GM (Task X directive, 2026-09-23) |
| D-118 | 2026-09-23 | A slice brief's Read-ONLY list over 12 files is a hard split requirement, enforced before delegation, never fixed retroactively once a slice has started; reworded in `.claude/briefs/_TEMPLATE.brief.md`. 2.6's 21-file brief is not fixed retroactively | Prevents budget creep from becoming a silent norm while not rewriting a slice already in flight | GM (Task X directive, 2026-09-23) |
| D-119 | 2026-09-23 | WBS 2.7 stays `WAITING_GM` until the GM has read the decision sheet | Data-gate scorecard task needs an explicit GM read before proceeding | GM (Task X directive, 2026-09-23) |
| D-121 | 2026-09-23 | Kit commands renamed to avoid a possible clash with Claude Code's own built-ins: `resume.md`→`pg-resume.md`, `state.md`→`pg-state.md`, `review.md`→`pg-review.md`; every reference outside `docs/package/` updated. `docs/package/BOOTSTRAP-v5.md` §9 and `PROJECT-SETUP-GUIDE.md` still name the old commands — flagged as a package-edit erratum in `docs/package/CHANGELOG-v4.md` §19, not edited directly (governing package, GM-only) | Avoids a name collision risk while respecting that the governing package is edited only by the GM | GM (Task X directive, 2026-09-23) |
