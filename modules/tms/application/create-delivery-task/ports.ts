// modules/tms/application/create-delivery-task/ports.ts — WBS 3.4 part 1.
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: CreateDeliveryTaskDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/create-delivery-task/repository.ts implements `DeliveryTasksRepository`;
// ../../api/create-delivery-task/composition.ts wires it.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value is
 *  accepted (including an `err` key holding the raw caught value, pino's own convention). */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/create-delivery-task/logger.ts; a
 *  fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** The locked wms.outbound_orders row, as this command needs it. */
export interface OutboundOrderRow {
  readonly id: string;
  readonly entityId: string;
  readonly clientId: string;
  readonly contractId: string | null;
  readonly status: string;
  readonly version: number;
  readonly deliveryTaskId: string | null;
}

/** The columns this command writes on the new tms.delivery_tasks row (01-Data-Model.sql:871-899 +
 *  migration 0046's `version`). Every other column stays at its own default (vehicle_id and
 *  driver_id null — brief Decision 3). */
export interface InsertDeliveryTaskColumns {
  readonly entityId: string;
  readonly docNo: string;
  readonly clientId: string;
  readonly contractId: string | null;
  readonly sourceType: string;
  readonly outboundOrderId: string;
  readonly taskType: string;
  readonly status: string;
  readonly version: number;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly addressText: string | null;
  readonly area: string;
  readonly governorate: string | null;
  readonly block: string;
  readonly street: string;
  readonly building: string | null;
}

/** The audited table for each target — the application layer names a target, never a table. */
export type AuditTarget = 'task' | 'order';

/** Every DB statement the create-delivery-task use case needs. */
export interface DeliveryTasksRepository {
  /** the caller's own entity (`app.entity_id`, via platform.allowed_entities()) — never the body.
   *  Throws @pg-eos/db EntityScopeRequiredError unless exactly one entity. */
  resolveCallerEntityId(tx: NodePgDatabase): Promise<string>;
  /** `select ... for update` on the ONE wms.outbound_orders row; OrderNotFoundError when not
   *  visible. First port call of the command. */
  getOrderForUpdate(tx: NodePgDatabase, orderId: string): Promise<OutboundOrderRow>;
  /** platform.next_doc_no(entity_id, doc_type) — the only document-number allocator. */
  nextDocNo(tx: NodePgDatabase, entityId: string, docType: string): Promise<string>;
  insertDeliveryTask(tx: NodePgDatabase, columns: InsertDeliveryTaskColumns): Promise<{ readonly id: string }>;
  /** Sets wms.outbound_orders.delivery_task_id with `WHERE version = expectedVersion`, bumping the
   *  version; StaleVersionError on zero rows. Returns the new version. */
  linkOrderToTask(
    tx: NodePgDatabase,
    params: { readonly orderId: string; readonly taskId: string; readonly expectedVersion: number },
  ): Promise<number>;
  /** doc 40 P3/P7: one append-only platform.audit_log row sharing the outbox row's correlation_id
   *  (G9). `occurredAt` always from the injected Clock. */
  writeAuditRow(
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
  ): Promise<void>;
}

/** Everything the command needs, injected by ../../api/create-delivery-task/composition.ts. */
export interface CreateDeliveryTaskDeps extends ClockDeps {
  readonly repo: DeliveryTasksRepository;
  readonly logger: Logger;
}
