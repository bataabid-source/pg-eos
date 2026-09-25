// modules/wms/domain/take-occupancy-snapshot/errors.ts — WBS 2.14 (lane 2).
//
// Typed errors for the take-occupancy-snapshot use case. Every class sets `name` explicitly
// (CLAUDE.md · AGENT CONSTRAINTS; same discipline as ../count-inventory/errors.ts) — an `Error`
// subclass does NOT get its constructor name for free at runtime. The api/ layer
// (../../api/take-occupancy-snapshot/handlers.ts) maps these to the Problem envelope.

/** The caller does not hold a role this command requires (checked via `platform.my_roles()`
 *  inside the transaction — read, never guessed). Brief D7: WH_MGR only. */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** No `wms.warehouses` row is visible for this id — it does not exist, or RLS hides it from the
 *  caller (an entity resolution failure, fail-closed). Maps to 422 (the Problem envelope has no
 *  404), same discipline as ../count-inventory/errors.ts's own WarehouseNotFoundError. */
export class WarehouseNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarehouseNotFoundError';
  }
}

/** No `catalog.services` row is visible for the code this command looked up ('ST-01'/'ST-12') —
 *  defensive, should be unreachable (both are pre-seeded at 13B). A typed error, never a plain
 *  `Error` reaching the api/ layer as an unmapped 500. */
export class ServiceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceNotFoundError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to platform.audit_log's own user_id. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}
