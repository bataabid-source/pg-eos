-- 0008_M_inbound-orders-version.sql — Lane M — WBS 2.9. Forward-only, idempotent (apply.sh
-- re-runs every file on every apply).
--
-- Generalises 13B-Schema-Reference-Consolidation.sql:161-166 (wms.outbound_orders.version) to
-- wms.inbound_orders — the mutable aggregate the golden slice's state machine drives through six
-- transitions (draft -> approved -> receiving -> received -> putaway -> closed | cancelled), per
-- that 13B comment's own "the doc says every mutable entity carries version; applied here
-- literally to only the named table, and generalising it is a WBS task" — this IS that WBS task.
-- Not a G-01 invention: CLAUDE.md ARCHITECTURE already states the rule for every mutable
-- aggregate, and 13B already applied it once, verbatim, to the sibling table.
--
-- Classifies its own column (G6, doc 40 Part F): migration 0002 (classify-columns) runs earlier
-- in file order on a fresh apply, so it cannot see this column — this file classifies it itself.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (this text, plus the classification
-- insert) — WBS 2.9 slice brief.

begin;

alter table wms.inbound_orders add column if not exists version int not null default 1;
comment on column wms.inbound_orders.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Generalises 13B:161-166 (wms.outbound_orders) — WBS 2.9.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('wms', 'inbound_orders', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
