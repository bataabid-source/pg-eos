// modules/hr/application/register-employee/change-employee-status.ts — WBS 3.3.
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set). Lock order,
// same discipline as the golden slice's own approve-inbound.ts / cancel-inbound.ts: (1)
// employee-row lock + expectedVersion check, (2) role gate (brief D6: HR_MGR or GM), (3) the
// machine's legality check — advanceEmployeeStatus is called directly (never an if/switch on the
// status string — CLAUDE.md · AGENT CONSTRAINTS) and itself throws IllegalTransitionError, naming
// allowedEventsFrom, the moment the event is not legal (same shape as the golden slice's own
// approve-inbound.ts, ../../../wms/application/receive-inbound/approve-inbound.ts:52-54), (4) the
// unconditional version bump — end_date is set to the injected clock's own Kuwait business date
// ONLY when the target is 'terminated' (brief D7), (5) the audit row (last, ADR-0002). No outbox
// event (brief D8: "ChangeEmployeeStatus writes an audit_log row only — the driver-ID release on
// termination is a 13 trigger and 3.12's concern").

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import {
  EMPLOYEE_STATUS,
  EMPLOYEE_STATUS_TO_EVENT,
  advanceEmployeeStatus,
  type EmployeeStatus,
} from '../../domain/register-employee/machine.js';
import { businessDateOf } from '../../domain/register-employee/invariants.js';
import { MissingActorError, RoleRequiredError, StaleVersionError } from '../../domain/register-employee/errors.js';
import type { RegisterEmployeeDeps } from './ports.js';

const AUDIT_OPERATION_CHANGE_STATUS = 'update';
// brief D6: ChangeEmployeeStatus -> HR_MGR or GM (same set as RegisterEmployee).
const CHANGE_STATUS_ROLES = ['HR_MGR', 'GM'] as const;

export interface ChangeEmployeeStatusInput {
  readonly employeeId: string;
  readonly newStatus: EmployeeStatus;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ChangeEmployeeStatusResult {
  readonly status: EmployeeStatus;
  readonly version: number;
  readonly endDate: string | null;
}

export async function changeEmployeeStatus(
  ctx: WithContextCtx,
  input: ChangeEmployeeStatusInput,
  deps: RegisterEmployeeDeps,
): Promise<ChangeEmployeeStatusResult> {
  if (!ctx.userId) throw new MissingActorError('ChangeEmployeeStatus requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ChangeEmployeeStatusResult>(ctx, input.idem, async (tx) => {
    const employee = await deps.repo.getEmployeeForUpdate(tx, input.employeeId);
    if (employee.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `ChangeEmployeeStatus: expectedVersion ${input.expectedVersion} no longer matches ` +
          `employee ${input.employeeId}'s version ${employee.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasAnyRole(tx, CHANGE_STATUS_ROLES))) {
      throw new RoleRequiredError(
        `ChangeEmployeeStatus requires role ${CHANGE_STATUS_ROLES.join(' or ')} (platform.my_roles()).`,
      );
    }

    const event = EMPLOYEE_STATUS_TO_EVENT[input.newStatus];
    // no if on the status string — advanceEmployeeStatus asks the machine and THROWS
    // IllegalTransitionError itself, naming allowedEventsFrom, when `event` is not legal from
    // `employee.status` (golden slice parity, approve-inbound.ts:52-54).
    const newStatus = advanceEmployeeStatus(employee.status, [event]);
    const occurredAt = deps.clock.now();
    const endDate = newStatus === EMPLOYEE_STATUS.TERMINATED ? businessDateOf(occurredAt) : null;

    const newVersion = await deps.repo.updateEmployeeStatus(tx, input.employeeId, { status: newStatus, endDate });

    await deps.repo.writeAuditRow(tx, {
      entityId: employee.entityId,
      target: 'employee',
      recordId: input.employeeId,
      operation: AUDIT_OPERATION_CHANGE_STATUS,
      correlationId: input.correlationId,
      actorId,
      newValue: { status: newStatus, version: newVersion, endDate },
      occurredAt,
    });

    return { status: newStatus, version: newVersion, endDate };
  });
}
