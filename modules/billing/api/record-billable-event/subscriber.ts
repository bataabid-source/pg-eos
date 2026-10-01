// modules/billing/api/record-billable-event/subscriber.ts — WBS 4.3 part 1 (lane 2).
//
// api/ layer for the record-billable-event use case: no HTTP route (brief Decision 1) — the entry
// point is the packages/events relay. `registerBillingSubscribers()` registers the ONE subscriber
// `billing.wms-outbound-checked` with the in-memory registry (packages/events/src/registry.ts);
// calling it again is a no-op. The relay invokes every subscriber for every relayed row, so the
// handler returns early for any other event type (the registry's dispatch filter, not a state
// transition). A throwing handler leaves the outbox row unpublished with `last_error` naming this
// subscriber (relay.ts) — errors are never swallowed here.

import { registerSubscriber, type CatalogedEventType, type OutboxEvent } from '@pg-eos/events';

import { recordOutboundChecked } from '../../application/record-billable-event/record-outbound-checked.js';
import type { RecordBillableEventDeps } from '../../application/record-billable-event/ports.js';
import { createRecordBillableEventDeps } from './composition.js';

export const WMS_OUTBOUND_CHECKED_SUBSCRIBER = 'billing.wms-outbound-checked';
const WMS_OUTBOUND_CHECKED_EVENT_TYPE: CatalogedEventType = 'wms.outbound.checked';

let registered = false;

/** Registers the billing subscribers once per process; a repeat call does nothing. */
export function registerBillingSubscribers(deps: RecordBillableEventDeps = createRecordBillableEventDeps()): void {
  if (registered) return;
  registerSubscriber(WMS_OUTBOUND_CHECKED_SUBSCRIBER, async (event: OutboxEvent): Promise<void> => {
    if (event.eventType !== WMS_OUTBOUND_CHECKED_EVENT_TYPE) return;
    await recordOutboundChecked(event, deps);
  });
  registered = true;
}
