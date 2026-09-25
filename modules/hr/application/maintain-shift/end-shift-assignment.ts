// modules/hr/application/maintain-shift/end-shift-assignment.ts — WBS 5.5a part 2 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction. Lock order, same discipline as the
// platform/maintain-site precedent (../../../platform/application/maintain-site/update-site.ts):
// (1) the assignment-row lock + expectedVersion check (brief D8 — an assignment outside the
// caller's entity is invisible to the `for update` select, RLS hiding it exactly like a missing
// id, so ShiftAssignmentNotFoundError fires here), (2) pg-reviewer round-2 finding 1 — the role
// gate (brief D3: HR_MGR or GM) runs FIRST among the business checks, straight after the lock/
// stale-version check, so a caller without the role gets a clean RoleRequiredError instead of a
// business-rule error that leaks the row's own validTo/validFrom to an unauthorized caller,
// (3) pg-reviewer round-1 finding 3 — the locked row's own `validTo` must still be null
// (open-ended); an already-ended assignment throws ShiftAssignmentAlreadyEndedError BEFORE any
// write, since pushing an already-set `valid_to` later could silently reopen an overlap the
// exclusion constraint then rejects with a raw 23P01, (4) pg-reviewer round-1 finding 1 — the
// domain's `isValidRange()` check (mirrors migration 0016's `chk_shift_assignments_valid_range`
// CHECK) against the locked row's own `validFrom` and the input's `validTo`, BEFORE any write;
// throws ShiftAssignmentRangeInvalidError (422), (5) the unconditional `valid_to` set + version
// bump — without this command, an employee with one open-ended assignment could never be
// reassigned (brief D2), (6) the 'hr.shift_assignment.ended' outbox event, (7) the audit row
// (last, ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { isValidRange } from '../../domain/maintain-shift/invariants.js';
import {
  MissingActorError,
  RoleRequiredError,
  ShiftAssignmentAlreadyEndedError,
  ShiftAssignmentRangeInvalidError,
  StaleVersionError,
} from '../../domain/maintain-shift/errors.js';
import type { MaintainShiftDeps } from './ports.js';

const AUDIT_OPERATION_UPDATE = 'update';
const SHIFT_ASSIGNMENT_ENDED_EVENT_TYPE: CatalogedEventType = 'hr.shift_assignment.ended';
const SHIFT_ASSIGNMENTS_AGGREGATE_TYPE = 'hr.shift_assignments';
const SHIFT_ASSIGNMENTS_TABLE_NAME = 'shift_assignments';
// brief D3: EndShiftAssignment -> HR_MGR or GM only (same set as the other three commands).
const END_SHIFT_ASSIGNMENT_ROLES = ['HR_MGR', 'GM'] as const;

export interface EndShiftAssignmentInput {
  readonly assignmentId: string;
  readonly validTo: string;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface EndShiftAssignmentResult {
  readonly id: string;
  readonly version: number;
}

export async function endShiftAssignment(
  ctx: WithContextCtx,
  input: EndShiftAssignmentInput,
  deps: MaintainShiftDeps,
): Promise<EndShiftAssignmentResult> {
  if (!ctx.userId) throw new MissingActorError('EndShiftAssignment requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<EndShiftAssignmentResult>(ctx, input.idem, async (tx) => {
    const assignment = await deps.repo.getAssignmentForUpdate(tx, input.assignmentId);
    if (assignment.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `EndShiftAssignment: expectedVersion ${input.expectedVersion} no longer matches assignment ` +
          `${input.assignmentId}'s version ${assignment.version} (optimistic lock).`,
      );
    }

    // pg-reviewer round-2 finding 1: the role gate is the FIRST business check, before any check
    // that could leak the row's own validTo/validFrom to an unauthorized caller.
    if (!(await deps.repo.hasAnyRole(tx, END_SHIFT_ASSIGNMENT_ROLES))) {
      throw new RoleRequiredError(
        `EndShiftAssignment requires role ${END_SHIFT_ASSIGNMENT_ROLES.join(' or ')} (platform.my_roles()).`,
      );
    }

    // pg-reviewer round-1 finding 3: an already-ended assignment (valid_to already set) must never
    // be rewritten — pushing it later could silently reopen an overlap the exclusion constraint
    // then rejects with a raw 23P01. Thrown BEFORE any write.
    if (assignment.validTo !== null) {
      throw new ShiftAssignmentAlreadyEndedError(
        `EndShiftAssignment: assignment ${input.assignmentId} already has validTo ${assignment.validTo} set ` +
          `(already ended). (Allowed: an open-ended assignment, validTo IS NULL)`,
      );
    }

    // pg-reviewer round-1 finding 1: the resulting range (the locked row's own validFrom, the
    // input's validTo) must satisfy chk_shift_assignments_valid_range BEFORE any write, never
    // relying on the DB CHECK's own 23514 error.
    if (!isValidRange(assignment.validFrom, input.validTo)) {
      throw new ShiftAssignmentRangeInvalidError(
        `EndShiftAssignment: validTo ${input.validTo} is earlier than assignment ${input.assignmentId}'s own ` +
          `validFrom ${assignment.validFrom} (chk_shift_assignments_valid_range). (Allowed: validTo >= validFrom)`,
      );
    }

    const updated = await deps.repo.endAssignment(tx, input.assignmentId, input.validTo);

    await writeOutboxEvent(tx, {
      entityId: assignment.entityId,
      aggregateType: SHIFT_ASSIGNMENTS_AGGREGATE_TYPE,
      aggregateId: input.assignmentId,
      eventType: SHIFT_ASSIGNMENT_ENDED_EVENT_TYPE,
      payload: { assignmentId: input.assignmentId, validTo: input.validTo, version: updated.version },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: assignment.entityId,
      tableName: SHIFT_ASSIGNMENTS_TABLE_NAME,
      recordId: input.assignmentId,
      operation: AUDIT_OPERATION_UPDATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { validTo: input.validTo, version: updated.version },
      occurredAt: deps.clock.now(),
    });

    return { id: input.assignmentId, version: updated.version };
  });
}
