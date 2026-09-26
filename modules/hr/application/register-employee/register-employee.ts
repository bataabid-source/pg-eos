// modules/hr/application/register-employee/register-employee.ts — WBS 3.3.
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set). Order: (1) the
// role gate (brief D6: HR_MGR or GM), (2) resolve the caller's own entity (brief D9 — never
// caller-supplied), (3) the INSERT (infrastructure translates a `employees_code_key` unique
// violation to EmployeeCodeTakenError), (4) the 'hr.employee.registered' outbox event, (5) the
// audit row (last, ADR-0002 — no row lock is taken after it; this command takes no row lock at
// all, since it only inserts).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { EMPLOYEE_STATUS } from '../../domain/register-employee/machine.js';
import { assertEmployeeCodeFormat } from '../../domain/register-employee/invariants.js';
import { MissingActorError, RoleRequiredError } from '../../domain/register-employee/errors.js';
import type { RegisterEmployeeDeps } from './ports.js';

const AUDIT_OPERATION_REGISTER = 'insert';
// Event name listed in packages/events/catalog.ts (added by the Master on MIGRATION-REQUEST-2,
// origin/main 8d7d337) — typed as CatalogedEventType so a typo fails typecheck, as the golden
// slice does for its own events.
const EMPLOYEE_REGISTERED_EVENT_TYPE: CatalogedEventType = 'hr.employee.registered';
const EMPLOYEES_AGGREGATE_TYPE = 'hr.employees';
// brief D6: RegisterEmployee -> HR_MGR or GM.
const REGISTER_EMPLOYEE_ROLES = ['HR_MGR', 'GM'] as const;
// 01-Data-Model.sql:1277 `hr.employees.employment_type not null default 'full_time'`.
const DEFAULT_EMPLOYMENT_TYPE = 'full_time';

export interface RegisterEmployeeInput {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn?: string | undefined;
  readonly civilId?: string | undefined;
  readonly nationality?: string | undefined;
  readonly passportNo?: string | undefined;
  readonly jobTitleAr?: string | undefined;
  readonly jobTitleEn?: string | undefined;
  readonly orgUnitId?: string | undefined;
  readonly reportsTo?: string | undefined;
  readonly employmentType?: string | undefined;
  readonly hireDate: string;
  readonly assignedClientId?: string | undefined;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface RegisterEmployeeResult {
  readonly id: string;
  readonly code: string;
  readonly status: 'active';
  readonly version: number;
}

export async function registerEmployee(
  ctx: WithContextCtx,
  input: RegisterEmployeeInput,
  deps: RegisterEmployeeDeps,
): Promise<RegisterEmployeeResult> {
  if (!ctx.userId) throw new MissingActorError('RegisterEmployee requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<RegisterEmployeeResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, REGISTER_EMPLOYEE_ROLES))) {
      throw new RoleRequiredError(
        `RegisterEmployee requires role ${REGISTER_EMPLOYEE_ROLES.join(' or ')} (platform.my_roles()).`,
      );
    }

    assertEmployeeCodeFormat(input.code);

    const entityId = await deps.repo.resolveCallerEntityId(tx);

    const inserted = await deps.repo.insertEmployee(tx, {
      entityId,
      code: input.code,
      nameAr: input.nameAr,
      nameEn: input.nameEn ?? null,
      civilId: input.civilId ?? null,
      nationality: input.nationality ?? null,
      passportNo: input.passportNo ?? null,
      jobTitleAr: input.jobTitleAr ?? null,
      jobTitleEn: input.jobTitleEn ?? null,
      orgUnitId: input.orgUnitId ?? null,
      reportsTo: input.reportsTo ?? null,
      employmentType: input.employmentType ?? DEFAULT_EMPLOYMENT_TYPE,
      hireDate: input.hireDate,
      assignedClientId: input.assignedClientId ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
    });

    await writeOutboxEvent(tx, {
      entityId,
      aggregateType: EMPLOYEES_AGGREGATE_TYPE,
      aggregateId: inserted.id,
      eventType: EMPLOYEE_REGISTERED_EVENT_TYPE,
      payload: { employeeId: inserted.id, code: input.code },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId,
      target: 'employee',
      recordId: inserted.id,
      operation: AUDIT_OPERATION_REGISTER,
      correlationId: input.correlationId,
      actorId,
      newValue: { code: input.code, status: EMPLOYEE_STATUS.ACTIVE, version: inserted.version },
      occurredAt: deps.clock.now(),
    });

    return { id: inserted.id, code: input.code, status: EMPLOYEE_STATUS.ACTIVE, version: inserted.version };
  });
}
