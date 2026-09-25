// modules/sales/infrastructure/manage-quote/repository.ts — WBS 1.6, M02 sales.
//
// infrastructure/ layer: every DB statement for the manage-quote use case, run against the `tx` a
// caller's own withContext(ctx, fn) already opened. Implements
// ../../application/manage-quote/ports.ts's `QuoteRepository`.
//
// LOCK ORDER — the one every command follows (each command's own header points here):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's
//      own input carries an `idem` (every write command in this use case).
//   1. getQuoteForUpdate — `select ... for update` on the ONE aggregate row (every command except
//      CreateQuote, which takes no lock — a fresh insert). Held for the rest of the transaction;
//      the caller compares its own version to expectedVersion here.
//   2. role gate, business invariants, service/exception/line reads — no further row lock.
//   3. writes: insertLine, then updateQuote (the version bump, on the row already locked in step 1
//      — no new lock), then the outbox event (ApproveFinance only), then writeAuditRow, last
//      (ADR-0002 — no row lock may be taken after the audit-chain discipline).

const SALES_SCHEMA = 'sales';
const QUOTE_TABLE_NAME = 'quotes';
const QUOTE_TABLE = `${SALES_SCHEMA}.${QUOTE_TABLE_NAME}`;
const QUOTE_LINE_TABLE_NAME = 'quote_lines';
const QUOTE_LINE_TABLE = `${SALES_SCHEMA}.${QUOTE_LINE_TABLE_NAME}`;
const ACCOUNT_TABLE = `${SALES_SCHEMA}.accounts`;
const CATALOG_SCHEMA = 'catalog';
const SERVICE_TABLE = `${CATALOG_SCHEMA}.services`;
const PRICE_EXCEPTION_TABLE = `${CATALOG_SCHEMA}.price_exceptions`;
const DOC_TYPE_QUOTE = 'QTE';
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
const AUDIT_TABLE_BY_TARGET = { quote: QUOTE_TABLE_NAME, line: QUOTE_LINE_TABLE_NAME } as const;

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { QuoteNotFoundError } from '../../domain/manage-quote/errors.js';
import type { QuoteStatus } from '../../domain/manage-quote/machine.js';
import type {
  AccountRow,
  InsertLineParams,
  InsertQuoteParams,
  PriceExceptionRow,
  QuoteLineRow,
  QuoteRepository,
  QuoteRow,
  QuoteUpdateColumns,
  ServiceRow,
  WriteAuditRowParams,
} from '../../application/manage-quote/ports.js';

async function hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roles.includes(roleCode);
}

async function getAccountById(tx: NodePgDatabase, accountId: string): Promise<AccountRow | null> {
  const result = await tx.execute<{ id: string; status: string; cr_number: string | null }>(sql`
    select id, status, cr_number from ${sql.raw(ACCOUNT_TABLE)} where id = ${accountId}::uuid and deleted_at is null
  `);
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, crNumber: row.cr_number } : null;
}

async function getServiceById(tx: NodePgDatabase, serviceId: string): Promise<ServiceRow | null> {
  const result = await tx.execute<{ id: string; uom: string; min_price: string | null; standard_cost: string | null }>(sql`
    select id, uom, min_price::text as min_price, standard_cost::text as standard_cost
      from ${sql.raw(SERVICE_TABLE)} where id = ${serviceId}::uuid and is_active = true
  `);
  const row = result.rows[0];
  return row ? { id: row.id, uom: row.uom, minPrice: row.min_price, standardCost: row.standard_cost } : null;
}

async function getPriceExceptionById(tx: NodePgDatabase, exceptionId: string): Promise<PriceExceptionRow | null> {
  const result = await tx.execute<{
    id: string;
    client_id: string;
    service_id: string;
    valid_from: string;
    valid_to: string;
    approved_price: string;
  }>(sql`
    select id, client_id, service_id, valid_from::text as valid_from, valid_to::text as valid_to,
           approved_price::text as approved_price
      from ${sql.raw(PRICE_EXCEPTION_TABLE)} where id = ${exceptionId}::uuid
  `);
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        serviceId: row.service_id,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        approvedPrice: row.approved_price,
      }
    : null;
}

async function insertQuote(
  tx: NodePgDatabase,
  params: InsertQuoteParams,
): Promise<{ readonly id: string; readonly docNo: string; readonly version: number }> {
  const docNoResult = await tx.execute<{ doc_no: string }>(
    sql`select platform.next_doc_no(${params.entityId}::uuid, ${DOC_TYPE_QUOTE}) as doc_no`,
  );
  const docNoRow = docNoResult.rows[0];
  if (!docNoRow) throw new Error(`platform.next_doc_no returned no row for entity ${params.entityId} / doc type ${DOC_TYPE_QUOTE}`);
  const docNo = docNoRow.doc_no;

  const result = await tx.execute<{ id: string; version: number }>(sql`
    insert into ${sql.raw(QUOTE_TABLE)}
      (entity_id, doc_no, account_id, opportunity_id, valid_until, currency, terms_ar, terms_en, prepared_by)
    values
      (${params.entityId}::uuid, ${docNo}, ${params.accountId}::uuid, ${params.opportunityId}::uuid,
       ${params.validUntil}::date, ${params.currency}, ${params.termsAr}, ${params.termsEn}, ${params.preparedBy}::uuid)
    returning id, version
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${QUOTE_TABLE} returned no row`);
  return { id: row.id, docNo, version: row.version };
}

async function getQuoteForUpdate(tx: NodePgDatabase, quoteId: string): Promise<QuoteRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    doc_no: string;
    account_id: string;
    opportunity_id: string | null;
    status: string;
    valid_until: string;
    currency: string;
    subtotal: string;
    discount_amt: string;
    total: string;
    estimated_margin_pct: string | null;
    terms_ar: string | null;
    terms_en: string | null;
    version: number;
  }>(sql`
    select id, entity_id, doc_no, account_id, opportunity_id, status, valid_until::text as valid_until,
           currency, subtotal::text as subtotal, discount_amt::text as discount_amt, total::text as total,
           estimated_margin_pct::text as estimated_margin_pct, terms_ar, terms_en, version
      from ${sql.raw(QUOTE_TABLE)} where id = ${quoteId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new QuoteNotFoundError(`no ${QUOTE_TABLE} row visible for id ${quoteId} (Allowed: an existing quote in the caller's entities).`);
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    docNo: row.doc_no,
    accountId: row.account_id,
    opportunityId: row.opportunity_id,
    status: row.status as QuoteStatus,
    validUntil: row.valid_until,
    currency: row.currency,
    subtotal: row.subtotal,
    discountAmt: row.discount_amt,
    total: row.total,
    estimatedMarginPct: row.estimated_margin_pct,
    termsAr: row.terms_ar,
    termsEn: row.terms_en,
    version: row.version,
  };
}

async function updateQuote(tx: NodePgDatabase, quoteId: string, columns: QuoteUpdateColumns): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(QUOTE_TABLE)}
       set version = version + 1,
           status = coalesce(${columns.status ?? null}, status),
           subtotal = coalesce(${columns.subtotal ?? null}::numeric, subtotal),
           discount_amt = coalesce(${columns.discountAmt ?? null}::numeric, discount_amt),
           total = coalesce(${columns.total ?? null}::numeric, total),
           estimated_margin_pct = case when ${columns.estimatedMarginPct !== undefined}::boolean
                                       then ${columns.estimatedMarginPct ?? null}::numeric
                                       else estimated_margin_pct end,
           reviewed_by = coalesce(${columns.reviewedBy ?? null}::uuid, reviewed_by),
           approved_by = coalesce(${columns.approvedBy ?? null}::uuid, approved_by),
           frozen_snapshot = coalesce(${columns.frozenSnapshot ? JSON.stringify(columns.frozenSnapshot) : null}::jsonb, frozen_snapshot),
           sent_at = coalesce(${columns.sentAt?.toISOString() ?? null}::timestamptz, sent_at),
           decided_at = coalesce(${columns.decidedAt?.toISOString() ?? null}::timestamptz, decided_at)
     where id = ${quoteId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateQuote: no ${QUOTE_TABLE} row for id ${quoteId} (lock was already held)`);
  }
  return row.version;
}

async function insertLine(tx: NodePgDatabase, params: InsertLineParams): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${sql.raw(QUOTE_LINE_TABLE)}
      (quote_id, service_id, qty, uom, unit_price, min_price_at_quote, exception_id, line_total, sort_order)
    values
      (${params.quoteId}::uuid, ${params.serviceId}::uuid, ${params.qty}::numeric, ${params.uom},
       ${params.unitPrice}::numeric, ${params.minPriceAtQuote}::numeric, ${params.exceptionId}::uuid,
       ${params.lineTotal}::numeric, ${params.sortOrder})
    returning id
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${QUOTE_LINE_TABLE} returned no row`);
  return { id: row.id };
}

async function getLinesForQuote(tx: NodePgDatabase, quoteId: string): Promise<readonly QuoteLineRow[]> {
  const result = await tx.execute<{
    id: string;
    service_id: string;
    qty: string;
    uom: string;
    unit_price: string;
    min_price_at_quote: string | null;
    exception_id: string | null;
    line_total: string;
    sort_order: number;
    standard_cost: string | null;
  }>(sql`
    select ql.id, ql.service_id, ql.qty::text as qty, ql.uom, ql.unit_price::text as unit_price,
           ql.min_price_at_quote::text as min_price_at_quote, ql.exception_id,
           ql.line_total::text as line_total, ql.sort_order, s.standard_cost::text as standard_cost
      from ${sql.raw(QUOTE_LINE_TABLE)} ql
      join ${sql.raw(SERVICE_TABLE)} s on s.id = ql.service_id
     where ql.quote_id = ${quoteId}::uuid
     order by ql.sort_order
  `);
  return result.rows.map((row) => ({
    id: row.id,
    serviceId: row.service_id,
    qty: row.qty,
    uom: row.uom,
    unitPrice: row.unit_price,
    minPriceAtQuote: row.min_price_at_quote,
    exceptionId: row.exception_id,
    lineTotal: row.line_total,
    sortOrder: row.sort_order,
    standardCost: row.standard_cost,
  }));
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with any outbox row the same
 *  call writes (G9). `occurredAt` is mandatory (always from the injected Clock, never the
 *  column's own `default now()`). */
async function writeAuditRow(tx: NodePgDatabase, params: WriteAuditRowParams): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${SALES_SCHEMA}, ${AUDIT_TABLE_BY_TARGET[params.target]},
       ${params.recordId}::uuid, ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb,
       ${params.correlationId}::uuid)
  `);
}

export const quoteRepository: QuoteRepository = {
  hasRole,
  getAccountById,
  getServiceById,
  getPriceExceptionById,
  insertQuote,
  getQuoteForUpdate,
  updateQuote,
  insertLine,
  getLinesForQuote,
  writeAuditRow,
};

// exported for a later slice's own reference (REPLACE-ON-COPY pattern the golden slice sets).
export { SALES_SCHEMA, QUOTE_TABLE_NAME, QUOTE_TABLE, QUOTE_LINE_TABLE_NAME, QUOTE_LINE_TABLE };
