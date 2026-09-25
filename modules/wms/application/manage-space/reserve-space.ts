// modules/wms/application/manage-space/reserve-space.ts — WBS 2.15 (lane 2).
//
// ONE withIdempotentContext transaction (step 0 — see ../../../../packages/db/src/idempotency.ts —
// runs first when input.idem is set). Order (docs/notes/slice-briefs/_slice-2.15.brief.md, D4/D5/D6/D7):
//   1. the role gate (D5: SALES_MGR only) — FIRST, before any read.
//   2. resolve the block's own entity THROUGH the request's own blockId, via a `SELECT ... FOR
//      UPDATE` that LOCKS the block row for the rest of the transaction (round-1 review finding 1
//      — closes the race where two concurrent calls on the same block both read a stale sellable
//      figure and both pass; never `ctx.entityId`, never caller-supplied — see ./ports.ts's
//      getBlockEntityId doc comment).
//   3. domain pre-check: isPositiveQty(qty) && hasValidQtyScale(qty) -> NonPositiveQtyError (422)
//      — D7, the ONLY enforcement for space_reservations.qty (no DB-level positive-qty CHECK,
//      unlike space_allocations).
//   4. domain pre-check: expiresAt > reservedFrom (mirrors the DB's own reservation_has_expiry
//      CHECK) -> ReservationDateRangeInvalidError (422) — belt-and-braces, and a DIFFERENT typed
//      error from step 5's ReservationTooLongError (round-1 review finding 3: a plain inverted
//      range is not the same failure as an over-long one).
//   5. domain pre-check: read platform.thresholds key space.reservation_max_days (repository read,
//      never hardcoded) and call isWithinMaxDuration -> ReservationTooLongError (422) if it fails.
//   6. `select wms.check_space_available($1,$2,$3,$4)` (D4 — same plain-SELECT/P0001-catch pattern
//      as allocate-space.ts's own step 4), still inside the same transaction holding the step 2 row
//      lock. A P0001 raise is caught and re-thrown as a typed SpaceNotAvailableError carrying the
//      raised function's own message VERBATIM.
//   7. only once every check passes: INSERT the wms.space_reservations row (entityId=the block's
//      own entity, reservedBy=ctx.userId, approvedBy=null — no approval step named by doc 40 for
//      this slice). No version column (D1) — a plain INSERT at status='active'.
//   8. ONE platform.audit_log row (D6 — no outbox event, this table has none named in doc 40's
//      events list), last — explicit business fields only, never a spread of `input` (round-1
//      review finding 2: `input` carries `idem`, the 7-day-retention Idempotency-Key/request-hash
//      material, which must never leak into the permanent hash-chained audit_log).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import {
  hasValidQtyScale,
  isPositiveQty,
  isValidReservationRange,
  isWithinMaxDuration,
  QTY_DB_SCALE,
} from '../../domain/manage-space/invariants.js';
import {
  MissingActorError,
  NonPositiveQtyError,
  ReservationDateRangeInvalidError,
  ReservationTooLongError,
  RoleRequiredError,
} from '../../domain/manage-space/errors.js';
import type { ManageSpaceDeps } from './ports.js';

const RESERVE_SPACE_ROLES = ['SALES_MGR'] as const;
const AUDIT_OPERATION_INSERT = 'insert';

export interface ReserveSpaceInput {
  readonly blockId: string;
  readonly clientId?: string | undefined;
  readonly quoteId?: string | undefined;
  readonly opportunityId?: string | undefined;
  readonly qty: number;
  readonly uom: string;
  readonly reservedFrom: string;
  readonly expiresAt: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface ReserveSpaceResult {
  readonly id: string;
  readonly status: string;
}

export async function reserveSpace(
  ctx: WithContextCtx,
  input: ReserveSpaceInput,
  deps: ManageSpaceDeps,
): Promise<ReserveSpaceResult> {
  if (!ctx.userId) throw new MissingActorError('ReserveSpace requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<ReserveSpaceResult>(ctx, input.idem, async (tx) => {
    // Step 1 — the role gate, FIRST (D5).
    if (!(await deps.repo.hasAnyRole(tx, RESERVE_SPACE_ROLES))) {
      throw new RoleRequiredError(
        `ReserveSpace requires role ${RESERVE_SPACE_ROLES.join(' or ')} (platform.my_roles()). (Allowed: SALES_MGR only)`,
      );
    }

    // Step 2 — the block's own entity, fail-closed (resolved through the request's own blockId —
    // see ./ports.ts's getBlockEntityId doc comment).
    const entityId = await deps.repo.getBlockEntityId(tx, input.blockId);

    const occurredAt = deps.clock.now();

    // Step 3 — D7: the ONLY enforcement for space_reservations.qty > 0. Round-4 review finding: the
    // scale check is part of that enforcement — a qty with more than QTY_DB_SCALE decimals would be
    // rounded by the numeric(14,3) column (0.0004 -> 0.000, an `active` zero-qty reservation).
    if (!isPositiveQty(input.qty) || !hasValidQtyScale(input.qty)) {
      throw new NonPositiveQtyError(
        `ReserveSpace requires qty > 0 with at most ${QTY_DB_SCALE} decimal places; received ${input.qty}. ` +
          `(Allowed: a strictly positive quantity with at most ${QTY_DB_SCALE} decimal places)`,
      );
    }

    // Step 4 — mirrors the DB's own reservation_has_expiry CHECK, belt-and-braces. Round-1 review
    // finding 3: a plain inverted/equal date range is NOT the same failure as the 30-day
    // max-duration threshold (step 5) — it gets its own typed error. Round-2 review finding 1: the
    // range check itself is a domain invariant (isValidReservationRange), not an inline comparison.
    if (!isValidReservationRange(input.reservedFrom, input.expiresAt)) {
      throw new ReservationDateRangeInvalidError(
        `ReserveSpace requires expiresAt (${input.expiresAt}) to be after reservedFrom (${input.reservedFrom}). ` +
          `(Allowed: an expiresAt strictly after reservedFrom)`,
      );
    }

    // Step 5 — D4: platform.thresholds key space.reservation_max_days, never hardcoded.
    const maxDays = await deps.repo.getReservationMaxDays(tx);
    if (!isWithinMaxDuration(input.reservedFrom, input.expiresAt, maxDays)) {
      throw new ReservationTooLongError(
        `ReserveSpace: the reservation [${input.reservedFrom}, ${input.expiresAt}] exceeds the ` +
          `space.reservation_max_days threshold of ${maxDays} days. (Allowed: a duration <= ${maxDays} days)`,
      );
    }

    // Step 6 — D4: a plain SELECT that raises on insufficient sellable capacity. The repository
    // adapter already re-throws a typed SpaceNotAvailableError for a P0001 raise (ports.ts).
    await deps.repo.checkSpaceAvailable(tx, {
      blockId: input.blockId,
      qty: input.qty,
      from: input.reservedFrom,
      to: input.expiresAt,
    });

    // Step 7 — only once every check passes.
    const reservation = await deps.repo.insertReservation(tx, {
      entityId,
      blockId: input.blockId,
      clientId: input.clientId ?? null,
      quoteId: input.quoteId ?? null,
      opportunityId: input.opportunityId ?? null,
      qty: input.qty,
      uom: input.uom,
      reservedFrom: input.reservedFrom,
      expiresAt: input.expiresAt,
      reason: input.reason,
      reservedBy: actorId,
    });

    // Step 8 — ONE audit row (D6), last. `qty` comes from the INSERT's own RETURNING — the value
    // actually stored, never `input.qty` (round-4 review finding, same rule as round-2 finding 2).
    await deps.repo.writeAuditRow(tx, {
      entityId,
      tableName: 'space_reservations',
      recordId: reservation.id,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        id: reservation.id,
        status: reservation.status,
        blockId: input.blockId,
        clientId: input.clientId ?? null,
        quoteId: input.quoteId ?? null,
        opportunityId: input.opportunityId ?? null,
        qty: reservation.qty,
        uom: input.uom,
        reservedFrom: input.reservedFrom,
        expiresAt: input.expiresAt,
        reason: input.reason,
      },
      occurredAt,
    });

    return { id: reservation.id, status: reservation.status };
  });
}
