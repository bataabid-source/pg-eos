# SCR-TMS-PORTAL-01 — delivery-client portal: self-dispatch to attached drivers, recipient book, live driver tracking (GM directive D-160)

**Status: FILED — shapes for GM approval; nothing in `database/schema/*` or `database/migrations/*` is touched.** Raised under **EXECUTION-MASTER-v4 §1.11 (G-01)** on criterion (iii): a GM requirement not modelled in doc 40 §C10 / doc 27 §6 (the 12 portal screens). Source: GM directive of 2026-09-24, verbatim in **D-160**. Timing: Phase 6 (6.1 Client Portal, lane 1) unless the GM pulls it forward; nothing in the pilot changes.

## 1. The directive, line by line

| # | GM line (verbatim) | Present today? | What is new |
|---|---|---|---|
| 1 | نافذة عميل التوصيل: تسمح له توزيع الطلبات على السائقين الملحقين والمخصصين لتقديم الخدمة له | **No.** Dispatch is DEL_MGR's (doc 03 §0-7 `assigned` by DEL_MGR, hard gate INV-C4-1). Dedicated packages exist as data: `tms.vehicles.assigned_client_id` (DL-04/05) and `hr.employees.assigned_client_id` | **Client-side dispatch**, limited to the drivers attached to that client |
| 2 | إدخال العملاء وبياناتهم | **No.** `tms.delivery_tasks` carries the recipient inline (name, phone, address); no reusable address book per client | **Recipient master data** owned by the client |
| 3 | الطلبات وتفاصيلها | **Yes** — screens "create outbound / my orders" (doc 40 §C10), Client API `POST /orders` | Unchanged; the order form gains a recipient picker (line 2) |
| 4 | يتابع منها حالة التوصيل وتتبع السائق | **Half.** "tracking + POD" screen exists for status. **Live driver location does not exist** anywhere in 01/13/13B, and §C10 says "client never sees … driver names" | **Live tracking** of the driver on the client's own tasks, and a **policy exception**: the client sees the name and position of *his attached* drivers |

## 2. Requested shapes (DDL only after approval; every column classified; `entity_id` + RLS + `version` where mutable)

**2.1 `tms.recipients`** — the client's customer book: `id · entity_id · client_id → sales.accounts · code · name · phone · alt_phone · area · governorate · block · street · building · address_text · geo_lat · geo_lng · notes · is_active · version`. Unique `(client_id, phone)`. RLS: `entity_scope` + `client_portal_scope` (`client_id = current_client_id()`). `tms.delivery_tasks.recipient_id → tms.recipients` (nullable; inline fields stay for API/import rows and are copied from the recipient at task creation so history never changes when the book changes).

**2.2 Attached drivers — one view, no new table.** `tms.client_drivers` (view): drivers whose `hr.employees.assigned_client_id = client` **or** whose current vehicle has `tms.vehicles.assigned_client_id = client`, with document validity (INV-C4-1) computed. This is the only driver set a portal user can dispatch to.

**2.3 Client-side dispatch** — no new column: `tms.delivery_tasks.status created → assigned` may be performed by a portal user with the new permission `tms.task.assign_own` **only when** the task's `client_id = current_client_id()` **and** the driver is in `tms.client_drivers` **and** INV-C4-1 passes (expired residency/licence/vehicle document → 422, same as internal). Event `tms.task.assigned` carries `assigned_by_kind = client`. DEL_MGR keeps override and reassignment. A task the client leaves unassigned goes to the normal plan.

**2.4 `tms.driver_positions`** — append-only: `id · entity_id · driver_id → hr.employees · task_id → tms.delivery_tasks (nullable) · recorded_at (device) · received_at (server) · geo_lat · geo_lng · accuracy_m · speed_kmh · device_ref`. Written by the driver app **only while the driver has an `out_for_delivery` task**; retention per `platform.thresholds` `tms.position_retention_days` (default proposed **30**, GM value). RLS: `entity_scope` + a restrictive client policy: a portal user sees a position row only if the row's `task_id` belongs to his client **or** the driver is in his `tms.client_drivers` set for that day. Classification `personal`.

**2.5 Portal screens delta (doc 40 §C10 12 → 15):** "my drivers" (attached drivers, document status, today's load) · "dispatch" (unassigned tasks × attached drivers, drag or pick, INV-C4-1 rejection with reason) · "recipients" (book). "Tracking + POD" gains the live map for the client's tasks. Roles: `CLIENT_CREATOR` gains `tms.task.assign_own`; `CLIENT_VIEWER` sees tracking only.

**2.6 Policy exception, recorded:** doc 40 §C10 "client never sees driver names" becomes "…driver names **except his attached drivers** (DL-04/05 or `assigned_client_id`)". Other clients' drivers, our costs, employees and partners stay hidden.

**2.7 Events:** `tms.task.assigned` (existing) with `assigned_by_kind`; new `tms.driver.position_recorded` is **not** published (high-volume telemetry; read by query, not by event).

## 3. Not included
Route optimisation for the client, chat with the driver, COD settlement view changes, iMile-model clients (doc 05 S4 — those drivers are dispatched by our plan engine, never by the client).

## 4. Defaults taken (recorded; the GM may change any in a later batch)
1. "الملحقين والمخصصين" = drivers with `hr.employees.assigned_client_id` or a vehicle with `tms.vehicles.assigned_client_id` (DL-04/05 packages). No other driver is dispatchable by a client.
2. INV-C4-1 (expired documents) is **not** bypassable from the portal.
3. Live position is recorded only during `out_for_delivery` and kept **30 days**; the client sees it only for his own tasks / attached drivers.
4. Position ping interval **60 s** while moving (driver app), configurable in `platform.thresholds`.
5. Phase 6 with 6.1; the API (6.2) gains `GET /drivers`, `POST /orders/{ref}/assign`, `GET /tasks/{ref}/position` in the same phase.

## 5. Addendum D-163 — account, package, sub-users, service request, complaints (GM, 2026-09-24)

| # | GM line (verbatim) | Present today? (doc 27 §6 / doc 40 §C10) | What is new |
|---|---|---|---|
| 5 | كشف حسابه وعدد طلباته | **Yes** — screen 10 "invoices & statement" (per entity + consolidated + ageing); screen 2 dashboard (open orders, today's shipments, balance); screen 7 "my orders" | Dashboard gains the **order counters** (today · month · by status) — a query on `tms.delivery_tasks` / `wms.outbound_orders`, no schema |
| 6 | إدارة باقته أو تعاقده | **Half** — the contract exists (`sales.contracts`, `contract_sla`, price annex) but **no portal screen shows it** | New screen **"my contract"**: package (DL-04/05 dedicated drivers/vehicles, contracted space, services, SLA, price annex, term, renewal date), read-only; changes go through "request a service" (line 8). No schema — `client_portal_scope` policy on `sales.contracts` and its annex (today `entity_scope` only) is the only addition |
| 7 | إدارة حسابات المستخدمين الفرعيين تحت إدارته | **Yes** — `CLIENT_ADMIN` "manages his users" (doc 27 §8, §9 step ③) | The user-management screen is implied but **not among the 12** → listed explicitly as screen **"my users"** (invite by mail + OTP, role among the four client roles, deactivate). No schema |
| 8 | طلب إضافة خدمة من خدمات بريميوم | **No** | New screen **"request a service"**: the client picks from the 92-service catalog (only categories his entity offers; prices not shown unless in his annex) or writes a free request → creates a **`sales.opportunities` row of source `client_portal`** for SALES_MGR/SALES_REP and a card on their board; the client sees its status (received · quoted · contracted · declined). Precedent: the "partner_or_decline" decision path (S9). No new table — `sales.opportunities.source` gains the value `client_portal` (check-list addition, G-01 with this SCR) |
| 9 | شكاوى واقتراحات: فتح تذكرة | **Yes** — screen 12 "complaints → PCC ticket automatically" (`cc.tickets`) | Extend with **type `suggestion`** beside `complaint` (`cc.tickets.ticket_type` value — check-list addition) and show the ticket's status + SLA state to the client |

**Screens after this addendum: 12 → 18** (D-160: my drivers · dispatch · recipients; D-163: my contract · my users · request a service). Roles: `CLIENT_ADMIN` alone manages users and contract requests; `CLIENT_FINANCE` sees statement only (unchanged).
**Defaults taken:** service requests are opportunities, not orders (Sales qualifies and quotes — no price is committed from the portal); the contract screen is read-only; suggestions are PCC tickets with the lowest priority class.
