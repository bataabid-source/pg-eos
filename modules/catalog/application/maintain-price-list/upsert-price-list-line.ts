// modules/catalog/application/maintain-price-list/upsert-price-list-line.ts — WBS 1.2, M03
// catalog.
//
// ONE withIdempotentContext transaction (step 0). Lock order: (1) list-row lock + expectedVersion
// check, (2) role gate, (3) assertListEditable (Master decision 3 — PriceListLockedError on a
// non-draft list), (4) resolve the service by code (ServiceNotFoundError/
// ServiceNotPriceableError), (5) the floor check — THE acceptance criterion — BEFORE any write
// (Master decision 4), (6) the one-currency-per-list check (CurrencyMismatchError), (7) the tier
// ladder check against the service's existing lines (Master decision 5), (8) the upsert, (9) the
// unconditional version bump, (10) the audit row, last.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { Quantity } from '@pg-eos/domain-kit';

import { assertListEditable, assertPriceMeetsFloor } from '../../domain/maintain-price-list/invariants.js';
import { validateTierLadder, type TierLadderLine } from '../../domain/maintain-price-list/tier-ladder.js';
import {
  CurrencyMismatchError,
  MissingActorError,
  PriceBelowFloorError,
  RoleRequiredError,
  ServiceNotFoundError,
  ServiceNotPriceableError,
  StaleVersionError,
} from '../../domain/maintain-price-list/errors.js';
import type { MaintainPriceListDeps, PriceListLineRow } from './ports.js';

const ROLE_CFO = 'CFO';
const AUDIT_OPERATION_UPSERT_LINE = 'upsert';
const DEFAULT_FREE_UNITS = '0.000';

export interface UpsertPriceListLineInput {
  readonly priceListId: string;
  readonly serviceCode: string;
  readonly price: string;
  readonly currency: string;
  readonly tierFrom?: string | null | undefined;
  readonly tierTo?: string | null | undefined;
  readonly freeUnits?: string | undefined;
  readonly notes?: string | undefined;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface UpsertPriceListLineResult {
  readonly version: number;
  readonly lineId: string;
}

function sameTier(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Quantity.of(a).equals(Quantity.of(b));
}

function toTierLadderLine(row: PriceListLineRow): TierLadderLine {
  return { serviceId: row.serviceId, tierFrom: row.tierFrom, tierTo: row.tierTo, freeUnits: row.freeUnits };
}

export async function upsertPriceListLine(
  ctx: WithContextCtx,
  input: UpsertPriceListLineInput,
  deps: MaintainPriceListDeps,
): Promise<UpsertPriceListLineResult> {
  if (!ctx.userId) throw new MissingActorError('UpsertPriceListLine requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<UpsertPriceListLineResult>(ctx, input.idem, async (tx) => {
    const list = await deps.repo.getPriceListForUpdate(tx, input.priceListId);
    if (list.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `UpsertPriceListLine: expectedVersion ${input.expectedVersion} no longer matches price ` +
          `list ${input.priceListId}'s version ${list.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`UpsertPriceListLine requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    assertListEditable(list.status);

    const service = await deps.repo.getServiceByCode(tx, input.serviceCode);
    if (!service) {
      throw new ServiceNotFoundError(
        `no active catalog.services row for code "${input.serviceCode}" (Allowed: an existing, ` +
          'active service code).',
      );
    }
    if (service.minPrice === null) {
      throw new ServiceNotPriceableError(
        `service "${input.serviceCode}" has no min_price set (INV-C1-1) — it cannot be priced ` +
          'until the data gate (WBS 1.3) sets one.',
      );
    }

    const price = Quantity.of(input.price);
    const minPrice = Quantity.of(service.minPrice);
    try {
      assertPriceMeetsFloor(price, minPrice);
    } catch (error) {
      if (error instanceof PriceBelowFloorError) {
        throw new PriceBelowFloorError(error.message, {
          serviceCode: service.code,
          price: price.toString(),
          minPrice: minPrice.toString(),
        });
      }
      throw error;
    }

    const canonicalCurrency = await deps.repo.getAnyLineCurrency(tx, input.priceListId);
    if (canonicalCurrency !== null && canonicalCurrency !== input.currency) {
      throw new CurrencyMismatchError(
        `price list ${input.priceListId} already prices in ${canonicalCurrency}; a line in ` +
          `${input.currency} was rejected (Master decision 4 — one currency per list).`,
      );
    }

    const tierFrom = input.tierFrom ?? null;
    const tierTo = input.tierTo ?? null;
    const freeUnits = input.freeUnits ?? DEFAULT_FREE_UNITS;

    const existingForService = await deps.repo.getLinesForService(tx, input.priceListId, service.id);
    const replacedByThisWrite = existingForService.filter((row) => !sameTier(row.tierFrom, tierFrom));
    const candidate: TierLadderLine = { serviceId: service.id, tierFrom, tierTo, freeUnits };
    validateTierLadder([...replacedByThisWrite.map(toTierLadderLine), candidate]);

    const upserted = await deps.repo.upsertLine(tx, {
      priceListId: input.priceListId,
      serviceId: service.id,
      price: input.price,
      currency: input.currency,
      tierFrom,
      tierTo,
      freeUnits,
      notes: input.notes ?? null,
    });

    const newVersion = await deps.repo.updatePriceList(tx, input.priceListId, {});

    await deps.repo.writeAuditRow(tx, {
      entityId: list.entityId,
      target: 'line',
      recordId: upserted.id,
      operation: AUDIT_OPERATION_UPSERT_LINE,
      correlationId: input.correlationId,
      actorId,
      newValue: { serviceCode: service.code, price: input.price, currency: input.currency, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion, lineId: upserted.id };
  });
}
