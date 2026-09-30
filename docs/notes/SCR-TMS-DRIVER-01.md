# SCR-TMS-DRIVER-01 — `driver_id` on `tms.delivery_tasks` / `tms.routes` has no link to `hr.employees` (G-01 schema-change request)

**Status:** filed 2026-09-30 by the Master M14 (WBS 3.4 part 1 brief, Decision 3; PR #222 review finding 3). OPEN — a GM decision; no migration attached. Owner: 3.4 part 2 (lane B) once decided.

## 1 · The gap

doc 40 line 273 (INV-C4-1, verbatim): "Hard gate: driver with expired residency/licence, or vehicle with expired document, **cannot be assigned**." The vehicle half is enforceable today: `tms.delivery_tasks.vehicle_id` and `tms.routes.vehicle_id` reference `tms.vehicles(id)` (01-Data-Model.sql:892, 909) and `tms.vehicle_documents` carries `expiry_date` (01:865) — migration 0046 (3.4 part 1) adds the DB guard.

The driver half is not: `tms.delivery_tasks.driver_id uuid` (01:891) and `tms.routes.driver_id uuid` (01:909) carry **no foreign key** in 01 / 13 / 13B / 019, so a DB guard cannot name the `hr.employee_documents` row (01:1302-1310, `doc_type` residency · license, `expiry_date`) to check without inventing the link. Nothing in the permitted schema says whether `driver_id` is an `hr.employees.id` (own drivers) or may point elsewhere (partner drivers, `executed_by_partner_id` 13:172).

## 2 · Options for the GM

1. **`driver_id → hr.employees(id)` FK on both tables** (nullable; partner tasks keep it null and use `executed_by_partner_id`) + the driver half of the guard in a 3.4 part 2 migration: `exists (select 1 from hr.employee_documents d where d.employee_id = new.driver_id and d.doc_type in ('residency','license') and d.expiry_date < today)` → refuse. Smallest change; matches doc 35 §0-1 (driver readiness = residency + licence valid).
2. Keep `driver_id` unlinked and enforce the driver half only in the application (`fleet`/`hr` gate called by 3.4's assign use case). Weaker than INV-C4-1's "hard gate" for the vehicle half; not recommended.

## 3 · Until decided

3.4 part 1 writes `driver_id` null (status `created`; assignment is part 2). No slice writes `driver_id` before this SCR closes.
