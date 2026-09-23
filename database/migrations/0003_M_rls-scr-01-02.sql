-- ═══════════════════════════════════════════════════════════════════════════
-- PG-EOS · 0003 · Lane M — RLS composition fixes: SCR-RLS-01 (B + C) and SCR-RLS-02 (A)
-- Forward-only migration · PostgreSQL 16 · 23/09/2026 · GM-approved ("نفذ الاصلاحات", 2026-09-23)
--
-- Source: WBS 0.18 raised two G-01 schema-change requests, both reproduced against the applied
--         schema, both approved by the GM on 2026-09-23 and recorded as D-002 in
--         docs/DECISION_LOG.md:
--           docs/notes/SCR-RLS-01-entity-scope-defeats-client-isolation.md   (Options B + C here)
--           docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md (Option A here;
--             Options B and C are guard/loop edits in guards.sql · apply.sh · 13B · doc 40 Part F)
--
-- No new table, no new column (nothing to classify for G6). Every statement is idempotent
-- (drop … if exists / create or replace), and the Option B precondition below accepts BOTH the
-- original predicate (apply) and the already-gated one (skip), so this file is RE-RUNNABLE:
-- `apply.sh` re-runs every file in database/migrations/*.sql under ON_ERROR_STOP=1 on every apply
-- (there is no applied-migrations table in this repo — 0001 and 0002 are re-runnable for the same
-- reason). It therefore converges with a fresh `apply.sh --recreate` — where 01/13B create the
-- original policies and the 13B loop (now `relkind in ('r','p')`) covers the audit_log parent —
-- and with the forward path on an already-applied database, and with a second application.
-- Verified: applied six times on the live database (four by the Master, two by pg-reviewer, seven
-- skip NOTICEs each), then once on a recreated one; and it still refuses a drifted predicate
-- (pg-reviewer replaced one policy with `using (true)` in a transaction → raised, rolled back).
--
-- ── SCR-RLS-01 · the defect ────────────────────────────────────────────────
-- Seven tables carried TWO permissive policies: entity_scope (FOR ALL,
-- `entity_id = any(platform.allowed_entities())`) and client_portal_scope (FOR SELECT,
-- `platform.is_internal() or client_id = platform.current_client_id()`). Permissive policies are
-- OR-ed, so a client-portal user who ALSO held an identity.user_entities row read another
-- client's rows by direct ID substitution (reproduced: 1 row where doc 38 row 0.18 demands 0).
--
-- Option B (below): gate entity_scope on platform.is_internal(). The two policies then address
-- disjoint populations — internal users via entity access, portal users via client identity —
-- which is what 01-Data-Model.sql's own comments say was intended ("نمط 1: الجداول التشغيلية" vs
-- "نمط 2: نافذة العميل"). Internal users are unaffected. Portal users never satisfied
-- entity_scope legitimately, so nothing they were entitled to is lost.
--
-- Option C (below): make user_type = 'client' and holding a user_entities row mutually
-- exclusive, enforced by triggers on both sides of the relationship. Defence in depth: B closes
-- the composition, C prevents the dual-role user from existing at all. The trigger function is
-- SECURITY DEFINER for the same reason platform.allowed_entities() is — the check must read
-- identity.users / identity.user_entities regardless of the caller's own RLS visibility, or a
-- caller who cannot see the users row would bypass the check.
--
-- ── Known, recorded consequences of Option B (not defects of this migration) ──
-- (1) platform.is_internal() is GUC-only and returns FALSE when app.is_internal is unset
--     (01-Data-Model.sql:39-40 as amended by 0001), and entity_scope is FOR ALL with a USING
--     clause only, so the same predicate is the WITH CHECK for INSERT/UPDATE. After 0003 every
--     internal reader AND writer of the seven tables must pass isInternal: true through
--     withContext, or it silently reads and writes nothing. Nothing breaks today — the only
--     non-test withContext callers (packages/identity/src/context.ts) pass isInternal: true, and no
--     legitimate non-internal caller exists besides the client portal, which reads through
--     client_portal_scope / sku_client_scope (untouched); drivers, partners and imile were already
--     required to run is_internal = true because 13B ق-9 gives housing/partners/hr no client-facing
--     policy. Decide with the 0.5/0.6 role design. Recorded in SCR-RLS-01 §6 and MASTER_BACKLOG.
-- (2) Option B is applied to the seven tables that carried the composition — NOT extended to
--     wms.inbound_orders, cc.tickets or the four 13-Schema-Additions.sql:702-708 tables. Those are
--     not vulnerable today (no client policy), but a client policy added to any of them later
--     re-opens the same hole silently. Deliberate scope decision (the SCR's own "worth extending"
--     was an aside, not part of the approved recommendation); recorded, not silently dropped.
--
-- ── SCR-RLS-02 · the defect ────────────────────────────────────────────────
-- platform.audit_log is declaratively partitioned by month. Its five partitions (relkind 'r')
-- each carry entity_scope; the PARENT (relkind 'p') had relrowsecurity = false and no policy.
-- PostgreSQL applies the policies of the relation named in the query, so every read through
-- platform.audit_log returned every row of every partition to any role holding SELECT on the
-- parent — reproduced: a NOBYPASSRLS role with allowed_entities() = {} read all 8 rows, all with
-- a non-null entity_id. Both the 13B auto-policy loop and guard G7 filtered relkind = 'r', which
-- is why the parent was skipped AND why G7 = 0 never noticed.
--
-- Option A (below): enable RLS on the parent and give it the partitions' exact predicate. A
-- policy on a partitioned parent applies to every partition, so the five leaf policies become
-- redundant but harmless, and `force row level security` (13B ق-13) finally does what its
-- comment says. The existing partitions are NOT touched.
--
-- ── Known, recorded consequence of Option A (not a defect of this migration) ──
-- platform.audit_hash_chain / platform.sanitize_audit are NOT security definer, so once the
-- runtime stops connecting as superuser (WBS 0.5/0.6 — packages/db/src/client.ts KNOWN GAP),
-- audit rows are inserted under the acting user's RLS context. entity_scope is FOR ALL with a
-- USING clause only, so the same predicate governs INSERT: a portal user (allowed_entities() =
-- {}) whose action audits a row with a non-null entity_id will have the audit insert — and thus
-- the whole transaction — rejected. This is exactly the semantics the partition policies already
-- encoded for direct partition writes, i.e. the schema author's intent, and SCR-RLS-02 §5 says
-- "identical predicate". It is recorded in CHANGELOG 0.18 and PROJECT_STATE as an open item for
-- the 0.5/0.6 role design (an INSERT-permissive / SELECT-scoped split, or a security-definer
-- audit writer) — it is NOT silently changed here.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- SCR-RLS-01 · Option B — gate entity_scope on platform.is_internal() on the seven tables
-- ───────────────────────────────────────────────────────────────────────────
-- Guard first: each of the seven policies must carry EITHER the exact predicate the SCR
-- enumerated from pg_policy (→ apply Option B) OR the gated predicate this migration produces
-- (→ already applied, skip). Anything else means the schema drifted: stop rather than overwrite
-- something unknown — forward-only migrations must fail loudly, never guess.
do $$
declare
  v_tab      text;
  v_qual     text;
  v_original constant text := '(entity_id = ANY (platform.allowed_entities()))';
  v_gated    constant text := '(platform.is_internal() AND (entity_id = ANY (platform.allowed_entities())))';
  v_tabs     text[] := array[
    'billing.invoices', 'tms.delivery_tasks', 'wms.outbound_orders',
    'wms.occupancy_snapshots', 'wms.space_allocations', 'wms.space_reservations', 'wms.work_orders'
  ];
begin
  foreach v_tab in array v_tabs loop
    select pg_get_expr(p.polqual, p.polrelid) into v_qual
      from pg_policy p
     where p.polrelid = v_tab::regclass and p.polname = 'entity_scope';
    if v_qual is null then
      raise exception '0003: % has no entity_scope policy — schema drifted from SCR-RLS-01 §1, refusing to guess', v_tab;
    elsif v_qual = v_gated then
      raise notice '0003: % entity_scope already gated on platform.is_internal() — skipping', v_tab;
      continue;
    elsif v_qual <> v_original then
      raise exception '0003: % entity_scope predicate is % — neither the SCR-RLS-01 §1 form nor the gated form, refusing to overwrite', v_tab, v_qual;
    end if;

    execute format('drop policy if exists entity_scope on %s', v_tab);
    execute format(
      'create policy entity_scope on %s for all using '
      '(platform.is_internal() and entity_id = any(platform.allowed_entities()))',
      v_tab);
  end loop;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- SCR-RLS-01 · Option C — a client-portal user can never hold identity.user_entities access
-- ───────────────────────────────────────────────────────────────────────────
-- Existing data must already satisfy the rule; otherwise stop and let a human decide which side
-- of each violating user is wrong. Never silently delete access rows in a migration.
do $$
declare v_n integer;
begin
  select count(*) into v_n
    from identity.user_entities ue
    join identity.users u on u.id = ue.user_id
   where u.user_type = 'client';
  if v_n > 0 then
    raise exception '0003: % identity.user_entities row(s) belong to user_type = ''client'' users — resolve by hand before applying SCR-RLS-01 Option C', v_n;
  end if;
end $$;

create or replace function identity.enforce_client_users_hold_no_entities()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_table_name = 'user_entities' then
    if exists (select 1 from identity.users u
                where u.id = new.user_id and u.user_type = 'client') then
      raise exception
        'SCR-RLS-01: user % is a client-portal user (user_type = ''client'') and cannot hold identity.user_entities access — entity_scope and client_portal_scope must address disjoint populations. Allowed: set identity.users.user_type to ''internal'' first (an internal user may hold entity access), or do not grant this user entity access',
        new.user_id
        using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'users' then
    if new.user_type = 'client'
       and exists (select 1 from identity.user_entities ue where ue.user_id = new.id) then
      raise exception
        'SCR-RLS-01: user % holds identity.user_entities rows and cannot become a client-portal user (user_type = ''client''). Allowed: delete this user''s identity.user_entities rows first, then set user_type = ''client''',
        new.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

comment on function identity.enforce_client_users_hold_no_entities() is
  'SCR-RLS-01 Option C (migration 0003): user_type = client and identity.user_entities membership are mutually exclusive. SECURITY DEFINER so the check is independent of the caller''s RLS visibility of identity.users.';

drop trigger if exists user_entities_reject_client_user on identity.user_entities;
create trigger user_entities_reject_client_user
  before insert or update of user_id on identity.user_entities
  for each row execute function identity.enforce_client_users_hold_no_entities();

drop trigger if exists users_reject_client_with_entities on identity.users;
create trigger users_reject_client_with_entities
  before insert or update of user_type on identity.users
  for each row execute function identity.enforce_client_users_hold_no_entities();

-- ───────────────────────────────────────────────────────────────────────────
-- SCR-RLS-02 · Option A — RLS on the platform.audit_log partitioned PARENT
-- ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if (select c.relkind from pg_class c where c.oid = 'platform.audit_log'::regclass) <> 'p' then
    raise exception '0003: platform.audit_log is not a partitioned table (relkind p) — SCR-RLS-02 premise no longer holds, refusing to continue';
  end if;
end $$;

alter table platform.audit_log enable row level security;
alter table platform.audit_log force  row level security;   -- already set by 13B ق-13; idempotent

drop policy if exists entity_scope on platform.audit_log;
create policy entity_scope on platform.audit_log
  for all using (entity_id is null or entity_id = any(platform.allowed_entities()));

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification (run by hand, or trust tests/isolation + guards G7/G14):
--   select polrelid::regclass, pg_get_expr(polqual, polrelid) from pg_policy
--    where polname = 'entity_scope' and polrelid in ('billing.invoices'::regclass,
--          'wms.work_orders'::regclass, 'platform.audit_log'::regclass);
--   -- G7 (widened, SCR-RLS-02 Option B): must return 0
--   select count(*) from pg_class t join pg_namespace n on n.oid = t.relnamespace
--    where t.relkind in ('r','p') and n.nspname in ('platform','identity','catalog','sales','wms',
--      'tms','cc','billing','hr','partners','admin','housing','imile','governance')
--      and not t.relrowsecurity;
-- ═══════════════════════════════════════════════════════════════════════════
