// modules/catalog/application/maintain-price-list/ports.ts — WBS 1.2, M03 catalog.
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: MaintainPriceListDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/maintain-price-list/repository.ts implements `PriceListRepository`;
// ../../api/maintain-price-list/composition.ts wires it.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { PriceListStatus } from '../../domain/maintain-price-list/machine.js';

/** The clock and id generator every command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/maintain-price-list/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/maintain-price-list/composition.ts). Commands program only against these ports —
 *  the application layer never imports infrastructure/. */
export interface MaintainPriceListDeps extends ClockDeps {
  readonly repo: PriceListRepository;
  readonly logger: Logger;
}

/** What an audit row is about — the adapter maps this to schema_name/table_name (slice brief
 *  Master decision 13); the application layer never names a table. */
export type AuditTarget = 'list' | 'line' | 'exception';

export interface PriceListRow {
  readonly id: string;
  readonly entityId: string;
  readonly code: string;
  readonly segmentId: string | null;
  readonly clientId: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly isInternal: boolean;
  readonly status: PriceListStatus;
  readonly version: number;
}

export interface PriceListLineRow {
  readonly id: string;
  readonly serviceId: string;
  readonly price: string;
  readonly currency: string;
  readonly tierFrom: string | null;
  readonly tierTo: string | null;
  readonly freeUnits: string;
}

export interface ServiceRow {
  readonly id: string;
  readonly code: string;
  readonly minPrice: string | null;
}

export interface PriceListUpdateColumns {
  readonly status?: PriceListStatus;
  readonly validTo?: string;
}

export interface InsertPriceListParams {
  readonly entityId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly segmentId: string | null;
  readonly clientId: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly isInternal: boolean;
}

export interface UpsertLineParams {
  readonly priceListId: string;
  readonly serviceId: string;
  readonly price: string;
  readonly currency: string;
  readonly tierFrom: string | null;
  readonly tierTo: string | null;
  readonly freeUnits: string;
  readonly notes: string | null;
}

export interface InsertPriceExceptionParams {
  readonly entityId: string;
  readonly clientId: string;
  readonly serviceId: string;
  readonly approvedPrice: string;
  readonly minPriceAtApproval: string;
  readonly reason: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly reviewAt: string;
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

/** Every DB statement the maintain-price-list use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/maintain-price-list/repository.ts. */
export interface PriceListRepository {
  hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean>;
  /** Duplicate `(entity_id, code)` -> PriceListCodeTakenError (SQLSTATE 23505). */
  insertPriceList(
    tx: NodePgDatabase,
    params: InsertPriceListParams,
  ): Promise<{ readonly id: string; readonly version: number }>;
  /** list-row lock, FIRST — `select ... for update`. Throws PriceListNotFoundError when no row is
   *  visible (missing, or RLS entity_scope hides it). */
  getPriceListForUpdate(tx: NodePgDatabase, priceListId: string): Promise<PriceListRow>;
  /** unconditional version bump — the caller already validated expectedVersion against the
   *  locked row and holds that lock for the whole transaction, so this never races. */
  updatePriceList(tx: NodePgDatabase, priceListId: string, columns: PriceListUpdateColumns): Promise<number>;
  getServiceByCode(tx: NodePgDatabase, code: string): Promise<ServiceRow | null>;
  getServiceById(tx: NodePgDatabase, serviceId: string): Promise<ServiceRow | null>;
  getLinesForService(
    tx: NodePgDatabase,
    priceListId: string,
    serviceId: string,
  ): Promise<readonly PriceListLineRow[]>;
  getAllLines(tx: NodePgDatabase, priceListId: string): Promise<readonly PriceListLineRow[]>;
  /** Master decision 4 (default): any one existing line's currency — every line of a list already
   *  shares one currency by induction, so any row represents the list's canonical currency. `null`
   *  when the list has no lines yet (the next line written decides it). */
  getAnyLineCurrency(tx: NodePgDatabase, priceListId: string): Promise<string | null>;
  upsertLine(tx: NodePgDatabase, params: UpsertLineParams): Promise<{ readonly id: string }>;
  insertPriceException(
    tx: NodePgDatabase,
    params: InsertPriceExceptionParams,
  ): Promise<{ readonly id: string }>;
  writeAuditRow(tx: NodePgDatabase, params: WriteAuditRowParams): Promise<void>;
}
