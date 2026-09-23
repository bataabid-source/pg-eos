# `cc` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `cc` · tables in this module: 6 · default lane: 1 (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C5 M06 Call Center (`cc`)
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/05-Operations-iMile-CallCenter.md (tickets, switchboard)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `agent_queues` | — | no | internal_only |
| `agents` | — | no | internal_only |
| `calls` | — | yes | agent_queue_scope · entity_scope |
| `queues` | — | yes | agent_queue_scope · entity_scope |
| `ticket_events` | — | no | agent_queue_scope · internal_only |
| `tickets` | — | yes | agent_queue_scope · entity_scope |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `agents.status` | offline · available · busy · break |
| `tickets.status` | open · in_progress · pending_client · pending_internal · resolved · closed · reopen… |
| `tickets.priority` | urgent · high · normal · low |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `TKT` | `PCC-TK-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.

## 5. Views and functions in this schema

- Views: none
- Functions: `current_agent_queues()` · `is_agent()`

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh cc <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/cc/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
