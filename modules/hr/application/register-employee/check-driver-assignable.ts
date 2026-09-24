// modules/hr/application/register-employee/check-driver-assignable.ts — WBS 3.3.
//
// application/ layer — doc 40 INV-C4-1, the hard gate. Read-only: no Idempotency-Key, no `idem`
// field on the input (brief D1), so this runs through withIdempotentContext with `idem` always
// undefined — exactly `withContext(ctx, fn)` (CLAUDE.md · ARCHITECTURE: "All DB access goes
// through withContext"), no row lock, no write. Order: (1) role gate (brief D6: DEL_MGR, FLEET_MGR,
// HR_MGR or GM — the assigning roles), (2) read the employee + its documents, (3) the domain gate
// (assertDriverAssignable) — a failure is always a typed throw, never `{ assignable: false }`
// (Contract section).

import { withIdempotentContext, type WithContextCtx } from '@pg-eos/db';

import { assertDriverAssignable, businessDateOf, type DriverAssignmentPurpose } from '../../domain/register-employee/invariants.js';
import { MissingActorError, RoleRequiredError } from '../../domain/register-employee/errors.js';
import type { RegisterEmployeeDeps } from './ports.js';

// brief D6: CheckDriverAssignable -> any of DEL_MGR, FLEET_MGR, HR_MGR, GM (the assigning roles).
const CHECK_DRIVER_ASSIGNABLE_ROLES = ['DEL_MGR', 'FLEET_MGR', 'HR_MGR', 'GM'] as const;

export interface CheckDriverAssignableInput {
  readonly employeeId: string;
  readonly purpose: DriverAssignmentPurpose;
  readonly correlationId: string;
}

export interface CheckDriverAssignableResult {
  readonly assignable: true;
}

export async function checkDriverAssignable(
  ctx: WithContextCtx,
  input: CheckDriverAssignableInput,
  deps: RegisterEmployeeDeps,
): Promise<CheckDriverAssignableResult> {
  if (!ctx.userId) throw new MissingActorError('CheckDriverAssignable requires ctx.userId.');

  return withIdempotentContext<CheckDriverAssignableResult>(ctx, undefined, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, CHECK_DRIVER_ASSIGNABLE_ROLES))) {
      throw new RoleRequiredError(
        `CheckDriverAssignable requires role ${CHECK_DRIVER_ASSIGNABLE_ROLES.join(' or ')} (platform.my_roles()).`,
      );
    }

    const employee = await deps.repo.getEmployee(tx, input.employeeId);
    const documents = await deps.repo.getDocumentsForEmployee(tx, input.employeeId);
    const today = businessDateOf(deps.clock.now());

    assertDriverAssignable(employee, documents, input.purpose, today);

    return { assignable: true };
  });
}
