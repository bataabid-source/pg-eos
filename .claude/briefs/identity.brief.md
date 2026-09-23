# `identity` — module brief (generated)

Generated 2026-09-22 by `scripts/gen-briefs.py` from the live schema (`175` tables, 14 schemas). **Do not hand-edit** — change the schema under G-01, then re-run the script.
Schema `identity` · tables in this module: 11 · default lane: M (doc 38 `Lane` column governs).
> **Two identity packages, no rename (GM 2026-09-23, D-109).** `@pg-eos/identity` = `modules/identity/` — the identity module (schema `identity` use cases; scaffold today).
> `@pg-eos/identity-mechanisms` = `packages/identity/` — the shared WBS 0.17 mechanisms (OTP, sessions, RBAC/SoD evaluation), no endpoint.

## 1. Where the rules are
- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — Part B §B1 Identity (+ §B2 Audit) — doc 40 has no Part C section for identity
- Screens / boards / KPIs (binding): `docs/package/D-blueprints/07-Governance-Control.md (roles, SoD, delegation)`
- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`
- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`
- Client portal app `apps/portal`: doc 40 Part C §C10 · D-blueprints 11-Client-Store-Integration.md

## 2. Tables

| table | row purpose (obj_description) | entity_id | RLS policies |
|---|---|---|---|
| `column_classification` | — | no | reference_read · reference_write |
| `delegations` | EXECUTION-MASTER-v4 ط¢آ§1.6 (ex DECISIONS-ADDENDUM ط¢آ§2)… | no | internal_only |
| `otp_codes` | — | no | internal_only |
| `permissions` | — | no | reference_read · reference_write |
| `role_permissions` | — | no | reference_read · reference_write |
| `roles` | — | no | reference_read · reference_write |
| `sessions` | — | no | internal_only |
| `sod_rules` | — | no | reference_read · reference_write |
| `user_entities` | — | yes | entity_scope |
| `user_roles` | — | no | internal_only |
| `users` | — | no | internal_only |

## 3. Status columns and their allowed values (check constraints)

| column | allowed values |
|---|---|
| `roles.scope_type` | all · entity · org_unit · subordinates · assigned · account · client · self |

## 4. Document series and counters

This module allocates no document series of its own (`platform.counters` holds none for it).

## 5. Views and functions in this schema

- Views: `identity.unclassified_columns`
- Functions: `check_sod()` · `check_sod_delegation()`

## 6. Golden-slice counterpart paths

filled by bootstrap after 2.9 — every file this module delivers must have a counterpart in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound`. Replicate with `scripts/new-slice.sh identity <use-case>`; a hand-made file tree is a review FAIL.

## 7. How a worker uses this brief

- This brief replaces the package. Read a package document only where section 1 points to a section this brief does not already carry.
- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: **STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). Never invent one.
- Write only inside the paths the slice brief's `Write ONLY` line names. This module's home is `modules/identity/` (+ `tests/`).
- Domain events go to `platform.outbox` in the same transaction as the state change; `platform.domain_events` is retired.
