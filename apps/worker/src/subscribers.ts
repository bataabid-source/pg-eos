// apps/worker/src/subscribers.ts — X part 5b. The single registration point for production outbox
// subscribers. Doc 40 §B3:156: "Subscribers (registered in `packages/events`): billing, documents,
// notifications, audit, traceability" — each lands here, through @pg-eos/events' registry, with
// its own WBS row (the first, `billing`, with row 4.3). Empty today: the loop warns once and idles
// (relay.ts never publishes without a delivery).

import { registerSubscriber } from '@pg-eos/events';
import type { Subscriber } from '@pg-eos/events';

interface ProductionSubscriber {
  readonly name: string;
  readonly handler: Subscriber;
}

const PRODUCTION_SUBSCRIBERS: readonly ProductionSubscriber[] = [];

/** Registers every production subscriber; returns how many were registered. */
export function registerProductionSubscribers(): number {
  for (const subscriber of PRODUCTION_SUBSCRIBERS) {
    registerSubscriber(subscriber.name, subscriber.handler);
  }
  return PRODUCTION_SUBSCRIBERS.length;
}
