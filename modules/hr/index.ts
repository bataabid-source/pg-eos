// modules/hr — package shell created by scripts/new-slice.sh (lane blocker (c), 2026-09-24),
// copied from the golden module's shell (modules/wms). Public barrel: every use case re-exports
// its application layer and typed domain errors here, same shape as modules/wms/index.ts. Never
// hand-made (CLAUDE.md · SPEED AND QUALITY).
export * from './application/register-employee/index.js';
export * from './domain/register-employee/errors.js';

// WBS 5.5a part 2 (lane 2, SCR-HR-SHIFT-01 §2.1-§2.3): hr.shifts / hr.shift_groups /
// hr.shift_assignments. Named re-exports (not `export *`): ./domain/register-employee/errors.js
// already exports RoleRequiredError / StaleVersionError / MissingActorError /
// EntityScopeAmbiguousError — a wildcard re-export from both use cases would collide (same
// discipline as modules/platform/index.ts's own maintain-site precedent). maintain-shift's own
// error names are aliased with a `MaintainShift` prefix here so both use cases' typed errors stay
// reachable from this one module barrel.
export {
  createShift,
  createShiftGroup,
  assignShift,
  endShiftAssignment,
  type CreateShiftInput,
  type CreateShiftResult,
  type CreateShiftGroupInput,
  type CreateShiftGroupResult,
  type AssignShiftInput,
  type AssignShiftResult,
  type EndShiftAssignmentInput,
  type EndShiftAssignmentResult,
  type MaintainShiftDeps,
  type ShiftRepository,
} from './application/maintain-shift/index.js';
export {
  ShiftAssignmentOverlapError,
  ShiftGroupShiftMismatchError,
  ShiftAssignmentNotFoundError,
  ShiftGroupNotFoundError,
  RoleRequiredError as MaintainShiftRoleRequiredError,
  StaleVersionError as MaintainShiftStaleVersionError,
  MissingActorError as MaintainShiftMissingActorError,
  EntityScopeAmbiguousError as MaintainShiftEntityScopeAmbiguousError,
} from './domain/maintain-shift/errors.js';
