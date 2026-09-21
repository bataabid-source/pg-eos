# `tms` — module brief (generated)

Generated 2026-09-21 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `tms` · tables in this module: 7 · default lane: 2 (doc 38 `Lane` column governs).
> **Schema `tms` also holds the `fleet` module's tables** (vehicles · vehicle_documents · maintenance_orders · maintenance_plans · fuel_ledger · accidents). They are listed in `fleet.brief.md`, not here.

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C4 M05 Delivery (`tms`) & M09 Fleet — delivery half
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/04-Operations-Delivery-Fleet.md (delivery, routes, POD)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `contact_log` | — | no | internal_only |
| `delivery_exceptions` | — | no | internal_only |
| `delivery_tasks` | — | yes | client_portal_scope · entity_scope |
| `failure_reasons` | — | no | reference_read · reference_write |
| `payment_attempts` | — | no | internal_only |
| `proof_of_delivery` | — | no | internal_only |
| `routes` | — | yes | entity_scope |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `delivery_exceptions.exception_type` | waiting_time · failed_attempt · damage · shortage · wrong_address · refused · retur… |
| `delivery_tasks.status` | created · assigned · out_for_delivery · delivered · failed · deferred · returned ·… |
| `routes.status` | planned · active · closed · cancelled |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `TSK` | `PCC-TSK-` |
| `RTE` | `PCC-RT-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.

## 5. Views and functions in this schema

- Views: none
- Functions: `raise_legal_hold()`
  (schema `tms` is shared by the `tms` and `fleet` modules — the lists above are the whole schema's.)

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh tms <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/tms/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
