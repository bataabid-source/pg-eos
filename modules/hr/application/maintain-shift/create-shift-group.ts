// modules/hr/application/maintain-shift/create-shift-group.ts — WBS 5.5a part 2 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction. Order, same discipline as
// ./create-shift.ts: (1) the role gate (brief D3: HR_MGR or GM), (2) the domain invariant
// (isValidGroupType — pg-reviewer round-1 finding 6/chk_shift_groups_type — thrown BEFORE any DB
// write, never relying on the DB CHECK's own error; dual domain+DB enforcement, same discipline
// as ./create-shift.ts's isValidDaysOfWeek — migration 0016's chk_shift_groups_type is NOT the
// sole enforcer), (3) resolve the caller's own entity (brief D6), (4) the INSERT (the repository
// catches a `23505` unique violation on `code` and re-throws it as ShiftGroupCodeTakenError —
// pg-reviewer round-1 finding 7), (5) the 'hr.shift_group.created' outbox event, (6) the audit row
// (last, ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { isValidGroupType, VALID_GROUP_TYPES_LIST } from '../../domain/maintain-shift/invariants.js';
import {
  MissingActorError,
  RoleRequiredError,
  ShiftGroupTypeInvalidError,
} from '../../domain/maintain-shift/errors.js';
import type { MaintainShiftDeps } from './ports.js';

const AUDIT_OPERATION_CREATE = 'insert';
const SHIFT_GROUP_CREATED_EVENT_TYPE: CatalogedEventType = 'hr.shift_group.created';
const SHIFT_GROUPS_AGGREGATE_TYPE = 'hr.shift_groups';
const SHIFT_GROUPS_TABLE_NAME = 'shift_groups';
// brief D3: CreateShiftGroup -> HR_MGR or GM only.
const CREATE_SHIFT_GROUP_ROLES = ['HR_MGR', 'GM'] as const;

export interface CreateShiftGroupInput {
  readonly shiftId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly groupType: string;
  readonly leadEmployeeId: string;
  readonly vehicleId?: string | undefined;
  readonly siteId: string;
  readonly startsAt?: string | undefined;
  readonly endsAt?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateShiftGroupResult {
  readonly id: string;
  readonly version: number;
}

export async function createShiftGroup(
  ctx: WithContextCtx,
  input: CreateShiftGroupInput,
  deps: MaintainShiftDeps,
): Promise<CreateShiftGroupResult> {
  if (!ctx.userId) throw new MissingActorError('CreateShiftGroup requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateShiftGroupResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, CREATE_SHIFT_GROUP_ROLES))) {
      throw new RoleRequiredError(
        `CreateShiftGroup requires role ${CREATE_SHIFT_GROUP_ROLES.join(' or ')} (platform.my_roles()).`,
      );
    }

    if (!isValidGroupType(input.groupType)) {
      throw new ShiftGroupTypeInvalidError(
        `CreateShiftGroup: groupType "${input.groupType}" is not one of the values chk_shift_groups_type allows. ` +
          `(Allowed: ${VALID_GROUP_TYPES_LIST})`,
      );
    }

    const entityId = await deps.repo.resolveCallerEntityId(tx);

    const inserted = await deps.repo.insertShiftGroup(tx, {
      entityId,
      shiftId: input.shiftId,
      code: input.code,
      nameAr: input.nameAr,
      groupType: input.groupType,
      leadEmployeeId: input.leadEmployeeId,
      vehicleId: input.vehicleId ?? null,
      siteId: input.siteId,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    });

    await writeOutboxEvent(tx, {
      entityId,
      aggregateType: SHIFT_GROUPS_AGGREGATE_TYPE,
      aggregateId: inserted.id,
      eventType: SHIFT_GROUP_CREATED_EVENT_TYPE,
      payload: { shiftGroupId: inserted.id, shiftId: input.shiftId, code: input.code },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId,
      tableName: SHIFT_GROUPS_TABLE_NAME,
      recordId: inserted.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { code: input.code, nameAr: input.nameAr, version: inserted.version },
      occurredAt: deps.clock.now(),
    });

    return { id: inserted.id, version: inserted.version };
  });
}
