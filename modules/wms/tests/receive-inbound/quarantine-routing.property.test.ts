// modules/wms/tests/receive-inbound/quarantine-routing.property.test.ts — WBS 2.9 part 3 step 2
// (pg-tester, RED-first). ONE stock invariant (D-208): a short-shelf-life receipt is posted to the
// location pickQrtLocation returned (never pickRcvLocation's), every other receipt to RCV's, and
// exactly one quarantine decision is written per short receipt and none otherwise.
//
// Application-level with fake ports (no stock row is written; the DB is used only for the
// withContext transaction shell). Expected new port surface on InboundOrderRepository (RED until built):
//   getSkuShelfLifeRule(tx, skuId): Promise<{ trackExpiry: boolean; minRemainingLifeReceiptDays: number | null }>
//   pickQrtLocation(tx, warehouseId): Promise<{ id: string }>
//   getQuarantineChainRole(tx): Promise<string>
//   getQuarantineDueHours(tx): Promise<number>
//   insertQuarantineDecision(tx, params): Promise<{ id: string }>   (params shape is the builder's)

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

import { receiveLine } from '../../application/receive-inbound/index.js';
import type { LedgerPort, ReceiveInboundDeps } from '../../application/receive-inbound/ports.js';

const ACTOR_ID = '5a1e0b0c-0000-4000-8000-00000000c101';
const ORDER_ID = '5a1e0b0c-0000-4000-8000-00000000c102';
const LINE_ID = '5a1e0b0c-0000-4000-8000-00000000c103';
const SKU_ID = '5a1e0b0c-0000-4000-8000-00000000c104';
const CLIENT_ID = '5a1e0b0c-0000-4000-8000-00000000c105';
const ENTITY_ID = '5a1e0b0c-0000-4000-8000-00000000c106';
const WAREHOUSE_ID = '5a1e0b0c-0000-4000-8000-00000000c107';
const RCV_LOCATION_ID = '5a1e0b0c-0000-4000-8000-00000000c108';
const QRT_LOCATION_ID = '5a1e0b0c-0000-4000-8000-00000000c109';
const CHAIN_ROLE = 'FIXTURE_ROLE';
const DUE_HOURS = 1;
const QTY = '10.000';
const UOM = 'EA';
const MS_PER_DAY = 86_400_000;
const CLOCK_NOW = new Date('2026-09-30T09:00:00.000Z'); // Kuwait date 2026-09-30, same as UTC
const MAX_MIN_DAYS = 400;
const MAX_EXTRA_DAYS = 400;
const NUM_RUNS = 60;
const MAX_EXPIRED_DAYS = 30; // short arm also covers already-expired batches (negative remaining days)
const CORRELATION_ID = '5a1e0b0c-0000-4000-8000-00000000c110';

function isoDayFromToday(days: number): string {
  return new Date(CLOCK_NOW.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

interface Scenario {
  readonly short: boolean;
  readonly trackExpiry: boolean;
  readonly minDays: number | null;
  readonly expiryDate: string | null;
}

// Built by construction: which receipts are short is decided by the generator arm, not recomputed.
const shortArb: fc.Arbitrary<Scenario> = fc
  .tuple(fc.integer({ min: 1, max: MAX_MIN_DAYS }), fc.nat())
  .map(([min, seed]) => ({ short: true, trackExpiry: true, minDays: min, expiryDate: isoDayFromToday((seed % (min + MAX_EXPIRED_DAYS)) - MAX_EXPIRED_DAYS) }));
const atOrAboveArb: fc.Arbitrary<Scenario> = fc
  .tuple(fc.integer({ min: 0, max: MAX_MIN_DAYS }), fc.integer({ min: 0, max: MAX_EXTRA_DAYS }))
  .map(([min, extra]) => ({ short: false, trackExpiry: true, minDays: min, expiryDate: isoDayFromToday(min + extra) }));
const untrackedArb: fc.Arbitrary<Scenario> = fc
  .integer({ min: 1, max: MAX_MIN_DAYS })
  .map((min) => ({ short: false, trackExpiry: false, minDays: min, expiryDate: isoDayFromToday(0) }));
const noMinimumArb: fc.Arbitrary<Scenario> = fc.constant({ short: false, trackExpiry: true, minDays: null, expiryDate: isoDayFromToday(0) });
const noExpiryArb: fc.Arbitrary<Scenario> = fc
  .integer({ min: 1, max: MAX_MIN_DAYS })
  .map((min) => ({ short: false, trackExpiry: true, minDays: min, expiryDate: null }));

function buildDeps(scenario: Scenario, failInsert = false): { deps: ReceiveInboundDeps; postedTo: string[]; decisions: unknown[] } {
  const postedTo: string[] = [];
  const decisions: unknown[] = [];
  const repo = {
    getOrderForUpdate: async () => ({ id: ORDER_ID, entityId: ENTITY_ID, clientId: CLIENT_ID, warehouseId: WAREHOUSE_ID, status: 'approved', version: 1 }),
    getOrderLineForUpdate: async () => ({ id: LINE_ID, orderId: ORDER_ID, skuId: SKU_ID, qtyOrdered: QTY, qtyActual: null, uom: UOM, batchNo: null, status: 'open', locationId: null }),
    getSkuClientId: async () => CLIENT_ID,
    getSkuShelfLifeRule: async () => ({ trackExpiry: scenario.trackExpiry, minRemainingLifeReceiptDays: scenario.minDays }),
    updateLineReceipt: async () => true,
    countUnreceiptedLines: async () => 1, // not the last line: no GRN path
    getAllLineQtyActual: async () => [QTY],
    pickRcvLocation: async () => ({ id: RCV_LOCATION_ID }),
    pickQrtLocation: async () => ({ id: QRT_LOCATION_ID }),
    getQuarantineChainRole: async () => CHAIN_ROLE,
    getQuarantineDueHours: async () => DUE_HOURS,
    insertQuarantineDecision: async (_tx: unknown, params: unknown) => {
      if (failInsert) throw new Error('decision insert failed');
      decisions.push(params);
      return { id: '5a1e0b0c-0000-4000-8000-00000000c111' };
    },
    updateOrder: async () => 2,
    writeAuditRow: async () => undefined,
  };
  const ledger: LedgerPort = {
    postReceipt: async (_tx, params) => {
      postedTo.push(params.toLocationId);
      return { movementIds: ['5a1e0b0c-0000-4000-8000-00000000c112'], correlationId: params.correlationId };
    },
    postPutawayTransfer: async () => {
      throw new Error('not expected: put-away is not part of this property');
    },
  };
  const deps: ReceiveInboundDeps = {
    clock: new FixedClock(CLOCK_NOW),
    ids: new SequentialIdGenerator(2110),
    repo: repo as unknown as ReceiveInboundDeps['repo'],
    ledger,
    logger: { error: () => undefined, info: () => undefined },
  };
  return { deps, postedTo, decisions };
}

describe('receiveLine routing — property (stock invariant: a short-shelf-life batch never lands outside the quarantine location)', () => {
  it('posts a short receipt to the pickQrtLocation result with exactly one decision; every other receipt to the pickRcvLocation result with none', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(shortArb, atOrAboveArb, untrackedArb, noMinimumArb, noExpiryArb), async (scenario) => {
        const { deps, postedTo, decisions } = buildDeps(scenario);
        await receiveLine(
          { userId: ACTOR_ID, clientId: null, isInternal: true },
          {
            orderId: ORDER_ID,
            lineId: LINE_ID,
            qtyActual: QTY,
            batchNo: 'PROP-B1',
            ...(scenario.expiryDate === null ? {} : { expiryDate: scenario.expiryDate }),
            expectedVersion: 1,
            correlationId: CORRELATION_ID,
          },
          deps,
        );
        expect(postedTo).toEqual([scenario.short ? QRT_LOCATION_ID : RCV_LOCATION_ID]);
        expect(decisions).toHaveLength(scenario.short ? 1 : 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('receiveLine — a failing decision insert fails the whole receipt (same transaction)', () => {
  it('rejects when insertQuarantineDecision rejects for a short receipt', async () => {
    const { deps } = buildDeps({ short: true, trackExpiry: true, minDays: 10, expiryDate: isoDayFromToday(1) }, true);
    await expect(
      receiveLine(
        { userId: ACTOR_ID, clientId: null, isInternal: true },
        { orderId: ORDER_ID, lineId: LINE_ID, qtyActual: QTY, batchNo: 'PROP-B2', expiryDate: isoDayFromToday(1), expectedVersion: 1, correlationId: CORRELATION_ID },
        deps,
      ),
    ).rejects.toThrow('decision insert failed');
  });
});
