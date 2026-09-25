// modules/hr/domain/maintain-shift/errors.ts — WBS 5.5a part 2 (lane 2).
//
// Typed errors for the maintain-shift use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS; same discipline as modules/wms/domain/receive-inbound/errors.ts, THE GOLDEN
// SLICE) — an `Error` subclass does NOT get its constructor name for free at runtime. The api/
// layer (../../api/maintain-shift/handlers.ts) maps these to the Problem envelope:
// StaleVersionError -> 409, everything else -> 422/400 per that layer's own map.
// IdempotencyConflictError is NOT declared here — it comes from `@pg-eos/db`
// (packages/db/src/idempotency.ts), same as the platform/maintain-site and hr/register-employee
// precedents.

/** brief D4 (mirrors migration 0016's `shift_assignments_no_overlap` exclusion constraint): the
 *  employee already has an existing hr.shift_assignments row whose date range genuinely
 *  intersects the candidate (validFrom, validTo). Thrown BEFORE any DB write — the domain-layer
 *  `overlaps()` check (./invariants.js) runs first; the DB exclusion constraint stays as the
 *  belt-and-braces layer (doc 36 §5-4 #2's "both, not one"). Maps to HTTP 422. */
export class ShiftAssignmentOverlapError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ShiftAssignmentOverlapError';
  }
}

/** brief D5 (mirrors migration 0016's composite FK `shift_assignments_group_shift_fk`): the
 *  caller supplied a `groupId` whose own `shift_id` disagrees with the input's `shiftId`. Thrown
 *  BEFORE any DB write — the domain-layer `groupShiftMismatch()` check (./invariants.js) runs
 *  first; the DB composite FK stays as the belt-and-braces layer. Maps to HTTP 422. */
export class ShiftGroupShiftMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftGroupShiftMismatchError';
  }
}

/** Optimistic-lock conflict: `expectedVersion` no longer matches the locked hr.shift_assignments
 *  row's own `version` — another caller already advanced it (brief D8, EndShiftAssignment only).
 *  Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The caller does not hold any of the roles a command requires (checked via
 *  `platform.my_roles()` inside the transaction — read, never guessed, brief D3). */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to platform.audit_log.user_id / platform.outbox.actor_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}

/** brief D6 (3.3/part-1 precedent): "entity_id = ctx.entityId (never caller-supplied)" —
 *  resolved from `platform.allowed_entities()`. Thrown, never defaulted, when the caller's own
 *  entity scope is not exactly one entity. Thrown BEFORE any write. */
export class EntityScopeAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityScopeAmbiguousError';
  }
}

/** No hr.shift_assignments row is visible for this id — it does not exist, or RLS hides it from
 *  the caller (indistinguishable from a missing one, by design — same convention as
 *  EmployeeNotFoundError/SiteNotFoundError). Maps to 422 (the Problem envelope has no 404). */
export class ShiftAssignmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftAssignmentNotFoundError';
  }
}

/** brief D5: AssignShift's `groupId`, when supplied, must reference an existing, visible
 *  hr.shift_groups row (to read its own shift_id) BEFORE the write. Maps to 422. */
export class ShiftGroupNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftGroupNotFoundError';
  }
}

/** pg-reviewer round-1 findings 1/2 (mirrors migration 0016's `chk_shift_assignments_valid_range`
 *  CHECK, `valid_to is null or valid_to >= valid_from`): the domain-layer `isValidRange()` check
 *  (./invariants.js) runs BEFORE any write, both for AssignShift's new candidate range (finding 2)
 *  and EndShiftAssignment's own resulting range (finding 1) — a raw `23514` must never reach the
 *  API as a 500. Maps to HTTP 422. */
export class ShiftAssignmentRangeInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftAssignmentRangeInvalidError';
  }
}

/** pg-reviewer round-1 finding 3: EndShiftAssignment was called on a row whose `valid_to` is
 *  already set (already ended) — pushing it later could silently reopen an overlap the exclusion
 *  constraint then rejects with a raw `23P01`. Thrown BEFORE any write. Maps to HTTP 422. */
export class ShiftAssignmentAlreadyEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftAssignmentAlreadyEndedError';
  }
}

/** pg-reviewer round-1 finding 5 (mirrors migration 0016's `chk_shifts_dow` CHECK): CreateShift's
 *  `daysOfWeek` failed the domain's own `isValidDaysOfWeek()` check — a raw `Error`/`23514` must
 *  never reach the API as a 500. Maps to HTTP 422. Same shape as
 *  modules/platform/domain/maintain-site/errors.ts's `SiteKindInvalidError`. */
export class DaysOfWeekInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaysOfWeekInvalidError';
  }
}

/** pg-reviewer round-1 finding 6 (mirrors migration 0016's `chk_shifts_grace_nonneg` CHECK,
 *  `grace_minutes >= 0`): CreateShift's `graceMinutes` failed the domain's own
 *  `isValidGraceMinutes()` check. Thrown BEFORE any write. Maps to HTTP 422. */
export class ShiftGraceMinutesInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftGraceMinutesInvalidError';
  }
}

/** pg-reviewer round-1 finding 6 (mirrors migration 0016's `chk_shift_groups_type` CHECK,
 *  `group_type in ('transport','warehouse','other')`): CreateShiftGroup's `groupType` failed the
 *  domain's own `isValidGroupType()` check. Thrown BEFORE any write. Maps to HTTP 422. */
export class ShiftGroupTypeInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShiftGroupTypeInvalidError';
  }
}

/** pg-reviewer round-1 finding 7 (mirrors migration 0016's `shifts_code_key` unique constraint on
 *  `hr.shifts.code`): the repository caught a `23505` unique violation on that constraint and
 *  re-threw it as this typed error instead of letting the raw constraint violation reach the API
 *  as a 500 — same pattern as modules/hr/infrastructure/register-employee/repository.ts's own
 *  `EmployeeCodeTakenError` mapping. Maps to HTTP 409. */
export class ShiftCodeTakenError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ShiftCodeTakenError';
  }
}

/** pg-reviewer round-1 finding 7 (mirrors migration 0016's `shift_groups_code_key` unique
 *  constraint on `hr.shift_groups.code`): same pattern as `ShiftCodeTakenError` above, for
 *  hr.shift_groups. Maps to HTTP 409. */
export class ShiftGroupCodeTakenError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ShiftGroupCodeTakenError';
  }
}
