# SCR-HR-SHIFT-01 — shifts, shift groups, work sites, device custody, vehicle QR, employee requests (GM directive D-143)

**Status: APPROVED — GM directive D-144 (2026-09-24); resolution in §5. Scope: INSIDE THE PILOT (GM), sequenced after the golden slice 2.9 is accepted. Nothing in `database/schema/*` or `database/migrations/*` is touched by this note; DDL after pg-reviewer's pre-migration review.** Raised under **EXECUTION-MASTER-v4 §1.11 (G-01)** on criterion (i) real schema gap (Gap-Register **#7** shifts/leaves, **#17**, **#18** device registry) and (iii) a GM requirement not modelled. Source: the GM's eleven-line directive of 2026-09-24 recorded verbatim as **D-143** in `docs/DECISION_LOG.md`. Companion requests: SCR-HR-ATT-01 (attendance punches, approved D-131) and SCR-TMS-PICKUP-01 (pickup leg + `sales.account_sites`, approved D-137). Timing: **inside the pilot by D-144** (overrides the D-127 default for this request); the golden slice 2.9 is untouched and is accepted first, then these shapes enter the lanes as WBS rows the Master issues.

## 1. The eleven directive lines, classified

| # | GM line (verbatim) | Classification | Where it lands |
|---|---|---|---|
| 1 | بمجرد تسليم هاتف يتم تسجيل البصمة على الجهاز وقت الاستلام لتفعيل الحضور والغياب | Process rule + link between two existing shapes | Device handover (§2.5) **creates the device-registry row** (SCR-HR-ATT-01 §2.2) in the same transaction; biometric enrolment on the OS is the employee's act on the phone — the system records only "enrolled at handover = yes" |
| 2 | تفعيل الحضور والانصراف ونظام البصمة بمجرد إعداد بصمة الموظف | Process rule | Punch **capture** is live per employee the moment a registered device exists. **Read carefully against PLT-50:** capture ≠ automatic absence/late detection. Capture starts immediately; automatic penalties stay off until 95% × 30 days (EXEC-v4 §1.3, doc 15 §6-7, D-126) **unless the GM explicitly overrides PLT-50** — batched question §4 |
| 3 | إنشاء جداول الورديات | **Schema gap #7 (shifts part)** | §2.1 `hr.shifts` + §2.2 `hr.shift_assignments` |
| 4 | تصنيف فرعي داخل الوردية إلى مجموعات نقل (سائق وعمال) بجدول وردية وموقع حضور خاص بها | **New shape** | §2.3 `hr.shift_groups` (a group inside a shift: one driver + workers, own schedule, own attendance site) |
| 5 | حضور سائقين من موقع عميل وتنشيطه في منفذ العميل جاهز للاستلام | **Answers Q30a** (D-141 carried): the geofence carrier is a **site table**, and client outlets are sites | §2.4 `hr.work_sites` **unified with** `sales.account_sites` (SCR-TMS-PICKUP-01 §3.3 b): one sites table, `kind ∈ {warehouse · office · client_pickup · other}`; a driver's punch at a client site sets `ready_for_pickup` on that site for the day |
| 6 | على كل اللوحات التشغيلية: سائقون جاهزون للاستلام بعلامة خضراء مضيئة | Board rule | A **static green status badge** "جاهز للاستلام" on the driver card / task card, derived from the punch (no new column). Static, not blinking: D-15 §3(ح) bans moving counters, and `prefers-reduced-motion` applies. "مضيئة" is read as *bright green*, not animated — GM may correct |
| 7 | من تطبيق الموظفين والسائقين: تطبيق الطلبات الإدارية الخاصة بهم | **Capability gap** (no employee self-service table in 01/13/13B) | §2.6 `hr.employee_requests` (leave · letter · advance · document · other) with `approval_chains`; UI = a group on the field app (APP-1) — extends APP-1 scope |
| 8 | إدراج الهاتف كعهدة من التطبيق: اختيار ملك الشركة أو هاتف شخصي، وكذلك خطوط التليفون | Existing carrier + two additions | `admin.assets` / `admin.asset_custody` exist (13 §543–570). Add: `admin.assets.ownership ∈ {company · personal}` (personal phone = registered but not a custody asset), asset_type value `sim_line` with `phone_number`, and the link `identity.devices.asset_id` (§2.5) |
| 9 | الاستلام والتسليم للأجهزة من خلال النظام | Existing carrier | `admin.asset_custody` already models issue/return with `handover_doc_id`. Needed: the **app-side flow** (employee confirms receipt from the phone, biometric enrolled → registry row). Process only + one flag |
| 10 | إنشاء QR code لكل سيارة من خلاله تُدار أسطول السيارات | Small addition | `tms.vehicles.qr_token` (unique, opaque) rendered as a printable QR; scanning opens the vehicle's fleet screen (documents, odometer, fuel, maintenance, custody). No new table |
| 11 | بند الموارد البشرية يمكن تخصيصه — مسؤوليات المدير العام أو أي إداري — بواسطة أدمن النظام أو المدير العام | Configuration rule | The role × group matrix (D-15 §2-2) is **data**: SYSADMIN or GM may assign the "الموارد البشرية" group to any **role**. Consistent with D-138 (no per-user customisation): the assignment is per role, applied to everyone holding it. If the GM means *per person*, that is a D-138 exception — batched question §4 |

## 2. Requested shapes (DDL only after approval; every column classified; `entity_id` + RLS + `version` where mutable)

**2.1 `hr.shifts`** — `id · entity_id · code · name_ar · name_en · starts_at time · ends_at time · crosses_midnight bool · grace_minutes int · days_of_week int[] · site_id → sites · is_active · version`. Replaces the free-text `hr.teams.shift` (kept, marked legacy until migrated).

**2.2 `hr.shift_assignments`** — `id · entity_id · employee_id → hr.employees · shift_id · group_id → hr.shift_groups (nullable) · valid_from date · valid_to date · assigned_by · version`. One active assignment per employee per date (exclusion constraint on the date range).

**2.3 `hr.shift_groups`** — the GM's "transport group": `id · entity_id · shift_id → hr.shifts · code · name_ar · group_type ∈ {transport · warehouse · other} · lead_employee_id → hr.employees (the driver) · vehicle_id → tms.vehicles (nullable) · site_id → sites (the group's own attendance site) · starts_at / ends_at (override of the shift's times, nullable) · is_active · version`. Members are the `shift_assignments` rows carrying `group_id`.

**2.4 Sites — one table for both requests.** SCR-TMS-PICKUP-01 §3.3 (b) proposed `sales.account_sites`; SCR-HR-ATT-01 §2.4 (b) proposed `hr.work_sites`. This request **unifies them** as `platform.sites`: `id · entity_id · kind ∈ {warehouse · office · client_pickup · housing · other} · account_id → sales.accounts (required when kind = client_pickup) · warehouse_id → wms.warehouses (nullable) · name_ar · name_en · address fields · geo_lat · geo_lng · radius_m (default from `platform.thresholds` `att.geofence_radius_m = 500`, D-141 Q30b) · contact_phone · is_active · version`. `hr.employees.default_site_id` and `tms.delivery_tasks.pickup_site_id` both reference it. **Driver at a client site:** a punch whose `site_ref` is a `client_pickup` site within radius sets `ready_for_pickup_at` on a daily view (`hr.driver_site_presence`, derived — no column), which every operational board reads for the green badge.

**2.5 Device registry link** (extends SCR-HR-ATT-01 §2.2, one registry in `identity`): add `asset_id → admin.assets (nullable: personal phone)`, `ownership ∈ {company · personal}`, `enrolled_at` (biometric set up at handover, D-143 line 1), `handover_custody_id → admin.asset_custody (nullable)`. Rule: a **company** phone must have an open custody row before it can be registered; a **personal** phone is registered without custody.

**2.6 `hr.employee_requests`** — `id · entity_id · employee_id · request_type ∈ {leave · letter · salary_advance · document_copy · device_issue · other} · payload jsonb (typed per request_type in the contract) · status ∈ {submitted · under_review · approved · rejected · cancelled} · decided_by · decided_at · reason · version`. Approval via `platform.approval_chains`; each state change → outbox + audit. **Leave requests need `hr.leaves`** (Gap #7, leaves part) — proposed here as `hr.leaves`: `id · entity_id · employee_id · leave_type ∈ {annual · sick · unpaid · emergency · other} · from_date · to_date · days numeric · status · request_id → hr.employee_requests · version`. Attendance reads it so an approved leave day is never "absent".

**2.7 `admin.assets` additions** — `ownership ∈ {company · personal}` (default company) · asset_type gains `phone` and `sim_line` · `phone_number` (for `sim_line`) · `imei` (for `phone`). `admin.asset_custody` unchanged.

**2.8 `tms.vehicles.qr_token`** — `text unique not null default encode(gen_random_bytes(16),'hex')`; printable QR = URL `…/fleet/v/<token>`. Scanning from the driver app or PDA opens the vehicle screen; `tms.vehicle_scans` is **not** requested (the audit log already records the read).

**2.9 Events (new, module-owned, Master adds to `packages/events/catalog.ts`):** `hr.shift.assigned` · `hr.device.registered` · `hr.request.submitted` · `hr.request.decided` · `hr.leave.approved` · `hr.driver.ready_for_pickup`.

## 3. What this request does NOT include
- Payroll (`hr.payroll_runs`, `hr.payroll_lines`) — still Gap #7 (payroll part); a separate SCR.
- The attendance punch itself — SCR-HR-ATT-01 (approved).
- Any WBS row — proposed deltas: **5.3** (attendance API) gains shifts/sites; **APP-1** gains device handover + employee requests; **3.7** (driver app) gains the client-site punch and the QR scan; a new row for fleet QR under Phase 3 (Master issues the id). All post-pilot.

## 4. Decisions owed by the GM (batched; nothing blocks 2.9)
1. **PLT-50** — line 2: does "activate attendance as soon as the biometric is set up" also switch on **automatic absence/late detection** before the 95% × 30-day gate? (Default kept: capture immediate, automatic penalties gated.)
2. **Line 6** — "مضيئة": a bright static green badge (default) or an animated one (contradicts D-15 §3-ح)?
3. **Line 11** — HR group assignable per **role** (default, consistent with D-138) or per **person** (a D-138 exception)?
4. **Sites** — approve the single `platform.sites` table replacing both `sales.account_sites` (D-137) and `hr.work_sites` (D-131 carried)? This also closes **Q30a** (D-141) as "site table with radius".
5. Approve shapes §2.1–§2.9 as shapes (DDL after pg-reviewer's pre-migration review, post-pilot).

## 5. Resolution under D-144 (GM, 2026-09-24)

| §4 item | GM answer (verbatim) | Applied |
|---|---|---|
| 1 PLT-50 | "لا تعطيل: تفعيل مباشر للغياب والتأخير" | **PLT-50 is superseded.** Automatic absence and late detection is ON from the moment an employee has a registered device **and** an active shift assignment (§2.2) — lateness needs a shift to be late against. The 95% × 30-day gate (EXEC-v4 §1.3, doc 15 §6-7, D-126 last-but-one clause, ADR-0003) no longer applies; `platform.feature_flags` PLT-50 is seeded `enabled = true`. Doc 15 §6-7's warning ("hundreds of wrong penalties on incomplete data") stays in the record as the known risk the GM accepted; the HR review queue (SCR-HR-ATT-01 §2.3) and the approve/reject step on every proposed penalty remain the safeguard |
| 2 badge | "وامضة" | The "جاهز للاستلام" badge **blinks** (D-15 §3-ح exception, recorded). Implementation rule: CSS animation on the badge only, ≤ 1 Hz, and **no animation when `prefers-reduced-motion: reduce`** (accessibility; the badge stays bright green, static) |
| 3 HR group | "نعم لكل من يحمله" | Per **role**, confirmed — consistent with D-138 |
| 4 sites | "نعم جدول واحد" | One `platform.sites` table (§2.4) replaces `sales.account_sites` (D-137) and `hr.work_sites` (D-131 carried). Q30a (D-141) closed |
| 5 shapes + timing | "أدرجها داخل الـpilot" | Shapes §2.1–§2.9 approved **and pulled into the pilot scope**. Consequence: two to three additional slices in the lanes after 2.9 acceptance (shifts+groups+sites · device custody link+requests+leaves · fleet QR), each with its own migration number, pg-reviewer pre-migration review, RED tests first. Payroll stays out (§3). The Master issues the WBS rows and lane assignments when 2.9 is accepted; nothing is started in parallel with 2.9 |
| — | "لا تلمس ملفات الجلسة الأخرى إلا بعد الانتهاء" | Standing rule for this governance session: no edit to any path the 2.9 session holds (`database/schema/*`, `modules/*`, `packages/*`, `tasks/LANE_LOCKS.md`) until that session commits |
