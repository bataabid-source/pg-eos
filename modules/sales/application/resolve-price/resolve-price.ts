// modules/sales/application/resolve-price/resolve-price.ts — WBS 1.4, M02 sales pricing engine.
//
// The use case's one public function (Master decision 1): resolve the price to charge for
// `{ accountId, serviceId, entityId, qty, asOfDate }` by trying, in order, exception -> contract
// annex -> segment list -> standard list -> pending (Master decision 2), never inventing a price
// (Master decision 5). Read-only — no write, no outbox row, no version bump; every read runs
// inside the ONE `withContext(ctx, fn)` transaction this function opens.

import { Money, Quantity } from '@pg-eos/domain-kit';
import type { WithContextCtx } from '@pg-eos/db';
import { withContext } from '@pg-eos/db';
import { ResolvePriceInputSchema } from '@pg-eos/contracts/sales/resolve-price';
import type { ResolvePriceInput as ContractResolvePriceInput, ResolvePriceResult as ContractResolvePriceResult } from '@pg-eos/contracts/sales/resolve-price';

import { AccountNotFoundError, ServiceNotFoundError } from '../../domain/resolve-price/errors.js';
import { computeTieredPrice } from '../../domain/resolve-price/tiered-pricing.js';
import type { ResolvePriceDeps } from './ports.js';

// pg-reviewer round 1 finding 5: one source of truth — the Zod-inferred types from the contract,
// never a hand-written duplicate.
export type ResolvePriceInput = ContractResolvePriceInput;
export type ResolvePriceResult = ContractResolvePriceResult;
export type UnitPriceSource = Extract<ResolvePriceResult, { readonly status: 'priced' }>['unitPriceSource'];

// The two pending reasons Master decision 2e names — no third reason is ever produced.
const REASON_NO_EXCEPTION_NO_LIST = 'no-exception-no-list';
const REASON_RESOLVED_LIST_HAS_NO_LINE = 'resolved-list-has-no-line-for-service';

export async function resolvePrice(
  ctx: WithContextCtx,
  rawInput: ResolvePriceInput,
  deps: ResolvePriceDeps,
): Promise<ResolvePriceResult> {
  // pg-reviewer round 1 finding 4: the real entry point must itself reject a non-positive qty
  // (and every other contract-level rule) BEFORE any DB read — never rely on the schema having
  // been exercised only in isolation by a test.
  const input = ResolvePriceInputSchema.parse(rawInput);

  return withContext(ctx, async (tx) => {
    const account = await deps.repo.getAccountById(tx, input.accountId, input.entityId);
    if (!account) {
      throw new AccountNotFoundError(
        `no sales.accounts row visible for id ${input.accountId} (Allowed: an existing account in the caller's entities)`,
      );
    }

    const service = await deps.repo.getServiceById(tx, input.serviceId);
    if (!service) {
      throw new ServiceNotFoundError(
        `no catalog.services row visible for id ${input.serviceId} (Allowed: an existing, seeded service)`,
      );
    }

    const qty = Quantity.of(input.qty);

    // a. Exception — flat unit price, overrides every other branch (Master decision 2a).
    const exception = await deps.repo.findActiveException(tx, {
      entityId: input.entityId,
      accountId: input.accountId,
      serviceId: input.serviceId,
      asOfDate: input.asOfDate,
    });
    if (exception) {
      // Master decision 3 (brief): "An exception is a flat unit price, not a tier ladder" —
      // total = qty × approved_price directly, no tier walk.
      const total = Money.of(exception.approvedPrice).multiply(qty.toString());
      return {
        status: 'priced',
        unitPriceSource: 'exception',
        totalPrice: total.toString(),
        priceExceptionId: exception.id,
      };
    }

    // Tracks whether ANY branch found a resolvable list/contract that simply had no line for this
    // service — distinguishes the two pending reasons (Master decision 2e).
    let anyListFound = false;

    // b. Contract annex (Master decision 2b/3): an active contract with its own price list. A
    // list with no line for the service falls through to (c), it does NOT stop here.
    const contract = await deps.repo.findActiveContract(tx, {
      accountId: input.accountId,
      entityId: input.entityId,
      asOfDate: input.asOfDate,
    });
    if (contract && contract.priceListId) {
      anyListFound = true;
      const lines = await deps.repo.getPriceListLines(tx, { priceListId: contract.priceListId, serviceId: input.serviceId });
      if (lines.length > 0) {
        const total = computeTieredPrice(lines, qty);
        return {
          status: 'priced',
          unitPriceSource: 'contract',
          totalPrice: total.toString(),
          priceListId: contract.priceListId,
          contractId: contract.id,
        };
      }
    }

    // c. Segment list (Master decision 2c) — skipped entirely when the account has no segment.
    if (account.segmentId) {
      const segmentList = await deps.repo.findPriceList(tx, {
        entityId: input.entityId,
        segmentId: account.segmentId,
        asOfDate: input.asOfDate,
      });
      if (segmentList) {
        anyListFound = true;
        // Master decision 12 (slice brief "Scope taken by the lane"): intercompany/transfer
        // pricing (is_internal = true) is out of scope — an internal list is "found" for the
        // pending reason but its lines are never used to price a client-facing request
        // (pg-reviewer round 1 finding 7).
        const lines = segmentList.isInternal
          ? []
          : await deps.repo.getPriceListLines(tx, { priceListId: segmentList.id, serviceId: input.serviceId });
        if (lines.length > 0) {
          const total = computeTieredPrice(lines, qty);
          return {
            status: 'priced',
            unitPriceSource: 'segment_list',
            totalPrice: total.toString(),
            priceListId: segmentList.id,
          };
        }
      }
    }

    // d. Standard list (Master decision 2d) — the entity's default list.
    const standardList = await deps.repo.findPriceList(tx, {
      entityId: input.entityId,
      segmentId: null,
      asOfDate: input.asOfDate,
    });
    if (standardList) {
      anyListFound = true;
      const lines = standardList.isInternal
        ? []
        : await deps.repo.getPriceListLines(tx, { priceListId: standardList.id, serviceId: input.serviceId });
      if (lines.length > 0) {
        const total = computeTieredPrice(lines, qty);
        return {
          status: 'priced',
          unitPriceSource: 'standard_list',
          totalPrice: total.toString(),
          priceListId: standardList.id,
        };
      }
    }

    // e. Pending — never throw, never invent a price (Master decision 5).
    return {
      status: 'pending',
      reason: anyListFound ? REASON_RESOLVED_LIST_HAS_NO_LINE : REASON_NO_EXCEPTION_NO_LIST,
    };
  });
}
