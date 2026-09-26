// modules/hr/application/dispute-commission/ports.ts — WBS 3.13 part 4.
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: DisputeCommissionDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/dispute-commission/repository.ts implements `CommissionDailyRepository`;
// ../../api/dispute-commission/composition.ts wires it.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN interface(s) named after its own
// aggregate — do not import this file from another use case (same discipline as
// calculate-daily-commission's own ports.ts).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { CommissionDailyStatus } from '../../domain/dispute-commission/machine.js';

// platform.thresholds key this use case reads at runtime — NEVER a magic `48` literal
// (CLAUDE.md · AGENT CONSTRAINTS).
export const DISPUTE_WINDOW_THRESHOLD_KEY = 'hr.commission.dispute_window_hours';

export const AUDIT_OPERATION_UPDATE = 'update';

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by
 *  ../../infrastructure/dispute-commission/logger.ts (a @pg-eos/logger child-logger adapter); a
 *  fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** The subset of an hr.commission_daily row DisputeCommission needs to validate a dispute — a
 *  plain SELECT, genuinely subject to the table's own `own_commission` RLS policy (a row invisible
 *  to the caller returns `null`, indistinguishable from a non-existent one). */
export interface CommissionDailyRow {
  readonly id: string;
  readonly entityId: string;
  readonly status: CommissionDailyStatus;
  readonly employeeId: string;
  readonly workDate: string;
  readonly createdAt: Date;
  readonly version: number;
  /** round-1 review finding 7: the row's REAL prior values, read before the UPDATE, so the audit
   *  row's `old_value` never assumes a `calculated` row's `dispute_note`/`disputed_at` are null (the
   *  table's own CHECK constraints do not guarantee it, 13-Schema-Additions.sql:381-383). */
  readonly disputeNote: string | null;
  readonly disputedAt: Date | null;
}

/** Every DB statement the dispute-commission use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/dispute-commission/repository.ts. */
export interface CommissionDailyRepository {
  /** platform.thresholds `hr.commission.dispute_window_hours` (migration 0033) — read at runtime,
   *  never hardcoded. */
  getDisputeWindowHours(tx: NodePgDatabase): Promise<number>;

  /** `null` when no row is visible for `id` (does not exist, or `own_commission`'s own RLS policy
   *  hides it from the caller). */
  getCommissionDailyById(tx: NodePgDatabase, id: string): Promise<CommissionDailyRow | null>;

  /** round-1 review finding 2 (SECURITY) / brief Scenario 1: the DISPUTING actor must be the row's
   *  OWN employee's own linked user — `EXISTS (SELECT 1 FROM identity.users WHERE id =
   *  disputingUserId AND employee_id = employeeId)`, an EXISTS check, never a naive single-row
   *  lookup (employee_id carries no unique constraint), mirroring
   *  ../confirm-commission/ports.ts's own `isSelfReview` shape (the same DB fact, read for the
   *  opposite conclusion: here TRUE is required to proceed, there TRUE blocks). */
  isOwnRow(
    tx: NodePgDatabase,
    params: { readonly disputingUserId: string; readonly employeeId: string },
  ): Promise<boolean>;

  /** `UPDATE hr.commission_daily SET status='disputed', dispute_note=$, disputed_at=$,
   *  version=version+1 WHERE id=$1 AND version=$2` — no RETURNING (this table's own
   *  `own_commission` SELECT policy is ALSO applied by Postgres to `UPDATE ... RETURNING`, and this
   *  use case's own actor is not guaranteed to hold `hr.commission.read_all` or be the row's own
   *  employee, same discipline as calculate-daily-commission's own avoided-RETURNING insert).
   *  Returns `true` iff exactly one row was updated; `false` (zero rows) means the optimistic lock
   *  failed — the application layer throws `StaleVersionError`. */
  updateToDisputed(
    tx: NodePgDatabase,
    params: {
      readonly id: string;
      readonly expectedVersion: number;
      readonly disputeNote: string;
      readonly disputedAt: Date;
    },
  ): Promise<boolean>;

  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly oldValue: unknown;
      readonly newValue: unknown;
      readonly changedFields: readonly string[];
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/dispute-commission/composition.ts). The command programs only against these ports —
 *  the application layer never imports infrastructure/. */
export interface DisputeCommissionDeps extends ClockDeps {
  readonly repo: CommissionDailyRepository;
  readonly logger: Logger;
}
