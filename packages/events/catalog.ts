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
] as const;
export type CatalogedEventType = (typeof EVENT_CATALOG)[number];
