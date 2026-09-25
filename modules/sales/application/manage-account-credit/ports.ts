// modules/sales/application/manage-account-credit/ports.ts — WBS 1.8, M02 sales.
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: ManageAccountCreditDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/manage-account-credit/repository.ts implements `AccountCreditRepository`;
// ../../api/manage-account-credit/composition.ts wires it.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

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

/** A structured logger port. Implemented by ../../infrastructure/manage-account-credit/logger.ts
 *  (a @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/manage-account-credit/composition.ts). Commands program only against these ports —
 *  the application layer never imports infrastructure/. */
export interface ManageAccountCreditDeps extends ClockDeps {
  readonly repo: AccountCreditRepository;
  readonly logger: Logger;
}

/** `sales.accounts` has no `entity_id` column at all (Scope: genuinely group-level) — this row
 *  shape carries only the columns this use case's commands read/write. */
export interface AccountCreditRow {
  readonly id: string;
  /** `sales.accounts.credit_limit` is `numeric(14,3) default 0` but NOT `not null` — a genuine
   *  NULL surfaces as `null` here, never coalesced to a fabricated `'0.000'` (pg-reviewer fix
   *  round 1, finding 2). */
  readonly creditLimit: string | null;
  readonly creditHold: boolean;
  readonly holdReason: string | null;
  readonly holdSetBy: string | null;
  readonly holdSetAt: Date | null;
  readonly version: number;
}

export interface UpdateCreditLimitColumns {
  readonly creditLimit: string;
}

export interface UpdateCreditHoldColumns {
  readonly creditHold: boolean;
  readonly holdReason: string;
  readonly holdSetBy: string;
  readonly holdSetAt: Date;
}

/** Every DB statement the manage-account-credit use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/manage-account-credit/repository.ts. */
export interface AccountCreditRepository {
  hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean>;
  /** account-row lock, FIRST — `select ... for update`. Throws AccountNotFoundError when no row
   *  is visible (missing, or RLS client_portal_scope hides it). */
  getAccountForUpdate(tx: NodePgDatabase, accountId: string): Promise<AccountCreditRow>;
  /** `null` when no row is visible (missing, or RLS hides it) — the caller maps that to
   *  AccountNotFoundError. No lock: a pure read for getAccountCreditStatus. */
  getAccountById(tx: NodePgDatabase, accountId: string): Promise<AccountCreditRow | null>;
  /** unconditional version bump — the caller already validated expectedVersion against the locked
   *  row and holds that lock for the whole transaction, so this never races. */
  updateCreditLimit(tx: NodePgDatabase, accountId: string, columns: UpdateCreditLimitColumns): Promise<number>;
  updateCreditHold(tx: NodePgDatabase, accountId: string, columns: UpdateCreditHoldColumns): Promise<number>;
}
