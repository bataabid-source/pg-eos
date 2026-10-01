// modules/tms/application/create-delivery-task/create-delivery-task.ts — WBS 3.4 part 1.
//
// createDeliveryTask — ONE withIdempotentContext transaction (step 0, packages/db/src/idempotency.ts,
// runs first when input.idem is set; a replay short-circuits BEFORE this callback runs). Order:
//   (1) INV-C4-2 (domain, before any read or write);
//   (2) lock the wms.outbound_orders row (for update) — first port call;
//   (3) the caller's entity (app.entity_id — never the body); an order in another entity ->
//       OrderNotFoundError, before any other order-derived refusal;
//   (4) one task per order (delivery_task_id already set -> DeliveryTaskAlreadyExistsError), order
//       status checked · packed · loaded, the caller's expectedVersion, then platform.next_doc_no(entity,'TSK');
//   (5) the tms.delivery_tasks INSERT (status = the machine's initial state, version 1, no vehicle,
//       no driver — brief Decision 3), then the order back-link with its version check and bump;
//   (6) the 'tms.task.created' outbox event (writeOutboxEvent, same transaction);
//   (7) the audit rows, last (ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import {
  MissingActorError,
  DeliveryTaskAlreadyExistsError,
  OrderNotFoundError,
  StaleVersionError,
} from '../../domain/create-delivery-task/errors.js';
import { assertAddressComplete, assertOrderReadyForTask } from '../../domain/create-delivery-task/invariants.js';
import { INITIAL_DELIVERY_TASK_STATUS, type DeliveryTaskStatus } from '../../domain/create-delivery-task/machine.js';
import type { CreateDeliveryTaskDeps } from './ports.js';

const TASK_DOC_TYPE = 'TSK'; // prefix from platform.counters per entity (PDL-TSK- in S1); tms.brief.md §4 says PCC-TSK- — routed to the Master.
const TASK_CREATED_EVENT_TYPE: CatalogedEventType = 'tms.task.created'; // doc 03 line 132.
const TASK_AGGREGATE_TYPE = 'tms.delivery_tasks';
const SOURCE_TYPE_INTERNAL = 'internal'; // brief Decision 4 (01-Data-Model.sql:877 default).
const TASK_TYPE_B2C = 'b2c'; // brief Decision 4 (01-Data-Model.sql:880 default).
const INITIAL_TASK_VERSION = 1; // brief Decision 2 / 4 (migration 0046 default).
const AUDIT_OPERATION_INSERT = 'insert';
const AUDIT_OPERATION_UPDATE = 'update';

export interface CreateDeliveryTaskInput {
  readonly outboundOrderId: string;
  readonly expectedVersion: number;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly area: string;
  readonly block: string;
  readonly street: string;
  readonly building?: string | undefined;
  readonly addressText?: string | undefined;
  readonly governorate?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateDeliveryTaskResult {
  readonly taskId: string;
  readonly docNo: string;
  readonly status: DeliveryTaskStatus;
  readonly version: number;
}

export async function createDeliveryTask(
  ctx: WithContextCtx,
  input: CreateDeliveryTaskInput,
  deps: CreateDeliveryTaskDeps,
): Promise<CreateDeliveryTaskResult> {
  if (!ctx.userId) throw new MissingActorError('CreateDeliveryTask requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateDeliveryTaskResult>(ctx, input.idem, async (tx) => {
    assertAddressComplete(input);
    const occurredAt = deps.clock.now();

    const order = await deps.repo.getOrderForUpdate(tx, input.outboundOrderId);
    const entityId = await deps.repo.resolveCallerEntityId(tx);
    // Fail closed: entity_scope RLS already limits internal callers to their one entity, but
    // client_portal_scope lets a non-internal caller see an order in another entity; the task, its
    // audit rows and the outbox event must never straddle two entities. Checked immediately after
    // the lock and before any write; every other refusal (existing task, status, stale version)
    // comes after it, so nothing about another entity's order is revealed by which error returns.
    if (order.entityId !== entityId) {
      throw new OrderNotFoundError(
        `outbound order ${order.id} is not in the caller's entity (allowed: an outbound order id visible in the caller's entity)`,
      );
    }
    if (order.deliveryTaskId !== null) {
      throw new DeliveryTaskAlreadyExistsError(
        `outbound order ${order.id} already has delivery task ${order.deliveryTaskId} (one task per order).`,
      );
    }
    assertOrderReadyForTask(order.status);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `outbound order ${order.id} is at version ${order.version}, not the expected ${input.expectedVersion}.`,
      );
    }

    const docNo = await deps.repo.nextDocNo(tx, entityId, TASK_DOC_TYPE);

    const columns = {
      entityId,
      docNo,
      clientId: order.clientId,
      contractId: order.contractId,
      sourceType: SOURCE_TYPE_INTERNAL,
      outboundOrderId: order.id,
      taskType: TASK_TYPE_B2C,
      status: INITIAL_DELIVERY_TASK_STATUS,
      version: INITIAL_TASK_VERSION,
      recipientName: input.recipientName,
      recipientPhone: input.recipientPhone,
      addressText: input.addressText ?? null,
      area: input.area,
      governorate: input.governorate ?? null,
      block: input.block,
      street: input.street,
      building: input.building ?? null,
    };
    const task = await deps.repo.insertDeliveryTask(tx, columns);
    const orderVersion = await deps.repo.linkOrderToTask(tx, {
      orderId: order.id,
      taskId: task.id,
      expectedVersion: input.expectedVersion,
    });

    await writeOutboxEvent(tx, {
      entityId,
      aggregateType: TASK_AGGREGATE_TYPE,
      aggregateId: task.id,
      eventType: TASK_CREATED_EVENT_TYPE,
      payload: { taskId: task.id, docNo, outboundOrderId: order.id, status: INITIAL_DELIVERY_TASK_STATUS },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId,
      target: 'task',
      recordId: task.id,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      newValue: columns,
      occurredAt,
    });
    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: order.id,
      operation: AUDIT_OPERATION_UPDATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { deliveryTaskId: task.id, version: orderVersion },
      occurredAt,
    });

    deps.logger.info({ correlationId: input.correlationId, taskId: task.id, docNo }, 'tms.task.created');
    return { taskId: task.id, docNo, status: INITIAL_DELIVERY_TASK_STATUS, version: INITIAL_TASK_VERSION };
  });
}
