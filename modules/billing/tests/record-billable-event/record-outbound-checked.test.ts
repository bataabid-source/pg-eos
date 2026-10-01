// modules/billing/tests/record-billable-event/record-outbound-checked.test.ts — WBS 4.3 part 1 (lane 2).
//
// INTEGRATION on the lane DB: a real wms.outbound_orders row + a real platform.outbox row ->
// registerBillingSubscribers() -> relayOnce(pool, { eventType }) -> billing.billable_events.
// One `describe` per Scenario in ./outbound-checked.feature (titles match EXACTLY).
// The money invariant over N deliveries lives ONLY in billable-idempotency.property.test.ts
// (D-208: no behaviour tested twice across layers); the redelivery scenario here covers the
// relay's published/at-least-once contract.
//
// SURFACE EXPECTED: modules/billing/api/record-billable-event/subscriber.ts exports
// `registerBillingSubscribers(): void` (idempotent; registers 'billing.wms-outbound-checked').

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CHECKED_EVENT_TYPE,
  EXPECTED_ROWS_PER_ORDER,
  EXPECTED_SERVICE_CODES,
  QTY_ONE,
  STATUS_CHECKED,
  STATUS_PENDING,
  SUBSCRIBER_NAME,
  assertNoForeignUnpublished,
  assertServicesSeeded,
  billableCount,
  billableRowsByCode,
  catalogServices,
  cleanupFixtures,
  createCheckedOrder,
  entityIdByCode,
  insertOutboxRow,
  otherEntityId,
  outboxState,
  MAIN_ENTITY_CODE,
  pool,
  resetOutboxRow,
  s1BillableQuery,
  type CatalogService,
} from './outbound-checked.fixtures.js';

// D-212 / migration 0048: the system actor is usable only when session_user = pgeos_worker, and
// @pg-eos/db's shared pool logs in as PG_APP_USER. Stub it BEFORE the pool is created: the
// subscriber and @pg-eos/events are loaded through dynamic import in beforeAll (vitest isolates
// modules per file). The "refused under pgeos_app" path is owned by
// tests/isolation/tests/system-actor-rls.test.ts (D-208).
const WORKER_ROLE = 'pgeos_worker';

type RelayOnce = typeof import('@pg-eos/events').relayOnce;
let relayOnce: RelayOnce;

// An event type only this suite writes; relayOnce does not validate types against the catalog.
const OTHER_EVENT_TYPE = 'billing.test.obchk-other-type';
const EXPECTED_ONE_ROW = 1;
const EXPECTED_NONE = 0;
const RELAY_LIMIT = 1000; // well above any backlog on the shared lane DB.

let mainEntityId: string;
let services: readonly CatalogService[];

beforeAll(async () => {
  vi.stubEnv('PG_APP_USER', WORKER_ROLE);
  ({ relayOnce } = await import('@pg-eos/events'));
  const { registerBillingSubscribers } = await import('../../api/record-billable-event/subscriber.js');
  await assertServicesSeeded();
  await assertNoForeignUnpublished(CHECKED_EVENT_TYPE);
  await assertNoForeignUnpublished(OTHER_EVENT_TYPE);
  registerBillingSubscribers();
  mainEntityId = await entityIdByCode(MAIN_ENTITY_CODE);
  services = await catalogServices();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await cleanupFixtures();
});

function relayChecked(): Promise<{ processed: number; published: number; failed: number }> {
  return relayOnce(pool, { eventType: CHECKED_EVENT_TYPE, limit: RELAY_LIMIT });
}

describe('Scenario: A wms.outbound.checked outbox row relayed once yields exactly one pending billing.billable_events row for each of OF-01, OF-02, OF-06, OF-07 on wms.outbound_orders/<order>, qty 1, uom of the catalog row, client and contract of the order, in one transaction', () => {
  it('writes one pending row per code (S1 query shape), qty 1.000, catalog uom, the order\'s client and contract, and publishes the outbox row', async () => {
    const order = await createCheckedOrder(mainEntityId);
    const outbox = await insertOutboxRow(CHECKED_EVENT_TYPE, order.orderId, order.entityId, {
      orderId: order.orderId,
      status: STATUS_CHECKED,
    });

    await relayChecked();

    const s1 = await s1BillableQuery(order.orderId);
    for (const service of services) {
      expect(Number(s1.get(service.code)?.cnt), service.code).toBe(EXPECTED_ONE_ROW);
      expect(s1.get(service.code)?.status, service.code).toBe(STATUS_PENDING);
    }
    const byCode = await billableRowsByCode(order.orderId);
    const state = await outboxState(outbox.outboxId);
    const xmins = new Set<string>();
    for (const service of services) {
      const rows = byCode.get(service.code) ?? [];
      expect(rows, service.code).toHaveLength(EXPECTED_ONE_ROW);
      const row = rows[0];
      expect(row?.status, service.code).toBe(STATUS_PENDING);
      expect(row?.qty, service.code).toBe(QTY_ONE);
      expect(row?.uom, service.code).toBe(service.uom);
      expect(row?.client_id, service.code).toBe(order.clientId);
      expect(row?.contract_id, service.code).toBe(order.contractId);
      expect(row?.entity_id, service.code).toBe(order.entityId);
      expect(row?.occurred_at.getTime(), service.code).toBe(state.createdAt.getTime());
      if (row) xmins.add(row.xmin);
    }
    expect(xmins.size, 'one transaction: a single distinct xmin across the four rows').toBe(EXPECTED_ONE_ROW);
    expect(await billableCount(order.orderId)).toBe(EXPECTED_ROWS_PER_ORDER);
    expect(state.published).toBe(true);
    expect(state.lastError).toBeNull();
  });
});

describe('Scenario: Redelivery of the same outbox row (at-least-once relay) leaves exactly one row per service and the row published', () => {
  it('relaying the same outbox row again (published_at reset) writes nothing more and publishes it again', async () => {
    const order = await createCheckedOrder(mainEntityId);
    const outbox = await insertOutboxRow(CHECKED_EVENT_TYPE, order.orderId, order.entityId, {
      orderId: order.orderId,
      status: STATUS_CHECKED,
    });
    await relayChecked();
    expect(await billableCount(order.orderId)).toBe(EXPECTED_ROWS_PER_ORDER);

    await resetOutboxRow(outbox.outboxId);
    await relayChecked();

    const state = await outboxState(outbox.outboxId);
    expect(state.published).toBe(true);
    expect(state.lastError).toBeNull();
  });
});

describe('Scenario: An outbox row of any other event type produces no billable event', () => {
  it('relays a billing.test.obchk-other-type row for a checked order with zero billable rows and the row published', async () => {
    const order = await createCheckedOrder(mainEntityId);
    const outbox = await insertOutboxRow(OTHER_EVENT_TYPE, order.orderId, order.entityId, {
      orderId: order.orderId,
      status: STATUS_CHECKED,
    });

    await relayOnce(pool, { eventType: OTHER_EVENT_TYPE, limit: RELAY_LIMIT });

    expect(await billableCount(order.orderId)).toBe(EXPECTED_NONE);
    expect((await outboxState(outbox.outboxId)).published).toBe(true);
  });
});

describe('Scenario: A checked order of another entity is written under that entity (RLS: entity_id follows the source row)', () => {
  it('every billable row carries the order\'s entity_id, not the main entity', async () => {
    const otherId = await otherEntityId(mainEntityId);
    const order = await createCheckedOrder(otherId);
    const outbox = await insertOutboxRow(CHECKED_EVENT_TYPE, order.orderId, order.entityId, {
      orderId: order.orderId,
      status: STATUS_CHECKED,
    });

    await relayChecked();

    const byCode = await billableRowsByCode(order.orderId);
    for (const code of EXPECTED_SERVICE_CODES) {
      const rows = byCode.get(code) ?? [];
      expect(rows, code).toHaveLength(EXPECTED_ONE_ROW);
      expect(rows[0]?.entity_id, code).toBe(otherId);
    }
    expect((await outboxState(outbox.outboxId)).published).toBe(true);
  });
});

// Last on purpose (): the unpublished malformed row stays in platform.outbox (retried by any later
// relay) until afterAll removes it.
describe('Scenario: A wms.outbound.checked row whose payload has no orderId is left unpublished with last_error naming the subscriber', () => {
  it('leaves the row unpublished, records last_error starting with the subscriber name, writes no billable row', async () => {
    const order = await createCheckedOrder(mainEntityId);
    const outbox = await insertOutboxRow(CHECKED_EVENT_TYPE, order.orderId, order.entityId, {
      status: STATUS_CHECKED,
    });

    await relayChecked();

    const state = await outboxState(outbox.outboxId);
    expect(state.published).toBe(false);
    expect(state.lastError).not.toBeNull();
    expect(state.lastError).toContain(SUBSCRIBER_NAME);
    expect(await billableCount(order.orderId)).toBe(EXPECTED_NONE);
  });
});
