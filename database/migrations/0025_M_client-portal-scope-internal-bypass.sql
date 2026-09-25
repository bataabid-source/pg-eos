-- 0025_M_client-portal-scope-internal-bypass.sql — Master — SCR-RLS-03 (D-181). Forward-only,
-- idempotent (apply.sh re-runs every file on every apply; inspect-then-rewrite, 0003's pattern).
--
-- Seven operational tables carried client_portal_scope FOR SELECT USING
--   (platform.is_internal() OR client_id = platform.current_client_id()).
-- Permissive policies OR together, so EVERY internal session read EVERY entity's rows and
-- entity_scope (0003 Option B) was never consulted for SELECT. Reproduced on the live database
-- 2026-09-25 (docs/notes/SCR-RLS-03-client-portal-scope-internal-bypass.md §1: an internal user
-- with platform.allowed_entities() = '{}' read probe rows of wms.outbound_orders and
-- wms.occupancy_snapshots). Depends on 0003 Option B (entity_scope gated on is_internal()).
--
-- After this file the two policies address disjoint populations, which is what 0003's header and
-- 01-Data-Model.sql "نمط 1 / نمط 2" state as the intent:
--   internal session (app.is_internal = true)  → entity_scope only
--   client-portal session (app.is_internal = false, app.client_id set) → client_portal_scope only
-- The predicate is `NOT platform.is_internal() AND client_id = platform.current_client_id()` —
-- the mirror of 0003 Option B — because an internal session that ALSO carries app.client_id would
-- otherwise still read that client's rows in every entity (pg-reviewer finding 1, reproduced).
--
-- Deliberately untouched (SCR-RLS-03 §1): sales.accounts (no entity_id; D-177 internal_only FOR ALL
-- already grants internal users everything, its OR-clause is redundant) and wms.skus
-- (client-partitioned "نمط 3", sole FOR ALL policy — removing is_internal() there would lock internal
-- staff out of every SKU).
--
-- Drift guard (0003:93-127 pattern — "fail loudly, never guess"): each table's existing
-- client_portal_scope is read back with pg_get_expr; the known legacy text is rewritten, the fixed
-- text is skipped with a NOTICE, anything else — or a missing / non-SELECT policy — raises and rolls
-- the whole file back. A final count asserts exactly seven fixed policies.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (5 findings, all applied: predicate
-- `NOT is_internal() AND …`; inspect-before-rewrite guard replacing a guard that could never fire;
-- this header; SCR note §1 view sentence corrected; wms/tests-isolation suites run before commit) —
-- SCR-RLS-03, D-181.
begin;

do $$
declare
  t      text;
  q      text;
  cmd    "char";
  n      int;
  target constant text := '((NOT platform.is_internal()) AND (client_id = platform.current_client_id()))';
  legacy constant text := '(platform.is_internal() OR (client_id = platform.current_client_id()))';
  tables constant text[] := array[
    'wms.outbound_orders', 'wms.work_orders', 'wms.occupancy_snapshots',
    'wms.space_allocations', 'wms.space_reservations',
    'tms.delivery_tasks', 'billing.invoices'
  ];
begin
  foreach t in array tables loop
    select pg_get_expr(p.polqual, p.polrelid), p.polcmd
      into q, cmd
      from pg_policy p
     where p.polrelid = t::regclass and p.polname = 'client_portal_scope';
    if not found then
      raise exception 'SCR-RLS-03: % has no client_portal_scope policy — refusing to guess', t;
    end if;
    if cmd <> 'r' then
      raise exception 'SCR-RLS-03: client_portal_scope on % is FOR "%" — expected SELECT (r)', t, cmd;
    end if;
    if q = target then
      raise notice 'SCR-RLS-03: % already carries the fixed policy — skipped', t;
    elsif q = legacy then
      execute format('drop policy client_portal_scope on %s', t);
      execute format(
        'create policy client_portal_scope on %s for select using (not platform.is_internal() and client_id = platform.current_client_id())',
        t);
      raise notice 'SCR-RLS-03: % client_portal_scope rewritten', t;
    else
      raise exception 'SCR-RLS-03: client_portal_scope on % has an unexpected predicate: % — refusing to overwrite', t, q;
    end if;
  end loop;

  select count(*) into n
    from pg_policy p
   where p.polname = 'client_portal_scope'
     and p.polcmd = 'r'
     and pg_get_expr(p.polqual, p.polrelid) = target
     and p.polrelid = any (select unnest(tables)::regclass);
  if n <> 7 then
    raise exception 'SCR-RLS-03: expected 7 fixed client_portal_scope policies, found %', n;
  end if;
end $$;

commit;
