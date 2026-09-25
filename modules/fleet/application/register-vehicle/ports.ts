// modules/fleet/application/register-vehicle/ports.ts — WBS 3.1.
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: RegisterVehicleDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/register-vehicle/repository.ts implements `VehiclesRepository`;
// ../../api/register-vehicle/composition.ts wires it.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN interface(s) named after its
// own aggregate — do not import this file from another use case.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/register-vehicle/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** One document as the command itself needs it — a structural subset of
 *  packages/contracts/fleet/register-vehicle.ts's own document shape (the application layer never
 *  imports the contract package). */
export interface RegisterVehicleDocumentInput {
  readonly docType: string;
  readonly docNo: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string;
  readonly fileUrl: string | null;
  readonly alertDaysBefore: number;
}

export interface InsertVehicleColumns {
  readonly entityId: string;
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
}

export interface InsertedVehicleRow {
  readonly id: string;
}

export interface InsertVehicleDocumentColumns {
  readonly vehicleId: string;
  readonly docType: string;
  readonly docNo: string | null;
  readonly issueDate: string | null;
  readonly expiryDate: string;
  readonly fileUrl: string | null;
  readonly alertDaysBefore: number;
}

/** Every DB statement the register-vehicle use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/register-vehicle/repository.ts. */
export interface VehiclesRepository {
  /** Throws DuplicatePlateNoError on a `tms.vehicles.plate_no` unique violation — translated here,
   *  in infrastructure, since only that layer sees the raw pg error. `status` is never passed here
   *  — it stays at its own column default (brief, Contract line). */
  insertVehicle(tx: NodePgDatabase, columns: InsertVehicleColumns): Promise<InsertedVehicleRow>;
  /** INSERT ONLY — one row per document, in the order the caller supplied them. A non-internal
   *  caller is rejected by tms.vehicle_documents' own `internal_only` RLS policy — never
   *  reimplemented as an application-level check (brief). */
  insertVehicleDocument(tx: NodePgDatabase, columns: InsertVehicleDocumentColumns): Promise<{ readonly id: string }>;
  /** the caller's own entity (brief: "entityId ... come[s] from ctx, never the caller") — resolved
   *  from identity.user_entities via platform.allowed_entities(), never trusted from the request
   *  body. */
  resolveCallerEntityId(tx: NodePgDatabase): Promise<string>;
  /** doc 40 P3/P7: one append-only platform.audit_log row for the vehicle insert, carrying every
   *  field the insert actually wrote. `occurredAt` is mandatory (always from the injected Clock,
   *  never the column's own `default now()`). */
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/register-vehicle/composition.ts). The command programs only against these ports —
 *  the application layer never imports infrastructure/. */
export interface RegisterVehicleDeps extends ClockDeps {
  readonly repo: VehiclesRepository;
  readonly logger: Logger;
}
