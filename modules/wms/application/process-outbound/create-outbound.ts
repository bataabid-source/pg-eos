// modules/wms/application/process-outbound/create-outbound.ts — WBS 2.11 part 1.
//
// ONE withIdempotentContext transaction (step 0 when input.idem is set). Lock order: (1) the
// qualified-account read (brief Master decision 13 — no row lock, a plain read: the client is not
// this command's own aggregate), (2) doc_no allocation (platform.next_doc_no locks a
// platform.counters row), (3) the order insert, (4) the outbox event ('wms.outbound.drafted'),
// (5) the audit row (last, ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { ClientNotQualifiedError, MissingActorError } from '../../domain/process-outbound/errors.js';
import type { ProcessOutboundDeps } from './ports.js';

const OUT_DOC_TYPE = 'OUT';
const QUALIFIED_STATUS = 'active';
const AUDIT_OPERATION_CREATE = 'create';
const OUTBOUND_DRAFTED_EVENT: CatalogedEventType = 'wms.outbound.drafted';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';

export interface CreateOutboundInput {
  readonly entityId: string;
  readonly clientId: string;
  readonly warehouseId: string;
  readonly contractId?: string | undefined;
  readonly orderType: 'standard' | 'rush' | 'transfer' | 'return_to_client';
  readonly requiredBy?: string | undefined;
  readonly shipToName?: string | undefined;
  readonly shipToPhone?: string | undefined;
  readonly shipToAddress?: string | undefined;
  readonly shipToArea?: string | undefined;
  readonly clientRef?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateOutboundResult {
  readonly orderId: string;
  readonly status: 'draft';
  readonly version: number;
  readonly docNo: string;
}

export async function createOutbound(
  ctx: WithContextCtx,
  input: CreateOutboundInput,
  deps: ProcessOutboundDeps,
): Promise<CreateOutboundResult> {
  if (!ctx.userId) throw new MissingActorError('CreateOutbound requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateOutboundResult>(ctx, input.idem, async (tx) => {
    const qualification = await deps.repo.getClientQualification(tx, input.clientId);
    if (!qualification || qualification.deletedAt !== null || qualification.status !== QUALIFIED_STATUS) {
      throw new ClientNotQualifiedError(
        `CreateOutbound refused: client ${input.clientId} is not a qualified account ` +
          `(Allowed: an existing, non-deleted client with status="${QUALIFIED_STATUS}").`,
      );
    }

    const docNo = await deps.repo.nextDocNo(tx, input.entityId, OUT_DOC_TYPE);

    const inserted = await deps.repo.insertOrder(tx, {
      entityId: input.entityId,
      docNo,
      clientId: input.clientId,
      contractId: input.contractId ?? null,
      warehouseId: input.warehouseId,
      orderType: input.orderType,
      requiredBy: input.requiredBy ? new Date(input.requiredBy) : null,
      shipToName: input.shipToName ?? null,
      shipToPhone: input.shipToPhone ?? null,
      shipToAddress: input.shipToAddress ?? null,
      shipToArea: input.shipToArea ?? null,
      clientRef: input.clientRef ?? null,
      createdBy: actorId,
    });

    const occurredAt = deps.clock.now();

    await writeOutboxEvent(tx, {
      entityId: input.entityId,
      aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: inserted.id,
      eventType: OUTBOUND_DRAFTED_EVENT,
      payload: { orderId: inserted.id, docNo: inserted.docNo },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      target: 'order',
      recordId: inserted.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: 'draft', version: inserted.version, docNo: inserted.docNo },
      occurredAt,
    });

    return { orderId: inserted.id, status: 'draft', version: inserted.version, docNo: inserted.docNo };
  });
}
