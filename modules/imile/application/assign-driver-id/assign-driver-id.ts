// modules/imile/application/assign-driver-id/assign-driver-id.ts — WBS 3.12.
//
// ONE withIdempotentContext transaction per assignment — step 0 (the idempotency advisory lock +
// platform.idempotency_keys upsert, ../../../../packages/db/src/idempotency.ts's
// withIdempotentContext) runs first whenever the command's own input carries an `idem`, ahead of
// everything this file does (same discipline as this module's own evaluate-dtl-problem/
// register-vehicle precedents). A replay (same key, same body) never re-runs this command's own
// work at all — withIdempotentContext short-circuits BEFORE `fn` is even invoked and resolves with
// the STORED response from the first call.
//
// Steps, per assignment (round-2 fix round, finding 1: the UPDATE is now a compare-and-set that
// re-checks the guard AT WRITE TIME — see ../../infrastructure/assign-driver-id/repository.ts's own
// `markDriverIdAssigned` — so the early read below can never cause a lost update):
//   0. the idempotency check (above) — a replay short-circuits here.
//   1. deps.clock.now() is read EXACTLY ONCE (`occurredAt`) — assigned_from and both audit rows
//      this call writes share that instant (CLAUDE.md · AGENT CONSTRAINTS: no Date.now()/
//      new Date() in domain/, and here in application/ the clock port is still the only time
//      source).
//   1b. WBS 3.12 part 2c-i: `getDriverAssignabilityCheck` (a read-only, cross-schema query —
//      ../../infrastructure/assign-driver-id/repository.ts, no `modules/hr` TypeScript import,
//      same pattern as WMS's `getContractCheck`) resolves the target employee's own
//      `hr.employees.entity_id`/`status` and `hr.employee_documents` rows, then
//      `../../domain/assign-driver-id/invariants.js`'s `assertDriverAssignable` (this module's own
//      copy of hr's WBS-3.3 INV-C4-1 hard gate, 'task' purpose only) throws `EmployeeNotActiveError`
//      / `DriverDocumentMissingError` / `DriverDocumentExpiredError` before any write — this ALSO
//      covers "a terminated employee cannot be assigned" (a terminated employee's status is never
//      'active'), so no separate terminated-employee check exists.
//   2. SELECT imile.driver_ids.status by driverIdRef — a fast, non-authoritative early check
//      (../../domain/assign-driver-id/invariants.js's `isAssignableStatus`, round-2 fix round
//      finding 4: the business rule now lives in domain/, not as an inline comparison here) that
//      rejects the common case before attempting any write. A driverIdRef that does not exist AT
//      ALL is NOT this typed error (brief's two scenarios are both about an EXISTING row) — it is
//      left to surface as the DB's own foreign-key violation on the insert below, an untyped error
//      mapped to 500 at the api layer (never invented as a third typed error not in the brief).
//   3. INSERT imile.driver_id_assignments (driver_id_ref, employee_id, assigned_from=occurredAt,
//      assigned_to=null, assigned_by=ctx.userId) — the repository translates the DB's own
//      partial-unique-index violations to EmployeeAlreadyAssignedError / DriverIdNotAvailableError.
//   4. Compare-and-set UPDATE imile.driver_ids SET status='assigned', updated_at=now() WHERE
//      id=driverIdRef AND status='available' RETURNING id — the ACTUAL guard against the race step
//      2's read cannot close on its own (round-2 fix round, finding 1): zero rows means the row was
//      not 'available' at the instant of the UPDATE (including a concurrent status change racing
//      with steps 2/3 above — e.g. trg_close_on_suspension), mapped to
//      DriverIdNotAvailableError; the whole transaction (including step 3's insert) rolls back, so
//      "no row is written" holds for this case too.
//   5. Two platform.audit_log rows: one for the assignment insert, one for the driver_ids status
//      update (brief, Audit row).
//   5b. WBS 3.12 part 2c-i: ONE platform.outbox row, `imile.driver_id.assigned` (packages/events/
//      catalog.ts, granted by the Master), written via `@pg-eos/events`'s `writeOutboxEvent` right
//      after step 5's assignment-insert audit row, in the SAME transaction — `entity_id` resolved
//      from step 1b's own read (the employee's `hr.employees.entity_id`; neither
//      `imile.driver_ids` nor `imile.driver_id_assignments` has its own entity_id column, G-01 row
//      `l`, docs/notes/2026-09-24-imile-agent-scenario.md §4). No second audit_log row — step 5's
//      insert row already satisfies G9's pairing requirement (writeOutboxEvent's own doc comment).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import {
  assertDriverAssignable,
  businessDateOf,
  isAssignableStatus,
  isValidAssignDriverIdInput,
} from '../../domain/assign-driver-id/invariants.js';
import { DriverIdNotAvailableError, MissingActorError } from '../../domain/assign-driver-id/errors.js';
import type { AssignDriverIdDeps } from './ports.js';

const AUDIT_OPERATION_INSERT = 'insert';
const AUDIT_OPERATION_UPDATE = 'update';
const DRIVER_IDS_TABLE_NAME = 'driver_ids';
const DRIVER_ID_ASSIGNMENTS_TABLE_NAME = 'driver_id_assignments';
const DRIVER_ID_STATUS_AVAILABLE = 'available';
const DRIVER_ID_STATUS_ASSIGNED = 'assigned';
const DRIVER_ID_ASSIGNED_EVENT_TYPE: CatalogedEventType = 'imile.driver_id.assigned';
const DRIVER_ID_ASSIGNMENTS_AGGREGATE_TYPE = 'imile.driver_id_assignments';

export interface AssignDriverIdInput {
  readonly driverIdRef: string;
  readonly employeeId: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface AssignDriverIdResult {
  readonly assignmentId: string;
}

export async function assignDriverId(
  ctx: WithContextCtx,
  input: AssignDriverIdInput,
  deps: AssignDriverIdDeps,
): Promise<AssignDriverIdResult> {
  // doc 40 P3/P7: every audit row this command writes needs an actor — ctx.userId ONLY, same
  // discipline as this module's own evaluate-dtl-problem/register-vehicle precedents. Checked
  // before the idempotency context.
  if (!ctx.userId) throw new MissingActorError('AssignDriverId requires ctx.userId.');
  const actorId = ctx.userId;

  // brief, Contract: `{ driverIdRef: uuid, employeeId: uuid, correlationId: uuid }` — the api layer
  // (../../api/assign-driver-id/handlers.ts) already enforces this via
  // AssignDriverIdInputSchema.parse before calling here; this is a defense-in-depth re-assertion
  // for any OTHER caller of this application function (round-2 fix round, finding 4: wires
  // ../../domain/assign-driver-id/invariants.js's `isValidAssignDriverIdInput` into the entry point
  // instead of leaving it unused).
  if (!isValidAssignDriverIdInput(input)) {
    throw new Error('AssignDriverId: input does not match the brief Contract shape.');
  }

  return withIdempotentContext<AssignDriverIdResult>(ctx, input.idem, async (tx) => {
    const occurredAt = deps.clock.now();

    // WBS 3.12 part 2c-i, doc 40 INV-C4-1 — the SAME query serves two purposes (brief, Scenario:
    // "one query serves both purposes, no separate read"): the employee's own `entity_id` (the
    // outbox row's own `entityId` below — neither imile table has its own entity_id column) AND the
    // employee-status/document shape `assertDriverAssignable` gates on. Runs before any write —
    // ahead of the existing early `selectDriverIdStatus` check (order between the two early checks
    // does not matter).
    const assignabilityCheck = await deps.repo.getDriverAssignabilityCheck(tx, input.employeeId);
    const today = businessDateOf(occurredAt);
    assertDriverAssignable(
      { status: assignabilityCheck.employeeStatus },
      assignabilityCheck.documents,
      today,
    );

    // Step 2 — the ONE transition this command guards (available -> assigned): a precondition
    // check via the domain predicate (round-2 fix round, finding 4), not a dispatched state machine
    // (brief, Deliver). This is a FAST, non-authoritative early exit — see step 4's comment for the
    // atomic guard that actually prevents the race.
    const driverIdRow = await deps.repo.selectDriverIdStatus(tx, input.driverIdRef);
    if (driverIdRow && !isAssignableStatus(driverIdRow.status)) {
      throw new DriverIdNotAvailableError(
        'This driver ID is not available for assignment. (Allowed: an available driver ID.)',
      );
    }

    // Step 3 — the repository translates the DB's own partial-unique-index violations to
    // EmployeeAlreadyAssignedError / DriverIdNotAvailableError. A driverIdRef that does not exist AT
    // ALL is NOT either typed error (brief's two scenarios are both about an EXISTING row) — it is
    // left to surface as the DB's own foreign-key violation, an untyped error mapped to 500 at the
    // api layer (never invented as a third typed error not in the brief).
    const inserted = await deps.repo.insertAssignment(tx, {
      driverIdRef: input.driverIdRef,
      employeeId: input.employeeId,
      assignedFrom: occurredAt,
      assignedBy: actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      tableName: DRIVER_ID_ASSIGNMENTS_TABLE_NAME,
      recordId: inserted.id,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        driverIdRef: input.driverIdRef,
        employeeId: input.employeeId,
        assignedFrom: occurredAt.toISOString(),
        assignedTo: null,
        assignedBy: actorId,
        approvedBy: null,
        handoverDocId: null,
      },
      occurredAt,
    });

    // WBS 3.12 part 2c-i, finding 9 (CLAUDE.md · ARCHITECTURE): ONE platform.outbox row, in the
    // SAME transaction as the state change. The existing INSERT audit row above (same
    // correlationId) already satisfies G9's audit-log pairing obligation — writeOutboxEvent's own
    // doc comment (packages/events/src/outbox.ts) says not to write a second one. `entityId` is the
    // assignability check's own `entityId` (the ASSIGNED EMPLOYEE's own hr.employees.entity_id) —
    // read once, not re-read here (brief, Scenario: "one query serves both purposes").
    await writeOutboxEvent(tx, {
      entityId: assignabilityCheck.entityId,
      aggregateType: DRIVER_ID_ASSIGNMENTS_AGGREGATE_TYPE,
      aggregateId: inserted.id,
      eventType: DRIVER_ID_ASSIGNED_EVENT_TYPE,
      payload: {
        driverIdRef: input.driverIdRef,
        employeeId: input.employeeId,
        assignedFrom: occurredAt.toISOString(),
        assignedBy: actorId,
      },
      correlationId: input.correlationId,
      actorId,
    });

    // Step 4 — the guard and the write are the SAME statement
    // (../../infrastructure/assign-driver-id/repository.ts's `markDriverIdAssigned` — a
    // compare-and-set UPDATE, `where status = 'available'`), so a concurrent status change racing
    // with steps 2/3 above (e.g. trg_close_on_suspension) can never be silently
    // overwritten back to 'assigned' (round-2 fix round, finding 1). `updated` is `false` only when
    // the row was not 'available' at the instant of the UPDATE; the whole transaction (including
    // step 3's insert) rolls back in that case, so "no row is written" holds even under a race the
    // step-2 early check missed.
    const updated = await deps.repo.markDriverIdAssigned(tx, input.driverIdRef);
    if (!updated) {
      throw new DriverIdNotAvailableError(
        'This driver ID is not available for assignment. (Allowed: an available driver ID.)',
      );
    }

    await deps.repo.writeAuditRow(tx, {
      tableName: DRIVER_IDS_TABLE_NAME,
      recordId: input.driverIdRef,
      operation: AUDIT_OPERATION_UPDATE,
      correlationId: input.correlationId,
      actorId,
      oldValue: { status: DRIVER_ID_STATUS_AVAILABLE },
      newValue: { status: DRIVER_ID_STATUS_ASSIGNED },
      changedFields: ['status', 'updated_at'],
      occurredAt,
    });

    return { assignmentId: inserted.id };
  });
}
