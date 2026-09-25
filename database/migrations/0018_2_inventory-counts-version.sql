-- 0018_2_inventory-counts-version.sql — Lane 2 — WBS 2.13. Forward-only, idempotent (apply.sh
-- re-runs every file on every apply).
--
-- Adds the optimistic-concurrency column CLAUDE.md · ARCHITECTURE requires on every mutable
-- aggregate ("Every mutable aggregate has a version column") to wms.inventory_counts — the
-- aggregate WBS 2.13 mutates (StartCount/CountLocation/Recount/AdjustCount drive it through the
-- six statuses of chk_inventory_counts_status, 13B:2333-2335). Same shape as every earlier
-- version-column migration (0008 wms.inbound_orders, 0011 platform.alert_log, 0013
-- catalog.price_lists, 0014 hr.employees, 0015 platform.sites, 0016 three hr tables, plus
-- 13B:161-166's own wms.outbound_orders) — not a G-01 invention, the rule is stated in CLAUDE.md
-- and already applied repeatedly.
--
-- Parent-only versioning (0008 precedent): wms.inventory_count_lines is a child row
-- (on delete cascade from the count; no command of its own acts on a line directly — doc 40:260
-- names StartCount/CountLocation/Recount/AdjustCount, all commands of the count aggregate), same
-- as wms.order_lines was never versioned separately from wms.inbound_orders in migration 0008.
--
-- Classifies its own column (G6, doc 40 Part F): migration 0002 runs earlier in file order on a
-- fresh apply and cannot see this column.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (3 findings, all comment-only, applied)
-- — this header.

begin;

alter table wms.inventory_counts add column if not exists version int not null default 1;
comment on column wms.inventory_counts.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Same rule as 0008/0013/0014/0016 — WBS 2.13.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('wms', 'inventory_counts', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
