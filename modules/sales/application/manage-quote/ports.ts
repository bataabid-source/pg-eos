// modules/sales/application/manage-quote/ports.ts — WBS 1.6, M02 sales.
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: ManageQuoteDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/manage-quote/repository.ts implements `QuoteRepository`;
// ../../api/manage-quote/composition.ts wires it.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { QuoteStatus } from '../../domain/manage-quote/machine.js';

/** The clock and id generator every command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino." Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/manage-quote/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/manage-quote/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface ManageQuoteDeps extends ClockDeps {
  readonly repo: QuoteRepository;
  readonly logger: Logger;
}

/** What an audit row is about — the adapter maps this to schema_name/table_name (mirrors catalog's
 *  AuditTarget); the application layer never names a table. */
export type AuditTarget = 'quote' | 'line';

export interface AccountRow {
  readonly id: string;
  readonly status: string;
  readonly crNumber: string | null;
}

export interface ServiceRow {
  readonly id: string;
  readonly uom: string;
  readonly minPrice: string | null;
  readonly standardCost: string | null;
}

export interface PriceExceptionRow {
  readonly id: string;
  readonly clientId: string;
  readonly serviceId: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly approvedPrice: string;
}

export interface QuoteRow {
  readonly id: string;
  readonly entityId: string;
  readonly docNo: string;
  readonly accountId: string;
  readonly opportunityId: string | null;
  readonly status: QuoteStatus;
  readonly validUntil: string;
  readonly currency: string;
  readonly subtotal: string;
  readonly discountAmt: string;
  readonly total: string;
  readonly estimatedMarginPct: string | null;
  readonly termsAr: string | null;
  readonly termsEn: string | null;
  readonly version: number;
}

export interface QuoteLineRow {
  readonly id: string;
  readonly serviceId: string;
  readonly qty: string;
  readonly uom: string;
  readonly unitPrice: string;
  readonly minPriceAtQuote: string | null;
  readonly exceptionId: string | null;
  readonly lineTotal: string;
  readonly sortOrder: number;
  /** the line's own service's CURRENT `standard_cost` (joined fresh, never stored on the line) —
   *  used to recompute `estimated_margin_pct` over the whole quote on every UpsertQuoteLine call. */
  readonly standardCost: string | null;
}

export interface InsertQuoteParams {
  readonly entityId: string;
  readonly accountId: string;
  readonly opportunityId: string | null;
  readonly validUntil: string;
  readonly currency: string;
  readonly termsAr: string | null;
  readonly termsEn: string | null;
  readonly preparedBy: string;
}

export interface InsertLineParams {
  readonly quoteId: string;
  readonly serviceId: string;
  readonly qty: string;
  readonly uom: string;
  readonly unitPrice: string;
  readonly minPriceAtQuote: string | null;
  readonly exceptionId: string | null;
  readonly lineTotal: string;
  readonly sortOrder: number;
}

export interface QuoteUpdateColumns {
  readonly status?: QuoteStatus;
  readonly subtotal?: string;
  readonly discountAmt?: string;
  readonly total?: string;
  readonly estimatedMarginPct?: number | null;
  readonly reviewedBy?: string;
  readonly approvedBy?: string;
  readonly frozenSnapshot?: unknown;
  readonly sentAt?: Date;
  readonly decidedAt?: Date;
}

export interface WriteAuditRowParams {
  readonly entityId: string;
  readonly target: AuditTarget;
  readonly recordId: string;
  readonly operation: string;
  readonly correlationId: string;
  readonly actorId: string;
  readonly newValue: unknown;
  readonly occurredAt: Date;
}

/** Every DB statement the manage-quote use case needs, as an interface — the port the application
 *  layer programs against. Implemented by ../../infrastructure/manage-quote/repository.ts. */
export interface QuoteRepository {
  hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean>;
  /** `null` when no row is visible (missing, or RLS hides it) — the caller maps that to
   *  AccountNotFoundError. No lock: `sales.accounts` is not this use case's own aggregate. */
  getAccountById(tx: NodePgDatabase, accountId: string): Promise<AccountRow | null>;
  /** `null` when no active `catalog.services` row exists for the id. */
  getServiceById(tx: NodePgDatabase, serviceId: string): Promise<ServiceRow | null>;
  getPriceExceptionById(tx: NodePgDatabase, exceptionId: string): Promise<PriceExceptionRow | null>;
  insertQuote(tx: NodePgDatabase, params: InsertQuoteParams): Promise<{ readonly id: string; readonly docNo: string; readonly version: number }>;
  /** quote-row lock, FIRST — `select ... for update`. Throws QuoteNotFoundError when no row is
   *  visible (missing, or RLS entity_scope hides it). */
  getQuoteForUpdate(tx: NodePgDatabase, quoteId: string): Promise<QuoteRow>;
  /** unconditional version bump — the caller already validated expectedVersion against the locked
   *  row and holds that lock for the whole transaction, so this never races. */
  updateQuote(tx: NodePgDatabase, quoteId: string, columns: QuoteUpdateColumns): Promise<number>;
  insertLine(tx: NodePgDatabase, params: InsertLineParams): Promise<{ readonly id: string }>;
  /** every line of `quoteId`, joined with each line's own service's CURRENT standard_cost, ordered
   *  by sort_order. */
  getLinesForQuote(tx: NodePgDatabase, quoteId: string): Promise<readonly QuoteLineRow[]>;
  writeAuditRow(tx: NodePgDatabase, params: WriteAuditRowParams): Promise<void>;
}
