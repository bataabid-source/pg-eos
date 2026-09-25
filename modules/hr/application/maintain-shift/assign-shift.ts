// modules/hr/application/maintain-shift/assign-shift.ts — WBS 5.5a part 2 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction. Order: (1) the role gate (brief D3:
// HR_MGR or GM), (2) pg-reviewer round-1 finding 2 — the domain's `isValidRange()` check
// (mirrors migration 0016's `chk_shift_assignments_valid_range` CHECK) against the NEW candidate
// (validFrom, validTo), BEFORE the overlap check; throws ShiftAssignmentRangeInvalidError (422).
// (3) brief D4 — read the employee's EXISTING hr.shift_assignments date ranges
// (a repository query) and run the domain's `overlaps()` check against the candidate
// (validFrom, validTo) BEFORE issuing the INSERT; throws ShiftAssignmentOverlapError (422) on a
// real overlap. The DB's own exclusion constraint (`shift_assignments_no_overlap`, `23P01`) stays
// as the belt-and-braces layer only (doc 36 §5-4 #2's "both, not one") — never the primary
// mechanism; the repository (../../infrastructure/maintain-shift/repository.ts's
// insertShiftAssignment) still catches a raw `23P01` from the TOCTOU race window and re-throws it
// as the SAME typed error (pg-reviewer round-1 finding 4). (4) brief D5 — when `groupId` is
// supplied, look up that group's own `shift_id` (a repository read) and run
// `groupShiftMismatch()` against the input's `shiftId` BEFORE the write; throws
// ShiftGroupShiftMismatchError (422) on mismatch. The DB's own composite FK
// (`shift_assignments_group_shift_fk`, `23503`) stays belt-and-braces only. (5) resolve the
// caller's own entity (brief D6). (6) the INSERT. (7) the 'hr.shift.assigned' outbox event. (8)
// the audit row (last, ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { groupShiftMismatch, isValidRange, overlaps } from '../../domain/maintain-shift/invariants.js';
import {
  MissingActorError,
  RoleRequiredError,
  ShiftAssignmentOverlapError,
  ShiftAssignmentRangeInvalidError,
  ShiftGroupShiftMismatchError,
} from '../../domain/maintain-shift/errors.js';
import type { MaintainShiftDeps } from './ports.js';

const AUDIT_OPERATION_CREATE = 'insert';
const SHIFT_ASSIGNED_EVENT_TYPE: CatalogedEventType = 'hr.shift.assigned';
const SHIFT_ASSIGNMENTS_AGGREGATE_TYPE = 'hr.shift_assignments';
const SHIFT_ASSIGNMENTS_TABLE_NAME = 'shift_assignments';
// brief D3: AssignShift -> HR_MGR or GM only.
const ASSIGN_SHIFT_ROLES = ['HR_MGR', 'GM'] as const;

export interface AssignShiftInput {
  readonly employeeId: string;
  readonly shiftId: string;
  readonly groupId?: string | undefined;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface AssignShiftResult {
  readonly id: string;
  readonly version: number;
}

export async function assignShift(
  ctx: WithContextCtx,
  input: AssignShiftInput,
  deps: MaintainShiftDeps,
): Promise<AssignShiftResult> {
  if (!ctx.userId) throw new MissingActorError('AssignShift requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<AssignShiftResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, ASSIGN_SHIFT_ROLES))) {
      throw new RoleRequiredError(`AssignShift requires role ${ASSIGN_SHIFT_ROLES.join(' or ')} (platform.my_roles()).`);
    }

    const candidate = { validFrom: input.validFrom, validTo: input.validTo ?? null };

    // pg-reviewer round-1 finding 2: the new assignment's own date range must satisfy
    // chk_shift_assignments_valid_range BEFORE the overlap check, never relying on the DB CHECK's
    // own 23514 error.
    if (!isValidRange(candidate.validFrom, candidate.validTo)) {
      throw new ShiftAssignmentRangeInvalidError(
        `AssignShift: validTo ${candidate.validTo ?? 'null'} is earlier than validFrom ` +
          `${candidate.validFrom} (chk_shift_assignments_valid_range). (Allowed: validTo >= validFrom)`,
      );
    }

    // brief D4: the domain-layer overlap check runs BEFORE the repository issues the INSERT — the
    // DB exclusion constraint is belt-and-braces, never the primary mechanism.
    const existingRanges = await deps.repo.getAssignmentRangesForEmployee(tx, input.employeeId);
    if (overlaps(existingRanges, candidate)) {
      throw new ShiftAssignmentOverlapError(
        `AssignShift: employee ${input.employeeId} already has an assignment overlapping ` +
          `[${candidate.validFrom}, ${candidate.validTo ?? 'open-ended'}] (shift_assignments_no_overlap). ` +
          `(Allowed: end the current assignment with EndShiftAssignment first, or a range that does not intersect it)`,
      );
    }

    // brief D5: the domain-layer group/shift consistency check runs BEFORE the repository issues
    // the INSERT — the DB composite FK is belt-and-braces, never the primary mechanism.
    if (input.groupId !== undefined) {
      const groupShiftId = await deps.repo.getShiftGroupShiftId(tx, input.groupId);
      if (groupShiftMismatch(groupShiftId, input.shiftId)) {
        throw new ShiftGroupShiftMismatchError(
          `AssignShift: group ${input.groupId} belongs to shift ${groupShiftId}, not the input's own ` +
            `shiftId ${input.shiftId} (shift_assignments_group_shift_fk). (Allowed: shiftId ${groupShiftId})`,
        );
      }
    }

    const entityId = await deps.repo.resolveCallerEntityId(tx);

    const inserted = await deps.repo.insertShiftAssignment(tx, {
      entityId,
      employeeId: input.employeeId,
      shiftId: input.shiftId,
      groupId: input.groupId ?? null,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      assignedBy: actorId,
    });

    await writeOutboxEvent(tx, {
      entityId,
      aggregateType: SHIFT_ASSIGNMENTS_AGGREGATE_TYPE,
      aggregateId: inserted.id,
      eventType: SHIFT_ASSIGNED_EVENT_TYPE,
      payload: { assignmentId: inserted.id, employeeId: input.employeeId, shiftId: input.shiftId },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId,
      tableName: SHIFT_ASSIGNMENTS_TABLE_NAME,
      recordId: inserted.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { employeeId: input.employeeId, shiftId: input.shiftId, version: inserted.version },
      occurredAt: deps.clock.now(),
    });

    return { id: inserted.id, version: inserted.version };
  });
}
