// modules/tms/domain/create-delivery-task/errors.ts — WBS 3.4 part 1.
//
// Typed errors for the create-delivery-task use case. Every class sets `name` explicitly (CLAUDE.md ·
// AGENT CONSTRAINTS) — an `Error` subclass does NOT get its constructor name for free at runtime.
// The three business-rule errors carry a `readonly i18nKey` (brief Decision 4) so the api/ layer's
// Problem body can surface it. The api/ layer (../../api/create-delivery-task/handlers.ts) maps:
// StaleVersionError / DeliveryTaskAlreadyExistsError -> 409; OrderNotReadyError /
// AddressIncompleteError / OrderNotFoundError / MissingActorError -> 422. A caller whose active
// entity is not exactly one is refused with @pg-eos/db's own EntityScopeRequiredError (422,
// `identity.entityScope.required`) — reused, never re-declared here.

/** Optimistic-lock conflict on wms.outbound_orders: the order's `version` is not the caller's
 *  `expectedVersion` (or `UPDATE ... WHERE id=$1 AND version=$2` matched zero rows). HTTP 409. */
export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleVersionError';
  }
}

/** The outbound order id does not resolve to a wms.outbound_orders row visible to the caller (a row
 *  hidden by RLS is indistinguishable from a missing one). HTTP 422 (PROBLEM_STATUS has no 404).
 *  Message ends "(allowed: an outbound order id visible in the caller's entity)". */
export class OrderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNotFoundError';
  }
}

/** INV-C4-2 (doc 40 line 274): "Task creation rejected without area, block, street, phone" — a
 *  missing or whitespace-only value in any of the four. HTTP 422. */
export class AddressIncompleteError extends Error {
  readonly i18nKey = 'tms.task.create.addressIncomplete';

  constructor(message: string) {
    super(message);
    this.name = 'AddressIncompleteError';
  }
}

/** The outbound order is not in a status a delivery task may follow (checked · packed · loaded —
 *  brief Decision 4). HTTP 422. */
export class OrderNotReadyError extends Error {
  readonly i18nKey = 'tms.task.create.orderNotReady';

  constructor(message: string) {
    super(message);
    this.name = 'OrderNotReadyError';
  }
}

/** The outbound order already carries a delivery task (wms.outbound_orders.delivery_task_id is
 *  set) — one task per order (brief Decision 4). HTTP 409. */
export class DeliveryTaskAlreadyExistsError extends Error {
  readonly i18nKey = 'tms.task.create.alreadyExists';

  constructor(message: string) {
    super(message);
    this.name = 'DeliveryTaskAlreadyExistsError';
  }
}

/** Every command's actor is `ctx.userId` only; a null userId is a typed error, never a silent
 *  `null` written to platform.audit_log.user_id / platform.outbox.actor_id. HTTP 422. */
export class MissingActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingActorError';
  }
}
