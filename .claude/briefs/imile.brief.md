# `imile` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `imile` · tables in this module: 15 · default lane: 2 (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C8 M11 iMile Operations (`imile`)
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/05-Operations-iMile-CallCenter.md (sorting, DTL, attribution, trust)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `agent_health` | — | no | internal_only |
| `coverage_areas` | ط·آ¨ط¸â€‍ط·آ§ ط·آ¨ط·آ°ط·آ±ط·آ© ط·آ¹ط¸â€¦ط·آ¯ط·آ§ط¸â€¹: ط¸… | no | reference_read · reference_write |
| `daily_inventory` | — | no | internal_only |
| `dispatch_autonomy` | — | no | internal_only |
| `driver_id_assignments` | — | no | internal_only |
| `driver_ids` | — | no | internal_only |
| `driver_trust` | ADR-28 ط¢آ§9. ط·آ§ط¸â€‍ط·آ§ط·آ­ط·ع¾ط¸ظ¾ط·آ§ط·آ¸ 24 ط·آ´ط¸… | no | internal_only |
| `driver_zone_exclusions` | — | no | internal_only |
| `dtl_problems` | — | no | internal_only |
| `dtl_rule_autonomy` | ADR-27 ط¢آ§8: ط·آ§ط¸â€‍ط·آ§ط·آ³ط·ع¾ط¸â€ڑط¸â€‍ط·آ§ط¸â€‍ط¸ظ… | no | internal_only |
| `inventory_discrepancies` | — | no | internal_only |
| `plan_assignments` | — | no | internal_only |
| `scan_log` | — | no | internal_only |
| `shipments` | — | no | internal_only |
| `sorting_plans` | — | no | internal_only |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `driver_ids.status` | available · assigned · suspended |
| `shipments.internal_status` | expected · arrived · sorted · staged · assigned · ofd · delivered · failed · return… |
| `sorting_plans.status` | draft · review · approved · executing · closed |
| `driver_ids.suspension_category` | administrative · performance · conduct · permanent_ban |
| `dtl_problems.auditor_decision` | accept · reject · human · reclassify |
| `dtl_problems.engine_decision` | accept · reject · human · reclassify |
| `dtl_rule_autonomy.decision_kind` | accept · reclassify |
| `sorting_plans.approved_by_kind` | human · engine |

## 4. Document series and counters

This module allocates no document series of its own (`platform.counters` holds none for it).

## 5. Views and functions in this schema

- Views: `imile.driver_id_dashboard` · `imile.shipments_attributed`
- Functions: `close_assignment_on_suspension()` · `verify_attribution()` · `verify_no_orphan_ids()`

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh imile <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/imile/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
