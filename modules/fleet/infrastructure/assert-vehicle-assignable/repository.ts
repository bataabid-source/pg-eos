// modules/fleet/infrastructure/assert-vehicle-assignable/repository.ts — WBS 3.1.
//
// infrastructure/ layer: every DB statement for the assert-vehicle-assignable use case, run against
// the `tx` a caller's own withContext(ctx, fn) already opened (see
// ../../application/assert-vehicle-assignable/assert-vehicle-assignable.ts). Implements
// ../../application/assert-vehicle-assignable/ports.ts's `AssignabilityRepository`. Read-only: no
// insert/update, so no row lock — the vehicle's own `entity_scope` RLS policy (fleet.brief.md · §2)
// already limits the read to whatever entity(ies) the caller's session is scoped to, same as every
// other RLS-scoped read in this codebase.
//
// TEMPLATE GUIDANCE — every module-specific literal a later slice's copy must change is a named
// constant in this ONE file:
const VEHICLE_SCHEMA = 'tms'; // REPLACE-ON-COPY: the module schema.
const VEHICLE_TABLE_NAME = 'vehicles'; // REPLACE-ON-COPY: the aggregate table.
const VEHICLE_TABLE = `${VEHICLE_SCHEMA}.${VEHICLE_TABLE_NAME}`; // dotted, so sed-rename catches both halves.
const DOCUMENT_TABLE_NAME = 'vehicle_documents'; // REPLACE-ON-COPY: the document table.
const DOCUMENT_TABLE = `${VEHICLE_SCHEMA}.${DOCUMENT_TABLE_NAME}`; // dotted, like VEHICLE_TABLE.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { VehicleNotFoundError } from '../../domain/assert-vehicle-assignable/errors.js';
import type {
  AssignabilityRepository,
  VehicleDocumentRow,
  VehicleForAssignabilityCheck,
} from '../../application/assert-vehicle-assignable/ports.js';

async function findVehicleForAssignabilityCheck(
  tx: NodePgDatabase,
  vehicleId: string,
): Promise<VehicleForAssignabilityCheck> {
  const vehicleResult = await tx.execute<{ plate_no: string }>(sql`
    select plate_no from ${sql.raw(VEHICLE_TABLE)} where id = ${vehicleId}::uuid
  `);
  const vehicleRow = vehicleResult.rows[0];
  if (!vehicleRow) {
    throw new VehicleNotFoundError(
      `no ${VEHICLE_TABLE} row readable for id ${JSON.stringify(vehicleId)} (either it does not exist, or ` +
        `it is outside the caller's own entity_scope). (Allowed: an id of a vehicle the caller can read.)`,
    );
  }

  const documentsResult = await tx.execute<{ doc_type: string; expiry_date: string }>(sql`
    select doc_type, expiry_date::text as expiry_date
    from ${sql.raw(DOCUMENT_TABLE)}
    where vehicle_id = ${vehicleId}::uuid
  `);
  const documents: VehicleDocumentRow[] = documentsResult.rows.map((row) => ({
    docType: row.doc_type,
    expiryDate: row.expiry_date,
  }));

  return { plateNo: vehicleRow.plate_no, documents };
}

export const assignabilityRepository: AssignabilityRepository = {
  findVehicleForAssignabilityCheck,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export { VEHICLE_SCHEMA, VEHICLE_TABLE_NAME, VEHICLE_TABLE, DOCUMENT_TABLE_NAME, DOCUMENT_TABLE };
