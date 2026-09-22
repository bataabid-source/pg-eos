# `hr` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `hr` · tables in this module: 14 · default lane: 2 (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C7 M08 HR (`hr`), Housing (`housing`), Admin (`admin`) — HR part
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/06-Administrative-HR-Housing.md (recruitment, penalties, discipline)`
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/14-Sales-Compensation.md (hr.sales_commission_events — SCR-SC-01)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `commission_daily` | — | yes | own_commission |
| `commission_rules` | — | yes | entity_scope |
| `disciplinary_cases` | — | yes | entity_scope |
| `employee_documents` | — | no | internal_only |
| `employees` | — | yes | entity_scope |
| `manpower_requests` | — | yes | entity_scope |
| `org_units` | — | yes | reference_read · reference_write |
| `penalty_schedule` | ط¸â€‍ط·آ§ط·آ¦ط·آ­ط·آ© ط·آ§ط¸â€‍ط·آ¬ط·آ²ط·آ§ط·طŒط·آ§ط·ع¾ أ… | no | reference_read · reference_write |
| `recruitment_cases` | — | yes | entity_scope |
| `recruitment_costs` | — | no | internal_only |
| `recruitment_stage_log` | — | no | internal_only |
| `recruitment_stages` | — | no | reference_read · reference_write |
| `sales_commission_events` | ط·آ§ط·آ³ط·ع¾ط·آ­ط¸â€ڑط·آ§ط¸â€ڑ ط·آ¹ط¸â€¦ط¸ث†ط¸â€‍ط·آ© ط·آ… | yes | entity_scope · own_sales_commission |
| `teams` | — | yes | reference_read · reference_write |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `commission_daily.status` | calculated · disputed · approved · paid |
| `disciplinary_cases.status` | draft · issued · grievance_filed · upheld · cancelled · applied · carried_forward ·… |
| `employees.status` | active · on_leave · suspended · terminated |
| `manpower_requests.status` | draft · pending_approval · approved · in_progress · completed · rejected · cancelled |
| `sales_commission_events.status` | accrued · under_review · disputed · approved · paid · clawed_back · rejected |
| `commission_rules.applies_to` | driver · sales_rep · sales_mgr |
| `commission_rules.basis` | per_unit · recurring · one_time · hybrid |
| `commission_rules.revenue_basis` | collected · invoiced |
| `commission_rules.service_category` | ST · HD · OF · VA · DL · CC · IT · all |
| `penalty_schedule.category` | attendance · work · vehicle · client · safety · conduct · housing · custody · system |
| `recruitment_cases.stage` | manpower_request · sourcing_route · work_permit · visa_issue · agency_contract · ca… |
| `sales_commission_events.event_kind` | recurring_collection · one_time_sign · one_time_execute · clawback_credit_note · ma… |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `MPR` | `PCC-MP-` |
| `RCR` | `PCC-RQ-` |
| `DSC` | `PCC-DS-` |
| `SCM` | `PCC-SCM-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.

## 5. Views and functions in this schema

- Views: `hr.employees_basic` · `hr.recruitment_cost_per_employee`
- Functions: `check_penalty_authority()` · `close_driver_id_on_termination()` · `guard_sales_commission_status()` · `max_degree_for_role()` · `next_penalty_degree()`

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh hr <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/hr/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
