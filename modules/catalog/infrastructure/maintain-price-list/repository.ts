// modules/catalog/infrastructure/maintain-price-list/repository.ts — WBS 1.2, M03 catalog.
//
// infrastructure/ layer: every DB statement for the maintain-price-list use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/maintain-price-list/ports.ts's `PriceListRepository`.
//
// LOCK ORDER — the one every command follows (each command's own header points here):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's
//      own input carries an `idem` (every write command in this use case).
//   1. getPriceListForUpdate — `select ... for update` on the ONE aggregate row (list-mutating
//      commands only; CreatePriceList and GrantPriceException take no lock — a fresh insert and an
//      append-only record, respectively). Held for the rest of the transaction; the caller
//      compares its own version to expectedVersion here.
//   2. role gate, business invariants, service/line reads — no further row lock.
//   3. writes: upsertLine / insertPriceException, then updatePriceList (the version bump, on the
//      row already locked in step 1 — no new lock), then the outbox event (activate/grant only),
//      then writeAuditRow, last (ADR-0002 — no row lock may be taken after the audit-chain
//      discipline; this use case takes none after step 1 anyway).

const CATALOG_SCHEMA = 'catalog';
const PRICE_LIST_TABLE_NAME = 'price_lists';
const PRICE_LIST_TABLE = `${CATALOG_SCHEMA}.${PRICE_LIST_TABLE_NAME}`;
const PRICE_LIST_LINE_TABLE_NAME = 'price_list_lines';
const PRICE_LIST_LINE_TABLE = `${CATALOG_SCHEMA}.${PRICE_LIST_LINE_TABLE_NAME}`;
const PRICE_EXCEPTION_TABLE_NAME = 'price_exceptions';
const PRICE_EXCEPTION_TABLE = `${CATALOG_SCHEMA}.${PRICE_EXCEPTION_TABLE_NAME}`;
const SERVICE_TABLE = `${CATALOG_SCHEMA}.services`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
// The audited table for each AuditTarget — the application layer names a target, never a table.
const AUDIT_TABLE_BY_TARGET = {
  list: PRICE_LIST_TABLE_NAME,
  line: PRICE_LIST_LINE_TABLE_NAME,
  exception: PRICE_EXCEPTION_TABLE_NAME,
} as const;
// Postgres SQLSTATE for a unique-constraint violation (Master decision 6 — catalog.price_lists
// unique (entity_id, code)).
const POSTGRES_UNIQUE_VIOLATION = '23505';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { PriceListCodeTakenError, PriceListNotFoundError } from '../../domain/maintain-price-list/errors.js';
import type { PriceListStatus } from '../../domain/maintain-price-list/machine.js';
import type {
  InsertPriceExceptionParams,
  InsertPriceListParams,
  PriceListLineRow,
  PriceListRepository,
  PriceListRow,
  PriceListUpdateColumns,
  ServiceRow,
  UpsertLineParams,
  WriteAuditRowParams,
} from '../../application/maintain-price-list/ports.js';

/** Walks `error`'s own `cause` chain looking for a raw node-postgres error's `code` field —
 *  node-postgres attaches the SQLSTATE directly to the thrown error (drizzle may wrap it once via
 *  `cause`), so this recurses rather than assuming one fixed depth. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current !== null && typeof current === 'object') {
    const code = (current as { readonly code?: unknown }).code;
    if (code === POSTGRES_UNIQUE_VIOLATION) return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

function mapLineRow(row: {
  id: string;
  service_id: string;
  price: string;
  currency: string;
  tier_from: string | null;
  tier_to: string | null;
  free_units: string;
}): PriceListLineRow {
  return {
    id: row.id,
    serviceId: row.service_id,
    price: row.price,
    currency: row.currency,
    tierFrom: row.tier_from,
    tierTo: row.tier_to,
    freeUnits: row.free_units,
  };
}

async function hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roles.includes(roleCode);
}

async function insertPriceList(
  tx: NodePgDatabase,
  params: InsertPriceListParams,
): Promise<{ readonly id: string; readonly version: number }> {
  try {
    const result = await tx.execute<{ id: string; version: number }>(sql`
      insert into ${sql.raw(PRICE_LIST_TABLE)}
        (entity_id, code, name_ar, segment_id, client_id, valid_from, valid_to, is_internal)
      values
        (${params.entityId}::uuid, ${params.code}, ${params.nameAr}, ${params.segmentId}::uuid,
         ${params.clientId}::uuid, ${params.validFrom}::date, ${params.validTo}::date, ${params.isInternal})
      returning id, version
    `);
    const row = result.rows[0];
    if (!row) throw new Error(`insert into ${PRICE_LIST_TABLE} returned no row`);
    return { id: row.id, version: row.version };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PriceListCodeTakenError(
        `${PRICE_LIST_TABLE}: code "${params.code}" already exists for entity ${params.entityId} ` +
          '(unique (entity_id, code), Master decision 6).',
      );
    }
    throw error;
  }
}

async function getPriceListForUpdate(tx: NodePgDatabase, priceListId: string): Promise<PriceListRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    code: string;
    segment_id: string | null;
    client_id: string | null;
    valid_from: string;
    valid_to: string | null;
    is_internal: boolean;
    status: string;
    version: number;
  }>(sql`
    select id, entity_id, code, segment_id, client_id, valid_from::text as valid_from,
           valid_to::text as valid_to, is_internal, status, version
      from ${sql.raw(PRICE_LIST_TABLE)} where id = ${priceListId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new PriceListNotFoundError(
      `no ${PRICE_LIST_TABLE} row visible for id ${priceListId} (Allowed: an existing price list ` +
        "in the caller's entities).",
    );
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    code: row.code,
    segmentId: row.segment_id,
    clientId: row.client_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    isInternal: row.is_internal,
    status: row.status as PriceListStatus,
    version: row.version,
  };
}

async function updatePriceList(
  tx: NodePgDatabase,
  priceListId: string,
  columns: PriceListUpdateColumns,
): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(PRICE_LIST_TABLE)}
       set version = version + 1,
           status = coalesce(${columns.status ?? null}, status),
           valid_to = coalesce(${columns.validTo ?? null}::date, valid_to)
     where id = ${priceListId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updatePriceList: no ${PRICE_LIST_TABLE} row for id ${priceListId} (lock was already held)`);
  }
  return row.version;
}

async function getServiceByCode(tx: NodePgDatabase, code: string): Promise<ServiceRow | null> {
  const result = await tx.execute<{ id: string; code: string; min_price: string | null }>(sql`
    select id, code, min_price::text as min_price
      from ${sql.raw(SERVICE_TABLE)} where code = ${code} and is_active = true
  `);
  const row = result.rows[0];
  return row ? { id: row.id, code: row.code, minPrice: row.min_price } : null;
}

async function getServiceById(tx: NodePgDatabase, serviceId: string): Promise<ServiceRow | null> {
  const result = await tx.execute<{ id: string; code: string; min_price: string | null }>(sql`
    select id, code, min_price::text as min_price
      from ${sql.raw(SERVICE_TABLE)} where id = ${serviceId}::uuid and is_active = true
  `);
  const row = result.rows[0];
  return row ? { id: row.id, code: row.code, minPrice: row.min_price } : null;
}

async function getLinesForService(
  tx: NodePgDatabase,
  priceListId: string,
  serviceId: string,
): Promise<readonly PriceListLineRow[]> {
  const result = await tx.execute<{
    id: string;
    service_id: string;
    price: string;
    currency: string;
    tier_from: string | null;
    tier_to: string | null;
    free_units: string;
  }>(sql`
    select id, service_id, price::text as price, currency, tier_from::text as tier_from,
           tier_to::text as tier_to, free_units::text as free_units
      from ${sql.raw(PRICE_LIST_LINE_TABLE)}
     where price_list_id = ${priceListId}::uuid and service_id = ${serviceId}::uuid
  `);
  return result.rows.map(mapLineRow);
}

async function getAllLines(tx: NodePgDatabase, priceListId: string): Promise<readonly PriceListLineRow[]> {
  const result = await tx.execute<{
    id: string;
    service_id: string;
    price: string;
    currency: string;
    tier_from: string | null;
    tier_to: string | null;
    free_units: string;
  }>(sql`
    select id, service_id, price::text as price, currency, tier_from::text as tier_from,
           tier_to::text as tier_to, free_units::text as free_units
      from ${sql.raw(PRICE_LIST_LINE_TABLE)}
     where price_list_id = ${priceListId}::uuid
  `);
  return result.rows.map(mapLineRow);
}

async function getAnyLineCurrency(tx: NodePgDatabase, priceListId: string): Promise<string | null> {
  const result = await tx.execute<{ currency: string }>(sql`
    select currency from ${sql.raw(PRICE_LIST_LINE_TABLE)} where price_list_id = ${priceListId}::uuid limit 1
  `);
  return result.rows[0]?.currency ?? null;
}

/** `on conflict (price_list_id, service_id, tier_from)` — the 01 unique key (Master decision 6).
 *  Postgres semantics: a NULL tier_from (a flat line) never satisfies a unique-index conflict
 *  (NULL <> NULL), so `on conflict` cannot replace an existing flat row. pg-reviewer fix round 1
 *  (finding 1): when tierFrom is null, UPDATE the existing flat row for (price_list_id,
 *  service_id) explicitly first, and INSERT only when zero rows were updated — exactly one flat
 *  row per (list, service) afterwards, same as the non-null path's unique key already guarantees. */
async function upsertLine(tx: NodePgDatabase, params: UpsertLineParams): Promise<{ readonly id: string }> {
  if (params.tierFrom === null) {
    const updated = await tx.execute<{ id: string }>(sql`
      update ${sql.raw(PRICE_LIST_LINE_TABLE)}
         set price = ${params.price}::numeric, currency = ${params.currency},
             tier_to = ${params.tierTo}::numeric, free_units = ${params.freeUnits}::numeric,
             notes = ${params.notes}
       where price_list_id = ${params.priceListId}::uuid and service_id = ${params.serviceId}::uuid
         and tier_from is null
      returning id
    `);
    const updatedRow = updated.rows[0];
    if (updatedRow) return { id: updatedRow.id };

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into ${sql.raw(PRICE_LIST_LINE_TABLE)}
        (price_list_id, service_id, price, currency, tier_from, tier_to, free_units, notes)
      values
        (${params.priceListId}::uuid, ${params.serviceId}::uuid, ${params.price}::numeric, ${params.currency},
         null, ${params.tierTo}::numeric, ${params.freeUnits}::numeric, ${params.notes})
      returning id
    `);
    const insertedRow = inserted.rows[0];
    if (!insertedRow) throw new Error(`insert into ${PRICE_LIST_LINE_TABLE} returned no row`);
    return { id: insertedRow.id };
  }

  const result = await tx.execute<{ id: string }>(sql`
    insert into ${sql.raw(PRICE_LIST_LINE_TABLE)}
      (price_list_id, service_id, price, currency, tier_from, tier_to, free_units, notes)
    values
      (${params.priceListId}::uuid, ${params.serviceId}::uuid, ${params.price}::numeric, ${params.currency},
       ${params.tierFrom}::numeric, ${params.tierTo}::numeric, ${params.freeUnits}::numeric, ${params.notes})
    on conflict (price_list_id, service_id, tier_from) do update set
      price = excluded.price, currency = excluded.currency, tier_to = excluded.tier_to,
      free_units = excluded.free_units, notes = excluded.notes
    returning id
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`upsert into ${PRICE_LIST_LINE_TABLE} returned no row`);
  return { id: row.id };
}

async function insertPriceException(
  tx: NodePgDatabase,
  params: InsertPriceExceptionParams,
): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${sql.raw(PRICE_EXCEPTION_TABLE)}
      (entity_id, client_id, service_id, approved_price, min_price_at_approval, reason, valid_from,
       valid_to, approved_by, approved_at, review_at)
    values
      (${params.entityId}::uuid, ${params.clientId}::uuid, ${params.serviceId}::uuid,
       ${params.approvedPrice}::numeric, ${params.minPriceAtApproval}::numeric, ${params.reason},
       ${params.validFrom}::date, ${params.validTo}::date, ${params.approvedBy}::uuid,
       ${params.approvedAt.toISOString()}::timestamptz, ${params.reviewAt}::date)
    returning id
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${PRICE_EXCEPTION_TABLE} returned no row`);
  return { id: row.id };
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with any outbox row the
 *  same call writes (G9). `occurredAt` is mandatory (always from the injected Clock, never the
 *  column's own `default now()`). */
async function writeAuditRow(tx: NodePgDatabase, params: WriteAuditRowParams): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${CATALOG_SCHEMA}, ${AUDIT_TABLE_BY_TARGET[params.target]},
       ${params.recordId}::uuid, ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb,
       ${params.correlationId}::uuid)
  `);
}

export const priceListRepository: PriceListRepository = {
  hasRole,
  insertPriceList,
  getPriceListForUpdate,
  updatePriceList,
  getServiceByCode,
  getServiceById,
  getLinesForService,
  getAllLines,
  getAnyLineCurrency,
  upsertLine,
  insertPriceException,
  writeAuditRow,
};

// exported for a later slice's own reference (REPLACE-ON-COPY pattern the golden slice sets).
export { CATALOG_SCHEMA, PRICE_LIST_TABLE_NAME, PRICE_LIST_TABLE, PRICE_LIST_LINE_TABLE_NAME, PRICE_LIST_LINE_TABLE };
