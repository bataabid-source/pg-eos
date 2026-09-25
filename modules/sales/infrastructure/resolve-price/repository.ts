// modules/sales/infrastructure/resolve-price/repository.ts — WBS 1.4, M02 sales pricing engine.
//
// infrastructure/ layer: every DB statement for the resolve-price use case, run against the `tx`
// the caller's own `withContext(ctx, fn)` already opened. Implements
// ../../application/resolve-price/ports.ts's `PricingRepository`. Read-only — no write statement
// in this file.
//
// Cross-schema reads follow existing precedent, not a new exception (slice brief "Scope taken by
// the lane"): this module reads `catalog.services`/`catalog.price_lists`/
// `catalog.price_list_lines`/`catalog.price_exceptions` and `sales.accounts`/`sales.contracts`
// directly via SQL — a schema-level read, not a TypeScript cross-module import, so the boundaries
// lint rule does not fire.
//
// Currency (Master decision 6/brief decision 4): every list/exception read is filtered to
// `currency = 'KWD'` where the row carries a currency column; a mixed-currency-only list is
// treated as "no line" by the caller (falls through).

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { TieredPriceLine } from '../../domain/resolve-price/tiered-pricing.js';
import type { AccountRow, ContractRow, PriceExceptionRow, PriceListRow, PricingRepository, ServiceRow } from '../../application/resolve-price/ports.js';

const PRICING_CURRENCY = 'KWD';
const CONTRACT_STATUS_ACTIVE = 'active';
const PRICE_LIST_STATUS_ACTIVE = 'active';

/** `entityId` gates visibility (pg-reviewer round 1 finding 8): `sales.accounts` carries no
 *  `entity_id` of its own, so this method enforces the entity-scope rule directly — the same
 *  `platform.is_internal() and <entity> = any(platform.allowed_entities())` check the schema's own
 *  RLS-backed functions use elsewhere (01-Data-Model.sql, `platform.next_doc_no`). A caller whose
 *  ctx does not cover `entityId` gets zero rows here, indistinguishable from an unknown account —
 *  never a leaked RLS error. */
async function getAccountById(tx: NodePgDatabase, accountId: string, entityId: string): Promise<AccountRow | null> {
  const result = await tx.execute<{ id: string; segment_id: string | null }>(sql`
    select id, segment_id
      from sales.accounts
     where id = ${accountId}::uuid
       and platform.is_internal()
       and ${entityId}::uuid = any(platform.allowed_entities())
  `);
  const row = result.rows[0];
  return row ? { id: row.id, segmentId: row.segment_id } : null;
}

async function getServiceById(tx: NodePgDatabase, serviceId: string): Promise<ServiceRow | null> {
  const result = await tx.execute<{ id: string }>(sql`
    select id from catalog.services where id = ${serviceId}::uuid
  `);
  const row = result.rows[0];
  return row ? { id: row.id } : null;
}

/** Master decision 2a: `client_id = accountId`, `service_id = serviceId`, `valid_from <=
 *  asOfDate <= valid_to`, tie-break latest `approved_at`. */
async function findActiveException(
  tx: NodePgDatabase,
  params: { readonly entityId: string; readonly accountId: string; readonly serviceId: string; readonly asOfDate: string },
): Promise<PriceExceptionRow | null> {
  const result = await tx.execute<{ id: string; approved_price: string }>(sql`
    select id, approved_price::text as approved_price
      from catalog.price_exceptions
     where entity_id = ${params.entityId}::uuid
       and client_id = ${params.accountId}::uuid
       and service_id = ${params.serviceId}::uuid
       and valid_from <= ${params.asOfDate}::date
       and valid_to >= ${params.asOfDate}::date
     order by approved_at desc, id asc
     limit 1
  `);
  const row = result.rows[0];
  return row ? { id: row.id, approvedPrice: row.approved_price } : null;
}

/** Master decision 2b: `account_id = accountId`, `entity_id = entityId`, `status = 'active'`,
 *  validity covers `asOfDate`, `price_list_id is not null` (applied HERE in the SQL, not left to
 *  the caller — pg-reviewer round 1 finding 2: an active contract with a null list must never
 *  shadow, via the tie-break, an older active contract that DOES have one), and the joined list
 *  itself must be a genuine client-facing list of the SAME entity (`pl.is_internal = false`,
 *  `pl.entity_id = entityId` — finding 1). A contract whose own list fails that check is
 *  therefore simply not returned by this query — the caller falls through to the segment/standard
 *  list exactly as it would for "no active contract found", never a data-integrity error.
 *  Tie-break latest `start_date`. */
async function findActiveContract(
  tx: NodePgDatabase,
  params: { readonly accountId: string; readonly entityId: string; readonly asOfDate: string },
): Promise<ContractRow | null> {
  const result = await tx.execute<{ id: string; price_list_id: string | null }>(sql`
    select c.id, c.price_list_id
      from sales.contracts c
      join catalog.price_lists pl on pl.id = c.price_list_id
     where c.account_id = ${params.accountId}::uuid
       and c.entity_id = ${params.entityId}::uuid
       and c.status = ${CONTRACT_STATUS_ACTIVE}
       and c.start_date <= ${params.asOfDate}::date
       and (c.end_date is null or c.end_date >= ${params.asOfDate}::date)
       and c.price_list_id is not null
       and pl.entity_id = ${params.entityId}::uuid
       and pl.is_internal = false
     order by c.start_date desc, c.id asc
     limit 1
  `);
  const row = result.rows[0];
  return row ? { id: row.id, priceListId: row.price_list_id } : null;
}

/** Master decisions 2c/2d — `segmentId: null` selects the standard (entity default) list. Tie-
 *  break latest `valid_from`, then lowest `id` (slice brief "Scope taken by the lane", a data-
 *  hygiene default, not a schema rule). */
async function findPriceList(
  tx: NodePgDatabase,
  params: { readonly entityId: string; readonly segmentId: string | null; readonly asOfDate: string },
): Promise<PriceListRow | null> {
  const result = await tx.execute<{ id: string; is_internal: boolean }>(sql`
    select id, is_internal
      from catalog.price_lists
     where entity_id = ${params.entityId}::uuid
       and segment_id is not distinct from ${params.segmentId}::uuid
       and client_id is null
       and status = ${PRICE_LIST_STATUS_ACTIVE}
       and valid_from <= ${params.asOfDate}::date
       and (valid_to is null or valid_to >= ${params.asOfDate}::date)
     order by valid_from desc, id asc
     limit 1
  `);
  const row = result.rows[0];
  return row ? { id: row.id, isInternal: row.is_internal } : null;
}

/** `catalog.price_list_lines` for one list/service, filtered to `currency = 'KWD'` (Master
 *  decision 6), sorted by `tier_from` ascending (nulls first — the sole row of a flat line). */
async function getPriceListLines(
  tx: NodePgDatabase,
  params: { readonly priceListId: string; readonly serviceId: string },
): Promise<readonly TieredPriceLine[]> {
  const result = await tx.execute<{
    price: string;
    tier_from: string | null;
    tier_to: string | null;
    free_units: string;
  }>(sql`
    select price::text as price, tier_from::text as tier_from, tier_to::text as tier_to,
           coalesce(free_units, 0)::text as free_units
      from catalog.price_list_lines
     where price_list_id = ${params.priceListId}::uuid
       and service_id = ${params.serviceId}::uuid
       and currency = ${PRICING_CURRENCY}
     order by tier_from asc nulls first
  `);
  return result.rows.map((row) => ({
    price: row.price,
    tierFrom: row.tier_from,
    tierTo: row.tier_to,
    freeUnits: row.free_units,
  }));
}

export const pricingRepository: PricingRepository = {
  getAccountById,
  getServiceById,
  findActiveException,
  findActiveContract,
  findPriceList,
  getPriceListLines,
};
