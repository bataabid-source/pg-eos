// WBS 2.16 part 2 — property test (brief): for any sequence of scans, each accepted scan enqueues
// exactly one command and replays never duplicate its Idempotency-Key. Targets
// apps/pda/src/features/receive/scan-queue.ts (contract in receive-screen.test.tsx header).
// An invalid-field scan (accepted verdict, contract-rejected field), a refused scan and an offline scan (checkScan rejects; offline queuing is deferred to 2.16 part
// 2b) both enqueue nothing and burn no key. Every queued body is a valid contract ReceiveLineInput tied to its own scan.
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { ReceiveLineInputSchema } from '@pg-eos/contracts/wms/receive-inbound';

import { submitReceiveScan, replayReceiveCommand, type ReceiveLineCommand } from '../../src/features/receive/scan-queue';
import { ReceiveTransportError, type ReceiveClient } from '../../src/features/receive/client';

// 'invalid' = an ACCEPTED verdict but a field the contract's own schemas reject.
type Outcome = 'accepted' | 'refused' | 'offline' | 'invalid';
const OUTCOMES: readonly Outcome[] = ['accepted', 'refused', 'offline', 'invalid'];
const MAX_SCANS = 30;
const MAX_REPLAYS = 5;
const MIN_REPLAYS = 1;
const SINGLE = 1;
const MAX_QTY = 999;
const ISO_DATE_LENGTH = 10;
const UUID_SUFFIX_LENGTH = 12;
const FIXED_NOW = new Date('2026-09-29T08:00:00.000Z');
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const EXPECTED_VERSION = 3;

const uuid = (n: number): string => `44444444-4444-4444-8444-${String(n).padStart(UUID_SUFFIX_LENGTH, '0')}`;

const scanArb = fc.record({
  skuCode: fc.string({ minLength: 1 }),
  batchNo: fc.string({ minLength: 1 }),
  expiryDate: fc
    .date({ min: new Date('2026-01-01T00:00:00.000Z'), max: new Date('2030-12-31T00:00:00.000Z'), noInvalidDate: true })
    .map((date) => date.toISOString().slice(0, ISO_DATE_LENGTH)),
  qty: fc.integer({ min: 1, max: MAX_QTY }).map(String),
});
// Values ReceiveLineInputSchema really rejects: expiryDate is z.iso.date(); qtyActual is
// /^\d{1,11}(\.\d{1,3})?$/ (no empty, sign, letters or a 4th decimal).
const invalidPatchArb = fc.oneof(
  fc.record({ expiryDate: fc.constantFrom('27/01/2027', 'not-a-date', '2027-13-45') }),
  fc.record({ qty: fc.constantFrom('', '-1', 'abc', '1.2345') }),
);
const stepArb = fc
  .record({ scan: scanArb, outcome: fc.constantFrom(...OUTCOMES), patch: invalidPatchArb })
  .map(({ scan, outcome, patch }) => ({ outcome, scan: outcome === 'invalid' ? { ...scan, ...patch } : scan }));
const sequenceArb = fc.array(stepArb, { maxLength: MAX_SCANS });

function clientFor(outcome: Outcome): ReceiveClient {
  return {
    checkScan: () => {
      if (outcome === 'offline') {
        return Promise.reject(new ReceiveTransportError('offline'));
      }
      return Promise.resolve(
        outcome === 'accepted' || outcome === 'invalid'
          ? { accepted: true as const, lineId: LINE_ID, expectedVersion: EXPECTED_VERSION }
          : { accepted: false as const, code: 'lineNotFound' as const },
      );
    },
  };
}

describe('receive queue invariants (property)', () => {
  it('each accepted scan enqueues exactly one command, tied to its own scan, with a unique key; refused, offline and invalid-field scans enqueue nothing and burn no key', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (steps) => {
        const enqueued: unknown[] = [];
        let keyCounter = 0;
        let correlationCounter = 0;
        const newKey = vi.fn(() => `key-${(keyCounter += 1)}`);
        const newCorrelationId = vi.fn(() => uuid((correlationCounter += 1)));
        const enqueue = vi.fn((payload: unknown) => {
          enqueued.push(payload);
          return Promise.resolve();
        });
        for (const { scan, outcome } of steps) {
          await submitReceiveScan(
            { client: clientFor(outcome), newKey, newCorrelationId, now: () => FIXED_NOW, enqueue },
            { orderId: ORDER_ID, ...scan },
          );
        }
        const acceptedSteps = steps.filter((step) => step.outcome === 'accepted');
        expect(enqueued).toHaveLength(acceptedSteps.length);
        expect(newKey).toHaveBeenCalledTimes(acceptedSteps.length);
        expect(newCorrelationId).toHaveBeenCalledTimes(acceptedSteps.length);
        const commands = enqueued as ReceiveLineCommand[];
        expect(new Set(commands.map((command) => command.idempotencyKey)).size).toBe(acceptedSteps.length);
        acceptedSteps.forEach((step, index) => {
          const body = commands[index]?.body;
          expect(body?.batchNo).toBe(step.scan.batchNo);
          expect(body?.expiryDate).toBe(step.scan.expiryDate);
          expect(body?.qtyActual).toBe(step.scan.qty);
          expect(ReceiveLineInputSchema.safeParse(body).success).toBe(true);
        });
      }),
    );
  });

  it('replaying a queued command any number of times reuses its Idempotency-Key, keeps a schema-valid body and never enqueues again', async () => {
    await fc.assert(
      fc.asyncProperty(scanArb, fc.integer({ min: MIN_REPLAYS, max: MAX_REPLAYS }), async (scan, replays) => {
        const enqueue = vi.fn(() => Promise.resolve());
        const newKey = vi.fn(() => 'key-fixed');
        const newCorrelationId = vi.fn(() => uuid(SINGLE));
        const result = await submitReceiveScan(
          { client: clientFor('accepted'), newKey, newCorrelationId, now: () => FIXED_NOW, enqueue },
          { orderId: ORDER_ID, ...scan },
        );
        if (result.status !== 'accepted') {
          throw new Error('expected an accepted scan');
        }
        for (let i = 0; i < replays; i += 1) {
          const replay = replayReceiveCommand(result.command);
          expect(replay.headers['Idempotency-Key']).toBe('key-fixed');
          expect(ReceiveLineInputSchema.safeParse(replay.body).success).toBe(true);
        }
        expect(enqueue).toHaveBeenCalledTimes(SINGLE);
        expect(newKey).toHaveBeenCalledTimes(SINGLE);
        expect(newCorrelationId).toHaveBeenCalledTimes(SINGLE);
      }),
    );
  });
});
