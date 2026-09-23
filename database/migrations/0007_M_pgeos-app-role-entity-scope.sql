-- ═══════════════════════════════════════════════════════════════════════════
-- 0007_M_pgeos-app-role-entity-scope.sql — Lane M — WBS 0.6a-1 (D-133)
-- Forward-only migration · PostgreSQL 16 · lean design (GM directive, this session; supersedes the
-- interrupted view-rewrite draft).
--
-- Creates the `pgeos_app` runtime role (the role the application connects as once
-- packages/db/src/client.ts stops connecting as the Postgres superuser — that gap is tracked
-- separately, this migration only builds the role and its privilege surface) and splits every
-- entity_scope policy's USING clause into an explicit WITH CHECK equal to it, so an INSERT/UPDATE
-- is rejected by RLS exactly as reliably as a SELECT is filtered.
--
-- LEAN DESIGN: views are NOT altered — no security_invoker rewrite. Instead pgeos_app is granted
-- NO privilege at all on any view: the grant loop below only ever touches relkind 'r'/'p' (tables),
-- and an explicit pass then strips any privilege pgeos_app might otherwise hold (e.g. from a prior
-- run's default-privilege grant reaching a newly created view) on every view that does not carry
-- security_invoker=true. G7 (guards.sql) is extended to flag such an "owner-rights" view only when
-- pgeos_app still holds a privilege on it — a view without security_invoker=true is not itself a
-- defect this migration is asked to fix.
--
-- Idempotency: apply.sh re-runs every migration file on every apply — there is no applied-
-- migrations table (0001-0006's own headers document the same constraint). This file converges on
-- a fresh database, on an already-applied one, and on a second back-to-back run:
--   - the role block uses create-if-absent / alter-if-present, no password ever set;
--   - the grants are plain GRANT/ALTER DEFAULT PRIVILEGES statements — re-granting an already-held
--     privilege is a Postgres no-op, and REVOKE on a privilege not held is a no-op;
--   - the view-privilege-strip loop re-runs every time and is a no-op once nothing is held;
--   - the entity_scope loop below reads pg_policy at RUN TIME and skips a policy whose WITH CHECK
--     already equals its USING — critically, migration 0003 drops and recreates entity_scope on
--     platform.audit_log's PARENT only, WITHOUT a WITH CHECK, on every one of its own re-runs
--     (0003's own header, and its verification block; the other seven SCR-RLS-01 tables are
--     skipped by 0003 once already gated), and 0003 always runs before 0007 in apply.sh's fixed
--     file order, so this loop re-fixes the audit_log parent's policy on every apply, not merely
--     once;
--   - the audit_append policy, on the platform.audit_log PARENT ONLY (binding design §5; never on
--     a partition — see §4 below), is dropped and recreated unconditionally (cheap, always
--     converges); the same block also drops any audit_append policy a partition may carry (this
--     migration itself created some, in error, before this fix).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- Each DO block below re-declares its own copy of the 14-schema array (mirrors 0003's own
-- per-block v_tabs style) — plpgsql has no cross-block shared variable without a session GUC.

-- ───────────────────────────────────────────────────────────────────────────
-- 1) Role: pgeos_app — LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, NOREPLICATION,
--    no password, owns nothing.
-- ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'pgeos_app') then
    create role pgeos_app login nosuperuser nobypassrls nocreaterole nocreatedb noreplication;
    raise notice '0007: created role pgeos_app';
  else
    alter role pgeos_app login nosuperuser nobypassrls nocreaterole nocreatedb noreplication;
    raise notice '0007: pgeos_app already exists — attributes re-applied';
  end if;
end $$;

do $$
begin
  execute format('grant connect on database %I to pgeos_app', current_database());
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2) Grants, per schema. Never TRUNCATE/REFERENCES/TRIGGER, never EXECUTE (PUBLIC already carries
--    EXECUTE by default; audit_hash_chain()/verify_audit_chain() are individually revoked from
--    PUBLIC by 0004, so pgeos_app never gets them). The table loop below is an explicit relkind
--    ('r','p') scan excluding partitions (`not c.relispartition`), not `on all tables in schema`
--    (grants on views too) and not a plain relkind scan (grants UPDATE/DELETE on every append-only
--    partition, e.g. platform.audit_log_2026_10, breaking append-only — pg-reviewer finding 2,
--    fix round 2). A partitioned PARENT (relkind 'p') is never itself a partition, so it is still
--    granted here; its own partitions are revoked-from explicitly below (§2b).
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_schemas constant text[] := array[
    'platform','identity','catalog','sales','wms','tms','cc',
    'billing','hr','partners','admin','housing','imile','governance'
  ];
  v_sch text;
  r record;
begin
  foreach v_sch in array v_schemas loop
    execute format('grant usage on schema %I to pgeos_app', v_sch);

    for r in
      select c.relname as tab
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r','p')
         and not c.relispartition
         and n.nspname = v_sch
    loop
      execute format('grant select, insert, update, delete on %I.%I to pgeos_app', v_sch, r.tab);
    end loop;

    execute format('grant usage, select on all sequences in schema %I to pgeos_app', v_sch);

    execute format(
      'alter default privileges for role postgres in schema %I grant select, insert, update, delete on tables to pgeos_app',
      v_sch);
    execute format(
      'alter default privileges for role postgres in schema %I grant usage, select on sequences to pgeos_app',
      v_sch);
  end loop;
end $$;

-- The three append-only books (01 §P3 pattern): INSERT/SELECT remain granted, UPDATE/DELETE do
-- not. 01-Data-Model.sql already revokes update/delete FROM PUBLIC on these tables (audit_log:134,
-- stock_movements:703) and 13B does the same for work_order_events (4264) — none of that reaches
-- pgeos_app, which was just granted UPDATE/DELETE directly above, so it must be revoked from
-- pgeos_app explicitly, every run (REVOKE on a privilege not held is a no-op).
revoke update, delete on platform.audit_log       from pgeos_app;
revoke update, delete on wms.stock_movements       from pgeos_app;
revoke update, delete on wms.work_order_events     from pgeos_app;

-- ★ §2b (pg-reviewer finding 2, fix round 2): the grant loop above already excludes partitions —
--   this pass additionally strips ANY privilege pgeos_app might otherwise hold on an existing
--   partition (e.g. carried over from a default-privilege grant on the parent before this fix, or
--   from a manual grant), so a repeat apply always converges to zero partition privileges.
do $$
declare
  v_schemas constant text[] := array[
    'platform','identity','catalog','sales','wms','tms','cc',
    'billing','hr','partners','admin','housing','imile','governance'
  ];
  r record;
begin
  for r in
    select n.nspname as sch, c.relname as tab
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and c.relispartition
       and n.nspname = any(v_schemas)
  loop
    execute format('revoke all on %I.%I from pgeos_app', r.sch, r.tab);
  end loop;
end $$;

-- ★ Views are never altered. Strip any privilege pgeos_app holds on a view that does not yet carry
--   security_invoker=true, so a repeat run and future ALTER DEFAULT PRIVILEGES on tables (which in
--   Postgres also cover future views — accepted, G7 catches a privileged owner-rights view) can't
--   leave pgeos_app with owner-rights access through a view.
do $$
declare
  v_schemas constant text[] := array[
    'platform','identity','catalog','sales','wms','tms','cc',
    'billing','hr','partners','admin','housing','imile','governance'
  ];
  r record;
begin
  for r in
    select n.nspname as sch, c.relname as vw
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'v'
       and n.nspname = any(v_schemas)
       and not (coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true'])
  loop
    execute format('revoke all on %I.%I from pgeos_app', r.sch, r.vw);
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3) entity_scope: USING / WITH CHECK split. Reads pg_policy at run time — not a fixed table list —
--    so it re-fixes any entity_scope policy 0003 resets on its own re-runs (see header). The name,
--    FOR ALL, and PUBLIC role stay; only USING/WITH CHECK are altered, no drop.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_schemas constant text[] := array[
    'platform','identity','catalog','sales','wms','tms','cc',
    'billing','hr','partners','admin','housing','imile','governance'
  ];
  r record;
  v_q  text;
  v_wc text;
begin
  for r in
    select p.polrelid, p.polqual, p.polwithcheck, p.polpermissive, p.polcmd,
           (n.nspname || '.' || c.relname) as tab
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where p.polname = 'entity_scope'
       and n.nspname = any(v_schemas)
     order by 1
  loop
    if r.polqual is null then
      raise exception '0007: entity_scope on % has a null USING clause — refusing to guess', r.tab;
    end if;
    if not r.polpermissive then
      raise exception '0007: entity_scope on % is not a permissive policy — refusing to alter', r.tab;
    end if;
    if r.polcmd <> '*' then
      raise exception '0007: entity_scope on % is not FOR ALL (polcmd = %) — refusing to alter', r.tab, r.polcmd;
    end if;

    v_q := pg_get_expr(r.polqual, r.polrelid);

    if r.polwithcheck is not null then
      v_wc := pg_get_expr(r.polwithcheck, r.polrelid);
      if v_wc = v_q then
        raise notice '0007: entity_scope on % already has WITH CHECK = USING — skipping', r.tab;
        continue;
      else
        raise exception '0007: entity_scope on % has an existing WITH CHECK (%) that differs from its USING (%) — refusing to overwrite', r.tab, v_wc, v_q;
      end if;
    end if;

    execute format('alter policy entity_scope on %s using (%s) with check (%s)', r.tab, v_q, v_q);
  end loop;
end $$;

-- Final assertion (binding design §4): no entity_scope policy in the 14 schemas has a null
-- WITH CHECK after the loop above.
do $$
declare
  v_schemas constant text[] := array[
    'platform','identity','catalog','sales','wms','tms','cc',
    'billing','hr','partners','admin','housing','imile','governance'
  ];
  v_n integer;
begin
  select count(*) into v_n
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where p.polname = 'entity_scope'
     and n.nspname = any(v_schemas)
     and p.polwithcheck is null;
  if v_n > 0 then
    raise exception '0007: % entity_scope polic(y/ies) still have a null WITH CHECK after the fix loop', v_n;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4) audit_append — a new permissive FOR INSERT policy on the platform.audit_log PARENT ONLY
--    (binding design §5), so a portal (non-internal) user can still insert an audit row for their
--    own action even though entity_scope's own WITH CHECK (gated on allowed_entities(), empty for
--    a portal user) does not admit it — permissive policies are OR-ed. Every real write is routed
--    through the parent (platform.audit_log), and a routed INSERT is checked against the parent's
--    own policies, not the receiving partition's — so a parent-only policy is exercised on every
--    real write; pg-tester's test 5 proves this. Never create audit_append on a partition.
-- ───────────────────────────────────────────────────────────────────────────
drop policy if exists audit_append on platform.audit_log;
create policy audit_append on platform.audit_log
  for insert with check (user_id is not null and user_id = platform.current_user_id());

-- Cleanup (fix round 2): an earlier run of this migration mistakenly created audit_append on every
-- partition too. Drop it there if it exists, so a database that already applied that earlier
-- version converges to the parent-only policy this file now defines.
do $$
declare r record;
begin
  for r in
    select n.nspname, c.relname
      from pg_inherits i
      join pg_class c     on c.oid = i.inhrelid
      join pg_namespace n on n.oid = c.relnamespace
     where i.inhparent = 'platform.audit_log'::regclass
  loop
    execute format('drop policy if exists audit_append on %I.%I', r.nspname, r.relname);
  end loop;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification (trust tests/isolation/tests/app-role-rls.test.ts + guards G7):
--   select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, rolpassword
--     from pg_roles where rolname = 'pgeos_app';
--   select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
--     join pg_namespace n on n.oid = c.relnamespace
--    where p.polname = 'entity_scope' and p.polwithcheck is null
--      and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc',
--        'billing','hr','partners','admin','housing','imile','governance');  -- 0
-- ═══════════════════════════════════════════════════════════════════════════
