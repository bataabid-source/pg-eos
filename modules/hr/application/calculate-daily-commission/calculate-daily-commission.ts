// modules/hr/application/calculate-daily-commission/calculate-daily-commission.ts — WBS 3.13
// part 2.
//
// ONE withIdempotentContext transaction (step 0 — see ../../../../packages/db/src/idempotency.ts —
// runs first when input.idem is set). Order (brief, Deliver):
//   1. resolve entityId from ctx (never caller-supplied — same discipline as register-employee/
//      register-vehicle's own resolveCallerEntityId).
//   1a. round-1 review finding 1 (SECURITY/RLS): read the target employeeId's own
//       hr.employees.entity_id (through hr.employees' own entity_scope RLS) and refuse with
//       EmployeeNotInCallerEntityError BEFORE any shipments/rule read if no row is visible or its
//       entity_id does not equal the resolved entityId — an entity-A caller must never write a
//       commission row (priced by A's own rules) for an entity-B employee.
//   2. query imile.shipments_attributed (NEVER imile.shipments.driver_code directly — doc 38's
//      "Attribution through assignment table only" acceptance criterion) grouped by
//      internal_status, for ofd_at::date = workDate.
//   3. query candidate hr.commission_rules rows.
//   4. domain's selectCommissionRule — "none" -> NoApplicableCommissionRuleError, "ambiguous" ->
//      AmbiguousCommissionRuleError.
//   5. gross_commission = greatest(delivered_count * rate_per_unit, coalesce(min_daily, 0)) —
//      domain's own computeGrossCommission (round-1 review finding 4: moved out of this file into
//      ../../domain/calculate-daily-commission/invariants.js so it is a pure, testable function) —
//      exact decimal arithmetic via @pg-eos/domain-kit's Money (numeric(14,3), no floating-point).
//   6. resolve driver_id_ref: the employee's ACTIVE imile.driver_id_assignments row covering
//      workDate, null if none active that day (brief default 5).
//   7. INSERT hr.commission_daily, status 'calculated' — the repository translates the DB's own
//      unique (work_date, employee_id) violation to CommissionAlreadyCalculatedError. The insert's
//      own id is pre-generated (deps.ids.next()) so it never needs a RETURNING clause (see
//      ../../infrastructure/calculate-daily-commission/repository.ts's own header for why).
//   8. ONE platform.audit_log row for the insert.
//   9. NO outbox event this slice (brief default 4 — no event named in doc 40/38 for this step).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import {
  computeGrossCommission,
  selectCommissionRule,
} from '../../domain/calculate-daily-commission/invariants.js';
import {
  AmbiguousCommissionRuleError,
  EmployeeNotInCallerEntityError,
  MissingActorError,
  NoApplicableCommissionRuleError,
  NotInternalActorError,
} from '../../domain/calculate-daily-commission/errors.js';
import { COMMISSION_DAILY_STATUS_CALCULATED, type CalculateDailyCommissionDeps } from './ports.js';

const AUDIT_OPERATION_INSERT = 'insert';

export interface CalculateDailyCommissionInput {
  readonly employeeId: string;
  readonly workDate: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CalculateDailyCommissionResult {
  readonly commissionDailyId: string;
  readonly grossCommission: string;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly returnedCount: number;
}

export async function calculateDailyCommission(
  ctx: WithContextCtx,
  input: CalculateDailyCommissionInput,
  deps: CalculateDailyCommissionDeps,
): Promise<CalculateDailyCommissionResult> {
  // doc 40 P3/P7: every audit row this command writes needs an actor — ctx.userId ONLY, same
  // discipline as register-employee/register-vehicle/assign-driver-id precedents.
  if (!ctx.userId) throw new MissingActorError('CalculateDailyCommission requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CalculateDailyCommissionResult>(ctx, input.idem, async (tx) => {
    const occurredAt = deps.clock.now();

    // Step 1 — never caller-supplied. A truly scope-less outsider (zero identity.user_entities
    // rows, e.g. outsiderCtx) is refused HERE, by EntityScopeAmbiguousError, before ever reaching
    // the isInternal gate below.
    const entityId = await deps.repo.resolveCallerEntityId(tx);

    // Step 1a (MASTER_BACKLOG 3.13 part 2, item 2 — originally part 1's round-2 finding 2,
    // typed-error gap): a caller who DOES resolve a real,
    // unambiguous entity scope but is not internal (e.g. NON_INTERNAL_WITH_ENTITY_ACTOR_UUID) is
    // fail-closed HERE, before any further read or the write — same discipline as
    // expire-contract's own "Role gate FIRST" ctx.isInternal check
    // (../../domain/calculate-daily-commission/errors.js's own NotInternalActorError header cites
    // both cross-module precedents). hr.commission_daily's own migration-0027 INSERT/UPDATE
    // policies already gate on platform.is_internal() — this only TRANSLATES that rejection into a
    // typed, actionable error instead of a raw RLS 42501 the caller would otherwise hit only once
    // the INSERT itself runs.
    if (!ctx.isInternal) {
      throw new NotInternalActorError(
        'CalculateDailyCommission requires an internal caller — hr.commission_daily has no write ' +
          "policy for a non-internal actor (migration 0027's own INSERT/UPDATE policies gate on " +
          'platform.is_internal()). (Allowed: an internal caller session.)',
      );
    }

    // Step 1b — round-1 review finding 1 (SECURITY/RLS): fail fast, before any shipments/rule
    // read, if the target employeeId is not visible in / does not belong to the caller's own
    // resolved entity.
    const employeeEntityId = await deps.repo.getEmployeeEntityId(tx, input.employeeId);
    if (employeeEntityId === null || employeeEntityId !== entityId) {
      throw new EmployeeNotInCallerEntityError(
        `employeeId ${input.employeeId} is not visible in, or does not belong to, the caller's ` +
          `own resolved entity ${entityId}. (Allowed: calculate commission only for an employee ` +
          `of your own entity.)`,
      );
    }

    // Step 2 — imile.shipments_attributed ONLY (doc 38's own acceptance criterion).
    const counts = await deps.repo.getAttributedShipmentCounts(tx, {
      employeeId: input.employeeId,
      workDate: input.workDate,
    });

    // Step 3 — candidates pre-filtered by entity/applies_to/client_id/valid-window in SQL; only
    // the tier match itself happens in domain/ (brief, Deliver).
    const candidates = await deps.repo.getCandidateCommissionRules(tx, {
      entityId,
      workDate: input.workDate,
    });

    // Step 4.
    const selection = selectCommissionRule(candidates, counts.deliveredCount);
    if (selection.kind === 'none') {
      throw new NoApplicableCommissionRuleError(
        `no hr.commission_rules row matches employee ${input.employeeId}'s entity, tier and valid ` +
          `window for ${input.workDate}. (Allowed: exactly one matching rule.)`,
      );
    }
    if (selection.kind === 'ambiguous') {
      throw new AmbiguousCommissionRuleError(
        `${selection.rules.length} hr.commission_rules rows match the same tier for employee ` +
          `${input.employeeId} on ${input.workDate}. (Allowed: exactly one matching rule; no ` +
          `tie-break specified.)`,
      );
    }
    const { rule } = selection;

    // Step 5 — greatest(delivered_count * rate_per_unit, coalesce(min_daily, 0)), exact decimal
    // arithmetic (domain's own computeGrossCommission, Money, never a float).
    const grossCommission = computeGrossCommission(counts.deliveredCount, rule.ratePerUnit, rule.minDaily);

    // Step 6.
    const driverIdRef = await deps.repo.getActiveDriverIdRef(tx, {
      employeeId: input.employeeId,
      workDate: input.workDate,
    });

    const ruleSnapshot = await deps.repo.getCommissionRuleSnapshot(tx, rule.id);

    const commissionDailyId = deps.ids.next();

    // Step 7 — the repository translates hr.commission_daily's own unique
    // (work_date, employee_id) violation to CommissionAlreadyCalculatedError.
    await deps.repo.insertCommissionDaily(tx, {
      id: commissionDailyId,
      entityId,
      workDate: input.workDate,
      employeeId: input.employeeId,
      driverIdRef,
      deliveredCount: counts.deliveredCount,
      failedCount: counts.failedCount,
      returnedCount: counts.returnedCount,
      grossCommission: grossCommission.toString(),
      sourceSnapshot: {
        deliveredCount: counts.deliveredCount,
        failedCount: counts.failedCount,
        returnedCount: counts.returnedCount,
        deliveredTrackingNos: counts.deliveredTrackingNos,
        failedTrackingNos: counts.failedTrackingNos,
        returnedTrackingNos: counts.returnedTrackingNos,
      },
      ruleSnapshot,
    });

    // Step 8 — status is always 'calculated' this slice (brief, Deliver).
    await deps.repo.writeAuditRow(tx, {
      entityId,
      recordId: commissionDailyId,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        employeeId: input.employeeId,
        workDate: input.workDate,
        driverIdRef,
        deliveredCount: counts.deliveredCount,
        failedCount: counts.failedCount,
        returnedCount: counts.returnedCount,
        grossCommission: grossCommission.toString(),
        status: COMMISSION_DAILY_STATUS_CALCULATED,
      },
      occurredAt,
    });

    return {
      commissionDailyId,
      grossCommission: grossCommission.toString(),
      deliveredCount: counts.deliveredCount,
      failedCount: counts.failedCount,
      returnedCount: counts.returnedCount,
    };
  });
}
