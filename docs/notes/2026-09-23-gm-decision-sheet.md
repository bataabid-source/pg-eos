# GM decision sheet — 2026-09-23 (refreshed after WBS 2.6 and Task X D-113…D-121)

Source: `tasks/MASTER_BACKLOG.md` (every row whose status is `WAITING_GM`), ADR-0002 (open G-01), `docs/PROJECT_STATE.md` blockers.
Blocks = direct dependants in the doc-38 `Depends on` column, plus the phase gate that names the row. Recommendations are the agent's; nothing here is decided.

**Row count:** the directive expected 26 `WAITING_GM` rows; the backlog holds **28** — 24 doc-38 rows + 4 staged rows (2.20 · 5.18 · 6.2b · SC-01). All 28 are listed. Unchanged since the first version of this sheet — no `WAITING_GM` row was resolved by 2.6 or Task X D-113…D-121, though 2.6's completion satisfies 2.7's dependency (2.7 stays `WAITING_GM` — D-119, 2026-09-23 — pending the GM's own read of this sheet).

**G-01 items — one closed since the first version of this sheet.** A second item was raised during WBS 2.6 (`wms.skus` has no `entity_id`, so a registration event cannot legally carry one under `outbox_business_needs_entity`) and closed the same day by **D-116 (GM, 2026-09-23): no `entity_id` added to `wms.skus`, the outbox constraint is not weakened; the `platform.audit_log` row this slice writes is the correct and final behaviour; any future SKU-related event is published by the entity-owning context (inventory/warehouse), never by the SKU aggregate.** It is not listed as an open row below — it is resolved, not pending. The G8-anchor item (§A) is the only G-01 item still open.

## A. Blockers named in PROJECT_STATE

| id | what GM must decide | options | agent recommendation | blocks which tasks |
|---|---|---|---|---|
| 0.2 | Record the three cloud decisions (PAYG upgrade, region, Tunnel) | ① confirm the values already recorded in doc 42 §11 (20 Sep 2026: PAYG · `me-jeddah-1`, fallback `me-dubai-1` · Cloudflare Tunnel) ② change one of them | **①** — the acceptance criterion ("Three decisions recorded") is already met in doc 42 §11; one GM line confirming it lets pg-scribe mark 0.2 DONE | 0.3 → 0.5 → 0.6 / 0.7 / 0.8 → 0.20 → 7.6; Phase-0 gate; 2.9 start |
| 0.8 | Run the first `backup.sh` + `restore.sh` test on Tier 0 | ① run after 0.5 as planned ② interim restore drill on the local Docker DB now (does not satisfy 0.8) | **①**, and do ② now as a rehearsal so the Tier-0 run is mechanical | 0.20 → 7.6; Phase-0 gate; 2.9 start |
| 2.2 | Deliver the WH1 field survey (aisles, positions per aisle, numbering direction) | ① WH_MGR survey now ② accept the 019 seed layout as the survey | **①** — acceptance is "Map sums to exactly 3,153"; only a physical count proves it | 2.3 → 2.4 → **2.9 (golden slice)**; 2.3 → 2.5; Phase-2 gate |
| G-01 (G8 anchor) | Where the audit-chain anchor (first retained `chain_seq` + `prev_hash`) is stored so parameterless G8 keeps working after the first partition detach (ADR-0002) | ① `platform.settings` key (`entity_id` null, `{"seq","prev_hash"}`) written by the archival job, read by the verifier defaults ② archive manifest only, G8 called with explicit arguments ③ a new dedicated table | **①** (ADR-0002 proposal; no new table) — decide any time before the first detach, no earlier than March 2028 | first audit-log partition detach / archival job; G8 after detach |

## B. WAITING_GM rows — Phase 0

| id | what GM must decide | options | agent recommendation | blocks which tasks |
|---|---|---|---|---|
| 0.2 | see §A | | | |
| 0.3 | Create the Oracle tenancy (MFA, compartment `premium-production`, IAM `deployer`, break-glass) | ① SYSADMIN does it after 0.2 ② defer | **①** immediately after 0.2 is confirmed | 0.5 → 0.6 / 0.7 / 0.8 |
| 0.5 | Provision VCN + NSG + A1.Flex VM + hardening + Docker + Cloudflare Tunnel (doc 42 §2–§5) | ① now ② wait for a Tier-0 need | **①** — 0.6 CI, 0.8 restore and the Phase-0 gate all wait on it | 0.6, 0.7, 0.8 |
| 0.7 | Tier-0 monitoring (doc 42 §7) | ① with 0.5 ② after | **②** straight after 0.5 | — (no direct dependant) |
| 0.8 | see §A | | | |
| 0.20 | Seal runbook v1 (draft after 0.6, seal after 0.8) | ① agent drafts after 0.6, GM seals after 0.8 | **①** as written in doc 38 | 7.6 |

## C. WAITING_GM rows — Phases 1–7 (data gates, sign-offs, human actions)

| id | what GM must decide | options | agent recommendation | blocks which tasks |
|---|---|---|---|---|
| 1.1 | Enter entity legal data (CR, tax, address, logo) for PCC/PST/PDL/POR | ① Admin Mgr enters now ② after 0.9 UI exists | **①** collect the data now; entry when the screen exists | 4.1 → 4.11, 5.11 |
| 1.3 | Data gate M03: floor price + standard cost for every active service | ① CFO fills now ② at Phase 1 end | **①** — it is a Phase-1 gate item | Phase-1 gate |
| 1.10 | Data gate M02: all current clients with CR and contact | ① CFO fills now ② at Phase 1 end | **①** — 1.5 duplicate detection is ready to use it | Phase-1 gate |
| 2.2 | see §A | | | |
| 2.5 | Print and apply 3,330 labels; 5% scan audit | ① after 2.3 as planned | **①** | Phase-2 gate |
| 2.7 | Data gate M04: ≥ 95% of active SKUs complete | ① WH_MGR after 2.6 | **①** | Phase-2 gate |
| 2.19 | Super-user sign-off + 90-min PDA training | ① after 2.18 | **①** | Phase-2 gate |
| 3.2 | Data gate M09: all vehicles with valid documents | ① FLEET_MGR after 3.1 | **①** | Phase-3 gate |
| 3.22 | Driver training (60 min, 6 languages) + sign-off | ① after 3.21 | **①** | — (Phase-3 exit) |
| 4.1 | Chart of accounts per entity | ① CFO after 1.1 | **①** | 4.11, 5.11 |
| 5.4 | Enter biometric credentials; hourly sync | ① GM after 5.3 | **①** (entered by the GM in person — credentials never pass through an agent) | — |
| 5.15 | Data gates M08, M09 (documents 100%) | ① HR_MGR + FLEET_MGR after 5.3 / 3.1 | **①** | Phase-5 gate |
| 6.6 | Three real clients onboarded and operating | ① GM names the three clients | **①** — name them early so 6.1 isolation is tested on their shapes | Phase-6 gate |
| 7.5 | Manual fallback kits + one manual-mode drill | ① OPS_DIR after 5.13 | **①** | — |
| 7.6 | Name and train `DEPUTY_SYSADMIN` | ① name now, train after 0.20 | **①** — naming does not wait for the runbook | — |
| 7.8 | Submit penalty schedule to labour authority | ① PRO after 5.7 | **①** | — |
| 7.9 | Data-residency legal review | ① commission now (no dependency) ② later | **①** — no dependency, and it can change the Tier-2 region | — |
| 7.10 | Structural verification — row text says "Closed (verified; drawing + licence on file)" | ① confirm closed ② reopen | **①** — the row already records closure; confirm so pg-scribe marks it DONE | — |

## D. Staged rows (not in doc 38)

| id | what GM must decide | options | agent recommendation | blocks which tasks |
|---|---|---|---|---|
| 2.20 | Work orders & VAS: initial `wo.sla.*` minutes (D-12 §10-3 item D-1) | ① approve the provisional 13B values ② set new values | no recommendation — the numbers are the GM's (D-12 §10-3) | 2.20 itself |
| 5.18 | Focus boards: per-role composition (D-15 §4) and focus rules marked provisional (D-15 §8) | ① approve as written ② amend | ① — the view `platform.my_work` already exists | 5.18 itself |
| 6.2b | Store connectors: D-11 §7 decisions 1–7 (scope, phase of the file bridge, platforms, owner, …) | D-11 §7 ① A only ② A + B ③ A + B + C | **③ staged** (D-11 recommendation: B in Phase 3, A in Phase 6, C as 6.2b) | 6.2b itself |
| SC-01 | Sales commission: D-14 §8 D-1…D-8 (model, family rates, basis, duration, cap, manager share, existing clients, approve SCR-SC-01) | D-14 §8 | D-14 recommendation: recurring model, rates as proposed for year 1, `collected` basis, 24 months, no cap in year 1, 0.5% manager share, half rate 12 months for existing clients, approve SCR-SC-01 | SC-01 itself |
