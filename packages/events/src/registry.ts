// packages/events/src/registry.ts — WBS 0.12.
//
// A module-level (in-memory) subscriber registry. relay.ts (packages/events/src/relay.ts) reads
// the currently-registered subscribers to invoke, sequentially, for each unpublished
// platform.outbox row it relays. Doc 40 §B3: "subscribers are idempotent by (event_id)" — that
// property belongs to each registered handler, not to this registry (see relay.ts and
// tests/subscriber-idempotency.test.ts).
//
// `OutboxEvent` is the camelCase shape relay.ts maps each platform.outbox row into before handing
// it to a subscriber — `payload` is the already-parsed JS value (node-postgres/drizzle parse a
// jsonb column back into a JS value automatically via the driver's type parser), never a JSON
// string a subscriber would need to re-parse.

export interface OutboxEvent {
  readonly id: number;
  readonly entityId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly createdAt: Date;
  readonly actorId: string | null;
}

export type Subscriber = (event: OutboxEvent) => Promise<void>;

export interface RegisteredSubscriber {
  readonly name: string;
  readonly handler: Subscriber;
}

let subscribers: RegisteredSubscriber[] = [];

/** Registers a subscriber under `name`. relay.ts invokes every registered handler, in
 * registration order, sequentially, for each row it relays. */
export function registerSubscriber(name: string, handler: Subscriber): void {
  subscribers = [...subscribers, { name, handler }];
}

/** Test-only reset: empties the registry. A real, exported function (not test-conditional code)
 * so suites that register their own subscribers can isolate themselves from every other suite. */
export function clearSubscribers(): void {
  subscribers = [];
}

/** Accessor relay.ts uses to read the currently-registered subscribers (name + handler), in
 * registration order — so `last_error` can name which subscriber threw, not just record the
 * message. */
export function listSubscribersWithNames(): readonly RegisteredSubscriber[] {
  return subscribers;
}
