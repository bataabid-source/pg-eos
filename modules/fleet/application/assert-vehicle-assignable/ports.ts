// modules/fleet/application/assert-vehicle-assignable/ports.ts — WBS 3.1.
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: AssertVehicleAssignableDeps` (repo, logger) and never imports infrastructure/.
// ../../infrastructure/assert-vehicle-assignable/repository.ts implements `AssignabilityRepository`;
// ../../api/assert-vehicle-assignable/composition.ts wires it.
//
// This use case is a pure read-and-assert (brief: "no write, no side effect") — no ClockDeps/
// IdGenerator port here, unlike ../register-vehicle/ports.ts: `at` is caller-supplied input, never
// an injected clock the command reads itself.

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by
 *  ../../infrastructure/assert-vehicle-assignable/logger.ts (a @pg-eos/logger child-logger
 *  adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

export interface VehicleDocumentRow {
  readonly docType: string;
  readonly expiryDate: string;
}

export interface VehicleForAssignabilityCheck {
  readonly plateNo: string;
  readonly documents: readonly VehicleDocumentRow[];
}

/** Every DB statement the assert-vehicle-assignable use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/assert-vehicle-assignable/repository.ts. Read-only: no insert/update. */
export interface AssignabilityRepository {
  /** Fetches the vehicle's own plateNo plus every tms.vehicle_documents row linked to it (docType,
   *  expiryDate). Throws VehicleNotFoundError (../../domain/assert-vehicle-assignable/errors.ts)
   *  when the vehicleId does not resolve to a row this caller can read (its own entity_scope RLS
   *  policy included). */
  findVehicleForAssignabilityCheck(tx: NodePgDatabase, vehicleId: string): Promise<VehicleForAssignabilityCheck>;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/assert-vehicle-assignable/composition.ts). The command programs only against these
 *  ports — the application layer never imports infrastructure/. */
export interface AssertVehicleAssignableDeps {
  readonly repo: AssignabilityRepository;
  readonly logger: Logger;
}
