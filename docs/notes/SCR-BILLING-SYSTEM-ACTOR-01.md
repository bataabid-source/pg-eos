# SCR-BILLING-SYSTEM-ACTOR-01 — a system actor identity for outbox subscribers (G-01 schema-change request)

**Status:** REQUESTED — PENDING GM RATIFICATION. Filed by the Master M15 (2026-09-30) for lane 2, WBS 4.3 part 1 (#207, 11:26Z). A privileged identity is not a slice-level default, so nothing is decided here. Migration number **0048** is reserved for M-core (lane M, `identity` lock) and is written only after the GM ratifies this SCR.

## 1 · Context (verified by lane 2 on `pgeos_lane2`, 11:26Z)
- `platform.allowed_entities()` (01:331, 0031) reads `identity.user_entities` for `platform.current_user_id()`; with `userId: null` it returns `'{}'`, so `entity_scope` hides `wms.outbound_orders` and refuses the `billing.billable_events` insert.
- `platform.audit_log` policy `audit_append` (0007:249) requires `user_id IS NOT NULL AND user_id = current_user_id()`, so an audit row for a system actor is refused.
- `pgeos_app` / `pgeos_worker` (0039) have no BYPASSRLS; no system identity is seeded in `identity.users`. `platform.audit_log.actor_type` already allows `system` (13B:183); the all-zero uuid is the `changed_by` of every seed row (0010, 0015, 0033, 0045).

## 2 · Proposal (NOT applied)
| # | Need | Proposal | status |
|---|---|---|---|
| 1 | An identity for `withContext` in outbox subscribers | One `identity.users` service row (well-known id), never given a credential or `identity.sessions` row, non-routable email. | requested |
| 2 | Entity scope | `identity.user_entities` rows for every `platform.entities` row; entities created later get theirs from the entity-creation path (row 4.3 part 1c). | requested |
| 3 | **Control: the id is usable only by the worker** | A guessable id with all-entity scope must not be usable from request code. Proposal: `platform.allowed_entities()` (and `audit_append`) accept the system id only when `current_user = 'pgeos_worker'` (0039); under `pgeos_app` the id resolves to no entities. Pinned by an RLS test for both roles. | requested |
| 4 | `user_type` | doc 01 lists internal · client · agent. Either add `system` (a schema change) or use `internal` + the control in #3. | **GM decides** |
| 5 | Rejected | a `SECURITY DEFINER` insert that bypasses RLS; a system GUC with no identity. Both lack the #3 role binding. | rejected |

## 3 · Open items
- GM ratification of #1–#4. Then M-core writes `0048_M_system-actor-identity.sql` under `identity | M | 2.16` (the 0044 precedent), with RED paths first in `tasks/backlog/MIGRATION-REQUEST-M.md`, a pre-migration review (opus) covering G6 `identity.column_classification`, the doc 01 `user_type` list and the non-login check.
- Until then lane 2 keeps 4.3 part 1 on its branch: domain, application and api are built; the four RLS-bound integration tests stay RED (never skipped). Sequencing: 0048 → 4.3 part 1 → 4.3 part 1c → 4.3 part 2.
