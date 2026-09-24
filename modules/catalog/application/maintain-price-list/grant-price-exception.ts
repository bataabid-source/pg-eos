// modules/catalog/application/maintain-price-list/grant-price-exception.ts — WBS 1.2, M03
// catalog.
//
// ONE withIdempotentContext transaction (step 0). `catalog.price_exceptions` is append-only — not
// versioned, no row lock on an existing aggregate (Master decision 9). Order: (1) role gate (GM
// ONLY — every other command in this use case is CFO-gated), (2) resolve the service and read its
// current min_price IN THIS transaction (ServiceNotFoundError/ServiceNotPriceableError), (3) the
// validity checks (validTo >= validFrom, reviewAt >= validFrom), (4) the insert — approved_price
// may be BELOW min_price, that is the point of an exception, (5) ONE outbox event
// ('catalog.price_exception.granted') in the SAME transaction, (6) the audit row, sharing the SAME
// correlation_id as the outbox row (G9).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent } from '@pg-eos/events';

import { assertValidValidity } from '../../domain/maintain-price-list/invariants.js';
import { MissingActorError, RoleRequiredError, ServiceNotFoundError, ServiceNotPriceableError } from '../../domain/maintain-price-list/errors.js';
import type { MaintainPriceListDeps } from './ports.js';

const ROLE_GM = 'GM';
const AUDIT_OPERATION_GRANT = 'grant';
const PRICE_EXCEPTION_GRANTED_EVENT_TYPE = 'catalog.price_exception.granted';
const PRICE_EXCEPTIONS_AGGREGATE_TYPE = 'catalog.price_exceptions';

export interface GrantPriceExceptionInput {
  readonly entityId: string;
  readonly clientId: string;
  readonly serviceId: string;
  readonly approvedPrice: string;
  readonly reason: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly reviewAt: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface GrantPriceExceptionResult {
  readonly exceptionId: string;
}

export async function grantPriceException(
  ctx: WithContextCtx,
  input: GrantPriceExceptionInput,
  deps: MaintainPriceListDeps,
): Promise<GrantPriceExceptionResult> {
  if (!ctx.userId) throw new MissingActorError('GrantPriceException requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<GrantPriceExceptionResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasRole(tx, ROLE_GM))) {
      throw new RoleRequiredError(`GrantPriceException requires role ${ROLE_GM} (platform.my_roles()).`);
    }

    const service = await deps.repo.getServiceById(tx, input.serviceId);
    if (!service) {
      throw new ServiceNotFoundError(
        `no active catalog.services row for id ${input.serviceId} (Allowed: an existing, active ` +
          'service id).',
      );
    }
    if (service.minPrice === null) {
      throw new ServiceNotPriceableError(
        `service ${input.serviceId} has no min_price set (INV-C1-1) — no exception can be ` +
          'approved against a floor that does not exist.',
      );
    }

    assertValidValidity({ validFrom: input.validFrom, validTo: input.validTo, reviewAt: input.reviewAt });

    const approvedAt = deps.clock.now();
    const created = await deps.repo.insertPriceException(tx, {
      entityId: input.entityId,
      clientId: input.clientId,
      serviceId: input.serviceId,
      approvedPrice: input.approvedPrice,
      minPriceAtApproval: service.minPrice,
      reason: input.reason,
      validFrom: input.validFrom,
      validTo: input.validTo,
      approvedBy: actorId,
      approvedAt,
      reviewAt: input.reviewAt,
    });

    await writeOutboxEvent(tx, {
      entityId: input.entityId,
      aggregateType: PRICE_EXCEPTIONS_AGGREGATE_TYPE,
      aggregateId: created.id,
      eventType: PRICE_EXCEPTION_GRANTED_EVENT_TYPE,
      payload: {
        exceptionId: created.id,
        entityId: input.entityId,
        clientId: input.clientId,
        serviceId: input.serviceId,
        approvedPrice: input.approvedPrice,
        minPriceAtApproval: service.minPrice,
        validFrom: input.validFrom,
        validTo: input.validTo,
        reviewAt: input.reviewAt,
      },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: input.entityId,
      target: 'exception',
      recordId: created.id,
      operation: AUDIT_OPERATION_GRANT,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        approvedPrice: input.approvedPrice,
        minPriceAtApproval: service.minPrice,
        approvedBy: actorId,
      },
      occurredAt: approvedAt,
    });

    return { exceptionId: created.id };
  });
}
