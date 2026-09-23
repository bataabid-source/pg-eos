# `catalog` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `catalog` · tables in this module: 6 · default lane: M (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C1 M03 Catalog & Pricing (`catalog`)
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/02-Financial-Accounting.md (price lists, service pricing)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `price_exceptions` | — | yes | entity_scope |
| `price_list_lines` | — | no | internal_only |
| `price_lists` | — | yes | entity_scope |
| `segments` | — | no | reference_read · reference_write |
| `service_categories` | — | no | reference_read · reference_write |
| `services` | — | yes | reference_read · reference_write |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `price_lists.status` | draft · active · expired |

## 4. Document series and counters

This module allocates no document series of its own (`platform.counters` holds none for it).

## 5. Views and functions in this schema

- Views: none
- Functions: none

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh catalog <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/catalog/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
