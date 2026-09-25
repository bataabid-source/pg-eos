// packages/events/catalog.ts — the list CLAUDE.md's PARALLEL LANES section calls "frozen": a lane
// may consume another module's event only through a name listed here. First entry shipped by WBS 2.8
// (before the golden slice 2.9, as a mechanism slice). A future slice that publishes a new
// event type adds its name here in the SAME commit that ships the publisher, per the naming
// convention doc 40 §B3 states: <module>.<aggregate>.<past_tense> (e.g. wms.outbound.checked).
export const EVENT_CATALOG = [
  // WBS 2.8 — stock ledger posting (modules/wms/src/stock-ledger): one event per ledger row written,
  // aggregate `wms.stock_movements`, payload = the ledger entry as written. Added by the Master in the
  // same commit as the publisher (CLAUDE.md · PARALLEL LANES: packages/* is a Master-only path).
  'wms.stock.moved',
  // WBS 2.9 (golden slice), fix round 2 (finding 6a/6b, doc 40 §C3 line 262): written once per
  // inbound order, in the SAME transaction as the last ReceiveLine call that brings the order to
  // 'received' — NOT at CloseInbound (Close only closes). Aggregate `wms.inbound_orders`.
  'wms.inbound.received',
  // WBS 2.9 fix round 2 (finding 6d): written per ReceiveLine call whose qty_actual differs from
  // qty_ordered, same transaction as the line write. Aggregate `wms.order_lines`.
  'wms.inbound.variance',
  // WBS 3.3 (lane 2, MIGRATION-REQUEST-2 / Master issue 2026-09-24): written once per employee
  // registration, same transaction as the insert. Aggregate `hr.employees`.
  'hr.employee.registered',
  // WBS 3.3: written once per employee document recorded (residency, licence, …), same
  // transaction as the insert; the INV-C4-1 hard gate reads document validity. Aggregate
  // `hr.employee_documents`.
  'hr.employee_document.recorded',
  // WBS 5.13 part 1 (alert evaluation mechanism, modules/platform/application/evaluate-alerts):
  // written once per fired alert, in the SAME transaction as the platform.alert_log insert
  // (doc 40 §B6 / doc 25 §1). aggregate_type `platform.alert_rules`, aggregate_id = the rule's
  // uuid (platform.outbox.aggregate_id is `uuid not null`; platform.alert_log.id is bigserial, so
  // the log row's id travels in the payload, not in aggregate_id — Master default, CHANGELOG 5.13).
  // payload = alertLogId, ruleCode, entityRef, recipients, firedAt. Added by the Master in the
  // same commit as the publisher
  // (CLAUDE.md · PARALLEL LANES: packages/* is a Master-only path).
  'platform.alert.fired',
  // WBS 5.5a part 1 (lane 2, MIGRATION-REQUEST-2 / Master issue 2026-09-24): written once per
  // CreateSite call, same transaction as the insert. Aggregate `platform.sites`.
  'platform.site.created',
  // WBS 5.5a part 1: written once per UpdateSite call that changes a column, same transaction as
  // the update (doc 38 row 5.5a acceptance: "every state change → outbox + audit in one
  // transaction"). Aggregate `platform.sites`.
  'platform.site.updated',
  // WBS 5.5a part 2 (lane 2, MIGRATION-REQUEST-2 / Master issue 2026-09-25, migration 0016):
  // written once per CreateShift. Aggregate `hr.shifts`.
  'hr.shift.created',
  // WBS 5.5a part 2: written once per CreateShiftGroup. Aggregate `hr.shift_groups`.
  'hr.shift_group.created',
  // WBS 5.5a part 2: written once per AssignShift (name proposed by SCR-HR-SHIFT-01 §2.9).
  // Aggregate `hr.shift_assignments`.
  'hr.shift.assigned',
  // WBS 5.5a part 2: written once per EndShiftAssignment. Aggregate `hr.shift_assignments`.
  'hr.shift_assignment.ended',
  // WBS 2.14 (lane 2, Master issue 2026-09-25): written once per TakeOccupancySnapshot call, same
  // transaction as the snapshot insert. Aggregate `wms.occupancy_snapshots`. Named verbatim as
  // doc 40 line 262 states it ("wms.occupancy.snapshot → ST-* daily") — present tense, not the
  // usual past-tense convention, because the doc names it this way explicitly.
  'wms.occupancy.snapshot',
  // WBS 2.9b (SCR-WMS-INB-01 §7, D-168/D-169): written once per ScheduleInbound, and again by
  // ApproveInbound when it is given an `expectedAt`, same transaction as the order update.
  // Aggregate `wms.inbound_orders`. Added by the Master on lane 2's request (packages/* is frozen).
  'wms.inbound.scheduled',
  // WBS 2.9b (SCR-WMS-INB-01 §7): written once per ApproveInbound (draft → approved), same
  // transaction as the status change. Aggregate `wms.inbound_orders`.
  'wms.inbound.approved',
  // WBS 2.9b (SCR-WMS-INB-01 §7): written once per CancelInbound; carries the now-mandatory
  // `cancelReason` to the client. Aggregate `wms.inbound_orders`.
  'wms.inbound.cancelled',
] as const;
export type CatalogedEventType = (typeof EVENT_CATALOG)[number];
