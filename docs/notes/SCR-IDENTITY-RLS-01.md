# SCR-IDENTITY-RLS-01 — permission-gated RLS on identity.* and hr.employees PII (G-01 schema-change request)

**Status:** REQUESTED — filed 2026-09-27 by the consultant session under **EXECUTION-MASTER-v4 §1.11 (G-01)**, authorised by GM decision **D-193 D4 أ** ("اعتماد وتنفيذ ضمن 2.16"). Nothing in `database/schema/*` changes until the request is applied by a numbered migration with a pre-migration review.

## 1 · Context (verified on `origin/main @ fc4c6d4`)
- RLS enforces entity isolation, not permissions: `identity.*` carries only `internal_only for all using (is_internal())` (`database/schema/13B-Schema-Reference-Consolidation.sql:3143`) and the generic `entity_scope for all` (`:3129-3135`); `identity.user_roles` has no `entity_id` (`01-Data-Model.sql:259-267`); `packages/identity/src/context.ts:8-13` confirms the identity tables are internal-only.
- Consequence: any internal context can write `identity.user_roles`, `sessions`, `otp_codes` and `users`, so one missing `hasRole` check in application code, or any SQL injection, grants GM-level roles; the database gives no backstop.
- `hr.employees` (`civil_id`, `passport_no`) is readable and writable by anyone in the entity under `entity_scope`.
- `platform.has_perm` is SECURITY DEFINER without `set search_path` (`01-Data-Model.sql:313-314`), unlike every other definer function.

## 2 · Requested deltas
| # | Object | Delta | Source | status |
|---|---|---|---|---|
| 1 | `identity.user_roles` | per-command policies: SELECT internal; INSERT/UPDATE/DELETE only through a SECURITY DEFINER `identity.grant_role(...)` / `identity.revoke_role(...)` that checks `has_perm('identity.structure.manage')` on the caller and writes the audit row | 13B:3143 · 01:259-267 | requested |
| 2 | `identity.users`, `identity.sessions`, `identity.otp_codes` | INSERT/UPDATE/DELETE policies gated on the owning flow (session/OTP rows only for `current_user_id()` or via the identity package's definer functions); `users` writes need `identity.structure.manage` | 13B:3129-3143 | **sessions/otp_codes applied by 0044** (2.16 part 1a-8: select-only `internal_read`, DML revoked from `pgeos_app`, six `identity.*` definers); `users` → 1a-9 (G-01) |
| 3 | `hr.employees` | column-level: `civil_id`, `passport_no` readable only with `hr.employee.pii.read` (view or column privilege), writable only with `hr.employee.manage` | 01 (hr.employees) · doc 40 P-rules | requested — permission names to be confirmed against doc 019 |
| 4 | `platform.has_perm` | `set search_path = pg_catalog, platform` | 01:313-314 | **applied by 0043** — value `pg_catalog, pg_temp` (brief 2.16 part 1a-7 Decision 1); 01 parity edit by the Master after merge |

## 3 · Open items
- 2026-09-28 (M-core R6, 2.16 part 1a-7): delta 4 applied (0043). Deltas 1–3 BLOCKED (G-01): `identity.structure.manage` (named only in doc 22 §194), `hr.employee.pii.read`, `hr.employee.manage` are absent from 01/13/13B/019/40 and unseeded — relayed to the GM by Master M5; rows `2.16 part 1a-8` (delta 2, sessions/otp_codes), `2.16 part 1a-9` (deltas 1 + 2 users) and an `hr` part (delta 3).
- 2026-09-29 (M-core, 2.16 part 1a-8): delta 2 applied for sessions/otp_codes (0044); `users` stays with delta 1 in 1a-9 (G-01).
- Permission codes for deltas 1–3 must exist in doc 019 / `identity.permissions` seed; if a code is missing the row is a second G-01 item, never invented.
- Built inside 2.16 (same module, pg-builder-core), after 2.16 part 1a-5, with the pre-migration review on opus.
