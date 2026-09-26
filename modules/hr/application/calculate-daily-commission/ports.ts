// modules/hr/application/calculate-daily-commission/ports.ts — WBS 3.13 part 1.
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: CalculateDailyCommissionDeps` (clock, ids, repo, logger) and never imports
// infrastructure/. ../../infrastructure/calculate-daily-commission/repository.ts implements
// `CommissionDailyRepository`; ../../api/calculate-daily-commission/composition.ts wires it.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN interface(s) named after its own
// aggregate — do not import this file from another use case (same discipline as register-employee/
// assign-driver-id's own ports.ts).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { CommissionRuleCandidate } from '../../domain/calculate-daily-commission/invariants.js';

// round-1 review finding 12: the single source of truth for hr.commission_daily's inserted
// `status` value this slice ever writes — shared by the application layer (audit new_value) and
// the infrastructure layer (the INSERT statement itself) so the two can never drift out of a
// literal string duplicated in two files.
export const COMMISSION_DAILY_STATUS_CALCULATED = 'calculated';

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by
 *  ../../infrastructure/calculate-daily-commission/logger.ts (a @pg-eos/logger child-logger
 *  adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** delivered/failed/returned counts read from imile.shipments_attributed (NEVER
 *  imile.shipments.driver_code directly — doc 38's "Attribution through assignment table only"
 *  acceptance criterion), grouped by internal_status, for one employee/work date. `trackingNos`
 *  per status feeds `source_snapshot` (brief: "which shipment ids contributed"). */
export interface AttributedShipmentCounts {
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly returnedCount: number;
  readonly deliveredTrackingNos: readonly string[];
  readonly failedTrackingNos: readonly string[];
  readonly returnedTrackingNos: readonly string[];
}

export interface InsertCommissionDailyColumns {
  readonly id: string;
  readonly entityId: string;
  readonly workDate: string;
  readonly employeeId: string;
  readonly driverIdRef: string | null;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly returnedCount: number;
  readonly grossCommission: string;
  readonly sourceSnapshot: unknown;
  readonly ruleSnapshot: unknown;
}

/** Every DB statement the calculate-daily-commission use case needs, as an interface — the port
 *  the application layer programs against. Implemented by
 *  ../../infrastructure/calculate-daily-commission/repository.ts. Every cross-schema read
 *  (imile.shipments_attributed, imile.driver_id_assignments) follows the `getContractCheck`
 *  pattern (modules/wms/infrastructure/process-outbound/repository.ts:245-280): plain SQL via
 *  `tx.execute`, no `modules/imile` TypeScript import (cross-module lint boundary). */
export interface CommissionDailyRepository {
  /** brief, Contract: "entityId resolved from ctx" — resolved from identity.user_entities via
   *  platform.allowed_entities(), never trusted from the request body. Same discipline as
   *  register-employee/register-vehicle's own resolveCallerEntityId. */
  resolveCallerEntityId(tx: NodePgDatabase): Promise<string>;

  /** round-1 review finding 1 (SECURITY/RLS): the target employeeId's own `hr.employees.entity_id`
   *  — read through `hr.employees`' own `entity_scope` RLS, so a row invisible to the caller
   *  returns no row here at all (indistinguishable from "does not exist", by the same design as
   *  register-employee's own EmployeeNotFoundError). `null` when no row is visible. The caller
   *  compares this against the resolved `entityId` BEFORE any shipments/rule read — never a
   *  cross-entity write. */
  getEmployeeEntityId(tx: NodePgDatabase, employeeId: string): Promise<string | null>;

  /** imile.shipments_attributed — the ONLY allowed view for attributing a shipment to a human
   *  driver (doc 38's own acceptance criterion) — grouped by internal_status, for the Kuwait-local
   *  business day (repository.ts's own `(ofd_at AT TIME ZONE 'Asia/Kuwait')::date = workDate`,
   *  MASTER_BACKLOG 3.13 part 2 item 1 — never a bare `ofd_at::date` cast). */
  getAttributedShipmentCounts(
    tx: NodePgDatabase,
    params: { readonly employeeId: string; readonly workDate: string },
  ): Promise<AttributedShipmentCounts>;

  /** the employee's ACTIVE imile.driver_id_assignments row covering `workDate` (brief default 5) —
   *  `null` when none is active that day (the row is still insertable; shipments were still
   *  attributed via a historical assignment row). */
  getActiveDriverIdRef(
    tx: NodePgDatabase,
    params: { readonly employeeId: string; readonly workDate: string },
  ): Promise<string | null>;

  /** candidate hr.commission_rules rows: entity_id, applies_to='driver', client_id is null,
   *  valid_from <= workDate, valid_to is null or valid_to >= workDate (brief default 1) — the
   *  tier match itself is NOT done here, only in
   *  ../../domain/calculate-daily-commission/invariants.js's `selectCommissionRule`. */
  getCandidateCommissionRules(
    tx: NodePgDatabase,
    params: { readonly entityId: string; readonly workDate: string },
  ): Promise<readonly CommissionRuleCandidate[]>;

  /** the full row of the matched rule (brief: "rule_snapshot is populated" with "the matched
   *  rule's full row"). */
  getCommissionRuleSnapshot(tx: NodePgDatabase, ruleId: string): Promise<Record<string, unknown>>;

  /** INSERT into hr.commission_daily, status always 'calculated' — `id` is pre-generated
   *  (deps.ids.next()) so this insert never needs a `RETURNING` clause: `hr.commission_daily`'s
   *  own `own_commission` SELECT policy (migration 0027) applies to `INSERT ... RETURNING` too, and
   *  this use case's actor is not guaranteed to hold `hr.commission.read_all` or be the row's own
   *  employee. Translates the DB's own `commission_daily_work_date_employee_id_key` unique
   *  violation to `CommissionAlreadyCalculatedError` (same pattern as register-vehicle's
   *  `DuplicatePlateNoError` translation). */
  insertCommissionDaily(tx: NodePgDatabase, columns: InsertCommissionDailyColumns): Promise<void>;

  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/calculate-daily-commission/composition.ts). The command programs only against these
 *  ports — the application layer never imports infrastructure/. */
export interface CalculateDailyCommissionDeps extends ClockDeps {
  readonly repo: CommissionDailyRepository;
  readonly logger: Logger;
}
