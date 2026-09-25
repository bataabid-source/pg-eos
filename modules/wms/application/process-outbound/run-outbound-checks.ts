// modules/wms/application/process-outbound/run-outbound-checks.ts — WBS 2.11 part 1.
//
// ONE withIdempotentContext transaction. Lock order (brief Master decision 3): (1) order-row lock
// + expectedVersion check, (2) the machine's own transition-guard check (RUN_CHECKS_PASS must be
// legal from the order's current status — only 'draft' in this part), (3) conditions 1, 3-9 in
// order as pure PRE-CHECKS — the first failure THROWS its typed error and nothing is persisted
// (the whole transaction rolls back); (4) condition 2 (credit hold), checked LAST — on failure the
// order transitions to 'credit_rejected' instead of throwing; (5) on every-condition pass, the
// order transitions to 'checks_pending'; (6) the unconditional version bump with
// credit_check_passed/credit_checked_at; (7) the outbox event ('wms.outbound.checks_started' on
// pass, 'wms.outbound.credit_rejected' on condition-2 failure); (8) the audit row (last,
// ADR-0002). Condition 10 (quantity within the agreed order limit) is SKIPPED — no schema source
// (brief Scope, G-01 batched, not counted toward the ten).
//
// This layer is ORCHESTRATION ONLY (fix round 1 finding 11): it fetches every condition's data via
// wms's own repository (../../infrastructure/process-outbound/repository.ts, no cross-module
// TypeScript import — brief "Scope taken by the lane"), then calls the PURE decision functions in
// ../../domain/process-outbound/invariants.ts to decide pass/fail. The as-of date is read from
// `deps.clock` ONCE here and passed down as a plain ISO string — never `new Date()` inside
// domain/ (CLAUDE.md, no exceptions).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { OUTBOUND_ORDER_EVENTS, advanceOutboundOrder, canTransition } from '../../domain/process-outbound/machine.js';
import {
  IllegalTransitionError,
  MissingActorError,
  StaleVersionError,
  CreditHoldError,
} from '../../domain/process-outbound/errors.js';
import {
  assertContractActive,
  assertDeliveryAddressComplete,
  assertNonBlockedLocationsSufficient,
  assertServicePriced,
  assertShelfLifeSufficient,
  assertSkuBelongsToOrderClient,
  assertSkuNotBlocked,
  assertSkuResolved,
  assertSufficientStock,
  evaluateCreditHold,
} from '../../domain/process-outbound/invariants.js';
import type { ProcessOutboundDeps } from './ports.js';

const AUDIT_OPERATION_CHECKS = 'update';
const OUTBOUND_CHECKS_STARTED_EVENT: CatalogedEventType = 'wms.outbound.checks_started';
const OUTBOUND_CREDIT_REJECTED_EVENT: CatalogedEventType = 'wms.outbound.credit_rejected';
const OUTBOUND_ORDERS_AGGREGATE_TYPE = 'wms.outbound_orders';
const SERVICE_CODE_OF01 = 'OF-01';
// order types that do NOT need a delivery address (brief Master decision 3, condition 8 note).
const NO_DELIVERY_ORDER_TYPES: ReadonlySet<string> = new Set(['transfer', 'return_to_client']);

export interface RunOutboundChecksInput {
  readonly orderId: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface RunOutboundChecksResult {
  readonly status: 'checks_pending' | 'credit_rejected';
  readonly version: number;
  /** Non-null only on the `credit_rejected` outcome (fix round 1 finding 9) — condition 2 never
   *  throws, so the api/ layer's Problem envelope needs the i18n key/params from this result
   *  shape instead of from a caught error. A concrete (not `unknown`-valued) shape — this result
   *  crosses withIdempotentContext's JSON-plain boundary (packages/db/src/idempotency.ts). */
  readonly i18nKey: string | null;
  readonly params: { readonly reason: string | null } | null;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function runOutboundChecks(
  ctx: WithContextCtx,
  input: RunOutboundChecksInput,
  deps: ProcessOutboundDeps,
): Promise<RunOutboundChecksResult> {
  if (!ctx.userId) throw new MissingActorError('RunOutboundChecks requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<RunOutboundChecksResult>(ctx, input.idem, async (tx) => {
    const order = await deps.repo.getOrderForUpdate(tx, input.orderId);
    if (order.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `RunOutboundChecks: expectedVersion ${input.expectedVersion} no longer matches order ` +
          `${input.orderId}'s version ${order.version} (optimistic lock).`,
      );
    }

    if (!canTransition(order.status, OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS)) {
      throw new IllegalTransitionError(
        `RunOutboundChecks is illegal from status "${order.status}" (the machine allows it only ` +
          `from "draft").`,
      );
    }

    const asOfDate = toIsoDate(deps.clock.now());
    const lines = await deps.repo.getOrderLines(tx, input.orderId);

    // --- condition 1: contract active -------------------------------------------------------
    // Fix round 1 finding 4: looked up by (clientId, entityId) always; contractId (when the order
    // carries one) is only a narrowing filter, never the sole lookup key.
    const contract = await deps.repo.getContractCheck(tx, {
      clientId: order.clientId,
      entityId: order.entityId,
      contractId: order.contractId ?? undefined,
    });
    assertContractActive(contract, asOfDate, input.orderId);

    // --- condition 3: sufficient stock, every line ------------------------------------------
    // Fetch every line's SKU row first (fix round 1 finding 6 — condition 3's message needs the
    // SKU code) without throwing on mismatch yet; condition 4 below throws on mismatch using the
    // same map.
    const skuChecks = new Map<string, NonNullable<Awaited<ReturnType<typeof deps.repo.getSkuCheck>>>>();
    for (const line of lines) {
      const sku = await deps.repo.getSkuCheck(tx, line.skuId);
      if (sku) skuChecks.set(line.skuId, sku);
    }
    for (const line of lines) {
      const availability = await deps.repo.getStockAvailability(tx, {
        clientId: order.clientId,
        skuId: line.skuId,
        warehouseId: order.warehouseId,
      });
      assertSufficientStock({
        skuId: line.skuId,
        skuCode: skuChecks.get(line.skuId)?.code ?? line.skuId,
        availableSum: availability.availableSum,
        ordered: line.qtyOrdered,
        singleLocationCode: availability.singleLocationCode,
      });
    }

    // --- condition 4: SKU belongs to the order's own client, every line ---------------------
    for (const line of lines) {
      // Escalated fix round, finding 11: an unresolved row is SkuNotFoundError ({ skuId }); only a
      // resolved row owned by another client is SkuClientMismatchError (with the SKU's code).
      const sku = skuChecks.get(line.skuId);
      assertSkuResolved(sku, line.skuId);
      assertSkuBelongsToOrderClient({
        skuId: line.skuId,
        skuCode: sku.code,
        skuClientId: sku.clientId,
        orderClientId: order.clientId,
      });
    }

    // --- condition 5: remaining shelf life, every line whose SKU tracks expiry --------------
    for (const line of lines) {
      const sku = skuChecks.get(line.skuId);
      if (!sku || !sku.trackExpiry || sku.minRemainingLifeIssueDays === null) continue;
      const lots = await deps.repo.getStockLots(tx, { clientId: order.clientId, skuId: line.skuId, warehouseId: order.warehouseId });
      assertShelfLifeSufficient(lots, asOfDate, sku.minRemainingLifeIssueDays, sku.code);
    }

    // --- condition 6: SKU not blocked, every line -------------------------------------------
    for (const line of lines) {
      const sku = skuChecks.get(line.skuId);
      if (sku) assertSkuNotBlocked({ skuId: line.skuId, skuCode: sku.code, status: sku.status });
    }

    // --- condition 7: non-blocked stocked locations hold enough for the order, every line ----
    for (const line of lines) {
      const blocks = await deps.repo.getStockedLocationBlocks(tx, {
        clientId: order.clientId,
        skuId: line.skuId,
        warehouseId: order.warehouseId,
      });
      assertNonBlockedLocationsSufficient(blocks, line.qtyOrdered, line.skuId);
    }

    // --- condition 8: delivery address complete, when the order type implies delivery -------
    assertDeliveryAddressComplete(
      {
        orderId: input.orderId,
        orderType: order.orderType,
        shipToName: order.shipToName,
        shipToPhone: order.shipToPhone,
        shipToAddress: order.shipToAddress,
        shipToArea: order.shipToArea,
      },
      NO_DELIVERY_ORDER_TYPES,
    );

    // --- condition 9: a service price exists for OF-01 --------------------------------------
    const serviceId = await deps.repo.getServiceIdByCode(tx, SERVICE_CODE_OF01);
    const hasPricedLine =
      serviceId !== null && contract.priceListId !== null
        ? await deps.repo.hasPricedLine(tx, { priceListId: contract.priceListId, serviceId, asOfDate })
        : false;
    const hasPriceException =
      serviceId !== null
        ? await deps.repo.hasPriceException(tx, { entityId: order.entityId, clientId: order.clientId, serviceId, asOfDate })
        : false;
    assertServicePriced(hasPricedLine, hasPriceException, SERVICE_CODE_OF01, input.orderId);

    // --- condition 10: BLOCKED — no schema source (brief Scope, G-01 batched). Never evaluated.

    // --- condition 2: credit hold, checked LAST — failure transitions, never throws ---------
    const account = await deps.repo.getAccountCredit(tx, order.clientId);
    const occurredAt = deps.clock.now();
    const creditCheckedAt = occurredAt;
    const creditDecision = evaluateCreditHold(account);

    if (creditDecision.onHold) {
      // Fix round 1 finding 9: CreditHoldError is constructed (not thrown) to derive the
      // i18nKey/params pair for the returned result — condition 2 persists credit_rejected
      // instead of throwing, per brief Master decision 3.
      const creditError = new CreditHoldError(
        `RunOutboundChecks: order ${input.orderId}'s client is on credit hold: ${creditDecision.holdReason ?? 'n/a'}.`,
        { reason: creditDecision.holdReason },
      );
      const newStatus = advanceOutboundOrder(order.status, [OUTBOUND_ORDER_EVENTS.RUN_CHECKS_CREDIT_FAIL]);
      const newVersion = await deps.repo.updateOrder(tx, input.orderId, {
        status: newStatus,
        creditCheckPassed: false,
        creditCheckedAt,
      });

      await writeOutboxEvent(tx, {
        entityId: order.entityId,
        aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
        aggregateId: input.orderId,
        eventType: OUTBOUND_CREDIT_REJECTED_EVENT,
        payload: { orderId: input.orderId, status: newStatus, reason: creditDecision.holdReason },
        correlationId: input.correlationId,
        actorId,
      });

      await deps.repo.writeAuditRow(tx, {
        entityId: order.entityId,
        target: 'order',
        recordId: input.orderId,
        operation: AUDIT_OPERATION_CHECKS,
        correlationId: input.correlationId,
        actorId,
        newValue: { status: newStatus, version: newVersion, creditCheckPassed: false, holdReason: creditDecision.holdReason },
        occurredAt,
      });

      return {
        status: 'credit_rejected',
        version: newVersion,
        i18nKey: creditError.i18nKey,
        params: { reason: creditDecision.holdReason },
      };
    }

    const newStatus = advanceOutboundOrder(order.status, [OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS]);
    const newVersion = await deps.repo.updateOrder(tx, input.orderId, {
      status: newStatus,
      creditCheckPassed: true,
      creditCheckedAt,
    });

    await writeOutboxEvent(tx, {
      entityId: order.entityId,
      aggregateType: OUTBOUND_ORDERS_AGGREGATE_TYPE,
      aggregateId: input.orderId,
      eventType: OUTBOUND_CHECKS_STARTED_EVENT,
      payload: { orderId: input.orderId, status: newStatus },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: order.entityId,
      target: 'order',
      recordId: input.orderId,
      operation: AUDIT_OPERATION_CHECKS,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, creditCheckPassed: true },
      occurredAt,
    });

    return { status: 'checks_pending', version: newVersion, i18nKey: null, params: null };
  });
}
