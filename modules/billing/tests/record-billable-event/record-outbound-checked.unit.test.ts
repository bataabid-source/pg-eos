// modules/billing/tests/record-billable-event/record-outbound-checked.unit.test.ts — WBS 4.3 part 1 (lane 2).
//
// UNIT (no DB) of the handler's defensive guard. The outbox CHECK outbox_business_needs_entity
// already refuses such a row at insert, so the integration layer cannot reach this path; the guard
// is exercised here through the application surface with fake ports that fail on any use.

import { describe, expect, it } from 'vitest';

import type { OutboxEvent } from '@pg-eos/events';

import type { RecordBillableEventDeps } from '../../application/record-billable-event/ports.js';
import { OutboundCheckedPayloadSchema, recordOutboundChecked } from '../../application/record-billable-event/record-outbound-checked.js';
import { InvalidEventPayloadError, MissingEventEntityError } from '../../domain/record-billable-event/errors.js';

const EVENT_ID = 1;
const CHECKED_EVENT_TYPE = 'wms.outbound.checked';
const ORDER_ID = '00000000-0000-4000-8000-000000000001';
const CORRELATION_ID = '00000000-0000-4000-8000-000000000002';

describe('Scenario: A wms.outbound.checked event without entity_id is refused before any write (the outbox CHECK outbox_business_needs_entity already refuses the row)', () => {
  it('throws MissingEventEntityError and touches no port (no context, no repository call, no log)', async () => {
    const calls: string[] = [];
    const deps: RecordBillableEventDeps = {
      repo: {
        resolveSource: () => { calls.push('resolveSource'); return Promise.reject(new Error('repo used')); },
        findBilledServiceIds: () => { calls.push('findBilledServiceIds'); return Promise.reject(new Error('repo used')); },
        findActiveServicesByCode: () => { calls.push('findActiveServicesByCode'); return Promise.reject(new Error('repo used')); },
        insert: () => { calls.push('insert'); return Promise.reject(new Error('repo used')); },
      },
      systemActor: {
        actorId: null,
        contextFor: () => { calls.push('contextFor'); throw new Error('context opened'); },
      },
      logger: {
        info: () => { calls.push('info'); },
        error: () => { calls.push('error'); },
      },
    };
    const event: OutboxEvent = {
      id: EVENT_ID,
      entityId: null,
      aggregateType: 'wms.outbound_orders',
      aggregateId: ORDER_ID,
      eventType: CHECKED_EVENT_TYPE,
      payload: { orderId: ORDER_ID, status: 'checked' },
      correlationId: CORRELATION_ID,
      causationId: null,
      createdAt: new Date(0),
      actorId: null,
    };

    await expect(recordOutboundChecked(event, deps)).rejects.toBeInstanceOf(MissingEventEntityError);
    expect(calls).toEqual([]);
  });
});

describe('OutboundCheckedPayloadSchema.parse refuses a malformed wms.outbound.checked payload', () => {
  it('refuses a non-object payload', () => {
    expect(() => OutboundCheckedPayloadSchema.parse('checked')).toThrow(InvalidEventPayloadError);
  });

  it('refuses an orderId that is not a uuid', () => {
    expect(() => OutboundCheckedPayloadSchema.parse({ orderId: 'not-a-uuid', status: 'checked' })).toThrow(
      InvalidEventPayloadError,
    );
  });

  it('refuses a status that is missing or not a string', () => {
    expect(() => OutboundCheckedPayloadSchema.parse({ orderId: ORDER_ID })).toThrow(InvalidEventPayloadError);
    expect(() => OutboundCheckedPayloadSchema.parse({ orderId: ORDER_ID, status: 1 })).toThrow(InvalidEventPayloadError);
  });
});
