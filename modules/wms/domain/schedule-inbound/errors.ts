// modules/wms/domain/schedule-inbound/errors.ts — WBS 2.9b (lane 2).
//
// Typed errors for the schedule-inbound use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS; same discipline as ../receive-inbound/errors.ts) — an `Error` subclass does
// NOT get its constructor name for free at runtime. The api/ layer
// (../../api/schedule-inbound/handlers.ts) maps these to the Problem envelope: StaleVersionError
// -> 409, everything else -> 400/422 per that layer's own map.
//
// InvalidVehicleTypeError/ScheduleInPastError also live here so
// ../../application/receive-inbound/approve-inbound.ts (the WBS 2.9b scoped-grant extension) can
// import them — neither domain/receive-inbound/errors.ts nor domain/receive-inbound/invariants.ts
// is in this slice's Write ONLY list, so the shared home for these two typed errors and the
// isFutureTimestamp/isValidVehicleType/isNonEmptyReason invariants is this new, writable
// use case (recorded default, brief D7-adjacent, flagged in the closing report).

/** D1: `expectedAt` was not strictly after the injected clock's `now()`
 *  (../../domain/schedule-inbound/invariants.ts's isFutureTimestamp). Maps to HTTP 422. */
export class ScheduleInPastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleInPastError';
  }
}

/** D4 (migration 0023 chk_inbound_orders_vehicle_type): `vehicleType` is neither null/undefined
 *  nor one of the closed list (container_20, container_40, truck, trailer, van, pickup, other).
 *  Thrown by the domain pre-check (isValidVehicleType); also thrown by the infrastructure adapter
 *  as a belt-and-braces backstop when the DB's own CHECK raises SQLSTATE 23514 for this
 *  constraint. Maps to HTTP 422. */
export class InvalidVehicleTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVehicleTypeError';
  }
}

/** Round-1 review finding 3: chk_inbound_orders_handover_point — `handoverPoint` is neither
 *  null/undefined nor one of the closed list (premium_warehouse, client_site). Thrown by the
 *  domain pre-check (isValidHandoverPoint); also thrown by the infrastructure adapter as a
 *  belt-and-braces backstop when the DB's own CHECK raises SQLSTATE 23514 for this constraint.
 *  Maps to HTTP 422. */
export class InvalidHandoverPointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHandoverPointError';
  }
}

/** Round-1 review finding 3: chk_inbound_orders_transport_by — `transportBy` is neither
 *  null/undefined nor one of the closed list (client, premium). Same dual-enforcement discipline
 *  as InvalidHandoverPointError. Maps to HTTP 422. */
export class InvalidTransportByError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransportByError';
  }
}

/** Round-1 review finding 3: chk_inbound_orders_labour_by — `labourBy` is neither null/undefined
 *  nor one of the closed list (client, premium, shared). Same dual-enforcement discipline as
 *  InvalidHandoverPointError. Maps to HTTP 422. */
export class InvalidLabourByError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLabourByError';
  }
}

/** Round-1 review finding 3: chk_inbound_orders_labour_count — `labourCount` is neither
 *  null/undefined nor >= 0. Same dual-enforcement discipline as InvalidHandoverPointError. Maps to
 *  HTTP 422. */
export class InvalidLabourCountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLabourCountError';
  }
}

/** Round-1 review finding 5: on ApproveInbound's optional slot, one or more logistics
 *  terms/dockCode were supplied WITHOUT `expectedAt` in the same call. Recorded default (finding
 *  5, see ../../application/receive-inbound/approve-inbound.ts's own header): rejected with a
 *  typed 422 rather than silently dropped or persisted independently — D2's own wording ("When
 *  expectedAt is present: writes... When absent: unchanged behavior") treats the appointment slot
 *  as one atomic unit, so a partial slot without its anchor timestamp is not a state this slice
 *  models. */
export class LogisticsTermsRequireExpectedAtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogisticsTermsRequireExpectedAtError';
  }
}

/** D1: ScheduleInbound is legal only while the order's status is 'draft' or 'approved'
 *  — machine-gated via INBOUND_ORDER_EVENTS.SCHEDULE, a self-transition (no NEW state, version
 *  bump only; round-1 review finding 12). Maps to HTTP 422. */
export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** The caller does not hold role WH_MGR/WH_SUP (checked via `platform.my_roles()` inside the
 *  transaction — read, never guessed). D1. */
export class RoleRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleRequiredError';
  }
}

/** No wms.inbound_orders row is visible for this id — it does not exist, or RLS hides it from the
 *  caller (an order outside the caller's entities is indistinguishable from a missing one, by
 *  design — same convention as ../receive-inbound/errors.ts's own OrderNotFoundError). */
export class OrderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFoundError';
  }
}

/** Optimistic-lock conflict: `UPDATE ... WHERE id=$1 AND version=$2` matched zero rows — another
 *  caller already advanced the order's version. Maps to HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** WBS 2.9b (D3): `cancelReason` is missing/empty on CancelInbound — checked at the application
 *  layer BEFORE any write (the contract's own CancelInboundInputSchema already enforces `min(1)`
 *  at the API boundary; this is the domain-layer belt-and-braces backstop for any caller that
 *  bypasses the contract). Maps to HTTP 422. Round-1 review finding 7: moved here from
 *  ../../application/receive-inbound/cancel-inbound.ts to match golden-slice doctrine (every
 *  typed error lives in a domain/<use-case>/errors.ts) — this file, not
 *  domain/receive-inbound/errors.ts, because the latter is not in this slice's Write ONLY list. */
export class CancelReasonRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancelReasonRequiredError';
  }
}

/** every command's actor is `ctx.userId` ONLY. A null/missing userId is a typed error, not a
 *  silent `null` written to `scheduled_by`/audit `user_id`. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}
