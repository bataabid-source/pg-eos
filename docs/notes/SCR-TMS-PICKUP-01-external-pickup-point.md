# SCR-TMS-PICKUP-01 — pickup leg for the delivery-only client (external point of sale)

**Status: APPROVED — GM directive D-137 (2026-09-24), "بناء عليه تم اعتماد القرارات الخمس". Resolution in §7.** Originally filed under **EXECUTION-MASTER-v4 §1.11 (G-01)** on two criteria:
- **(i) a real schema gap** — already on record as **Gap-Register #61** ("pickup from the client's warehouse has no status and no constrained `task_type`; the delivery-only scenario S3 starts in an undefined state" → "↷ SCR on 13B", D-10 §6-2).
- **(iii) a doc 40 requirement that is not modelled** — doc 05 scenario 3 (SEG-B, client `SHOP`, "his goods are in his own warehouse") and doc 40 Part E `S3 B2C delivery with SLA` describe a client whose shipments never enter PST, yet the task state machine (doc 03 §0-7 · D-04 §5.1) begins at `created → assigned → out_for_delivery` as if the parcels were already in our custody.

Date: 2026-09-24. Raised by the Master on the GM's question and directive of 2026-09-24 ("سجل الطلب"). Nothing in `database/schema/*` or `database/migrations/*` is touched by this request. After GM approval the Master issues a migration number and pg-reviewer runs the pre-migration review before any DDL is written (CLAUDE.md · SLICE SEQUENCE). Under **D-127 (pilot-first)** this request is **DEFERRED-POST-PILOT** unless the GM rules otherwise: the pilot's three synthetic clients (D-134) run on seed 019 and the golden slice 2.9 is a warehouse inbound, not a delivery leg.

## 1. The business case (GM, 2026-09-24)

A client who sells from **his own external point of sale**, entirely outside our warehouses and fulfilment, and hands finished orders to **our drivers** for delivery. The package already names this client type — doc 05 "توصيل استهلاكي B2C · توصيل فقط · حجم عالٍ · COD", entity POR/PDL, services DL-01 · DL-07 · DL-10 · DL-11 · DL-12 · DL-14 · CC-08 — and gives it three intake paths (doc 05 S3 ①: API · file · client window → `tms.delivery_tasks`; doc 38 6.1 Client Portal, 6.2 Client API v1 / I-09). What it does **not** model is the first physical step: the driver **collecting** the parcels at the client's premises.

## 2. Why this is a gap and not an invention

| Needed for the delivery-only client | Present in 01 / 13 / 13B / 019 / 40? |
|---|---|
| a pickup step before `out_for_delivery` | **no**. `tms.delivery_tasks.status` is closed at eight values (`created · assigned · out_for_delivery · delivered · failed · deferred · returned · cancelled`, 13B `chk_delivery_tasks_status`, D-04 §5.1). `out_for_delivery` is set "automatically at the first scan" of the **loading** scan at our station (D-04 §4 step 5) |
| a task type that says "collect from the client, then deliver" | **no**. `task_type` comment lists `b2c · b2b · dedicated_trip · inter_warehouse` (01 line 868) and has **no check constraint** in 13B — any text is accepted (same defect class as D-11 §2-3 row 22 for `source_type`) |
| the pickup address (the client's shop), distinct from the recipient address | **no**. `delivery_tasks` carries one address block (`address_text, area, governorate, block, street, building, geo_lat/lng`) — the recipient's. `sales.accounts` has no "pickup site" structure |
| proof of collection (who handed over, how many parcels, when, where) | **no**. `tms.proof_of_delivery` is one row per delivered task (`delivered_at`, receiver, signature/photo, geo) — nothing for the collection end |
| a billable service for the collection leg | **no code in the catalog.** DL-01…DL-18 are delivery-side; the catalog is closed at **92 services** by GM + CFO (doc 04 decision 1). DL-03 "رحلة مخصصة" and DL-16 "نقل بين المستودعات" are the nearest, neither is a pickup |
| an event for the collection | **no**. `tms.task.*` events (doc 03 §0-7) have no `collected` / `picked_up` |

Adjacent gaps already recorded, **not** covered here (listed so the GM decides once): Gap #59 (file-import path has no WBS task), Gap #60 (no store-platform connectors — D-11 option ج / I-12), D-11 §2-3 row 23 (`(source_type, source_ref)` index is `btree`, not `unique` — the written duplicate guard is not enforced), row 22 (`source_type` has no check list).

## 3. Requested additions (shapes for GM approval; DDL only after approval)

Types follow existing precedent (`timestamptz`, coordinates `numeric(10,7)` as in `tms.proof_of_delivery`). Every column is added to `identity.column_classification`; every new table carries `entity_id`, RLS and `version` where mutable.

**3.1 `tms.delivery_tasks.task_type`** — add the value **`pickup_delivery`** and, at the same time, the missing **check constraint** over the closed list `b2c · b2b · dedicated_trip · inter_warehouse · pickup_delivery` (closing the "any text accepted" defect on this column).

**3.2 `tms.delivery_tasks.status`** — add one state **`collected`** ("in the driver's custody, collected at the client's premises"). Transitions, XState only (no if/switch):
- `assigned → collected` — `DRIVER`, at the **collection scan** at the client's premises, with proof (3.4). Only for `task_type = 'pickup_delivery'`.
- `collected → out_for_delivery` — `DRIVER`, automatic on departure / first delivery-run scan (same rule as today's loading scan).
- `collected → cancelled` — `DEL_MGR` (already "any state before `delivered`").
- Every other transition unchanged. For the four existing task types `collected` is **unreachable** (guard on `task_type`).
- Event: **`tms.task.collected`** — a new event of module `tms`, added to `packages/events/catalog.ts` as a Master task (frozen path).

**3.3 Pickup site** — two options for the GM (no recommendation carried into the DDL until chosen):
- **(a)** columns on `tms.delivery_tasks`: `pickup_address_text, pickup_area, pickup_block, pickup_street, pickup_building, pickup_geo_lat, pickup_geo_lng, pickup_contact_phone`, plus `collected_at timestamptz`. Simplest; repeats the address on every task.
- **(b)** a table **`sales.account_sites`** (`id, entity_id, account_id → sales.accounts, kind = 'pickup', name, address fields, geo_lat/lng, contact_phone, is_active, version`) and `tms.delivery_tasks.pickup_site_id → sales.account_sites`. Normalised; a client with two shops has two sites; the geofence for the collection scan lives on the site. **This is the shape the agent would recommend** because doc 05 S3 sizes this client at 1,800 shipments / month — repeating the address 1,800 times is the wrong shape, and ADR-0003 (D-131) already needs a site + geofence concept.

**3.4 Proof of collection** — `tms.proof_of_collection` (`id, entity_id, task_id → tms.delivery_tasks, collected_at` server time, `handed_by_name, parcel_count, signature_url` **or** `photo_url`, `geo_lat/lng, device_id`, and the three retention columns of `proof_of_delivery` — `sha256, legal_hold, retain_until`). Mirrors `tms.proof_of_delivery` exactly; INV-C4-3's rule ("GPS + (signature or photo) + name; timestamp from server") applied to the collection end.

**3.5 Service code** — the catalog is closed at 92 by GM + CFO. Two options:
- **(a)** no new code: the collection leg is priced inside DL-01 / DL-02 per contract (the client pays per delivered shipment; collection is included). **Zero catalog change.**
- **(b)** a new **`DL-19` "استلام من موقع العميل (Pickup)"**, unit "زيارة استلام", per event, triggered by `tms.task.collected` — needs the GM + CFO recorded decision doc 04 requires, `min_price` and `standard_cost` (M03 gate), and the 92 → 93 count updated in doc 04, 13B seed and the G-SEED guard.

**3.6 Unique guard on source** — while the migration is open, turn `delivery_tasks_source_type_source_ref_idx` into a **unique** index (D-11 row 23). Not strictly part of the pickup gap, but it is the same table, the same client, and the written guarantee ("prevents double entry") is currently not enforced.

## 4. What this request does NOT ask for

- No driver-app screen or WBS row is written here: the pickup screen belongs to doc 35 / WBS 3.7 as a delta once approved, the same way ADR-0003 attached to 5.3.
- No store-platform connector (Gap #60 — separate GM decision, D-11 option ج).
- No change to POD, COD, `attempt_no`, failure reasons, or the SLA in S3.

## 5. Decisions owed by the GM

| # | Decision | Options |
|---|---|---|
| 1 | Approve the gap as a schema change (3.1, 3.2, 3.4) | approve · reject · post-pilot (default under D-127) |
| 2 | Pickup site shape | 3.3 (a) columns · **(b) `sales.account_sites`** |
| 3 | Service code | 3.5 (a) inside DL-01/02 · (b) new DL-19 (needs CFO) |
| 4 | Fold the unique source index in (3.6) | yes · no |
| 5 | Timing | with 3.4 (Phase 3, lane 1) · earlier as a Master migration |

## 6. Cross-references

Gap-Register #61 (D-10 §6-2) · doc 05 scenario 3 · doc 40 §C4 (INV-C4-2/3/4) and Part E S3 · doc 03 §0-7 · D-04 §5.1 · D-11 §2-3 rows 21–24 · doc 04 DL-01…DL-18 and decision 1 (92 closed) · 01 lines 860–890 · 13B `chk_delivery_tasks_status` · precedent SCR-HR-ATT-01 (D-131).

## 7. Resolution under D-137 (GM, 2026-09-24)

The five decisions of §5 are approved "as written" (precedent D-131: an item with a recommendation resolves to it; an item without one is carried, nothing invented).

| # | Decision | Resolved |
|---|---|---|
| 1 | Gap as a schema change | **approved** — 3.1 (`pickup_delivery` + `task_type` check), 3.2 (`collected` state + `tms.task.collected`), 3.4 (`tms.proof_of_collection`) |
| 2 | Pickup site shape | **3.3 (b) `sales.account_sites`** + `tms.delivery_tasks.pickup_site_id` (the recommendation) |
| 3 | Service code | **Resolved D-141 (Q8 = a): inside DL-01 / DL-02, catalog stays 92.** Earlier text: no recommendation existed — carried to the CFO. Standing default until then: **3.5 (a)**, the collection leg is priced inside DL-01 / DL-02 per contract; the catalog stays at 92. (b) `DL-19` is opened only by a recorded GM + CFO decision with `min_price` and `standard_cost` (doc 04 decision 1, M03 gate) |
| 4 | Unique `(source_type, source_ref)` | **yes** — folded into the same migration (D-11 §2-3 row 23) |
| 5 | Timing | **post-pilot, with WBS 3.7 (Phase 3, lane 1)** — D-127 default. The migration number is issued by the Master **after the 0.6a commit lands** (0007 is taken by 0.6a; this becomes the next free number at that time), pg-reviewer pre-migration review first. `packages/events/catalog.ts` (`tms.task.collected`) and `database/schema/*` are frozen paths → single-lane Master task merged before lane 1 resumes |

Consequences, applied when Phase 3 opens (not now): the 3.7 brief (`.claude/briefs/tms.brief.md`) carries the `collected` state, the pickup screen delta to doc 35, and the S3 acceptance scenario gains a collection step; `identity.column_classification` rows for every new column; RLS on `sales.account_sites` and `tms.proof_of_collection` mirrors `sales.accounts` / `tms.proof_of_delivery`. Nothing in the pilot changes.
