// packages/contracts/hr/maintain-shift.ts — WBS 5.5a part 2 (lane 2).
//
// Zod input schemas for the maintain-shift use case's four commands (brief D2: CreateShift,
// CreateShiftGroup, AssignShift, EndShiftAssignment — no UpdateShift/UpdateShiftGroup command).
// `daysOfWeek` mirrors migration 0016's `chk_shifts_dow` at the contract layer (non-empty, each
// element 0-6) — the SAME rule is re-validated at the domain layer too
// (../../../modules/hr/domain/maintain-shift/invariants.ts's isValidDaysOfWeek), doc 36 §5-4 #2's
// dual-enforcement discipline. `graceMinutes` is REQUIRED (brief D9 — migration 0016 gives
// `grace_minutes` no DB default, since no `platform.thresholds` key exists for it; a hardcoded
// fallback here would be a fabricated number). `performedBy` does NOT exist on any schema: the
// actor is ALWAYS `ctx.userId`. `entityId` does NOT exist either — brief D6: "entity_id =
// ctx.entityId (never caller-supplied)". `expectedVersion` appears only on
// EndShiftAssignmentInputSchema (brief D8 — the only command taking an optimistic lock).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// migration 0016 `time` columns — `HH:MM` or `HH:MM:SS`, 24h.
const TIME_OF_DAY = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
// migration 0016 chk_shifts_dow: cardinality(days_of_week) > 0 and days_of_week <@ array[0..6].
const DAY_OF_WEEK = z.number().int().min(0).max(6);
// brief D9 / migration 0016: grace_minutes int not null, chk_shifts_grace_nonneg (>= 0), NO
// default — required here, never a hardcoded fallback (CLAUDE.md "No magic numbers").
const GRACE_MINUTES = z.number().int().min(0);
// migration 0016 chk_shift_groups_type.
const GROUP_TYPES = ['transport', 'warehouse', 'other'] as const;
// hr.shift_assignments.version / hr.shifts.version / hr.shift_groups.version all start at 1
// (migration 0016: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);

export const CreateShiftInputSchema = z
  .object({
    code: z.string().min(1),
    nameAr: z.string().min(1),
    nameEn: z.string().min(1).optional(),
    startsAt: TIME_OF_DAY,
    endsAt: TIME_OF_DAY,
    crossesMidnight: z.boolean().optional(),
    graceMinutes: GRACE_MINUTES,
    daysOfWeek: z.array(DAY_OF_WEEK).min(1),
    siteId: UUID_ID,
    correlationId: UUID_ID,
  })
  .meta({ id: 'CreateShiftInput' });

export type CreateShiftInput = z.infer<typeof CreateShiftInputSchema>;

export const CreateShiftGroupInputSchema = z
  .object({
    shiftId: UUID_ID,
    code: z.string().min(1),
    nameAr: z.string().min(1),
    groupType: z.enum(GROUP_TYPES),
    leadEmployeeId: UUID_ID,
    vehicleId: UUID_ID.optional(),
    siteId: UUID_ID,
    startsAt: TIME_OF_DAY.optional(),
    endsAt: TIME_OF_DAY.optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'CreateShiftGroupInput' });

export type CreateShiftGroupInput = z.infer<typeof CreateShiftGroupInputSchema>;

export const AssignShiftInputSchema = z
  .object({
    employeeId: UUID_ID,
    shiftId: UUID_ID,
    groupId: UUID_ID.optional(),
    validFrom: z.iso.date(),
    // omitted -> open-ended/current (brief Scenario: "Assign an employee to a shift" — "no validTo").
    validTo: z.iso.date().optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'AssignShiftInput' });

export type AssignShiftInput = z.infer<typeof AssignShiftInputSchema>;

export const EndShiftAssignmentInputSchema = z
  .object({
    assignmentId: UUID_ID,
    validTo: z.iso.date(),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'EndShiftAssignmentInput' });

export type EndShiftAssignmentInput = z.infer<typeof EndShiftAssignmentInputSchema>;
