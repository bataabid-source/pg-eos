# SCR-BILLING-SYSTEM-ACTOR-01 — a system actor identity for outbox subscribers (G-01 schema-change request, data only)

**Status:** DECIDED BY DEFAULT (Master M15, 2026-09-30 13:20Z, Advisory proposal 11:52Z «الخيار (أ)», GM standing order «DEFAULT, RECORD, PROCEED») — filed by the Master for lane 2, WBS 4.3 part 1 (#207, 11:26Z). Nothing in `database/schema/*` changes; migration **0048** (lane 2) inserts DATA only.

## 1 · Context (verified by lane 2 on `pgeos_lane2`, 11:26Z)
- `platform.allowed_entities()` (01:331, 0031) reads `identity.user_entities` for `platform.current_user_id()`; with `userId: null` it returns `'{}'`, so `entity_scope` hides `wms.outbound_orders` and refuses the `billing.billable_events` insert.
- `platform.audit_log` policy `audit_append` (0007:249) requires `user_id IS NOT NULL AND user_id = current_user_id()`, so the 4.2 port's audit row for a system actor is refused.
- `pgeos_app` / `pgeos_worker` have no BYPASSRLS; no system identity is seeded in `identity.users`. `evaluate-alert-rules.ts:106` throws `MissingActorError` without a userId — not a precedent.
- Already documented: the all-zero uuid `00000000-0000-0000-0000-000000000000` is the "system user" of every `changed_by` seed (13B thresholds seeds; migrations 0010, 0015, 0033, 0045) and `platform.audit_log.actor_type` already allows `system` (13B:183).

## 2 · Decision (default, recorded)
| # | Need | Decision | status |
|---|---|---|---|
| 1 | An identity for `withContext` in outbox subscribers | ONE service identity row in `identity.users`: `id = 00000000-0000-0000-0000-000000000000`, `email = 'system@pg-eos.invalid'`, `full_name_ar = 'نظام PG-EOS'`, `full_name_en = 'PG-EOS system'`, `user_type = 'internal'` (doc 01 enumerates internal · client · agent — a new `system` value would be a real schema change and is NOT made), `is_active = true`. Subscribers open `withContext` with this `userId`; audit rows carry `actor_type = 'system'`. | decided |
| 2 | Entity scope for that identity | `identity.user_entities` rows for every `platform.entities` row, `on conflict do nothing`. | decided |
| 3 | Where | migration `0048_2_system-actor-identity.sql`, data only, idempotent; RED paths first in `tasks/backlog/MIGRATION-REQUEST-2.md`; pre-migration pg-reviewer review (identity + RLS → opus) inside lane 2's pre-build pass. The lane writes this migration file although `identity` code is M-core's lock: a Master-issued data migration is not module code (Master ruling, #207). | decided |
| 4 | Rejected | (ب) a `SECURITY DEFINER` insert function — bypasses RLS instead of satisfying it; (ج) a system GUC without an identity — any application code could set it. | rejected |

## 3 · Open items (GM / follow-up rows)
- A `platform.entities` row created after 0048 has no `user_entities` row for the system actor until a follow-up (trigger or the entity-creation path) — backlog row **4.3 part 1c**.
- Whether `user_type = 'system'` should join doc 01's list is the GM's schema decision; until then `internal` + the well-known id is the recorded default.
