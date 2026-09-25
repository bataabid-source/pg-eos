-- 0017_1_quotes-version.sql — Lane 1 — WBS 1.6 (M02 sales, quotes). Forward-only, idempotent
-- (apply.sh re-runs every file on every apply).
--
-- Replicates 0008_M_inbound-orders-version.sql / 0013_1_price-lists-version.sql verbatim for
-- sales.quotes — the mutable aggregate WBS 1.6's state machine drives (the 8-value status enum
-- is `chk_quotes_status`, database/schema/13B-Schema-Reference-Consolidation.sql:2314-2316:
-- draft · commercial_review · finance_review · approved · sent · accepted · rejected · expired —
-- 01-Data-Model.sql:517's inline DDL comment predates that 13B alteration and omits
-- commercial_review; 13B's CHECK constraint is the live, authoritative list) and whose lines are
-- upserted under an expectedVersion check. CLAUDE.md ARCHITECTURE: "Every mutable aggregate has a
-- version column" — 13B:161-166 applied it to wms.outbound_orders, 0008 to wms.inbound_orders,
-- 0013 to catalog.price_lists; this file applies the same rule to sales.quotes. Not a G-01
-- invention.
--
-- Classifies its own column (G6): migration 0002 runs earlier in file order on a fresh apply and
-- cannot see this column, so this file inserts the identity.column_classification row itself.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES (finding 1: cite 13B:2314-2316 for
-- commercial_review, done above; finding 2: verdict line filled) — WBS 1.6 slice brief
-- (docs/notes/slice-briefs/_slice-1.6.brief.md decision 16).

begin;

alter table sales.quotes add column if not exists version int not null default 1;
comment on column sales.quotes.version is
  'Optimistic concurrency, doc 36 §3-3: WHERE id=$1 AND version=$2 -> SET version=version+1. '
  'Zero rows = conflict -> 409. Replicates 0008/0013 — WBS 1.6.';

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('sales', 'quotes', 'version', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
