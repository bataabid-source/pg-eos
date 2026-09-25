// modules/sales/application/customer-profile/ports.ts — WBS 1.9, M02 sales.
//
// application/ layer: the ports this use case programs against. getCustomerProfile takes ONE
// `deps: CustomerProfileDeps` (repo, logger) and never imports infrastructure/.
// ../../infrastructure/customer-profile/repository.ts implements `CustomerProfileRepository`;
// ../../api/customer-profile/composition.ts wires it.
//
// No `clock`/`ids` in `CustomerProfileDeps` — DEFAULT taken (pg-tester's own header comment,
// customer-profile.test.ts:23-28): this slice is a pure read with nothing computed from time or
// randomness (CLAUDE.md · AGENT CONSTRAINTS: "No Math.random() / new Date() in domain/" — here
// there is simply nothing to inject a generator/clock for), unlike manage-contract/manage-
// account-credit's write commands.

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Wired by ../../api/customer-profile/composition.ts to a
 *  @pg-eos/logger child-logger by default; a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything getCustomerProfile needs, injected by the composition root
 *  (../../api/customer-profile/composition.ts). The application layer programs only against these
 *  ports — it never imports infrastructure/. */
export interface CustomerProfileDeps {
  readonly repo: CustomerProfileRepository;
  readonly logger: Logger;
}

export interface AccountRow {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly crNumber: string | null;
  readonly creditLimit: string | null;
  /** `credit_limit > 0`, computed in SQL (pg-reviewer fix round 1, finding 1) — a negative
   *  `credit_limit` (no CHECK constraint forbids one) must not be misread as "present" by a
   *  string-shape check in the application layer. */
  readonly creditLimitPositive: boolean;
  readonly creditHold: boolean;
  readonly holdReason: string | null;
  readonly paymentTermsDays: number | null;
  readonly segmentId: string | null;
  readonly segmentCode: string | null;
  readonly segmentNameAr: string | null;
  readonly ownerUserId: string | null;
  readonly ownerNameAr: string | null;
}

export interface ContractRow {
  readonly contractId: string;
  readonly entityCode: string;
  readonly status: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly hasPriceList: boolean;
}

/** Every DB statement the customer-profile use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/customer-profile/repository.ts. */
export interface CustomerProfileRepository {
  /** `null` when no row is visible (missing, or RLS client_portal_scope hides it) — the caller
   *  maps that to AccountNotFoundError. No lock: a pure read. */
  getAccountById(tx: NodePgDatabase, accountId: string): Promise<AccountRow | null>;
  /** every `sales.contracts` row for the account, across every entity, newest `start_date` first
   *  (Master decision 3). The `priced_contract` readiness item (Master decision 2) is derived from
   *  this same list — `some(c => c.hasPriceList)` — never a second query. */
  getContractsForAccount(tx: NodePgDatabase, accountId: string): Promise<readonly ContractRow[]>;
}
