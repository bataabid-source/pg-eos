// modules/fleet/application/register-vehicle/register-vehicle.ts — WBS 3.1.
//
// registerVehicle — ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set; a replay short-
// circuits BEFORE this callback ever runs). Order: (1) resolve the caller's own entity (brief:
// "entityId ... come[s] from ctx, never the caller"), (2) the tms.vehicles INSERT (infrastructure
// translates a plate_no unique violation to DuplicatePlateNoError; status stays at its own column
// default), (3) one tms.vehicle_documents INSERT per document, in order (registration is NEVER
// blocked by an expired document — a non-internal caller is rejected atomically by that table's own
// `internal_only` RLS policy, rolling back the whole transaction including the vehicle row already
// inserted), (4) canBeAssigned computed ONCE from the exact documents just inserted (doc 40
// INV-C4-1's vehicle half — never a stored column), (5) the 'fleet.vehicle.registered' outbox
// event, (6) the audit row, last (ADR-0002 — no row lock is taken after it; this command takes no
// row lock at all, since it only inserts).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent } from '@pg-eos/events';

import { hasExpiredDocument } from '../../domain/register-vehicle/invariants.js';
import { MissingActorError } from '../../domain/register-vehicle/errors.js';
import type { RegisterVehicleDeps, RegisterVehicleDocumentInput } from './ports.js';

const AUDIT_OPERATION_INSERT = 'insert';
// Event name to be added to packages/events/catalog.ts by the Master (frozen path, MIGRATION-
// REQUEST — brief "Event" line: "reported to the Master for packages/events/catalog.ts"). Left as
// a plain string literal (not typed CatalogedEventType) until that catalog entry lands.
const VEHICLE_REGISTERED_EVENT_TYPE = 'fleet.vehicle.registered';
const VEHICLES_AGGREGATE_TYPE = 'fleet.vehicles';

export interface RegisterVehicleInput {
  readonly plateNo: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly year: number | null;
  readonly vehicleType: string;
  readonly capacityKg: number | null;
  readonly capacityCbm: number | null;
  readonly isRefrigerated: boolean;
  readonly ownership: string;
  readonly assignedClientId: string | null;
  readonly documents: readonly RegisterVehicleDocumentInput[];
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface RegisterVehicleResult {
  readonly id: string;
  readonly documentIds: readonly string[];
  readonly canBeAssigned: boolean;
}

export async function registerVehicle(
  ctx: WithContextCtx,
  input: RegisterVehicleInput,
  deps: RegisterVehicleDeps,
): Promise<RegisterVehicleResult> {
  if (!ctx.userId) throw new MissingActorError('RegisterVehicle requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<RegisterVehicleResult>(ctx, input.idem, async (tx) => {
    const occurredAt = deps.clock.now();
    const entityId = await deps.repo.resolveCallerEntityId(tx);

    const vehicle = await deps.repo.insertVehicle(tx, {
      entityId,
      plateNo: input.plateNo,
      make: input.make,
      model: input.model,
      year: input.year,
      vehicleType: input.vehicleType,
      capacityKg: input.capacityKg,
      capacityCbm: input.capacityCbm,
      isRefrigerated: input.isRefrigerated,
      ownership: input.ownership,
      assignedClientId: input.assignedClientId,
    });

    // Registration itself is never blocked by an expired document — every document the caller
    // supplied is inserted as given (brief, Scenario "A vehicle registered with one expired
    // document cannot be assigned"). A non-internal caller is rejected here by
    // tms.vehicle_documents' own `internal_only` RLS policy, which aborts the whole transaction —
    // including the vehicle row already inserted above.
    const documentIds: string[] = [];
    for (const document of input.documents) {
      const insertedDocument = await deps.repo.insertVehicleDocument(tx, {
        vehicleId: vehicle.id,
        docType: document.docType,
        docNo: document.docNo,
        issueDate: document.issueDate,
        expiryDate: document.expiryDate,
        fileUrl: document.fileUrl,
        alertDaysBefore: document.alertDaysBefore,
      });
      documentIds.push(insertedDocument.id);
    }

    // Computed ONCE, from the exact documents this call just inserted (brief: "NOT a stored
    // column").
    const canBeAssigned = !hasExpiredDocument(input.documents, occurredAt);

    await writeOutboxEvent(tx, {
      entityId,
      aggregateType: VEHICLES_AGGREGATE_TYPE,
      aggregateId: vehicle.id,
      eventType: VEHICLE_REGISTERED_EVENT_TYPE,
      payload: { vehicleId: vehicle.id, plateNo: input.plateNo, canBeAssigned },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId,
      recordId: vehicle.id,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        entityId,
        plateNo: input.plateNo,
        make: input.make,
        model: input.model,
        year: input.year,
        vehicleType: input.vehicleType,
        capacityKg: input.capacityKg,
        capacityCbm: input.capacityCbm,
        isRefrigerated: input.isRefrigerated,
        ownership: input.ownership,
        assignedClientId: input.assignedClientId,
      },
      occurredAt,
    });

    return { id: vehicle.id, documentIds, canBeAssigned };
  });
}
