# PG-EOS — EXECUTION MASTER v4
**Tier A · Governing · Version 4.1 · 23 September 2026**
**Authority:** Full mandate delegated by the GM to the consulting architect for engineering, architecture, administrative structure, and all operational decisions.
**Supersedes:** EXECUTION-MASTER v1 · DECISIONS-ADDENDUM · 43-Final-Project-Package · BOOTSTRAP-v3 (as a rule source) · doc 39 entirely · doc 37 · doc 41 Part 2.
**Status:** This document and `BOOTSTRAP-v5.md` (supersedes v4 as operating instruction; kit in `claude-kit/`; setup in `PROJECT-SETUP-GUIDE.md`) are the only operating instructions. This document is the only register of GM decisions.

> **v4 — Document status:** Governing (Tier A) · **Governs on conflict:** 40, 36 · **Corrections applied in v4:** GOV-03, GOV-05, GOV-12, GOV-13, GOV-14, GOV-15, GOV-16, GOV-20, GOV-23, GOV-24, GOV-25, GOV-26, GOV-27, GOV-28, GOV-29, GOV-30, GOV-31, GOV-41, GOV-42, GOV-45, GOV-46, GOV-47, GOV-49, GOV-51, GOV-52, GOV-53, GOV-55, GOV-56, PLT-12, PLT-17, PLT-19 · **Previously open decisions:** closed in §1.

---

## PART 0 — PRECEDENCE, MANIFEST, RETIRED DOCUMENTS

### 0.1 The single precedence ladder (R-01 — written verbatim wherever a ladder is stated)

1. `40-Build-Specification-EN.md` — the technical contract; governs on conflict
2. `36-Technical-Architecture-Audit.md` — architecture, stack, build method
3. `EXECUTION-MASTER-v4.md` — the GM decisions register (Tier A) + lane plan + commands
4. `42-Oracle-Cloud-Deployment.md` — the Tier 0 deployment target
5. `38-WBS.md` — the only task sequence (132 tasks: 126 phased across **eight phases (0–7)** + 6 cross-cutting)
6. `22-Master-Data-Governance.md` — ownership, separation of duties, approval chains
7. `database/01 · 13 · 13B · 019` — **the only permitted schema** (the list is always written "01 / 13 / 13B / 019")
8. `BOOTSTRAP-v4.md` — operating instructions (not a rule source; it quotes items 1–7)
9. All other package documents — reference

- Doc 36 does not declare itself the absolute authority; it is corrected to read "the governing technical reference **within** this ladder".
- The phrase "7 phases" is corrected everywhere to "**eight phases (0–7)**". "132 tasks" stands (it is correct).

On conflict the higher document governs and the lower document is the one that gets corrected.

### 0.2 Package manifest v4 (R-00)

```
PG-EOS-v4/
├── 00-README-v4.md                        (manifest · precedence ladder · how to use · what changed)
├── A-governing/
│   ├── BOOTSTRAP-v4.md                    (master-agent operating instructions — supersedes BOOTSTRAP-v3)
│   ├── EXECUTION-MASTER-v4.md             (the complete decisions register [merges DECISIONS-ADDENDUM §1–11
│   │                                        + EXEC Part 1] + the corrected lane plan + the commands
│   │                                        + the document map + the manifest — supersedes EXEC v1, 43
│   │                                        and DECISIONS-ADDENDUM)
│   ├── 40-Build-Specification-EN.md       (v4.0)
│   ├── 36-Technical-Architecture-Audit.md (v4.0)
│   ├── 42-Oracle-Cloud-Deployment.md      (v4.0)
│   ├── 38-WBS.md                          (v4.0 — with the Lane column)
│   ├── 22-Master-Data-Governance.md       (v4.0)
│   └── database/
│       ├── 01-Data-Model.sql · 13-Schema-Additions.sql · 13B-Schema-Reference-Consolidation.sql · 019-Warehouse-WH1-Setup.sql
│       ├── guards.sql   (G1–G13 + G18, runnable)  · apply.sh (applies the four in order, then guards)
├── B-reference/  (00 02 03 04 05 06 07 09 10 11 12 14 15 17 18 19 23 25 26 27 28 29 30 31 35 41 — all v4.0)
├── C-tools/      (32 33 34 + the three tools, corrected)
├── AUDIT-REPORT-v4.md   (the consolidated audit: every finding and how it was handled)
└── CHANGELOG-v4.md
```

`guards.sql` covers the SQL-expressible guards only. G14 (client isolation via ID tampering) needs two tenant users, G15 runs in Playwright, G16 in the mutation runner, G17 on a traced request; **G18** (`billing.verify_unpriced_events()`) is SQL but **report-only**. `scripts/deploy.sh` runs `pnpm guards:run` covering **G1–G18** (doc 42 §8.1).

### 0.3 Retired in v4 — never uploaded, never cited as a source

| Retired | Reason | Live replacement |
|---|---|---|
| `08-AI-Build-Guide.md` | Superseded by the build method | doc 36 §5 |
| `16-Premium-Driver-App.md` | Superseded by Driver App v2 | doc 35 |
| `20-Gap-Register.md` | Closed; historical only | — (gaps closed, see §6.2) |
| `21-UI-Architecture.md` | Screen count and Decision Inbox superseded; patterns redundant | doc 29 §6 · doc 40 Part D |
| `24-Data-Migration.md` | Retired entirely — clean slate; no migration logic exists in the schema | doc 29 |
| `37-Master-Project-Document-EN.md` | Superseded by the package cover, itself now merged here | this document |
| `39-Project-Charter.md` | Superseded entirely; its Section A (project instructions) and Section C (session opener) are reproduced here | this document Part 7 · BOOTSTRAP-v4 §5 |
| `43-Final-Project-Package.md` | Parts 2–3 were already superseded; Parts 1, 4, 5 and 6 are merged into this document | this document Parts 0, 5, 6, 7 |
| `DECISIONS-ADDENDUM.md` | Merged verbatim into §1.5–§1.15 of this document | this document §1.5–§1.15 |
| `BOOTSTRAP-v2.md` · `BOOTSTRAP-v3.md` | Superseded as operating instructions and as a rule source | `BOOTSTRAP-v4.md` |
| `KernelPg.js` · `Migrate.js` · `Retention.js` · `System-Target-Architecture-2026-09-19.md` | Early-phase files of the abandoned Supabase-migration approach | doc 36 · database/01 · 13 · 13B · 019 |

---

## PART 1 — MANDATE DECISIONS REGISTER

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

## PART 2 — PARALLEL EXECUTION MODEL

### 2.1 Principle

Parallelism shortens **calendar time**, not token count. It is applied only where modules are disjoint (boundaries enforce this) and never on the golden slice. **Maximum three concurrent lanes.** One `pg-reviewer` serialises all merges.

### 2.2 Mechanics

- **One Master session** (sonnet). Lanes are sub-agents launched **in the same turn** (parallel Task calls), each on its own **git worktree** and branch `lane/<id>`.
- **Migrations are serialised:** a lane that needs a migration requests a migration number from the Master; the Master issues numbers in order and merges migrations first.
- **Merge order:** reviewer PASS → rebase on main → guards green → merge. Lanes never merge each other.
- **Shared packages (`packages/*`) are frozen during parallel phases**; changes go through the Master as a single-lane task.

### 2.3 Lane Plan by Phase

Derived from the `Lane` column of 38-WBS.md v4. If the two ever differ, 38 governs.

```
PHASE 0 — Foundation
  Lane A (GM, manual)      0.1 ✅ · 0.2 ✅ (recorded in 42 §11) → 0.3 → 0.5 → 0.7 · 0.8 → 0.20
                                                      [WAITING_GM; never blocks a code lane]
  Lane B (pg-backend)      0.4 → 0.9 → 0.10 · 0.11 · 0.12       (0.10/0.11/0.12 in parallel after 0.9)
  Lane C (pg-backend)      0.13 · 0.14                          (need only 0.4)
  Master                   0.6 (CI, seven gates — needs 0.4 AND 0.5; deploy gates require the host)
  Then serial (Master):    0.15 → 0.16 → 0.17 → 0.18 → 0.19
  Note                     0.20 is drafted as soon as 0.6 is green and sealed only after 0.8 succeeds
  GATE: 0.18 isolation green (G7 = 0) · 0.16 classification complete (G6 = 0)
        · 0.8 restore succeeded (when Lane A lands) · 0.1 owners named · 0.2 three decisions recorded

PHASE 1 + PHASE 2 PREP — run together
  Lane 1 (pg-backend+tester)  1.2 → 1.4 → 1.5 → 1.6 → 1.7 → 1.8 → 1.9
  Lane 2 (pg-backend)         2.1 → [waits for 2.2 from Lane A] → 2.3 → 2.4 ∥ 2.6 ∥ 2.8
                              (needs 0.9 · 0.12 · 1.5 · 2.2)
  Lane A (GM, manual)         1.1 · 1.3 · 1.10 · 2.2 · 2.5 · 2.7   [data gates + field survey + labels]
  Master, after Lane 1:       1.11 (S6 · S10)
  Master, after both lanes:   2.9 GOLDEN SLICE (single lane, full human review, opus for the session)
  GATE: 1.3 · 1.10 · 1.11 green · 2.5 · 2.7 met · 2.9 accepted

PHASE 2 — after the golden slice (replication begins)
  Lane 1  2.10 → 2.11 → 2.12          Lane 2  2.13 → 2.14 → 2.15
  Master, after the lanes merge:      2.16 (PDA — needs 2.9–2.13) → 2.17 → 2.18
  Lane A (GM, manual)                 2.19  [super-user sign-off + PDA training]

PHASE 3
  Lane 1  3.1 → 3.4 → 3.5 → 3.6       Lane 2  3.3 → 3.12 → 3.13       Lane 3  3.14 → 3.15 → 3.16
  Then    Lane 1  3.7 → 3.8 → 3.9 → 3.10 → 3.11 (driver app)          Lane 3  3.17 → 3.18 → 3.19
  Lane A (FLEET_MGR/GM)               3.2  [data gate M09; after 3.1] · 3.22 [driver training sign-off]
  Master  3.20 · 3.21
  GATE: 3.2 gate · full station day from PG-EOS · zero audit problem > 24 h · 3.21 target met

PHASE 4 — mostly serial (ledgers)
  Lane A (CFO)  4.1  [chart of accounts]
  Master        4.2 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7 ∥ 4.8 → 4.9 → 4.10 ∥ 4.11
                    → 4.12 → 4.13 ∥ 4.14 ∥ 4.15 → 4.16 → 4.17 (S8 · S11 · S19 · S20) → 4.18
  GATE: 4.11 zero rows · 4.18 signed

PHASE 5 — six disjoint modules, three lanes
  Lane 1  5.1 → 5.2 (CC)  then 5.10 (Housing — waits for 5.3 in Lane 2)
  Lane 2  5.3 → 5.5 → 5.6 → 5.7 → 5.8 → 5.9 (HR)
  Lane 3  5.11 (Admin) → 5.12 (Fleet) → 5.14 (Governance)
  Lane A (GM)  5.4  [SUPERSEDED — ADR-0003 · D-126 · D-125] · 5.15 [data gates M08, M09]
  Master  5.13 (22 alerts / 24 reports) · 5.16 · 5.17
  GATE: 5.15 gates · 5.17 signed

PHASE 6
  Lane 1  6.1 → 6.2 (portal)          Lane 2  6.3 → 6.4 (decisions, trace)       Lane 3  6.5
  Lane A (GM)  6.6  [three real clients live]
  Master, after 6.3:  6.7 (S7 · S9 · S12)
  GATE: 6.1 isolation · 6.6 three clients live · 6.7 green

PHASE 7 — serial verification
  Master  7.1 · 7.2 · 7.3 · 7.4 (20/20) · 7.7 · 7.11 · 7.12
  Lane A (GM)  7.5 · 7.6 · 7.8 · 7.9  (7.10 already closed)

CROSS-CUTTING
  Lane A (GM)  X.1 · X.2 · X.5 · X.6
  Master       X.3 (Grafana board per module) · X.4 (ten-point review per slice)
```

### 2.4 Lane Rules (copied into CLAUDE.md)

- A lane touches only the modules listed in its brief. Boundaries lint fails the lane otherwise.
- A lane never edits `packages/*`, `database/schema/*`, or another lane's module.
- A lane that needs a schema change stops and files a one-line request; the Master resolves it under G-01 (§1.11).
- Each lane's brief follows BOOTSTRAP-v4 §5 exactly; each lane reports in the §5 format.
- Merge only after `pg-reviewer` PASS and guards green on the rebased branch.
- A cross-lane dependency is declared in the lane line itself (for example "waiting for 2.2 from Lane G"); an undeclared cross-lane dependency is a planning defect.

---

## PART 3 — COMMAND SEQUENCE

### 3.1 Prepare (on the GM's machine, once)

```bash
mkdir pg-eos && cd pg-eos && git init
mkdir -p docs/package/tools database/schema database/migrations database/seeds
unzip -o ~/Downloads/PG-EOS-v4.zip -d /tmp/pkg
PKG=$(find /tmp/pkg -maxdepth 3 -type d -name A-governing -printf '%h\n' | head -1)
cp "$PKG"/A-governing/*.md docs/package/
cp "$PKG"/B-reference/*.md docs/package/
cp "$PKG"/C-tools/*          docs/package/tools/
cp "$PKG"/A-governing/database/*.sql database/schema/
cp docs/package/BOOTSTRAP-v4.md .
corepack enable && corepack prepare pnpm@latest --activate   # or: sudo npm i -g pnpm
claude
```

The four schema files land in `database/schema/`: `01-Data-Model.sql` · `13-Schema-Additions.sql` · `13B-Schema-Reference-Consolidation.sql` · `019-Warehouse-WH1-Setup.sql`. They are applied in that order (`database/apply.sh`), then `guards.sql`.

### 3.2 Bootstrap (session 1, `/model sonnet`)

```
Execute BOOTSTRAP-v4.md exactly as written. The package is in docs/package/ and
database/schema/. Import; do not re-derive. Pin agent models with tier aliases; `inherit`
is forbidden — report any unsupported alias. Stop after the final report. Do not start 0.4.
```

**Accept only if:** cross-module import fails `pnpm lint` · task 2.9 present with its doc 38 criterion · `grep -c "DECISION REQUIRED" docs/DECISION_LOG.md || true` = 0 · `grep -c inherit .claude/agents/* || true` = 0 · PROJECT_STATE has exactly one DONE with a hash.

### 3.3 Phase 0 (session 2+, `/model sonnet`)

```
Resume Premium Development — Phase 0 with the lane plan in docs/package/EXECUTION-MASTER-v4.md §2.3
(and the Lane column of docs/package/38-WBS.md, which governs).
Launch the parallel lanes on separate worktrees. Run the CI task yourself.
Mark GM lane tasks WAITING_GM with runbooks. Serialise the tail of the phase after lanes merge.
Stop at the Phase 0 gate and report: which gate conditions are met, which await GM.
```

### 3.4 Every subsequent phase

```
Resume Premium Development — Phase <n> per EXECUTION-MASTER-v4 §2.3 and the Lane column of doc 38.
Launch up to three lanes on worktrees. Migrations are serialised through you.
Review every slice with pg-reviewer before merge. Stop at the phase gate and report.
```

### 3.5 Golden slice (the one exception — `/model opus` for this session)

```
Build WBS 2.9 as a single lane with pg-backend + pg-tester + pg-frontend, then pg-reviewer on opus.
Do not replicate anything yet. After PASS, stop and present: file tree, test summary, guard
results, and the exact brief template future slices will use to replicate this structure.
```

The GM reviews 2.9 personally. Nothing replicates before acceptance.

### 3.6 GM's parallel track (never on the critical path of code)

Oracle tenancy (doc 42 §1–§7) · the data gates and the field survey and the label run named in doc 38's GM lane · assign DEPUTY_SYSADMIN · send the iMile API letter · commission the structural verification file · fire licence on file.

---

## PART 4 — QUOTA AND QUALITY CONTROLS (built into the mechanism)

| Control | Where enforced |
|---|---|
| Session default sonnet; opus only for the WBS 2.9 session, ADRs, security, double failure | Operator instruction BOOTSTRAP-v4 §0 |
| Agents pinned: reviewer opus · workers sonnet · scribe ~~haiku~~ **sonnet** [SUPERSEDED — GM 2026-09-23 "no haiku" (CHANGELOG-v4 §13; CLAUDE.md MODEL ROUTING); D-125]; `inherit` forbidden | BOOTSTRAP-v4 §3, acceptance §9 |
| Workers read only listed files | Brief format BOOTSTRAP-v4 §5; reviewer flags violations |
| One commit per task with `Model:` `Delegated:` `Review:` trailers | CLAUDE.md GIT; reviewer flags missing trailers |
| No state-only commits | CLAUDE.md GIT |
| Golden slice replicated file-for-file; no file without counterpart | CLAUDE.md BUILD METHOD |
| Max 3 lanes; disjoint modules; migrations serialised | §2.2, §2.4 |
| Tests first (RED) before any implementation | pg-tester role |
| 10-point review on every slice; guards **G1–G18** block merge (G18 report-only) | pg-reviewer role; CI gate ⑤ of the seven-gate pipeline (doc 36 §4-3) |
| Mutation ≥ 75% on domain/ nightly | pg-tester; CI nightly |
| DONE only with commit hash in PROJECT_STATE | DoD |
| A blocker is only an un-runnable acceptance test or a money/permission/legal decision gap | CLAUDE.md |

**Expected token distribution:** ~75% sonnet (workers) · ~10% ~~haiku~~ sonnet (scribe) [SUPERSEDED — GM 2026-09-23 "no haiku", CHANGELOG-v4 §13; D-125] · ~10% opus (review) · ~5% session. Calendar compression from parallel lanes: Phases 2, 3, 5 roughly halve; Phase 4 unchanged (ledgers are serial by nature).

---

## PART 5 — DOCUMENT MAP (all documents, final status in v4)

| # | Title | Status |
|---|---|---|
| 00 | Master Blueprint | Reference · v4.0 |
| 01, 13 | Data Model (SQL) | **Governing schema** · v4.0 |
| **13B** | **Schema — Reference-DDL consolidation** | **Governing schema — reference-DDL consolidation** · v4.0 |
| **019** | **`019-Warehouse-WH1-Setup.sql`** | **Governing schema (WH1 setup, rebuilt from doc 19 §4)** · v4.0 |
| 02 | Roles & Permissions | Reference · v4.0 (26 roles) |
| 03 | Workflows | Reference · v4.0 (carries the state-machine register) |
| 04 | Service Catalog | Reference · v4.0 |
| 05, 12 | Acceptance Scenarios | Source for doc 40 Part E · v4.0 |
| 06 | Sales/CRM & Accounting | Reference · v4.0 |
| 07 | iMile Automation | Reference · v4.0 (carries ADR-27 in full) |
| ~~08~~ | ~~AI Build Guide~~ | **Retired — superseded by 36 §5** |
| 09 | Partners & Subcontracting | Reference · v4.0 |
| 10 | HR, Recruitment, Driver Ops | Reference · v4.0 |
| 11 | Administrative Cycle | Reference · v4.0 |
| 14 | Housing | Reference · v4.0 |
| 15 | Penalty Schedule | Reference · v4.0 (77 items; hierarchical authority) |
| ~~16~~ | ~~Driver App v1~~ | **Retired — superseded by 35** |
| 17, 18, 19 | Warehouse space, audit, setup | Reference · v4.0 (doc 19 §4 governs coding) |
| ~~20~~ | ~~Gap Register~~ | **Retired — closed** |
| ~~21~~ | ~~UI Architecture~~ | **Retired — superseded by 29 §6 / 40 Part D** |
| 22 | Master Data Governance | **Governing (ownership, SoD)** · v4.0 |
| 23 | Integration Register | Reference · v4.0 |
| ~~24~~ | ~~Data Migration~~ | **Retired entirely** |
| 25 | Alerts, Reports, NFR | Reference · v4.0 (22 alerts · 24 reports) |
| 26 | Business Continuity | Reference · v4.0 (tiered RPO/RTO and retention) |
| 27 | Fleet, Portal, Records | Reference · v4.0 |
| 28 | Adoption, Compliance, Launch | Reference · v4.0 |
| 29 | Clean-Slate Redesign | Reference · v4.0 (screen count, automation levels) |
| 30 | PDA App | Reference · v4.0 |
| 31 | Audit & Traceability | Reference · v4.0 (defers to 13B for audit DDL) |
| 32–34 | iMile benchmark / findings / lab | Tools · v4.0 |
| 35 | Driver App v2 | **Governing (driver app)** · v4.0 |
| 36 | Technical Architecture Audit | **Governing (architecture)** · v4.0 |
| ~~37~~ | ~~Master Project Document EN~~ | **Retired** |
| 38 | Work Breakdown Structure | **Governing (sequencing; Lane column)** · v4.0 |
| ~~39~~ | ~~Project Charter~~ | **Retired — its Sections A and C live in this document (Part 7) and BOOTSTRAP-v4 §5** |
| 40 | Build Specification EN | **Governing (technical contract)** · v4.0 |
| 41 | Cloud & AI Efficiency | Reference · v4.0 (Tier 2 cloud steps; **Part 2 superseded by this document Part 4 and BOOTSTRAP-v4 §4**) |
| 42 | Oracle Cloud Deployment | **Governing (Tier 0 deployment)** · v4.0 |
| ~~43~~ | ~~Final Project Package~~ | **Retired — merged into this document (Parts 0, 5, 6, 7)** |
| — | `DECISIONS-ADDENDUM.md` | **Retired — merged into §1.5–§1.15** |
| — | `BOOTSTRAP-v4.md` | **Governing (operating instructions)** · v4.0 |
| — | `EXECUTION-MASTER-v4.md` | **This document — Governing (decisions, lanes, commands, map)** · v4.0 |

Coverage: 125 business processes across 4 layers (doc 36 §6-3) · the doc 40 Part E acceptance scenarios in executable Gherkin · guard tests G1–G18 (doc 40 Part F) · **13 functional modules M01–M13 (M13 = Governance), delivered as 15 code packages under `modules/`** (doc 36 §8) · 4 end-user applications + 1 manager application (doc 40 Part D). Cross-checked against docs 03/05/12: no orphaned process, no undocumented screen trigger, no billing service code (doc 04) without a consuming event.

---

## PART 6 — STATUS BEFORE TASK 0.1

### 6.1 Prerequisites

| # | Item | Status |
|---|---|---|
| 1 | Oracle tenancy type | ✅ **Pay-As-You-Go** (doc 42 §11 #1) |
| 2 | Home region | ✅ **Jeddah `me-jeddah-1`**, fallback Dubai `me-dubai-1` on capacity failure (doc 42 §11 #2) |
| 3 | Edge / TLS | ✅ **Cloudflare Tunnel** — zero inbound ports; SSH through the tunnel (doc 42 §11 #3) |
| 4 | Tier-0 RPO | ✅ **24 h accepted for Phases 0–3 only** (doc 42 §11 #4) |
| 5 | Tier-1 triggers | ✅ Recorded (doc 42 §11 #5) |
| 6 | Governing schema | ✅ Four files: 01 / 13 / 13B / 019 |
| 7 | Task 0.1 (domain owners) and Task 0.2 (the three cloud decisions) | ✅ Closed — see doc 38 and doc 42 §11 |

### 6.2 Residual open items (none blocks Task 0.1)

| # | Item | Status | Blocks |
|---|---|---|---|
| 1 | Formal API request to iMile | Not sent | Nothing — the station agent (docs 07 / 23 I-01/I-02) works regardless |
| 2 | iMile driver-app lab study (docs 32–34) | Awaiting screenshots | Nothing — doc 35 already incorporates the public-data findings |
| 3 | Labour authority approval of the penalty schedule (Art. 36) | Pending submission | Penalty enforcement shows a warning banner until the approval flag is set (doc 15 §6) |
| 4 | Data-residency legal opinion (R5) | Open | Real client data ingestion into Tier 0/2; **not** the Tier 0 build — WBS 7.9 |

**Nothing blocks 0.1.** The build starts now. The next runnable code task is 0.4 (initialise the monorepo).

---

## PART 7 — VERIFY THE SETUP

Before starting the first task, ask the session one calibration question and confirm the answer matches:

> **Prompt:** "Summarize in 5 bullet points: (1) the architecture pattern, (2) the ORM and why, (3) what happens to a domain event when a state changes, (4) what the golden slice is, (5) what you do if I ask for a table that isn't in the permitted schema."
>
> **Expected answers:** (1) modular monolith, hexagonal, enforced boundaries (2) Drizzle, because it allows `SET LOCAL` inside a transaction for RLS (3) written to `platform.outbox` in the same transaction as the state change (4) "Receive inbound order," WBS 2.9 (5) **stop and ask, never invent — the schema is 01 / 13 / 13B / 019**, and a genuine gap is filed as a schema-change request under §1.11 (G-01).

If any answer is wrong, the instructions were not loaded correctly — re-check Part 3 §3.1 and §3.2 before proceeding.

### 7.1 Project instructions (paste verbatim where a project-level instruction field exists)

```
You are the build partner for PG-EOS — the Premium Group Enterprise Operating System.

GOVERNING DOCUMENTS (by precedence — EXECUTION-MASTER-v4 Part 0):
1. 40-Build-Specification-EN — the technical contract; governs on conflict
2. 36-Technical-Architecture-Audit — architecture, stack, build method
3. EXECUTION-MASTER-v4 — the GM decisions register, lane plan and commands
4. 42-Oracle-Cloud-Deployment — the Tier 0 deployment target
5. 38-WBS — the only task sequence; a task is done only when its acceptance test passes
6. 22-Master-Data-Governance — ownership, SoD, approval chains
7. database/01 · 13 · 13B · 019 — the only permitted schema
8. BOOTSTRAP-v4 — operating instructions only, not a rule source

ARCHITECTURE (non-negotiable, doc 36 + doc 40 Part A):
- Modular monolith. Hexagonal per module (domain/application/infrastructure/api/tests).
  No cross-module imports — enforced by eslint-plugin-boundaries.
- NestJS on Fastify adapter · Drizzle ORM · Zod→OpenAPI · XState v5 · pg-boss (no Redis) ·
  React/TanStack/shadcn · React Native/Expo · Docker Compose on Oracle Cloud (Tier 0),
  Terraform-ready for GCP (Tier 2).
- Every domain event: written to platform.outbox in the SAME transaction as the state change.
- Every write endpoint: requires an Idempotency-Key header.
- Every mutable aggregate: optimistic concurrency via a version column.
- All DB access goes through withContext(ctx, fn), which sets RLS session variables.
  RLS is enabled on every operational table.

BUILD METHOD — every vertical slice, in this order, never skipping a step:
scenario (Given/When/Then) → Zod contract → SQL migration with RLS → tests written first and RED →
domain layer until unit tests green → application layer until integration tests green →
UI until the acceptance scenario is green → human review against the 10-point checklist (doc 36 §5-4).
The golden slice is "Receive inbound order" (WBS task 2.9). Once built, every subsequent slice is
produced by instructing: "replicate the golden slice's file structure exactly for <use case>."

AGENT CONSTRAINTS — violating any of these is a defect, not a style choice:
- No table, column, or business rule outside docs 01 / 13 / 13B / 019 / 40. If something is missing,
  STOP and ask — do not invent a schema, a number, a name, or a policy.
- No cross-module import. Use a domain event or a declared contract instead.
- No `db.*` call outside withContext(). No `any`, `@ts-ignore`, `eslint-disable`.
- Never weaken or skip a test to make it pass — fix the underlying code.
- No `if`/`switch` for state transitions — use an XState machine.
- No embedded UI string in any language — use the i18n package (ar, en, hi, ur, bn, am).
- No magic numbers — use named constants or platform.thresholds.
- No `console.log` — use the pino logger. No `Math.random()` or `new Date()` inside domain/ —
  inject a generator and a clock port so domain logic is deterministic and testable.
- Never fabricate a number in a response to the user; numbers come from the system, never from
  model reasoning.

LANGUAGE AND STYLE:
- Reply to the GM in Arabic. All code, identifiers, commit messages, and technical documentation
  in English.
- Be concise. Prefer tables to prose. State disagreements and risks plainly and early.
- Every deliverable ends with what — if anything — needs a human decision before proceeding.

DATA POLICY:
- Clean slate. No migration from any legacy system.
- Every record is entered from an official document by a named process owner.
- A module does not open to its users until its master-data gate (doc 22) is met. No exceptions,
  no "just this once."

WHEN YOU ARE UNSURE:
- If a requirement is ambiguous, pick the interpretation that matches an existing pattern elsewhere
  in the schema/architecture, state the assumption in one line, and proceed — unless the ambiguity
  touches money, permissions, or a legal/penalty rule, in which case stop and ask.
```

### 7.2 Ten-point review before accepting any slice (doc 36 §5-4)

| # | Check |
|---|---|
| 1 | Tests cover the **entire** scenario, not part of it |
| 2 | Invariants exist in `domain/invariants` **and** as DB constraints |
| 3 | RLS is enabled on the new table **and tested** with a cross-tenant user |
| 4 | Every new column is classified in `identity.column_classification` |
| 5 | The domain event is written in the **same transaction** as the state change (outbox) |
| 6 | An idempotency key guards the write endpoint |
| 7 | Error messages state what **is** allowed, not just that the action was rejected |
| 8 | No new library was added without a written reason |
| 9 | The screen renders correctly RTL and LTR |
| 10 | A Grafana panel exists for the new slice (Tier 0: a Netdata/Uptime Kuma check is acceptable) |

A slice that fails any of these ten is not done — it goes back for correction, not for a new slice on top of it.

---

*Under mandate, this register, the document map and the lane-plan rule are approved. Execution may start at Part 3 §3.1.*
