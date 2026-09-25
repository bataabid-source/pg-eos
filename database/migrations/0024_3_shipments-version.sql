-- 0024_3_shipments-version.sql — Lane 3 — WBS 3.14 part 2 (M11 imile, station-agent pull loop).
-- Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- Replicates 0008_M_inbound-orders-version.sql / 0013_1_price-lists-version.sql /
-- 0014_2_employees-version.sql / 0017_1_quotes-version.sql / 0019_1_contracts-version.sql /
-- 0020_1_accounts-version.sql verbatim for imile.shipments — the mutable aggregate WBS 3.14
-- part 2's `PullShipments` command updates in place (iMile-sourced columns only: imile_status,
-- merchant, zone_code, area, recipient_phone, is_cod, cod_amount, is_fresh, raw, last_sync_at —
-- internal_status/cage_code/driver_code/delivery_task_id stay owned by later WBS 3.15-3.18
-- slices and are never touched by this command). CLAUDE.md ARCHITECTURE: "Every mutable
-- aggregate has a version column" — applies here exactly as it did to every table above. Not a
-- G-01 invention; imile.shipments (01-Data-Model.sql:1315-1336) was simply created before this
-- rule was retrofitted onto the schema, same as every table listed above before its own turn.
--
-- Classifies its own column (G6): migration 0002 runs earlier in file order on a fresh apply and
-- cannot see this column, so this file inserts the identity.column_classification row itself.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (3 findings, comment-only — a
-- non-existent-precedent citation of 0022/0023 removed, applied) — docs/notes/slice-briefs/
-- _slice-3.14.brief.md.

begin;

alter table imile.shipments add column if not exists version int not null default 1;
comment on column imile.shipments.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Replicates 0008/0013/0014/0017/0019/0020 — WBS 3.14 part 2.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('imile', 'shipments', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
