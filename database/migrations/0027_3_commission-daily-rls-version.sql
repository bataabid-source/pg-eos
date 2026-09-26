-- 0027_3_commission-daily-rls-version.sql — Lane 3 — WBS 3.13 part 1 (commission engine,
-- `CalculateDailyCommission`). Forward-only, idempotent (apply.sh re-runs every file on every
-- apply).
--
-- Three fixes on hr.commission_daily, confirmed live (not from a static grep — the tms.vehicles
-- false alarm taught this lane to check pg_policies first) by both lane 3 and the Master
-- independently: `select schemaname,tablename,policyname,cmd from pg_policies where
-- tablename='commission_daily'` returned exactly one row before this migration.
--
-- (1) No write policy at all. hr.commission_daily has RLS enabled but only `own_commission`
-- (FOR SELECT). Under RLS-enabled/no-permissive-policy, pgeos_app (no BYPASSRLS) cannot INSERT
-- or UPDATE a single row — root cause: 13-Schema-Additions.sql:711 created `own_commission`
-- FIRST, so the 13B dynamic policy-generation loop `continue`d for this table (13B:4502-4506,
-- "skip any table that already has a policy") and never generated its own `entity_scope` —
-- an authoring-order oversight, not a deliberate restriction, same corrected root cause 0021's
-- own header received from review. Fix: an internal-only INSERT + UPDATE policy, entity-scoped
-- in both USING and WITH CHECK. This is the SCR-RLS-01 Option B gated form (is_internal() AND
-- entity_id = any(...), migration 0003) — NOT 13B's own generated `entity_scope` form
-- (13B:4535-4539 has no is_internal() gate) — kept narrower than commission_rules' own blanket
-- `entity_scope FOR ALL` so it does not also touch SELECT (own_commission's driver-sees-own-row
-- restriction on SELECT must stay exactly as it is).
--
-- NOTE for the slice's builders and pg-tester: Postgres also applies the SELECT policy to
-- `INSERT ... RETURNING` and to `UPDATE ... WHERE ...RETURNING` — CalculateDailyCommission's own
-- repository insert avoids RETURNING for exactly this reason, reading the new row's id back via a
-- separate, already-known value instead, so this particular interaction never triggers. Round-1
-- review finding 2 (a non-internal actor with a real entity scope refused by `internal_write`'s
-- `is_internal()` gate; `own_commission`'s entity-scoped SELECT hiding an entity-A row from an
-- entity-B `hr.commission.read_all` holder) is covered by tests added in the round-1 fix round.
--
-- (2) The existing own_commission SELECT policy is not entity-scoped: `has_perm(...) OR
-- own-employee-row` lets any `hr.commission.read_all` holder see every entity's rows, not just
-- their own entity's — an isolation gap. Fix: recreate the policy under the same name, AND-ing
-- `entity_id = any(platform.allowed_entities())` onto the existing condition — identical in
-- effect to 13B ق-44 on the sister table `hr.sales_commission_events` (13B:5114-5127): a driver
-- sees their own row only if they also hold `identity.user_entities` membership for that row's
-- `entity_id` (allowed_entities() is not otherwise tied to commission_daily.entity_id).
--
-- (3) No `version` column despite being a mutable aggregate — status lifecycle
-- calculated -> disputed -> approved -> paid (chk_commission_daily_status, 13B:2449), 48-hour
-- dispute window in WBS 3.13 part 2. CLAUDE.md ARCHITECTURE: "Every mutable aggregate has a
-- version column." Replicates 0008/0013/0014/0017/0019/0020/0024 verbatim. WBS 3.13 part 1's
-- own INSERT sets it at its column default (1); no UPDATE happens in part 1, so no
-- optimistic-lock check is exercised until part 2 (dispute/confirm).
--
-- Idempotent guards: drop-then-create for both policies (bare `create policy` fails on a second
-- apply, same pattern as 0021); `add column if not exists` for version, same pattern as 0024.
-- Classifies its own column (G6): migration 0002 runs earlier in file order on a fresh apply and
-- cannot see this column, so this file inserts the identity.column_classification row itself.
--
-- RED test paths (lane-guard): modules/hr/tests/calculate-daily-commission/
-- calculate-daily-commission.feature, modules/hr/tests/calculate-daily-commission/
-- calculate-daily-commission.test.ts, tests/isolation/tests/shipments-attributed-invoker-rls.test.ts
-- (the third path added with item (4) below) — all exist, RED confirmed 2026-09-26
-- (module-not-found / permission-denied; the RLS-gap RED layer triggers once pg-backend's
-- implementation exists, before this migration applies).
--
-- (4) `imile.shipments_attributed` (the VIEW that is doc 38's own "Attribution through
-- assignment table only" mechanism) has no GRANT to pgeos_app — 0007's role-grant loop only
-- covers pg_class.relkind in ('r','p') (tables), views are excluded by design (0007 L142-164),
-- same gap 0012 fixed for wms.space_dashboard. WITHOUT ALSO setting security_invoker=true first,
-- a bare GRANT would be a SECURITY HOLE: the view's owner is postgres (superuser), so an
-- owner-rights view runs its underlying queries with the OWNER's privileges — RLS on
-- imile.shipments/imile.driver_ids/imile.driver_id_assignments (all three `internal_only`, no
-- `entity_id` column at all — confirmed against `.claude/briefs/imile.brief.md` §2) would be
-- BYPASSED, and a NON-INTERNAL session (portal/driver) would read every shipment and its
-- attribution through the view instead of the zero rows `internal_only` should show it — exactly
-- why G7 (guards.sql L105-113) flags an owner-rights + privileged view. Master's own catch
-- before this was applied — the lane's first attempt (a bare GRANT, verified only by a
-- temporary grant/revoke against pgeos_lane3 with NO security_invoker set) would have shipped
-- this hole; caught before the migration file was finalized, no permanent grant was ever left in
-- place during that check. Fix, verbatim structure of 0012: `alter view ... set (security_invoker
-- = true)` THEN `grant select ... to pgeos_app`, plus 0012's own self-check `do $$ ... $$` block,
-- which runs AFTER the grant inside the same transaction — a failed check rolls the grant (and
-- items 1-3) back, so no window of owner-rights-plus-granted is ever visible to another session.
-- One migration per slice (this stays 0027, not a separate 0028 — 0028 is reserved for the P6
-- batch).
--
-- ORDER (both paths end in the same state, same shape as 0012's own ORDER note):
--   fresh `apply.sh --recreate`: 13 creates the view (no reloptions) before 0007's default
--   privileges exist → 0007's strip loop has nothing to revoke → 0027 sets the option and grants.
--   re-apply: apply.sh re-runs 01 → 13 → 13B → 019 first; 13-Schema-Additions.sql:317 does
--   `create or replace view` (resets the option, KEEPS any existing grant) → 0007's strip loop
--   then revokes pgeos_app's privilege on the now-owner-rights view → 0027 re-sets the option
--   and re-grants. The window of extra privilege closes inside the same apply run, before
--   guards.sql runs — identical to 0012's own accepted window.
--
-- KEEP IN MIND (later slices): any migration that redefines imile.shipments_attributed must say
-- `with (security_invoker = true)` — `create or replace view` resets the option and keeps the
-- grant, so G7 turns red inside the same apply.
--
-- `imile.driver_id_dashboard`, `hr.employees_basic`, `hr.recruitment_cost_per_employee` have the
-- same no-invoker state — NOT a leak today (0007's strip loop leaves pgeos_app with no grant on
-- them at all), but an untracked gap: flagged to the Master (no SCR-RLS-04 row exists yet in
-- MASTER_BACKLOG as of this commit — confirmed by grep), not touched here, and not this slice's
-- to file since it did not create the gap.
--
-- Design consequence recorded (not a finding against this migration, per pg-reviewer's second
-- pass): an internal actor scoped to entity A can see employee_ids of entity-B employees through
-- this view, since the view carries no entity_id at all. WBS 3.13's own `hr.commission_daily`
-- write stays correctly entity-scoped regardless: `entity_id` on the inserted row still comes
-- from `platform.allowed_entities()` (the caller's own resolved entity, same as every other
-- slice's entity resolution), and the application layer separately READS (not joins)
-- `hr.employees` through that table's own RLS to VERIFY the target employee actually belongs to
-- that same entity before ever reaching the insert (`EmployeeNotInCallerEntityError` otherwise —
-- WBS 3.13 part 2, per pg-reviewer round 2 finding 1, a real correctness bug found in the FIRST
-- draft of this check that is fixed in part 2, not this migration). `internal_write`'s own WITH
-- CHECK (item 1 above) only ever constrains `commission_daily.entity_id` itself — it does not and
-- cannot, on its own, prevent a row naming a DIFFERENT entity's employee; that protection is the
-- application-level check described above, entirely outside this migration's own scope.
--
-- pg-reviewer pre-migration review: round 1 APPROVED WITH CHANGES (8 findings on the original
-- 3-part draft; own-row branch uses platform.my_employee_id(), 13B ق-50, applied below; the rest
-- were header-wording/bookkeeping fixes) — see docs/notes/slice-briefs/_slice-3.13.brief.md (this
-- brief stays in docs/notes/ per the NOTES rule: 3.13 part 2 is still ACTIVE work in this lane,
-- not deleted with this commit). Round 2 (item 4, added after the Master's own catch) APPROVED
-- WITH CHANGES (7 findings; SQL body unchanged, header-wording findings 1-4 applied here; findings
-- 5-7, on the isolation test file, routed to pg-tester) — reviewer notes GREEN test output against
-- pgeos_lane3 must be seen before final PASS, per "never approve a test not seen run" (seen: 5/5
-- green). Slice-level round 2 (full review, separate from these two pre-migration passes) FAILED
-- (7 findings) — per REVIEW CAP, no round 3: this migration's SQL BODY is part of the PASS subset
-- committed as WBS 3.13 part 1; the application/repository/handlers layer that consumes it is
-- deferred to "3.13 part 2" along with the 7 open findings (a real timezone correctness bug in
-- work_date/assignment-window comparisons, chief among them) — see MASTER_BACKLOG.

begin;

drop policy if exists internal_write on hr.commission_daily;
create policy internal_write on hr.commission_daily
  for insert
  with check (platform.is_internal() and entity_id = any(platform.allowed_entities()));

drop policy if exists internal_update on hr.commission_daily;
create policy internal_update on hr.commission_daily
  for update
  using (platform.is_internal() and entity_id = any(platform.allowed_entities()))
  with check (platform.is_internal() and entity_id = any(platform.allowed_entities()));

drop policy if exists own_commission on hr.commission_daily;
create policy own_commission on hr.commission_daily
  for select using (
    entity_id = any(platform.allowed_entities())
    and (
      platform.has_perm('hr.commission.read_all')
      or employee_id = platform.my_employee_id()
    )
  );

alter table hr.commission_daily add column if not exists version int not null default 1;
comment on column hr.commission_daily.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Replicates 0008/0013/0014/0017/0019/0020/0024 — WBS 3.13 part 1.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('hr', 'commission_daily', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

alter view imile.shipments_attributed set (security_invoker = true);
grant select on imile.shipments_attributed to pgeos_app;

-- Self-check: the view must now be invoker-rights, or 0007's strip loop would undo the grant on
-- the next apply and G7 would flag it (same self-check shape as 0012).
do $$ begin
  if not exists (select 1 from pg_class c
                  where c.oid = 'imile.shipments_attributed'::regclass
                    and coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true']) then
    raise exception '0027: imile.shipments_attributed is not security_invoker=true';
  end if;
end $$;

commit;
