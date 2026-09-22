// packages/events/index.ts — WBS 0.12.
//
// Barrel: the package's public surface. The three test suites (outbox-write, relay,
// subscriber-idempotency) import directly from './src/*.js', not from this barrel — that's fine
// per the WBS 0.12 brief; this barrel exists for future consumers of @pg-eos/events.
//
// `clearSubscribers` is deliberately NOT re-exported here (review round 2, finding 10) — same
// precedent as WBS 0.11 round 2's `pool` finding: a dangerous test-only reset has no place in the
// public surface. Test files import it directly from './src/registry.js'.

export type { OutboxEventInput } from './src/outbox.js';
export { writeOutboxEvent } from './src/outbox.js';

export type { OutboxEvent, Subscriber } from './src/registry.js';
export { registerSubscriber } from './src/registry.js';

export type { RelayResult } from './src/relay.js';
export { relayOnce } from './src/relay.js';

export type { CatalogedEventType } from './catalog.js';
export { EVENT_CATALOG } from './catalog.js';
