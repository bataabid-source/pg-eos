// modules/hr/application/maintain-shift/ports.ts — WBS 5.5a part 2 (lane 2).
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: MaintainShiftDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/maintain-shift/repository.ts implements `ShiftRepository`.
// ../../api/maintain-shift/composition.ts wires it. Shape copied from the platform/maintain-site
// precedent (../../../platform/application/maintain-site/ports.ts) via this session's own part 1
// — this use case has three aggregate tables (hr.shifts, hr.shift_groups,
// hr.shift_assignments), so the repository carries one insert method per table plus the reads
// AssignShift/EndShiftAssignment need BEFORE their own write.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator every command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/maintain-shift/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/maintain-shift/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface MaintainShiftDeps extends ClockDeps {
  readonly repo: ShiftRepository;
  readonly logger: Logger;
}

export interface InsertShiftColumns {
  readonly entityId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly crossesMidnight: boolean | undefined;
  readonly graceMinutes: number;
  readonly daysOfWeek: readonly number[];
  readonly siteId: string;
}

export interface InsertShiftGroupColumns {
  readonly entityId: string;
  readonly shiftId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly groupType: string;
  readonly leadEmployeeId: string;
  readonly vehicleId: string | null;
  readonly siteId: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

export interface InsertShiftAssignmentColumns {
  readonly entityId: string;
  readonly employeeId: string;
  readonly shiftId: string;
  readonly groupId: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly assignedBy: string;
}

export interface InsertedRow {
  readonly id: string;
  readonly version: number;
}

export interface ShiftAssignmentRow {
  readonly id: string;
  readonly entityId: string;
  readonly version: number;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface ExistingAssignmentRange {
  readonly validFrom: string;
  readonly validTo: string | null;
}

/** Every DB statement the maintain-shift use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/maintain-shift/repository.ts. */
export interface ShiftRepository {
  insertShift(tx: NodePgDatabase, columns: InsertShiftColumns): Promise<InsertedRow>;
  insertShiftGroup(tx: NodePgDatabase, columns: InsertShiftGroupColumns): Promise<InsertedRow>;
  /** all of `employeeId`'s existing hr.shift_assignments date ranges — read BEFORE the write, so
   *  the domain-layer `overlaps()` check (brief D4) runs before the INSERT. */
  getAssignmentRangesForEmployee(tx: NodePgDatabase, employeeId: string): Promise<readonly ExistingAssignmentRange[]>;
  /** the group's own `shift_id` — read BEFORE the write, so the domain-layer
   *  `groupShiftMismatch()` check (brief D5) runs before the INSERT. Throws
   *  ShiftGroupNotFoundError when no such group is visible. */
  getShiftGroupShiftId(tx: NodePgDatabase, groupId: string): Promise<string>;
  insertShiftAssignment(tx: NodePgDatabase, columns: InsertShiftAssignmentColumns): Promise<InsertedRow>;
  /** row lock, FIRST — `select ... for update`. Throws ShiftAssignmentNotFoundError (RLS hides an
   *  assignment outside the caller's entities the same way a missing id does). */
  getAssignmentForUpdate(tx: NodePgDatabase, assignmentId: string): Promise<ShiftAssignmentRow>;
  /** unconditional `valid_to` set + version bump — the caller already validated `expectedVersion`
   *  against the locked row and holds that lock for the whole transaction, so this never races.
   *  Returns the new version. */
  endAssignment(tx: NodePgDatabase, assignmentId: string, validTo: string): Promise<{ readonly version: number }>;
  /** true iff the caller holds at least one of `roleCodes` (`platform.my_roles()`) — brief D3
   *  gates every command on an OR of roles, never a single one. */
  hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean>;
  /** the caller's own entity (brief D6: "entity_id = ctx.entityId (never caller-supplied)") —
   *  resolved from identity.user_entities via platform.allowed_entities(), never trusted from the
   *  request body. */
  resolveCallerEntityId(tx: NodePgDatabase): Promise<string>;
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly tableName: string;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}
