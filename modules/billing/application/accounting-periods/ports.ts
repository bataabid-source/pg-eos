// modules/billing/application/accounting-periods/ports.ts — WBS 4.19 (lane 2).
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: AccountingPeriodsDeps` (clock, repo, logger) and never imports infrastructure/ (golden
// slice: modules/wms/application/receive-inbound/ports.ts).
// ../../infrastructure/accounting-periods/repository.ts implements `AccountingPeriodRepository`;
// ../../infrastructure/accounting-periods/logger.ts implements `Logger`;
// ../../api/accounting-periods/composition.ts wires them.

import type { Clock } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { PeriodStatus } from '../../domain/accounting-periods/machine.js';

/** The clock every command needs (injected — domain-kit adapter in production, fixed in tests). */
export interface ClockDeps {
  readonly clock: Clock;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/accounting-periods/logger.ts. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root. */
export interface AccountingPeriodsDeps extends ClockDeps {
  readonly repo: AccountingPeriodRepository;
  readonly logger: Logger;
}

/** What an audit row is about. The adapter maps this to schema_name/table_name — the application
 *  layer never names a table. */
export type AuditTarget = 'fiscal_year' | 'period';

export interface FiscalYearRow {
  readonly id: string;
  readonly entityId: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface PeriodRow {
  readonly id: string;
  readonly entityId: string;
  readonly fiscalYearId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: PeriodStatus;
  readonly version: number;
}

/** The context a reopen decision carries (4.19 pre-build review D8) — read back by the DB trigger
 *  billing.guard_accounting_period() (requestedBy, periodVersion) and by applyPeriodReopenDecision. */
export interface ReopenDecisionContext {
  readonly requestedBy: string;
  readonly periodId: string;
  readonly entityId: string;
  readonly periodVersion: number;
  readonly startDate: string;
  readonly endDate: string;
}

/** A platform.decisions row of kind 'accounting_period_reopen', as applyPeriodReopenDecision reads
 *  it. `periodVersion`/`requestedBy` come from its context; null when absent. */
export interface ReopenDecisionRow {
  readonly id: string;
  readonly periodId: string;
  readonly status: string;
  readonly decision: string | null;
  readonly decidedBy: string | null;
  readonly requestedBy: string | null;
  readonly periodVersion: number | null;
}

/** Every DB statement the accounting-periods use case needs. Implemented by
 *  ../../infrastructure/accounting-periods/repository.ts. */
export interface AccountingPeriodRepository {
  insertFiscalYear(
    tx: NodePgDatabase,
    params: { readonly entityId: string; readonly startDate: string; readonly endDate: string },
  ): Promise<{ readonly id: string; readonly version: number }>;
  /** The fiscal year `fiscalYearId` of `entityId`, as RLS lets the caller see it. Throws
   *  FiscalYearNotFoundError when no row matches. */
  getFiscalYear(tx: NodePgDatabase, entityId: string, fiscalYearId: string): Promise<FiscalYearRow>;
  /** Inserts a period at its initial status 'open' (the DB refuses any other, D4). */
  insertPeriod(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly fiscalYearId: string;
      readonly startDate: string;
      readonly endDate: string;
    },
  ): Promise<{ readonly id: string; readonly version: number; readonly status: PeriodStatus }>;
  /** Period-row lock, FIRST — `select ... for update`. Throws PeriodNotFoundError when RLS hides
   *  the row or it does not exist. */
  getPeriodForUpdate(tx: NodePgDatabase, periodId: string): Promise<PeriodRow>;
  /** Status change plus version bump on the row already locked; returns the new version. */
  updatePeriodStatus(tx: NodePgDatabase, periodId: string, status: PeriodStatus): Promise<number>;
  hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean>;
  /** True iff the session user holds the approver role platform.approval_chains names for the
   *  reopen request (step 1) — the same check the DB trigger makes (D1, D9). */
  isReopenApprover(tx: NodePgDatabase): Promise<boolean>;
  /** Files one open reopen decision in platform.decisions; its assigned_role is read from
   *  platform.approval_chains in the same statement (D1, D8). */
  insertReopenDecision(
    tx: NodePgDatabase,
    params: { readonly entityId: string; readonly context: ReopenDecisionContext },
  ): Promise<{ readonly id: string }>;
  /** The reopen decision `decisionId`, or null when no reopen decision with that id is visible. */
  getReopenDecision(tx: NodePgDatabase, decisionId: string): Promise<ReopenDecisionRow | null>;
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly target: AuditTarget;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}
