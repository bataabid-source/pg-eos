# SCR-RLS-NULL-ENTITY-01 — `entity_scope` admits NULL-entity rows on platform.audit_log / platform.outbox (G-01 schema-change request)

**Status:** REQUESTED — filed by the Master M15 (2026-09-30) from M-core's finding on PR #246 (commit 8210540, CI ②③ on a fresh database). Nothing changes in `database/*` with this file.

## 1 · Context (M-core, verified in CI)
- The permissive `entity_scope` policy on `platform.audit_log` and `platform.outbox` is OR-ed with `entity_id IS NULL`, so any role holding INSERT (today `pgeos_app`; after 0048 also `pgeos_worker`) can insert a row with no entity and no user.
- Pre-existing (not introduced by 0048); `audit_append` (0007) binds `user_id` but the permissive OR admits the NULL-entity row regardless.

## 2 · Requested decision (GM)
| # | Question | Options | status |
|---|---|---|---|
| 1 | May an audit or outbox row carry no entity? | (a) never — drop the `entity_id IS NULL` arm, backfill/deny; (b) only for named platform-level event kinds, via a restrictive policy; (c) keep as is, recorded | requested |

## 3 · Open items
- Decision → a numbered migration under M-core's lock with a RED test per role (`pgeos_app`, `pgeos_worker`).
