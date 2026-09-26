-- 0031_M_active-entity-rls.sql — Master task P6b-2 (SCR-PLAT-CTX-01, D-190). Forward-only,
-- idempotent (apply.sh re-runs every file on every apply; `create or replace function` + a
-- read-only self-check). One transaction.
--
-- WHAT: platform.allowed_entities() — the set every entity-scoped RLS policy trusts — now follows
-- the active entity. withContext (packages/db/src/with-context.ts) ALWAYS sets the transaction-local
-- GUC app.entity_id from ctx.entityId (NULL when absent). When app.entity_id is empty/NULL the
-- function returns the user's full membership set, exactly as the 01 body did; when it is set the
-- function returns that entity only if the user is a member of it, else '{}' (fail-closed: a
-- non-member active entity sees nothing). The function also gains a pinned search_path
-- (pg_catalog, pg_temp) — every reference inside it is schema-qualified.
--
-- REVIEW: pg-reviewer pre-migration review APPROVED WITH CHANGES (5), all applied:
--   1. createUserEntitiesLookup (entity-scope.ts) reads with entityId: null — always the full set;
--   2. withContext always sets app.entity_id (deterministic, overrides a session-level leftover);
--   3. this migration: the body below, one transaction, this header;
--   4. the 0012-style self-check at the end (definer + pinned search_path);
--   5. schema-file parity: database/schema/01-Data-Model.sql carries the same body (0009 precedent).
--
-- CALLER NOTES (d):
--   - platform.next_doc_no follows the active entity (it reads allowed_entities() through RLS).
--   - fleet register-vehicle's `count = 1` check now resolves (one active entity → one row).
--   - Idempotency key reused under a different active entity: a LIVE key → the entity-scoped
--     SELECT sees 0 rows → `IdempotencyConflictError('mismatch')` (the replay is no longer
--     returned); an EXPIRED key → 42501 on reclaim (idem_entity_scope UPDATE USING) until
--     `platform.purge_idempotency_keys()` removes it.
--   - The N-11 alert evaluation job must run with no entityId (full entity set), as before.
--   - A malformed app.entity_id raises 22P02 (invalid_text_representation) on the ::uuid cast —
--     fail-closed; the API validates X-Entity-Id with Zod `.uuid()` before it reaches the GUC.
--
-- ROLLBACK: forward-only. To revert, a new forward-only migration restores the 01 body verbatim
-- (`select coalesce(array_agg(distinct ue.entity_id), '{}') from identity.user_entities ue where
-- ue.user_id = platform.current_user_id()`); app.entity_id then becomes inert (still set, never read).

begin;

create or replace function platform.allowed_entities() returns uuid[] language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(distinct ue.entity_id), '{}') from identity.user_entities ue
  where ue.user_id = platform.current_user_id()
    and (nullif(current_setting('app.entity_id', true), '') is null or ue.entity_id = nullif(current_setting('app.entity_id', true), '')::uuid) $$;

do $$ begin if not exists (select 1 from pg_proc where oid='platform.allowed_entities()'::regprocedure and prosecdef and proconfig @> array['search_path=pg_catalog, pg_temp']) then raise exception '0031: allowed_entities not definer/pinned'; end if; end $$;

commit;
