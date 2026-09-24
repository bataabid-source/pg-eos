-- 0012_M_space-dashboard-invoker-grant.sql — Lane M — WBS 5.13 part 1 (alert evaluation
-- mechanism). Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- WHY: alert rule N-11 ("تجاوز مساحة متعاقدة", 13B seed) reads the VIEW wms.space_dashboard. It is
-- the only one of the 22 source_query texts that reads a view (checked against
-- information_schema.views on 2026-09-24). EvaluateAlertRules executes each rule's source_query
-- inside the caller's own withContext transaction as pgeos_app, and migration 0007 (D-133, lean
-- design) leaves pgeos_app with NO privilege on any owner-rights view: its strip loop (0007 L146-164)
-- revokes all from every view that does not carry security_invoker=true, and G7 (guards.sql
-- L105-113) flags a view only when it is BOTH owner-rights AND privileged. Both checks exempt an
-- invoker-rights view by design.
--
-- WHAT THIS IS: a SINGLE-VIEW EXCEPTION to 0007's statement "views are NOT altered — no
-- security_invoker rewrite" (0007 L12, L142). The GM's D-133 lean design rejected rewriting every
-- view; this opts in ONE view that a seeded alert rule reads, keeps D-133's rule (pgeos_app never
-- reads through an owner-rights view), and adds no table, column or business rule — so it is not a
-- G-01 matter. Recorded as a Master default (CLAUDE.md · DEFAULT, RECORD, PROCEED) in
-- docs/CHANGELOG.md under WBS 5.13, citing D-133; DECISION_LOG D-133 (verbatim) says nothing about
-- views. Under invoker rights the caller's row security decides what N-11 sees — strictly safer than
-- owner rights, which would have exposed every block.
--
-- ORDER (both paths end in the same state):
--   fresh `apply.sh --recreate`: 13B creates the view (no reloptions) before 0007's default
--   privileges exist → 0007's strip loop has nothing to revoke → 0012 sets the option and grants.
--   re-apply: apply.sh re-runs 01 → 13 → 13B → 019 first; 13B L4852-4853 does `drop view if exists`
--   + `create view`, so the view comes back WITHOUT the option; 0007's `alter default privileges …
--   on tables` (which also covers views) gives pgeos_app privileges on it; 0007's strip loop then
--   revokes them; 0012 sets the option and re-grants SELECT only. The window of extra privilege
--   closes inside the same apply run, before guards.sql runs.
--
-- Underlying tables (all ordinary, non-partitioned; none of 0007's three append-only books; all get
-- SELECT from 0007's table loop): wms.warehouses (01, `reference_read`) · wms.occupancy_snapshots
-- (01, `client_portal_scope`) · wms.space_blocks (13B, `entity_scope`) · wms.space_allocations and
-- wms.space_reservations (13B, `entity_scope` + `client_portal_scope`) ·
-- wms.space_blocks_out_of_service (13B, no entity_id → the loop's `internal_only`). A portal session
-- sees no space_blocks rows, so the view returns nothing to it.
--
-- KEEP IN MIND (later slices): any migration that redefines wms.space_dashboard must say
-- `with (security_invoker = true)` — `create or replace view` resets the option and keeps the
-- grant, so G7 turns red inside the same apply. And N-11's numbers depend on which entities the
-- caller's context can see: the scheduled EvaluateAlertRules job (WBS 5.13 part 2) must run under
-- an internal system context whose allowed_entities() covers every entity, or N-11 can under-count.
--
-- pg-reviewer pre-migration review (opus): APPROVED WITH CHANGES (4 findings, all header text —
-- this text). SQL body unchanged from the reviewed draft.

begin;

alter view wms.space_dashboard set (security_invoker = true);
grant select on wms.space_dashboard to pgeos_app;

-- Self-check: the view must now be invoker-rights, or 0007's strip loop would undo the grant on
-- the next apply and G7 would flag it.
do $$ begin
  if not exists (select 1 from pg_class c
                  where c.oid = 'wms.space_dashboard'::regclass
                    and coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true']) then
    raise exception '0012: wms.space_dashboard is not security_invoker=true';
  end if;
end $$;

commit;
