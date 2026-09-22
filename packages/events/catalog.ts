// packages/events/catalog.ts — the list CLAUDE.md's PARALLEL LANES section calls "frozen": a lane
// may consume another module's event only through a name listed here. Starts empty — no module has
// shipped a real domain event yet (golden slice 2.9 not built). A future slice that publishes a new
// event type adds its name here in the SAME commit that ships the publisher, per the naming
// convention doc 40 §B3 states: <module>.<aggregate>.<past_tense> (e.g. wms.outbound.checked).
export const EVENT_CATALOG = [] as const;
export type CatalogedEventType = (typeof EVENT_CATALOG)[number];
