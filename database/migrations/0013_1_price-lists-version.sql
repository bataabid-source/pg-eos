-- 0013_1_price-lists-version.sql — Lane 1 — WBS 1.2 (M03 catalog). Forward-only, idempotent
-- (apply.sh re-runs every file on every apply).
--
-- Replicates 0008_M_inbound-orders-version.sql verbatim for catalog.price_lists — the mutable
-- aggregate WBS 1.2's state machine drives (draft -> active -> expired) and whose lines are
-- upserted/imported under an expectedVersion check. CLAUDE.md ARCHITECTURE: "Every mutable
-- aggregate has a version column" — 13B:161-166 applied it to wms.outbound_orders, 0008 to
-- wms.inbound_orders; this file applies the same rule to the sibling table. Not a G-01 invention.
--
-- Classifies its own column (G6): migration 0002 runs earlier in file order on a fresh apply and
-- cannot see this column, so this file inserts the identity.column_classification row itself.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (verdict line filled; 'public' taken
-- on the 0008 precedent, confirmed by a clean apply + G6 zero rows) — WBS 1.2 slice brief
-- (docs/notes/slice-briefs/_slice-1.2.brief.md decision 15).

begin;

alter table catalog.price_lists add column if not exists version int not null default 1;
comment on column catalog.price_lists.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Replicates 0008 (wms.inbound_orders) — WBS 1.2.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('catalog', 'price_lists', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
