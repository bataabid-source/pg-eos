-- 0019_1_contracts-version.sql — Lane 1 — WBS 1.7 (M02 sales, contracts). Forward-only, idempotent
-- (apply.sh re-runs every file on every apply).
--
-- Replicates 0008_M_inbound-orders-version.sql / 0013_1_price-lists-version.sql /
-- 0017_1_quotes-version.sql verbatim for sales.contracts — the mutable aggregate WBS 1.7's state
-- machine drives (the 7-value status enum is chk_contracts_status, 13B:2318-2320: draft · signed ·
-- active · suspended · expired · renewed · terminated) and whose price-annex link and billing
-- flags are updated under an expectedVersion check. CLAUDE.md ARCHITECTURE: "Every mutable
-- aggregate has a version column" — 13B:161-166 applied it to wms.outbound_orders, 0008 to
-- wms.inbound_orders, 0013 to catalog.price_lists, 0017 to sales.quotes; this file applies the
-- same rule to sales.contracts. Not a G-01 invention.
--
-- Classifies its own column (G6): migration 0002 runs earlier in file order on a fresh apply and
-- cannot see this column, so this file inserts the identity.column_classification row itself.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (placeholder verdict line filled) —
-- WBS 1.7 slice brief (docs/notes/slice-briefs/_slice-1.7.brief.md decision 15).

begin;

alter table sales.contracts add column if not exists version int not null default 1;
comment on column sales.contracts.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Replicates 0008/0013/0017 — WBS 1.7.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('sales', 'contracts', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
