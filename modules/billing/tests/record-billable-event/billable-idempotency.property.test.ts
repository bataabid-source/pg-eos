// modules/billing/tests/record-billable-event/billable-idempotency.property.test.ts — WBS 4.3 part 1.
//
// Money invariant (fast-check): for ANY sequence of N >= 1 deliveries of the same
// wms.outbound.checked event, billing.billable_events holds exactly one row per
// (source_table, source_id, service_id) — i.e. one per OF-xx code — and every qty is 1.000
// (01-Data-Model.sql:1079 unique index; doc 40 §B3 "subscribers are idempotent").
// Tested once, here; the integration file does not repeat it (D-208). numRuns is small: each run
// hits the lane DB.

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CHECKED_EVENT_TYPE,
  EXPECTED_ROWS_PER_ORDER,
  EXPECTED_SERVICE_CODES,
  QTY_ONE,
  STATUS_CHECKED,
  assertNoForeignUnpublished,
  assertServicesSeeded,
  billableCount,
  billableRowsByCode,
  cleanupFixtures,
  createCheckedOrder,
  entityIdByCode,
  insertOutboxRow,
  pool,
  resetOutboxRow,
} from './outbound-checked.fixtures.js';

// D-212 / migration 0048: the system actor is usable only when session_user = pgeos_worker, and
// @pg-eos/db's shared pool logs in as PG_APP_USER. Stub it BEFORE the pool is created: the
// subscriber and @pg-eos/events are loaded through dynamic import in beforeAll (vitest isolates
// modules per file). The "refused under pgeos_app" path is owned by
// tests/isolation/tests/system-actor-rls.test.ts (D-208).
const WORKER_ROLE = 'pgeos_worker';

type RelayOnce = typeof import('@pg-eos/events').relayOnce;
let relayOnce: RelayOnce;

const NUM_RUNS = 5;
const MIN_DELIVERIES = 1;
const MAX_DELIVERIES = 4;
const RELAY_LIMIT = 1000;
const EXPECTED_ONE_ROW = 1;

let mainEntityId: string;

beforeAll(async () => {
  vi.stubEnv('PG_APP_USER', WORKER_ROLE);
  ({ relayOnce } = await import('@pg-eos/events'));
  const { registerBillingSubscribers } = await import('../../api/record-billable-event/subscriber.js');
  await assertServicesSeeded();
  await assertNoForeignUnpublished(CHECKED_EVENT_TYPE);
  registerBillingSubscribers();
  mainEntityId = await entityIdByCode('PST');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await cleanupFixtures();
});

describe('Property: billable events are exactly-once per (source, service) under any number of deliveries', () => {
  it('N >= 1 deliveries of the same outbox event leave exactly one row per OF-xx code, each qty 1.000', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: MIN_DELIVERIES, max: MAX_DELIVERIES }), async (deliveries) => {
        const order = await createCheckedOrder(mainEntityId);
        const outbox = await insertOutboxRow(CHECKED_EVENT_TYPE, order.orderId, order.entityId, {
          orderId: order.orderId,
          status: STATUS_CHECKED,
        });

        for (let i = 0; i < deliveries; i += 1) {
          if (i > 0) await resetOutboxRow(outbox.outboxId);
          await relayOnce(pool, { eventType: CHECKED_EVENT_TYPE, limit: RELAY_LIMIT });
        }

        const byCode = await billableRowsByCode(order.orderId);
        for (const code of EXPECTED_SERVICE_CODES) {
          const rows = byCode.get(code) ?? [];
          expect(rows).toHaveLength(EXPECTED_ONE_ROW);
          expect(rows[0]?.qty).toBe(QTY_ONE);
        }
        expect(await billableCount(order.orderId)).toBe(EXPECTED_ROWS_PER_ORDER);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
