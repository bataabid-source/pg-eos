// modules/catalog/application/maintain-price-list/import-price-list-lines.ts — WBS 1.2, M03
// catalog.
//
// ONE withIdempotentContext transaction (step 0) — all-or-nothing: every row is validated BEFORE
// any write, so the first offending row aborts the whole import with zero lines written (slice
// brief scope note). Lock order: (1) list-row lock + expectedVersion check, (2) role gate, (3)
// assertListEditable, (4) per-row: resolve service by code, floor check (PriceBelowFloorError
// carries the zero-based rowIndex), one-currency-per-list check, (5) the combined tier-ladder
// check over the whole list's existing lines (minus rows this import replaces) plus every new row
// (Master decision 5), (6) the inserts, (7) the unconditional version bump — exactly once, not
// per row, (8) one audit row, last.

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
const AUDIT_OPERATION_IMPORT = 'import';
const DEFAULT_FREE_UNITS = '0.000';

export interface ImportPriceListLineRow {
  readonly serviceCode: string;
  readonly price: string;
  readonly currency: string;
  readonly tierFrom?: string | null | undefined;
  readonly tierTo?: string | null | undefined;
  readonly freeUnits?: string | undefined;
  readonly notes?: string | undefined;
}

export interface ImportPriceListLinesInput {
  readonly priceListId: string;
  readonly rows: readonly ImportPriceListLineRow[];
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ImportPriceListLinesResult {
  readonly version: number;
  readonly lineCount: number;
}

interface ResolvedRow {
  readonly serviceId: string;
  readonly serviceCode: string;
  readonly price: string;
  readonly currency: string;
  readonly tierFrom: string | null;
  readonly tierTo: string | null;
  readonly freeUnits: string;
  readonly notes: string | null;
}

function sameTier(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Quantity.of(a).equals(Quantity.of(b));
}

function toTierLadderLine(row: { serviceId: string; tierFrom: string | null; tierTo: string | null; freeUnits: string }): TierLadderLine {
  return { serviceId: row.serviceId, tierFrom: row.tierFrom, tierTo: row.tierTo, freeUnits: row.freeUnits };
}

export async function importPriceListLines(
  ctx: WithContextCtx,
  input: ImportPriceListLinesInput,
  deps: MaintainPriceListDeps,
): Promise<ImportPriceListLinesResult> {
  if (!ctx.userId) throw new MissingActorError('ImportPriceListLines requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ImportPriceListLinesResult>(ctx, input.idem, async (tx) => {
    const list = await deps.repo.getPriceListForUpdate(tx, input.priceListId);
    if (list.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ImportPriceListLines: expectedVersion ${input.expectedVersion} no longer matches price ` +
          `list ${input.priceListId}'s version ${list.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasRole(tx, ROLE_CFO))) {
      throw new RoleRequiredError(`ImportPriceListLines requires role ${ROLE_CFO} (platform.my_roles()).`);
    }

    assertListEditable(list.status);

    let canonicalCurrency = await deps.repo.getAnyLineCurrency(tx, input.priceListId);
    const resolved: ResolvedRow[] = [];

    for (const [rowIndex, row] of input.rows.entries()) {
      const service = await deps.repo.getServiceByCode(tx, row.serviceCode);
      if (!service) {
        throw new ServiceNotFoundError(
          `row ${rowIndex}: no active catalog.services row for code "${row.serviceCode}" (Allowed: ` +
            'an existing, active service code).',
        );
      }
      if (service.minPrice === null) {
        throw new ServiceNotPriceableError(
          `row ${rowIndex}: service "${row.serviceCode}" has no min_price set (INV-C1-1).`,
        );
      }

      const price = Quantity.of(row.price);
      const minPrice = Quantity.of(service.minPrice);
      try {
        assertPriceMeetsFloor(price, minPrice);
      } catch (error) {
        if (error instanceof PriceBelowFloorError) {
          // pg-reviewer fix round 1 (finding 3): the message itself must carry the row, service
          // and prices — this is the string the 422 Problem's `detail` field forwards to the
          // client (handlers.ts's errorToApiFailure uses error.message verbatim).
          throw new PriceBelowFloorError(
            `row ${rowIndex}: service "${service.code}" price ${price.toString()} is below the ` +
              `floor ${minPrice.toString()} (Master decision 4, the acceptance criterion "price ` +
              'below floor rejected").',
            {
              serviceCode: service.code,
              price: price.toString(),
              minPrice: minPrice.toString(),
              rowIndex,
            },
          );
        }
        throw error;
      }

      if (canonicalCurrency === null) {
        canonicalCurrency = row.currency;
      } else if (canonicalCurrency !== row.currency) {
        throw new CurrencyMismatchError(
          `row ${rowIndex}: price list ${input.priceListId} already prices in ${canonicalCurrency}; ` +
            `a row in ${row.currency} was rejected (Master decision 4 — one currency per list).`,
        );
      }

      resolved.push({
        serviceId: service.id,
        serviceCode: service.code,
        price: row.price,
        currency: row.currency,
        tierFrom: row.tierFrom ?? null,
        tierTo: row.tierTo ?? null,
        freeUnits: row.freeUnits ?? DEFAULT_FREE_UNITS,
        notes: row.notes ?? null,
      });
    }

    const existingLines = await deps.repo.getAllLines(tx, input.priceListId);
    const isReplaced = (existing: PriceListLineRow): boolean =>
      resolved.some((row) => row.serviceId === existing.serviceId && sameTier(row.tierFrom, existing.tierFrom));
    const combined: TierLadderLine[] = [
      ...existingLines.filter((row) => !isReplaced(row)).map(toTierLadderLine),
      ...resolved.map(toTierLadderLine),
    ];
    validateTierLadder(combined);

    for (const row of resolved) {
      await deps.repo.upsertLine(tx, {
        priceListId: input.priceListId,
        serviceId: row.serviceId,
        price: row.price,
        currency: row.currency,
        tierFrom: row.tierFrom,
        tierTo: row.tierTo,
        freeUnits: row.freeUnits,
        notes: row.notes,
      });
    }

    const newVersion = await deps.repo.updatePriceList(tx, input.priceListId, {});

    await deps.repo.writeAuditRow(tx, {
      entityId: list.entityId,
      target: 'list',
      recordId: input.priceListId,
      operation: AUDIT_OPERATION_IMPORT,
      correlationId: input.correlationId,
      actorId,
      newValue: { lineCount: resolved.length, version: newVersion },
      occurredAt: deps.clock.now(),
    });

    return { version: newVersion, lineCount: resolved.length };
  });
}
