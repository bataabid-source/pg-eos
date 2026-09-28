-- 0043_M_has-perm-search-path.sql — M-core (lane M), WBS 2.16 part 1a-7 = SCR-IDENTITY-RLS-01
-- delta 4. Forward-only, idempotent (apply.sh re-runs every file on every apply;
-- `create or replace function` + a read-only self-check). One transaction.
--
-- WHAT: platform.has_perm(text) — the permission check every RLS policy and definer trigger
-- trusts — was the only SECURITY DEFINER function in the database without a pinned search_path.
-- It gains `set search_path = pg_catalog, pg_temp`; the body is byte-identical to
-- database/schema/01-Data-Model.sql (2b, has_perm).
--
-- WHY `pg_catalog, pg_temp` (brief 1a-7 Decision 1): the pin of 0009 / 0010 / 0031 / 0038, not
-- the SCR's `pg_catalog, platform`. The body is fully schema-qualified, so it needs no schema on
-- the path; naming pg_temp LAST stops the implicit temp-schema-first lookup, so an operator or
-- function planted by the caller (a temp schema or a caller-controlled schema) cannot be resolved
-- ahead of pg_catalog inside the definer.
--
-- NOTES:
--   - `stable` and `security definer` are restated: CREATE OR REPLACE resets omitted attributes
--     to volatile / security invoker.
--   - No DROP: RLS policies depend on the function oid; CREATE OR REPLACE keeps it, and keeps the
--     owner and the grants.
--   - No REVOKE from PUBLIC: has_perm runs inside RLS policies and definer triggers as pgeos_app /
--     pgeos_worker, which reach it through the PUBLIC execute grant.
--   - Schema-file parity (01-Data-Model.sql has_perm header) is a Master step after merge
--     (brief 1a-7 Decision 2).
--
-- ROLLBACK: forward-only. A new forward-only migration would restate the 01 header without the
-- `set search_path` clause (not recommended — it reopens the search_path hijack).

begin;

create or replace function platform.has_perm(p_code text) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1
    from identity.user_roles ur
    join identity.role_permissions rp on rp.role_id = ur.role_id
    join identity.permissions p       on p.id = rp.permission_id
    where ur.user_id = platform.current_user_id()
      and p.code = p_code
      and ur.revoked_at is null
  )
$$;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_proc f
    join pg_catalog.pg_roles r on r.oid = f.proowner
    where f.oid = 'platform.has_perm(text)'::regprocedure
      and f.prosecdef
      and f.provolatile = 's'
      and f.proconfig = array['search_path=pg_catalog, pg_temp']
      and (r.rolsuper or r.rolbypassrls)
  ) then
    raise exception '0043: platform.has_perm must be SECURITY DEFINER, STABLE, search_path=pg_catalog, pg_temp, owned by a superuser/BYPASSRLS role';
  end if;
end $$;

commit;
