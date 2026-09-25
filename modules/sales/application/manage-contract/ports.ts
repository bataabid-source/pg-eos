// modules/sales/application/manage-contract/ports.ts — WBS 1.7, M02 sales.
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: ManageContractDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/manage-contract/repository.ts implements `ContractRepository`;
// ../../api/manage-contract/composition.ts wires it.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ContractStatus } from '../../domain/manage-contract/machine.js';

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

/** A structured logger port. Implemented by ../../infrastructure/manage-contract/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/manage-contract/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface ManageContractDeps extends ClockDeps {
  readonly repo: ContractRepository;
  readonly logger: Logger;
}

/** What an audit row is about — the adapter maps this to schema_name/table_name; the application
 *  layer never names a table. */
export type AuditTarget = 'contract' | 'sla';

export interface AccountRow {
  readonly id: string;
  readonly status: string;
  readonly crNumber: string | null;
}

export interface PriceListRow {
  readonly id: string;
  readonly entityId: string;
  readonly clientId: string | null;
  readonly segmentId: string | null;
  readonly isInternal: boolean;
  readonly status: string;
}

export interface ContractRow {
  readonly id: string;
  readonly entityId: string;
  readonly docNo: string;
  readonly accountId: string;
  readonly quoteId: string | null;
  readonly title: string;
  readonly status: ContractStatus;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly priceListId: string | null;
  readonly slaEnabled: boolean;
  readonly signedAt: Date | null;
  readonly version: number;
}

export interface InsertContractParams {
  readonly entityId: string;
  readonly accountId: string;
  readonly quoteId: string | null;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly billingCycle: string;
  readonly paymentTermsDays: number;
  readonly autoRenew: boolean;
  readonly noticeDays: number;
  readonly minMonthlyCharge: string;
  readonly slaEnabled: boolean;
  readonly billsFailedAttempt: boolean;
  readonly billsReturn: boolean;
  readonly billsWaiting: boolean;
  readonly billsReschedule: boolean;
  readonly billsPartialDelivery: boolean;
}

export interface ContractUpdateColumns {
  readonly status?: ContractStatus;
  readonly priceListId?: string;
  readonly signedAt?: Date;
  readonly signedByClient?: string;
}

export interface InsertContractSlaParams {
  readonly contractId: string;
  readonly metric: string;
  readonly targetValue: string;
  readonly direction: string;
  readonly penaltyType: string | null;
  readonly penaltyValue: string | null;
  readonly bonusValue: string | null;
}

export interface ContractForOrderRow {
  readonly contractId: string;
  readonly status: ContractStatus;
  readonly priceListId: string | null;
  readonly endDate: string | null;
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

/** Every DB statement the manage-contract use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/manage-contract/repository.ts. */
export interface ContractRepository {
  hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean>;
  /** `null` when no row is visible (missing, or RLS hides it) — the caller maps that to
   *  AccountNotFoundError. No lock: `sales.accounts` is not this use case's own aggregate. */
  getAccountById(tx: NodePgDatabase, accountId: string): Promise<AccountRow | null>;
  /** `null` when no `sales.accounts` row is visible — pg-reviewer fix round 1, finding 3: needed to
   *  validate a cited price list's own `segment_id` against the contract's account. */
  getAccountSegmentId(tx: NodePgDatabase, accountId: string): Promise<string | null>;
  /** `null` when no `catalog.price_lists` row exists for the id. */
  getPriceListById(tx: NodePgDatabase, priceListId: string): Promise<PriceListRow | null>;
  insertContract(tx: NodePgDatabase, params: InsertContractParams): Promise<{ readonly id: string; readonly docNo: string; readonly version: number }>;
  /** contract-row lock, FIRST — `select ... for update`. Throws ContractNotFoundError when no row
   *  is visible (missing, or RLS entity_scope hides it). */
  getContractForUpdate(tx: NodePgDatabase, contractId: string): Promise<ContractRow>;
  /** unconditional version bump — the caller already validated expectedVersion against the locked
   *  row and holds that lock for the whole transaction, so this never races. */
  updateContract(tx: NodePgDatabase, contractId: string, columns: ContractUpdateColumns): Promise<number>;
  insertContractSla(tx: NodePgDatabase, params: InsertContractSlaParams): Promise<{ readonly id: string }>;
  /** the account's contract for `entityId` whose `start_date <= asOfDate` (a contract that has not
   *  started yet is treated as "no contract found", not a distinct error — pg-reviewer fix round
   *  1, finding 2c), tie-break latest `start_date` THEN `id` descending for a deterministic result
   *  (finding 2d) — `null` when none is visible. No lock: a pure read for a future order-placing
   *  slice. */
  findContractForAccountEntity(
    tx: NodePgDatabase,
    params: { readonly accountId: string; readonly entityId: string; readonly asOfDate: string },
  ): Promise<ContractForOrderRow | null>;
  writeAuditRow(tx: NodePgDatabase, params: WriteAuditRowParams): Promise<void>;
}
