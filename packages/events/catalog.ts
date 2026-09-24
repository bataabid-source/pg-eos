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
] as const;
export type CatalogedEventType = (typeof EVENT_CATALOG)[number];
