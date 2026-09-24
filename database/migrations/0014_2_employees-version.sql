-- 0014_2_employees-version.sql — Lane 2 — WBS 3.3. Forward-only, idempotent (apply.sh re-runs
-- every file on every apply).
--
-- Adds the optimistic-concurrency column CLAUDE.md · ARCHITECTURE requires on every mutable
-- aggregate ("Every mutable aggregate has a version column") to hr.employees — the aggregate
-- WBS 3.3 mutates (RecordEmployeeDocument bumps it; ChangeEmployeeStatus drives status through the
-- XState machine active <-> on_leave / suspended -> terminated). Same shape as
-- 0008_M_inbound-orders-version.sql (wms.inbound_orders) and 13B:161-166 (wms.outbound_orders).
-- Not a G-01 invention: the rule is stated in CLAUDE.md and applied twice already.
--
-- Classifies its own column (G6, doc 40 Part F): migration 0002 runs earlier in file order on a
-- fresh apply and cannot see this column.
--
-- pg-reviewer pre-migration review: APPROVED (no changes) — WBS 3.3 slice brief.
-- Number 0014 issued by the Master 2026-09-24 (tasks/LANE_LOCKS.md "Migrations issued"; CHANGELOG 3.3, MIGRATION-REQUEST-2).

begin;

alter table hr.employees add column if not exists version int not null default 1;
comment on column hr.employees.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Same rule as 0008 (wms.inbound_orders) — WBS 3.3.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('hr', 'employees', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
