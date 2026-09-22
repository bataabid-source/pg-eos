# `wms` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `wms` · tables in this module: 20 · default lane: 1 (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C3 M04 Warehouse (`wms`)
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/03-Operations-Warehouse.md (core warehouse screens)`
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/10-Order-Fulfillment-Scenarios.md (inbound/outbound scenarios)`
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/12-Warehouse-Work-Orders-VAS.md (SCR-WO-01 work orders, 13B-WO)`
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/13-Space-Occupancy-Indicators.md (space indicators, 13B-SP)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `inbound_orders` | — | yes | entity_scope |
| `inventory_count_lines` | — | no | internal_only |
| `inventory_counts` | — | yes | entity_scope |
| `locations` | — | no | reference_read · reference_write |
| `occupancy_snapshots` | — | yes | client_portal_scope · entity_scope |
| `order_lines` | — | no | internal_only |
| `outbound_orders` | — | yes | client_portal_scope · entity_scope |
| `skus` | — | no | sku_client_scope |
| `space_allocations` | — | yes | client_portal_scope · entity_scope |
| `space_blocks` | — | yes | entity_scope |
| `space_blocks_out_of_service` | — | no | internal_only |
| `space_reservations` | — | yes | client_portal_scope · entity_scope |
| `stock_balance` | — | no | internal_only |
| `stock_movements` | ط·آ¯ط¸ظ¾ط·ع¾ط·آ± ط¸â€‍ط·آ§ ط¸ظ¹ط¸عˆط·آ¹ط·آ¯ط¸عکط¸â€کط¸â€‍… | yes | entity_scope |
| `warehouses` | — | yes | reference_read · reference_write |
| `work_order_events` | ط·آ³ط·آ¬ط¸â€‍ ط·آ²ط¸â€¦ط¸â€ ط¸ظ¹ ط¸â€‍ط·آ£ط¸ث†ط·آ§ط¸â€¦ط·… | no | internal_only |
| `work_order_task_types` | 12 ط¢آ§1: ط·آ®ط·آ±ط¸ظ¹ط·آ·ط·آ© ط·آ§ط¸â€‍ط·آ®ط·آ¯ط¸â€¦ط·آ§… | no | internal_only |
| `work_order_tasks` | ط·آ§ط¸â€‍ط¸â€¦ط¸â€،ط¸â€¦ط·آ© ط·آ§ط¸â€‍ط¸â€¦ط·آ³ط¸â€ ط¸عکط… | no | internal_only |
| `work_orders` | ط·آ£ط¸â€¦ط·آ± ط·آ¹ط¸â€¦ط¸â€‍ ط·آ¯ط·آ§ط·آ®ط¸â€‍ ط·آ§ط¸â€‍ط… | yes | client_portal_scope · entity_scope |
| `zones` | — | no | reference_read · reference_write |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `inbound_orders.status` | draft · approved · receiving · received · putaway · closed · cancelled |
| `inventory_counts.status` | draft · in_progress · review · recount · adjusted · closed |
| `locations.location_type` | pallet · shelf · operational · structural |
| `order_lines.status` | open · partial · complete · cancelled |
| `outbound_orders.status` | draft · checks_pending · credit_rejected · approved · allocated · partially_allocat… |
| `skus.status` | active · on_hold · discontinued |
| `space_allocations.alloc_type` | dedicated · shared · overflow |
| `space_allocations.status` | active · expiring · expired · terminated |
| `space_blocks.block_type` | pallet_rack · shelf · floor · mezzanine · yard · cold · frozen · secure · hazmat |
| `space_blocks.status` | active · inactive |
| `space_reservations.status` | active · converted · expired · cancelled |
| `stock_movements.movement_type` | receipt · putaway · pick · pack · ship · issue · transfer · adjust · count · damage… |
| `work_order_task_types.task_type` | receive · putaway · pick · check · pack · label · kit · load · return_sort · count… |
| `work_order_tasks.status` | queued · assigned · accepted · in_progress · paused · done · rejected · reassigned |
| `work_orders.status` | draft · released · in_progress · on_hold · completed · cancelled |
| `work_orders.task_type` | receive · putaway · pick · check · pack · label · kit · load · return_sort · count… |
| `zones.zone_type` | storage · receiving · quarantine · staging · shipping · returns · damaged · structu… |
| `skus.picking_policy` | FIFO · FEFO · LIFO |
| `space_blocks.uom` | pallet · sqm · cbm · position |
| `space_blocks_out_of_service.reason` | maintenance · damage · aisle · operational_buffer · safety |
| `space_reservations.reason` | quote_pending · incoming_client · seasonal_peak · internal |
| `work_order_task_types.billing_trigger` | per_event · per_qty · per_contract |
| `work_order_tasks.quality_result` | pass · fail |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `INB` | `PCC-IN-` |
| `OUT` | `PCC-OUT-` |
| `CNT` | `PCC-CNT-` |
| `WO` | `PCC-WO-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.
Sequences in `wms` owned by this module: `work_order_events_id_seq`.

## 5. Views and functions in this schema

- Views: `wms.client_space_overview` · `wms.reservations_aging` · `wms.space_by_type` · `wms.space_dashboard` · `wms.space_trend_30d` · `wms.warehouse_capacity`
- Functions: `check_location_limits()` · `check_space_available()` · `convert_reservation()` · `enforce_checker_not_picker()` · `enforce_worker_task_cap()` · `generate_locations()` · `space_availability()` · `trg_space_reservation_guard()` · `verify_balance_integrity()` · `verify_wh1()` · `wo_rollup_qty_done()`

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh wms <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/wms/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
