-- 0046_B_delivery-tasks-version-vehicle-guard.sql — Lane B — WBS 3.4 part 1 (number issued by the
-- Master M14 2026-09-30, D-205 C, issue #207; tasks/backlog/MIGRATION-REQUEST-B.md row 0046).
-- Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- WHAT (slice brief docs/notes/slice-briefs/_slice-3.4-p1-delivery-task.brief.md, Decisions 1-2):
--   1. INV-C4-1, doc 40 line 273 (verbatim): "Hard gate: driver with expired residency/licence, or
--      vehicle with expired document, cannot be assigned." — the vehicle half as a DB-level guard
--      on tms.delivery_tasks.vehicle_id and tms.routes.vehicle_id (MASTER_BACKLOG row 137: "or add
--      the equivalent DB-level guard"). Rule = fleet's own (modules/fleet/domain/register-vehicle/
--      invariants.ts expiredDocumentsOf): a document of ANY doc_type is expired iff expiry_date is
--      strictly before the Asia/Kuwait calendar date. SQLSTATE 23514, constraint
--      inv_c4_1_vehicle_assignable. Fires only when vehicle_id is set (INSERT) or changed (UPDATE);
--      a null vehicle_id is never checked. The driver half is out of part 1 (Decision 3,
--      SCR-TMS-DRIVER-01: driver_id carries no FK in the schema).
--   2. tms.delivery_tasks.version int not null default 1 — CLAUDE.md "every mutable aggregate has a
--      version column"; precedent 0008 (wms.inbound_orders). No other column.
--   3. INV-C4-2 DB CHECK deferred to WBS 3.4 part 2: existing fixtures in other modules insert address-less tasks.
--
-- security definer + search_path = pg_catalog, pg_temp (style of 0033/0035
-- hr.guard_commission_daily_status): RLS on tms.vehicle_documents must not hide an expired row
-- from the check. Every name schema-qualified, no dynamic SQL. EXECUTE revoked from public; no
-- grant to the app role (trigger invocation does not check EXECUTE).
--
-- Classifies its own column (G6, doc 40 Part F), as 0008 does: migration 0002 runs earlier in file
-- order on a fresh apply and cannot see this column.
--
-- pg-reviewer pre-migration review: findings 1 and 7 applied (WBS 3.4 part 1 slice brief).
-- RED tests: modules/tms/tests/create-delivery-task/vehicle-assignable-guard.test.ts ·
--            modules/tms/tests/create-delivery-task/create-delivery-task.test.ts (version = 1).

begin;

alter table tms.delivery_tasks add column if not exists version int not null default 1;
comment on column tms.delivery_tasks.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Generalises 13B:161-166 (wms.outbound_orders) — WBS 3.4 part 1.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('tms', 'delivery_tasks', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

create or replace function tms.guard_vehicle_assignable() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.vehicle_id is not null
     and (tg_op = 'INSERT' or new.vehicle_id is distinct from old.vehicle_id) then
    if exists (
      select 1
        from tms.vehicle_documents d
       where d.vehicle_id = new.vehicle_id
         and d.expiry_date < (pg_catalog.now() at time zone 'Asia/Kuwait')::date
    ) then
      raise exception 'INV-C4-1: vehicle % has an expired document and cannot be assigned (WBS 3.4 part 1)', new.vehicle_id
        using errcode = 'check_violation',
              constraint = 'inv_c4_1_vehicle_assignable',
              table = tg_table_name,
              schema = tg_table_schema;
    end if;
  end if;
  return new;
end;
$$;

comment on function tms.guard_vehicle_assignable() is
  'INV-C4-1 (doc 40 l.273) vehicle half: refuses setting vehicle_id to a vehicle with any '
  'tms.vehicle_documents.expiry_date before today (Asia/Kuwait). SQLSTATE 23514 — WBS 3.4 part 1.';

revoke all on function tms.guard_vehicle_assignable() from public;

drop trigger if exists trg_guard_vehicle_assignable on tms.delivery_tasks;
create trigger trg_guard_vehicle_assignable
  before insert or update of vehicle_id on tms.delivery_tasks
  for each row execute function tms.guard_vehicle_assignable();

drop trigger if exists trg_guard_vehicle_assignable on tms.routes;
create trigger trg_guard_vehicle_assignable
  before insert or update of vehicle_id on tms.routes
  for each row execute function tms.guard_vehicle_assignable();

commit;
