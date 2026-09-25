-- 0023_2_schedule-inbound.sql — Lane 2 — WBS 2.9b. Forward-only, idempotent (apply.sh re-runs
-- every file on every apply).
--
-- SCR-WMS-INB-01 §7 (schedule/appointment) + §8 (logistics terms), tasks/backlog/2.9b-schedule-
-- inbound.md. Adds nine columns to wms.inbound_orders: an appointment (scheduled_by/scheduled_at/
-- dock_code), a mandatory cancel reason (cancel_reason), the four logistics terms
-- (handover_point/transport_by/labour_by/labour_count — vehicle_type already exists, 01:744, this
-- migration only adds its CHECK), and delivery_task_id (nullable, no FK — mirrors
-- wms.outbound_orders.delivery_task_id, 01:765, which also has no FK; never written this slice,
-- D-180/D5, follow-up once a tms module exists to own it).
--
-- scheduled_by/scheduled_at/cancel_reason/dock_code classified `public` (§7 line 97). The four
-- logistics-term columns + delivery_task_id classified `commercial` (§8 line 120 — "All classified
-- commercial"). scheduleNote (§7 line 91, a command input only, no schema note names it) carries in
-- the audit row's newValue and the wms.inbound.scheduled event payload, not a column (G-01 — no
-- basis for a schedule_note column in the source spec).
--
-- No migration to sales.contracts (three default_* term columns) or wms.outbound_orders (the same
-- four terms on the outbound side) — neither is lane 2's lock this slice (D6/D-180 item 3).
--
-- pg-reviewer pre-migration review: round 1 FAIL(5 findings: 1 classification, 1 column removed
-- [schedule_note], 3 comment) → fixed → round 2 FAIL(2 findings, header-wording only) → fixed →
-- round 3 APPROVED.

begin;

alter table wms.inbound_orders add column if not exists scheduled_by uuid;
alter table wms.inbound_orders add column if not exists scheduled_at timestamptz;
alter table wms.inbound_orders add column if not exists dock_code text;
alter table wms.inbound_orders add column if not exists cancel_reason text;
alter table wms.inbound_orders add column if not exists handover_point text;
alter table wms.inbound_orders add column if not exists transport_by text;
alter table wms.inbound_orders add column if not exists labour_by text;
alter table wms.inbound_orders add column if not exists labour_count int;
alter table wms.inbound_orders add column if not exists delivery_task_id uuid;

comment on column wms.inbound_orders.scheduled_by is
  'SCR-WMS-INB-01 §7: WH_MGR/WH_SUP who set the appointment via ScheduleInbound. Null until scheduled.';
comment on column wms.inbound_orders.scheduled_at is
  'SCR-WMS-INB-01 §7: when ScheduleInbound was called (audit-style timestamp, from the injected clock, never now()). Rescheduling overwrites it.';
comment on column wms.inbound_orders.dock_code is
  'SCR-WMS-INB-01 §7: free-text dock code — no docks table exists yet, this is a label, not a reference.';
comment on column wms.inbound_orders.cancel_reason is
  'SCR-WMS-INB-01 §7: mandatory reason on CancelInbound (2.9b — was optional/unpersisted before this migration), reaches the client.';
comment on column wms.inbound_orders.handover_point is
  'SCR-WMS-INB-01 §8 logistics term: premium_warehouse | client_site. Caller-supplied only this slice (D6 — no sales.contracts default wired, no sales lock).';
comment on column wms.inbound_orders.transport_by is
  'SCR-WMS-INB-01 §8 logistics term: client | premium.';
comment on column wms.inbound_orders.labour_by is
  'SCR-WMS-INB-01 §8 logistics term: client | premium | shared.';
comment on column wms.inbound_orders.labour_count is
  'SCR-WMS-INB-01 §8 logistics term: workers to assign, >= 0.';
comment on column wms.inbound_orders.delivery_task_id is
  'SCR-WMS-INB-01 §8: would link to tms.delivery_tasks (type pickup_delivery) when transport_by=premium and handover_point=client_site. Mirrors wms.outbound_orders.delivery_task_id (01:765), which also has no FK. NULLABLE, NEVER WRITTEN this slice (D-180/D5) — follow-up once a tms module exists to own delivery-task creation.';

alter table wms.inbound_orders drop constraint if exists chk_inbound_orders_vehicle_type;
alter table wms.inbound_orders add constraint chk_inbound_orders_vehicle_type check (
  vehicle_type is null or vehicle_type in ('container_20', 'container_40', 'truck', 'trailer', 'van', 'pickup', 'other')
);

alter table wms.inbound_orders drop constraint if exists chk_inbound_orders_handover_point;
alter table wms.inbound_orders add constraint chk_inbound_orders_handover_point check (
  handover_point is null or handover_point in ('premium_warehouse', 'client_site')
);

alter table wms.inbound_orders drop constraint if exists chk_inbound_orders_transport_by;
alter table wms.inbound_orders add constraint chk_inbound_orders_transport_by check (
  transport_by is null or transport_by in ('client', 'premium')
);

alter table wms.inbound_orders drop constraint if exists chk_inbound_orders_labour_by;
alter table wms.inbound_orders add constraint chk_inbound_orders_labour_by check (
  labour_by is null or labour_by in ('client', 'premium', 'shared')
);

alter table wms.inbound_orders drop constraint if exists chk_inbound_orders_labour_count;
alter table wms.inbound_orders add constraint chk_inbound_orders_labour_count check (
  labour_count is null or labour_count >= 0
);

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
values
  ('wms', 'inbound_orders', 'scheduled_by', 'public'),
  ('wms', 'inbound_orders', 'scheduled_at', 'public'),
  ('wms', 'inbound_orders', 'dock_code', 'public'),
  ('wms', 'inbound_orders', 'cancel_reason', 'public'),
  ('wms', 'inbound_orders', 'handover_point', 'commercial'),
  ('wms', 'inbound_orders', 'transport_by', 'commercial'),
  ('wms', 'inbound_orders', 'labour_by', 'commercial'),
  ('wms', 'inbound_orders', 'labour_count', 'commercial'),
  ('wms', 'inbound_orders', 'delivery_task_id', 'commercial')
on conflict (schema_name, table_name, column_name) do update set sensitivity = excluded.sensitivity;

commit;
