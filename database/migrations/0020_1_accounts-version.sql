-- 0020_1_accounts-version.sql — Lane 1 — WBS 1.8 (group-level credit limit and hold, sales.accounts).
-- Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- Replicates 0008_M_inbound-orders-version.sql / 0013_1_price-lists-version.sql /
-- 0017_1_quotes-version.sql / 0019_1_contracts-version.sql verbatim for sales.accounts — the
-- mutable aggregate WBS 1.8's commands drive (credit_limit, credit_hold, hold_reason,
-- hold_set_by, hold_set_at) under an expectedVersion check. sales.accounts has no entity_id
-- column and no status-enum machine — CLAUDE.md ARCHITECTURE's "every mutable aggregate has a
-- version column" applies regardless: 13B:161-166 applied it to wms.outbound_orders, 0008 to
-- wms.inbound_orders, 0013 to catalog.price_lists, 0017 to sales.quotes, 0019 to sales.contracts;
-- this file applies the same rule to sales.accounts. Not a G-01 invention.
--
-- Classifies its own column (G6): migration 0002 runs earlier in file order on a fresh apply and
-- cannot see this column, so this file inserts the identity.column_classification row itself.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (placeholder verdict line filled) —
-- WBS 1.8 slice brief (docs/notes/slice-briefs/_slice-1.8.brief.md decision 10).

begin;

alter table sales.accounts add column if not exists version int not null default 1;
comment on column sales.accounts.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Replicates 0008/0013/0017/0019 — WBS 1.8.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('sales', 'accounts', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
