# SCR-WMS-OUT-04 — LoadOrder's cross-order/manifest rules have no schema support (G-01 schema-change request)

**Status:** filed 2026-09-26 by lane 1 (WBS 2.12 part 4, `LoadOrder`). Not built this slice — scope
narrowed to a single-order command; the two rules below are deferred, no migration attached.

## 1 · The gap

D-blueprint 03 §4.2 row 8 (Load) states two rules for the `loaded` transition:
1. "رفض الإقفال إن نقص شيء" (reject the close if something is missing).
2. "شحنة لعميل آخر ⇒ رفض فوري" (a shipment belonging to another client ⇒ immediate rejection).

Rule 2 only makes sense across MULTIPLE orders being loaded together onto one vehicle/trip (checking
that every order scanned onto that trip belongs to the same client, or is otherwise compatible) —
`01`/`13`/`13B`/`019` have no trip/manifest/load-batch table linking multiple `wms.outbound_orders`
rows together, and no column on `outbound_orders` records which vehicle/trip a load belongs to.
`tms.delivery_tasks` (referenced by `outbound_orders.delivery_task_id`) is created only at the LATER
`dispatched` transition (row 9), not at `loaded` (row 8) — so no cross-order structure exists yet at
the point this rule would fire.

## 2 · Why rule 1 needs no new code this slice

By the time an order reaches `packed` (the only legal predecessor of `loaded`), every `order_lines`
row already carries a terminal `qty_actual` — the machine cannot reach `picked` (a precondition of
`checked` → `packed`) until `countOpenPickLines` returns zero (WBS 2.12 part 1). "Something missing"
in the sense of an unpicked line cannot occur at `packed`; the schema/machine already guarantees line
completeness structurally, with no separate check needed in `LoadOrder` itself.

## 3 · This slice's mitigation (scope narrowing, same pattern as SCR-WMS-OUT-01)

`LoadOrder` is defined as a single-order command: `packed` → `loaded`, version-locked, one outbox
event (`wms.outbound.loaded`) + audit row — no cross-order/manifest check, since no schema structure
exists to check against. Rule 2 (cross-client shipment rejection) is out of scope until a trip/manifest
concept is designed.

## 4 · Proposed schema change (future, not this slice)

A `wms.load_trips` (or similar) table — `id`, `entity_id`, `vehicle_id`/`driver_id`, `client_id` (or
null for mixed-client trips if ever allowed), `created_at` — plus a `wms.load_trip_orders` join table
(`trip_id`, `outbound_order_id`) would let a future `LoadOrder`/`AddOrderToTrip` command enforce rule
2 by checking every order already on the same trip shares the client (or the trip's own declared
client). Needs RLS policy, `identity.column_classification` rows, and the same mandatory pre-migration
pg-reviewer review as every schema change. Not filed as a migration here — this SCR only records the
gap; a future WBS task (dispatch/TMS-adjacent, likely doc-38 row 2.12's own successor or a TMS slice)
files the actual migration when scheduled.

## 5 · Disposition

Recorded, not built. `LoadOrder`'s single-order scope (§3) is the accepted mitigation for 2.12 part 4.
Re-open this SCR if a future WBS task needs genuine multi-order/trip-level load enforcement.
