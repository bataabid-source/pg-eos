// packages/contracts/tms/create-delivery-task.ts — WBS 3.4 part 1.
//
// Zod input schema for the create-delivery-task use case's ONE command, CreateDeliveryTask
// (slice brief Decision 4). Field shapes derive from tms.delivery_tasks
// (database/schema/01-Data-Model.sql:871-899) — never a column not on that table. `area`, `block`,
// `street` and `recipientPhone` are required, non-empty (INV-C4-2, doc 40 line 274: "Task creation
// rejected without area, block, street, phone"); they are never derived from the order's
// `ship_to_*` columns. `expectedVersion` is the outbound order's own `version` (13B:164), checked
// when `wms.outbound_orders.delivery_task_id` is set in the same transaction. `performedBy` does
// NOT exist on any schema — the actor is ALWAYS `ctx.userId`; `entity_id` is the caller's
// `app.entity_id`, never a body field. No result schema — the 200 carries no body, as every
// wms/process-outbound create route.
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

import { IdempotencyKeyHeader } from '../_shared/headers.js';
import type { RouteDefinitionInput } from '../_shared/registry.js';
import { OK_RESPONSE, writeErrorResponses } from '../_shared/route-responses.js';

const UUID_ID = z.string().uuid();
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);
const NON_EMPTY_STRING = z.string().min(1);

export const CreateDeliveryTaskInputSchema = z
  .object({
    outboundOrderId: UUID_ID,
    // the outbound order's version (optimistic lock on the delivery_task_id write — brief Decision 4)
    expectedVersion: EXPECTED_VERSION,
    recipientName: NON_EMPTY_STRING,
    recipientPhone: NON_EMPTY_STRING,
    area: NON_EMPTY_STRING,
    block: NON_EMPTY_STRING,
    street: NON_EMPTY_STRING,
    building: z.string().optional(),
    addressText: z.string().optional(),
    governorate: z.string().optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'CreateDeliveryTaskInput' });

export type CreateDeliveryTaskInput = z.infer<typeof CreateDeliveryTaskInputSchema>;

// --- OpenAPI route registrations (Master task, docs/STREAMS.md §Enablement item 6) -------------
// Contract-first (ADR-0005 §3, billing/post-journal precedent): registered by the Master before
// lane B builds modules/tms/api/create-delivery-task/handlers.ts, so `withHostResponses` adds the
// 501 until the handler is mounted. Write route — Idempotency-Key header; 409 covers key reuse, a
// stale `expectedVersion` and `tms.task.create.alreadyExists`; 422 covers
// `tms.task.create.addressIncomplete` and `tms.task.create.orderNotReady` (brief Decision 4).
const WRITE_HEADERS = z.object({ 'Idempotency-Key': IdempotencyKeyHeader });

export const ROUTES: readonly RouteDefinitionInput[] = [
  {
    method: 'POST',
    path: '/tms/create-delivery-task/create-delivery-task',
    summary: 'Create delivery task',
    contractFirst: true,
    request: { headers: WRITE_HEADERS, body: CreateDeliveryTaskInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses() },
  },
];
