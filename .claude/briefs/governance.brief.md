# `governance` — module brief (generated)

Generated 2026-09-21 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `governance` · tables in this module: 14 · default lane: 3 (doc 38 `Lane` column governs).

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part C §C9 M13 Governance (`governance`)
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/07-Governance-Control.md (KPIs, OKRs, risks, NCR, policies)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `budget_lines` | — | no | internal_only |
| `budgets` | — | yes | entity_scope |
| `corrective_actions` | — | no | internal_only |
| `decisions` | 36 §6-2 · 40 §C9: سجل القرارات المركزي الدائم. غير platfo… | no | internal_only |
| `key_results` | — | no | internal_only |
| `kpi_actuals` | — | no | internal_only |
| `kpi_targets` | — | no | internal_only |
| `kpis` | — | yes | entity_scope |
| `ncr` | — | yes | entity_scope |
| `objectives` | — | yes | entity_scope |
| `policies` | — | no | internal_only |
| `policy_acknowledgements` | — | no | internal_only |
| `risk_reviews` | — | no | internal_only |
| `risks` | — | yes | entity_scope |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `budgets.status` | draft · approved · locked · closed |
| `corrective_actions.status` | open · in_progress · done · verified · cancelled |
| `decisions.status` | active · superseded · revoked |
| `ncr.status` | open · investigating · action_pending · verifying · closed |
| `objectives.status` | draft · active · achieved · missed · cancelled |
| `risks.status` | open · mitigating · accepted · closed |
| `kpis.direction` | higher_better · lower_better |
| `kpis.level` | group · entity · module |
| `risks.category` | operational · financial · legal · safety · technology · commercial |

## 4. Document series and counters

| doc_type | prefix (per entity) |
|---|---|
| `NCR` | `PCC-NC-` |

Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic allocator guard G13 measures. Never format a document number in application code.

## 5. Views and functions in this schema

- Views: none
- Functions: none

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh governance <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/governance/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
