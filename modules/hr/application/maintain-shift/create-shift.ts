// modules/hr/application/maintain-shift/create-shift.ts — WBS 5.5a part 2 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts). Order, modelled on the platform/maintain-site
// precedent (../../../platform/application/maintain-site/create-site.ts): (1) the role gate
// (brief D3: HR_MGR or GM), (2) the domain invariants (isValidDaysOfWeek — brief P3/chk_shifts_dow
// — and pg-reviewer round-1 finding 6's isValidGraceMinutes/chk_shifts_grace_nonneg — thrown
// BEFORE any DB write, never relying on the DB CHECK's own error), (3) resolve the caller's own
// entity (brief D6 — never caller-supplied), (4) the INSERT (the repository catches a `23505`
// unique violation on `code` and re-throws it as ShiftCodeTakenError — pg-reviewer round-1
// finding 7), (5) the 'hr.shift.created' outbox event, (6) the audit row (last, ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { isValidDaysOfWeek, isValidGraceMinutes } from '../../domain/maintain-shift/invariants.js';
import {
  DaysOfWeekInvalidError,
  MissingActorError,
  RoleRequiredError,
  ShiftGraceMinutesInvalidError,
} from '../../domain/maintain-shift/errors.js';
import type { MaintainShiftDeps } from './ports.js';

const AUDIT_OPERATION_CREATE = 'insert';
const SHIFT_CREATED_EVENT_TYPE: CatalogedEventType = 'hr.shift.created';
const SHIFTS_AGGREGATE_TYPE = 'hr.shifts';
const SHIFTS_TABLE_NAME = 'shifts';
// brief D3: CreateShift -> HR_MGR or GM only.
const CREATE_SHIFT_ROLES = ['HR_MGR', 'GM'] as const;

export interface CreateShiftInput {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn?: string | undefined;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly crossesMidnight?: boolean | undefined;
  readonly graceMinutes: number;
  readonly daysOfWeek: readonly number[];
  readonly siteId: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateShiftResult {
  readonly id: string;
  readonly version: number;
}

export async function createShift(
  ctx: WithContextCtx,
  input: CreateShiftInput,
  deps: MaintainShiftDeps,
): Promise<CreateShiftResult> {
  if (!ctx.userId) throw new MissingActorError('CreateShift requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateShiftResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, CREATE_SHIFT_ROLES))) {
      throw new RoleRequiredError(`CreateShift requires role ${CREATE_SHIFT_ROLES.join(' or ')} (platform.my_roles()).`);
    }

    if (!isValidDaysOfWeek(input.daysOfWeek)) {
      throw new DaysOfWeekInvalidError(
        `CreateShift: daysOfWeek ${JSON.stringify(input.daysOfWeek)} must be non-empty with every element in [0,6] ` +
          `(chk_shifts_dow). (Allowed: non-empty, each element 0-6)`,
      );
    }

    if (!isValidGraceMinutes(input.graceMinutes)) {
      throw new ShiftGraceMinutesInvalidError(
        `CreateShift: graceMinutes ${input.graceMinutes} must be >= 0 (chk_shifts_grace_nonneg). (Allowed: >= 0)`,
      );
    }

    const entityId = await deps.repo.resolveCallerEntityId(tx);

    const inserted = await deps.repo.insertShift(tx, {
      entityId,
      code: input.code,
      nameAr: input.nameAr,
      nameEn: input.nameEn ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      crossesMidnight: input.crossesMidnight,
      graceMinutes: input.graceMinutes,
      daysOfWeek: input.daysOfWeek,
      siteId: input.siteId,
    });

    await writeOutboxEvent(tx, {
      entityId,
      aggregateType: SHIFTS_AGGREGATE_TYPE,
      aggregateId: inserted.id,
      eventType: SHIFT_CREATED_EVENT_TYPE,
      payload: { shiftId: inserted.id, code: input.code },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId,
      tableName: SHIFTS_TABLE_NAME,
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
