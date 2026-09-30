-- 0047_1_quarantine-decision-chain-threshold.sql — Lane 1 — WBS 2.9 part 3 step 2 (D-211)
-- Forward-only, idempotent (apply.sh re-runs every file on every apply).
--
-- Purpose: seed the two data rows the short-shelf-life receipt reads (brief
-- _slice-2.9-p3-s2-qrt-quarantine, Decision 3). modules/wms reads both as DATA — no role literal and
-- no hour count in code:
--   (1) platform.approval_chains ('quarantine_decision', step 1, 'SALES_MGR') — the assigned_role of
--       the platform.decisions row a quarantined receipt opens (GM decision D-211, #207 2026-09-30
--       07:45Z; role SALES_MGR exists, 13B:554).
--   (2) platform.thresholds 'wms.quarantine.decision_due_hours' = 48 — due_at = occurred_at + this
--       many hours (doc 40 Part E S1 scenario 1, line 438 "within 48 h"; D-211).
--
-- No DDL, no RLS change, no audit change, no column → G6 unchanged. Both inserts are
-- `on conflict do nothing` (0040 chain-row and 0045 threshold-row precedents): a row a GM has already
-- edited is never overwritten. changed_by = the all-zero system user of the earlier seed migrations.
--
-- RED test paths (lane-guard, tasks/backlog/MIGRATION-REQUEST-1.md):
--   tests/scenarios/migration-0047.spec.ts · modules/wms/tests/receive-inbound/quarantine.test.ts ·
--   modules/wms/tests/process-outbound/allocate-excludes-quarantine.test.ts

begin;

insert into platform.approval_chains (request_type, step_no, approver_role, is_active, changed_by) values
  ('quarantine_decision', 1, 'SALES_MGR', true, '00000000-0000-0000-0000-000000000000')
on conflict (request_type, step_no) do nothing;

insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
  ('wms.quarantine.decision_due_hours', 48.000, 'hours',
   'مهلة قرار الحجر بالساعات لاستلام دفعة صلاحيتها أقل من الحد الأدنى — D-211 (وثيقة 40 S1 «خلال 48 ساعة») — WBS 2.9',
   '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

commit;
