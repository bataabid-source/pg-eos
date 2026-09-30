# MIGRATION-REQUEST — lane B (the third build lane, D-205 C)

Number issued by the Master M14 on 2026-09-30 (D-205 C, issue #207; brief `docs/notes/slice-briefs/_slice-3.4-p1-delivery-task.brief.md`). One row per migration; the RED test paths must exist before the file (lane-guard.sh, D-179). The lane edits this table only to correct a path; it never picks a number.

| number | module | slug | purpose | RED tests |
|---|---|---|---|---|
| 0046 | tms | delivery-tasks-version-vehicle-guard | 3.4 part 1: INV-C4-1 DB-level guard (doc 40 line 273) — `tms.guard_vehicle_assignable()` security definer + `trg_guard_vehicle_assignable` BEFORE INSERT OR UPDATE OF vehicle_id on `tms.delivery_tasks` and `tms.routes`, refusing a vehicle with any `tms.vehicle_documents.expiry_date` before today (Asia/Kuwait) with SQLSTATE 23514, constraint `inv_c4_1_vehicle_assignable`; plus `tms.delivery_tasks.version int not null default 1` (brief Decisions 1–2). Idempotent; forward-only. | `modules/tms/tests/create-delivery-task/vehicle-assignable-guard.test.ts` (raw SQL, both tables, expired / valid / null vehicle) · `modules/tms/tests/create-delivery-task/create-delivery-task.test.ts` (version column read back = 1) |
