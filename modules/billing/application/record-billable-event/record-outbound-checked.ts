// modules/billing/application/record-billable-event/record-outbound-checked.ts — WBS 4.3 part 1 (lane 2).
//
// The `wms.outbound.checked` subscriber body (brief Decision 3): ONE withContext tx per relayed
// event —
//   0. event.entityId null -> MissingEventEntityError; payload parsed by OutboundCheckedPayloadSchema
//      (malformed -> InvalidEventPayloadError). Both throw so the relay records `last_error`.
//   1. resolve the source row (wms.outbound_orders/<orderId>) through the 4.2 port — its entity,
//      client and contract (the ONLY read of a wms.* table, inside the port).
//   2. read the mapped services' ACTIVE catalog.services rows by code (uom from the row).
//   3. skip the service ids already billed for this source (a redelivery writes nothing and commits).
//   4. insertBillableEvent for each missing service, in the SAME tx (each writes its own outbox +
//      audit row, 4.2 port).
// A concurrent relay's unique violation surfaces as DuplicateBillableEventError from the port and
// is rethrown (never swallowed): the tx aborts and the relay redelivers (at-least-once).

import { withContext } from '@pg-eos/db';
import type { OutboxEvent } from '@pg-eos/events';

import {
  BillableServiceNotFoundError,
  InvalidEventPayloadError,
  MissingEventEntityError,
  SourceClientMissingError,
  SourceEventNotFoundError,
} from '../../domain/record-billable-event/errors.js';
import { OUTBOUND_CHECKED_SERVICES } from '../../domain/record-billable-event/outbound-checked-services.js';
import type { RecordBillableEventDeps } from './ports.js';

const SOURCE_MODULE_WMS = 'wms';
const SOURCE_TABLE_OUTBOUND_ORDERS = 'wms.outbound_orders';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `wms.outbound.checked` payload check-order.ts writes: `{ orderId, status }`. */
export interface OutboundCheckedPayload {
  readonly orderId: string;
  readonly status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Payload schema `{ orderId: uuid, status: string }`. A Zod-shaped `parse` (throws on mismatch):
 *  `zod` is not a dependency of @pg-eos/billing and this slice may not add one (see the closing
 *  report) — swap for `z.object({ orderId: z.uuid(), status: z.string() })` once it is. */
export const OutboundCheckedPayloadSchema = {
  parse(input: unknown): OutboundCheckedPayload {
    if (!isRecord(input)) {
      throw new InvalidEventPayloadError('wms.outbound.checked payload is not an object. (Allowed: { orderId: uuid, status: string })');
    }
    const { orderId, status } = input;
    if (typeof orderId !== 'string' || !UUID_PATTERN.test(orderId)) {
      throw new InvalidEventPayloadError(
        'wms.outbound.checked payload.orderId is missing or not a uuid. (Allowed: { orderId: uuid, status: string })',
      );
    }
    if (typeof status !== 'string') {
      throw new InvalidEventPayloadError(
        'wms.outbound.checked payload.status is missing or not a string. (Allowed: { orderId: uuid, status: string })',
      );
    }
    return { orderId, status };
  },
};

export interface RecordOutboundCheckedResult {
  readonly inserted: number;
  readonly skipped: number;
}

export async function recordOutboundChecked(
  event: OutboxEvent,
  deps: RecordBillableEventDeps,
): Promise<RecordOutboundCheckedResult> {
  if (event.entityId === null) {
    throw new MissingEventEntityError(
      `RecordOutboundChecked: outbox event ${event.id} (${event.eventType}) has no entity_id. (Allowed: an entity-scoped event)`,
    );
  }
  const payload = OutboundCheckedPayloadSchema.parse(event.payload);
  const ctx = deps.systemActor.contextFor(event.entityId);

  const result = await withContext(ctx, async (tx) => {
    const source = await deps.repo.resolveSource(tx, SOURCE_TABLE_OUTBOUND_ORDERS, payload.orderId);
    if (!source) {
      throw new SourceEventNotFoundError(
        `RecordOutboundChecked: no ${SOURCE_TABLE_OUTBOUND_ORDERS} row visible for id ${payload.orderId}. ` +
          `(Allowed: an existing, RLS-visible source row)`,
      );
    }
    if (source.clientId === null) {
      throw new SourceClientMissingError(
        `RecordOutboundChecked: ${SOURCE_TABLE_OUTBOUND_ORDERS} ${payload.orderId} has no client_id. (Allowed: a client-owned order)`,
      );
    }
    const clientId = source.clientId;

    const codes = OUTBOUND_CHECKED_SERVICES.map((service) => service.code);
    const serviceRows = await deps.repo.findActiveServicesByCode(tx, codes);
    const serviceByCode = new Map(serviceRows.map((row) => [row.code, row]));
    const billed = new Set(await deps.repo.findBilledServiceIds(tx, SOURCE_TABLE_OUTBOUND_ORDERS, payload.orderId));

    let inserted = 0;
    let skipped = 0;
    for (const mapped of OUTBOUND_CHECKED_SERVICES) {
      const service = serviceByCode.get(mapped.code);
      if (!service) {
        throw new BillableServiceNotFoundError(
          `RecordOutboundChecked: no active catalog.services row for code ${mapped.code}. (Allowed: ${codes.join(', ')} seeded and active)`,
        );
      }
      if (billed.has(service.id)) {
        skipped += 1;
        continue;
      }
      await deps.repo.insert(tx, {
        occurredAt: event.createdAt.toISOString(),
        clientId,
        contractId: source.contractId,
        serviceId: service.id,
        qty: mapped.qty,
        uom: service.uom,
        sourceModule: SOURCE_MODULE_WMS,
        sourceTable: SOURCE_TABLE_OUTBOUND_ORDERS,
        sourceId: payload.orderId,
        correlationId: event.correlationId,
        actorId: deps.systemActor.actorId,
      });
      inserted += 1;
    }
    return { inserted, skipped };
  });

  deps.logger.info(
    { outboxId: event.id, orderId: payload.orderId, correlationId: event.correlationId, ...result },
    'billing: wms.outbound.checked billable events recorded',
  );
  return result;
}
