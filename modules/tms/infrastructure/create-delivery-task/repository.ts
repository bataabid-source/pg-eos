// modules/tms/infrastructure/create-delivery-task/repository.ts — WBS 3.4 part 1.
//
// infrastructure/ layer: every DB statement for the create-delivery-task use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened (via withIdempotentContext — see
// ../../application/create-delivery-task/create-delivery-task.ts). Implements
// ../../application/create-delivery-task/ports.ts's `DeliveryTasksRepository`.
//
// LOCK ORDER:
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (withIdempotentContext).
//   1. getOrderForUpdate — `select ... for update` on the ONE wms.outbound_orders row, held for the
//      rest of the transaction (the back-link below updates that same row — no new lock).
//   2. nextDocNo — platform.next_doc_no locks the entity's TSK platform.counters row.
//   3. insertDeliveryTask, linkOrderToTask, the outbox insert, then writeAuditRow, last (ADR-0002).
//
// The wms.outbound_orders read/update is the brief's own Decision 4 (the back-link
// `delivery_task_id`, 01-Data-Model.sql:766, set in the same transaction with the order's version
// check) — a SQL statement on that table, never an import from modules/wms.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { EntityScopeRequiredError } from '@pg-eos/db';

import { OrderNotFoundError, StaleVersionError } from '../../domain/create-delivery-task/errors.js';
import type {
  AuditTarget,
  DeliveryTasksRepository,
  InsertDeliveryTaskColumns,
  OutboundOrderRow,
} from '../../application/create-delivery-task/ports.js';

const TASK_SCHEMA = 'tms';
const TASK_TABLE_NAME = 'delivery_tasks';
const TASK_TABLE = `${TASK_SCHEMA}.${TASK_TABLE_NAME}`;
const ORDER_SCHEMA = 'wms';
const ORDER_TABLE_NAME = 'outbound_orders';
const ORDER_TABLE = `${ORDER_SCHEMA}.${ORDER_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
// The audited (schema, table) for each AuditTarget — the application layer names a target, never a table.
const AUDIT_TABLE_BY_TARGET = {
  task: { schema: TASK_SCHEMA, table: TASK_TABLE_NAME },
  order: { schema: ORDER_SCHEMA, table: ORDER_TABLE_NAME },
} as const;
const EXACTLY_ONE_ENTITY = 1;

async function getOrderForUpdate(tx: NodePgDatabase, orderId: string): Promise<OutboundOrderRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    client_id: string;
    contract_id: string | null;
    status: string;
    version: number;
    delivery_task_id: string | null;
  }>(sql`
    select id, entity_id, client_id, contract_id, status, version, delivery_task_id
      from ${sql.raw(ORDER_TABLE)} where id = ${orderId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) throw new OrderNotFoundError(
      `no ${ORDER_TABLE} row visible for id ${orderId} (allowed: an outbound order id visible in the caller's entity)`,
    );
  return {
    id: row.id,
    entityId: row.entity_id,
    clientId: row.client_id,
    contractId: row.contract_id,
    status: row.status,
    version: row.version,
    deliveryTaskId: row.delivery_task_id,
  };
}

/** The caller's own entity: platform.allowed_entities() follows `app.entity_id` (withContext's
 *  ctx.entityId), so the active entity is the one element — never trusted from the body. Fails
 *  closed on zero or more than one entity (never guesses `[1]`) with @pg-eos/db's own
 *  EntityScopeRequiredError (422, `identity.entityScope.required`). */
async function resolveCallerEntityId(tx: NodePgDatabase): Promise<string> {
  const result = await tx.execute<{ entity_id: string | null; entity_count: number | null }>(sql`
    select (platform.allowed_entities())[1] as entity_id, array_length(platform.allowed_entities(), 1) as entity_count
  `);
  const row = result.rows[0];
  const entityCount = row?.entity_count ?? 0;
  const entityId = row?.entity_id ?? null;
  if (entityCount !== EXACTLY_ONE_ENTITY || entityId === null) {
    throw new EntityScopeRequiredError(
      `platform.allowed_entities() returned ${entityCount} entities for the caller, not exactly one. ` +
        `(Allowed: a caller with one active entity, app.entity_id)`,
    );
  }
  return entityId;
}

/** Atomic allocator — the ONLY way a document number is ever produced. */
async function nextDocNo(tx: NodePgDatabase, entityId: string, docType: string): Promise<string> {
  const result = await tx.execute<{ doc_no: string }>(sql`select platform.next_doc_no(${entityId}::uuid, ${docType}) as doc_no`);
  const row = result.rows[0];
  if (!row) throw new Error(`platform.next_doc_no returned no row for entity ${entityId} / doc type ${docType}`);
  return row.doc_no;
}

async function insertDeliveryTask(tx: NodePgDatabase, columns: InsertDeliveryTaskColumns): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${sql.raw(TASK_TABLE)}
      (entity_id, doc_no, client_id, contract_id, source_type, outbound_order_id, task_type, status,
       version, recipient_name, recipient_phone, address_text, area, governorate, block, street, building)
    values
      (${columns.entityId}::uuid, ${columns.docNo}, ${columns.clientId}::uuid, ${columns.contractId}::uuid,
       ${columns.sourceType}, ${columns.outboundOrderId}::uuid, ${columns.taskType}, ${columns.status},
       ${columns.version}::int, ${columns.recipientName}, ${columns.recipientPhone}, ${columns.addressText},
       ${columns.area}, ${columns.governorate}, ${columns.block}, ${columns.street}, ${columns.building})
    returning id
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${TASK_TABLE} returned no row`);
  return { id: row.id };
}

async function linkOrderToTask(
  tx: NodePgDatabase,
  params: { readonly orderId: string; readonly taskId: string; readonly expectedVersion: number },
): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(ORDER_TABLE)}
       set delivery_task_id = ${params.taskId}::uuid, version = version + 1
     where id = ${params.orderId}::uuid and version = ${params.expectedVersion}::int
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new StaleVersionError(`${ORDER_TABLE} ${params.orderId} is no longer at version ${params.expectedVersion}.`);
  }
  return row.version;
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the outbox row the same
 *  call writes (G9). `occurredAt` always from the injected Clock. */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly target: AuditTarget;
    readonly recordId: string;
    readonly operation: string;
    readonly correlationId: string;
    readonly actorId: string;
    readonly newValue: unknown;
    readonly occurredAt: Date;
  },
): Promise<void> {
  const audited = AUDIT_TABLE_BY_TARGET[params.target];
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${audited.schema}, ${audited.table}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const deliveryTasksRepository: DeliveryTasksRepository = {
  resolveCallerEntityId,
  getOrderForUpdate,
  nextDocNo,
  insertDeliveryTask,
  linkOrderToTask,
  writeAuditRow,
};

export { TASK_SCHEMA, TASK_TABLE_NAME, TASK_TABLE, ORDER_TABLE };
