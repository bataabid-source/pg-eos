// modules/sales/application/resolve-price/ports.ts — WBS 1.4, M02 sales pricing engine.
//
// application/ layer: the port resolvePrice programs against. This is a READ-ONLY resolution
// engine (slice brief "Scope taken by the lane") — no clock, no id generator, no ledger, no
// logger port: every read goes through the ONE caller-supplied `withContext(ctx, fn)` transaction
// (../../infrastructure/resolve-price/repository.ts implements `PricingRepository`);
// ../../api/resolve-price/composition.ts wires it.

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { TieredPriceLine } from '../../domain/resolve-price/tiered-pricing.js';

export interface AccountRow {
  readonly id: string;
  readonly segmentId: string | null;
}

export interface ServiceRow {
  readonly id: string;
}

export interface PriceExceptionRow {
  readonly id: string;
  readonly approvedPrice: string;
}

export interface ContractRow {
  readonly id: string;
  readonly priceListId: string | null;
}

export interface PriceListRow {
  readonly id: string;
  /** true iff the list is a transfer-pricing (intercompany) list — out of scope for this engine
   *  (slice brief "Scope taken by the lane"). The list is still "found" for the `pending` reason
   *  (Master decision 2e) even though its lines are never used to price a client-facing request. */
  readonly isInternal: boolean;
}

/** Every read the resolve-price use case needs, as an interface — the port the application layer
 *  programs against. Implemented by ../../infrastructure/resolve-price/repository.ts. Every
 *  method reads `catalog.*`/`sales.*` directly via SQL against the `tx` the caller's own
 *  `withContext(ctx, fn)` already opened (same cross-schema-read precedent as the golden slice's
 *  own repository reading `wms.locations`/`wms.skus` and `sales.accounts` directly from
 *  `modules/wms`). */
export interface PricingRepository {
  /** `entityId` gates visibility: `sales.accounts` carries no `entity_id` column of its own (an
   *  account is one per client, shared across entities), so this method itself enforces the same
   *  entity-scope rule RLS applies elsewhere (Master decision 7) — a caller whose ctx does not
   *  cover `entityId` gets `null` here, exactly as if the account did not exist, never a leaked
   *  RLS error (pg-reviewer round 1 finding 8). */
  getAccountById(tx: NodePgDatabase, accountId: string, entityId: string): Promise<AccountRow | null>;
  getServiceById(tx: NodePgDatabase, serviceId: string): Promise<ServiceRow | null>;
  /** Master decision 2a: `client_id = accountId`, `service_id = serviceId`, `valid_from <=
   *  asOfDate <= valid_to`, tie-break latest `approved_at`. */
  findActiveException(
    tx: NodePgDatabase,
    params: { readonly entityId: string; readonly accountId: string; readonly serviceId: string; readonly asOfDate: string },
  ): Promise<PriceExceptionRow | null>;
  /** Master decision 2b: `account_id = accountId`, `entity_id = entityId`, `status = 'active'`,
   *  validity covers `asOfDate`, `price_list_id is not null`, tie-break latest `start_date`. */
  findActiveContract(
    tx: NodePgDatabase,
    params: { readonly accountId: string; readonly entityId: string; readonly asOfDate: string },
  ): Promise<ContractRow | null>;
  /** Master decisions 2c/2d — pass `segmentId: null` for the standard-list branch. Always
   *  `client_id is null`, `status = 'active'`, validity covers `asOfDate`; tie-break latest
   *  `valid_from`, then lowest `id` (slice brief "Scope taken by the lane"). Deliberately does NOT
   *  filter `is_internal` here — an internal list still counts as "found" for the `pending`
   *  reason (Master decision 2e); the caller skips its lines instead (pg-reviewer round 1
   *  finding 7). */
  findPriceList(
    tx: NodePgDatabase,
    params: { readonly entityId: string; readonly segmentId: string | null; readonly asOfDate: string },
  ): Promise<PriceListRow | null>;
  /** `catalog.price_list_lines` for one list/service, filtered to `currency = 'KWD'` (Master
   *  decision 6), sorted by `tier_from` ascending. Empty array = "no line for this service" —
   *  the caller falls through per Master decision 3. */
  getPriceListLines(
    tx: NodePgDatabase,
    params: { readonly priceListId: string; readonly serviceId: string },
  ): Promise<readonly TieredPriceLine[]>;
}

/** Everything resolvePrice needs, injected by the composition root
 *  (../../api/resolve-price/composition.ts). */
export interface ResolvePriceDeps {
  readonly repo: PricingRepository;
}
