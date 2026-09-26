-- 0032_1_order-lines-picked-by.sql — Lane 1 — WBS 2.12 part 3, closes SCR-WMS-OUT-03 (D-190 option a).
-- Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- CheckOrder's self-check (doc 38 row 2.12 "Self-check rejected") had a residual gap found in 2.12
-- part 2's round 2: a picker whose ONLY action was a zero-quantity pick on a line OTHER than the one
-- that completed the order posts no wms.stock_movements row and is not outbound_orders.picked_by
-- either, so they could still pass self-check. Ruled fix (D-190 option a, SCR-WMS-OUT-03 §2): stamp
-- EVERY PickLine call (including zero-qty) onto the LINE itself, and widen the self-check to check
-- every line's own picked_by, not just the order-level column (which stays, unchanged, for
-- compatibility/display — the last picker to complete the order).
--
-- RLS: wms.order_lines already HAS row level security enabled, via 13B's auto-policy loop
-- (13B-Schema-Reference-Consolidation.sql:3082-3147) — a table in the wms schema with no existing
-- policy, no entity_id column and not on the reference-table list gets `enable row level security` +
-- a generated `internal_only ... for all using (platform.is_internal())` policy. order_lines has no
-- entity_id, so it received `internal_only`, not an entity-scoped policy; entity scoping happens
-- through the already-RLS-scoped parent order (this use case's own getOrderLineForPick precedent).
-- The two new columns inherit that existing row policy automatically — no new RLS statement here.
--
-- Classification: classifies its own columns (G6, same reason 0024 gives — 0002 runs earlier on a
-- fresh apply and cannot see these columns yet). sensitivity 'public' — matches the live
-- classification of wms.outbound_orders.picked_by/checked_by/packed_by AND wms.stock_movements.
-- performed_by (verified against both the live identity.column_classification table and
-- 0002_M_classify-columns.sql's own rules: an internal actor's uuid + a timestamp matches no secret/
-- personal/payroll/commercial override pattern, so both fall to the default, 'public').
--
-- DB-level invariant: an idempotent order_lines_picked_pair CHECK enforces "set together" at the row
-- (doc 36 §5-4 #2 — an invariant held in domain/ must also be a DB constraint where practical), same
-- pattern as this table's own existing variance_photo_pair (0010_M_idempotency-keys-variance-photo.sql).
--
-- Known consequence, no backfill (recorded, not silently accepted): an order already picking/picked
-- when this migration applies keeps picked_by/picked_at = null on every line touched before the
-- migration — no backfill is written, since deriving a per-line actor from outbound_orders.picked_by
-- would invent data the schema never recorded per-line. Acceptable because the pilot runs only on
-- seed 019 + synthetic data (D-127) — no real in-flight orders exist across this migration boundary.
--
-- G-01: this ruling (D-190, option a) was relayed by the Master from the GM-delegated evaluation
-- session; pg-scribe records it verbatim on the docs/DECISION_LOG.md D-190 row in this slice's own
-- feat(2.12) commit (same convention 0030's own header used for its own D-190 ruling).
--
-- pg-reviewer pre-migration review: round 1 FAIL(4: the RLS claim above was wrong before this fix;
-- G-01 authority not yet on record; no DB-level pairing check; no note on already-mid-pick orders) →
-- all 4 fixed → PASS.

begin;

alter table wms.order_lines add column if not exists picked_by uuid;
comment on column wms.order_lines.picked_by is
  'WBS 2.12 part 3 (SCR-WMS-OUT-03, D-190): the actor of the PickLine call that touched THIS line, '
  'set on every call including a zero-quantity pick. CheckOrder self-check reads this per-line, not '
  'just outbound_orders.picked_by (which stays the last-completing-picker column, unchanged).';

alter table wms.order_lines add column if not exists picked_at timestamptz;
comment on column wms.order_lines.picked_at is
  'WBS 2.12 part 3 (SCR-WMS-OUT-03): the PickLine call''s own clock.now(), set alongside picked_by.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_lines_picked_pair') then
    alter table wms.order_lines add constraint order_lines_picked_pair check (
      (picked_by is null) = (picked_at is null));
  end if;
end $$;

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('wms', 'order_lines', 'picked_by', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values ('wms', 'order_lines', 'picked_at', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
