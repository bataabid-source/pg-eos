// modules/wms/application/manage-space/allocate-space.ts — WBS 2.15 (lane 2).
//
// ONE withIdempotentContext transaction (step 0 — see ../../../../packages/db/src/idempotency.ts —
// runs first when input.idem is set). Order (docs/notes/slice-briefs/_slice-2.15.brief.md, D3/D5/D6):
//   1. the role gate (D5: SALES_MGR only) — FIRST, before any read.
//   2. resolve the block's own entity THROUGH the request's own blockId, via a `SELECT ... FOR
//      UPDATE` that LOCKS the block row for the rest of the transaction (round-1 review finding 1
//      — closes the race where two concurrent calls on the same block both read a stale sellable
//      figure and both pass; never `ctx.entityId`, never caller-supplied — see ./ports.ts's
//      getBlockEntityId doc comment).
//   3. domain pre-check: isPositiveQty(qty) && hasValidQtyScale(qty) -> NonPositiveQtyError (422)
//      — belt-and-braces alongside wms.space_allocations's own `positive_qty` CHECK (whose 23514
//      the repository adapter also maps to NonPositiveQtyError, round-4 review finding).
//   4. `select wms.check_space_available($1,$2,$3,$4)` (D3 — a plain SELECT; the function returns
//      void and RAISES on failure, it is not something a boolean result is checked from), still
//      inside the same transaction holding the step 2 row lock. A P0001 raise is caught and
//      re-thrown as a typed SpaceNotAvailableError carrying the raised function's own message
//      VERBATIM (it already states the exact sellable qty — never recomputed or reformatted here).
//   5. only once both checks pass: INSERT the wms.space_allocations row (entityId=the block's own
//      entity, createdBy=ctx.userId). No version column (D1) — a plain INSERT at status='active'.
//   6. ONE platform.audit_log row (D6 — no outbox event, this table has none named in doc 40's
//      events list), last — explicit business fields only, never a spread of `input` (round-1
//      review finding 2: `input` carries `idem`, the 7-day-retention Idempotency-Key/request-hash
//      material, which must never leak into the permanent hash-chained audit_log).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import { hasValidQtyScale, isPositiveQty, QTY_DB_SCALE } from '../../domain/manage-space/invariants.js';
import { MissingActorError, NonPositiveQtyError, RoleRequiredError } from '../../domain/manage-space/errors.js';
import type { ManageSpaceDeps } from './ports.js';

const ALLOCATE_SPACE_ROLES = ['SALES_MGR'] as const;
const AUDIT_OPERATION_INSERT = 'insert';

export interface AllocateSpaceInput {
  readonly contractId: string;
  readonly clientId: string;
  readonly blockId: string;
  readonly allocType?: string | undefined;
  readonly qty: number;
  readonly uom: string;
  readonly serviceId?: string | undefined;
  readonly validFrom: string;
  readonly validTo?: string | undefined;
  readonly minChargeApplies?: boolean | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface AllocateSpaceResult {
  readonly id: string;
  readonly status: string;
}

export async function allocateSpace(
  ctx: WithContextCtx,
  input: AllocateSpaceInput,
  deps: ManageSpaceDeps,
): Promise<AllocateSpaceResult> {
  if (!ctx.userId) throw new MissingActorError('AllocateSpace requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<AllocateSpaceResult>(ctx, input.idem, async (tx) => {
    // Step 1 — the role gate, FIRST (D5).
    if (!(await deps.repo.hasAnyRole(tx, ALLOCATE_SPACE_ROLES))) {
      throw new RoleRequiredError(
        `AllocateSpace requires role ${ALLOCATE_SPACE_ROLES.join(' or ')} (platform.my_roles()). (Allowed: SALES_MGR only)`,
      );
    }

    // Step 2 — the block's own entity, fail-closed (resolved through the request's own blockId —
    // see ./ports.ts's getBlockEntityId doc comment).
    const entityId = await deps.repo.getBlockEntityId(tx, input.blockId);

    const occurredAt = deps.clock.now();

    // Step 3 — belt-and-braces alongside space_allocations's own `positive_qty` CHECK. Round-4
    // review finding: a qty with more than QTY_DB_SCALE decimals is rejected here too, before the
    // numeric(14,3) column can round it (e.g. 0.0004 -> 0.000).
    if (!isPositiveQty(input.qty) || !hasValidQtyScale(input.qty)) {
      throw new NonPositiveQtyError(
        `AllocateSpace requires qty > 0 with at most ${QTY_DB_SCALE} decimal places; received ${input.qty}. ` +
          `(Allowed: a strictly positive quantity with at most ${QTY_DB_SCALE} decimal places)`,
      );
    }

    // Step 4 — D3: a plain SELECT that raises on insufficient sellable capacity. The repository
    // adapter already re-throws a typed SpaceNotAvailableError for a P0001 raise (ports.ts).
    await deps.repo.checkSpaceAvailable(tx, {
      blockId: input.blockId,
      qty: input.qty,
      from: input.validFrom,
      to: input.validTo ?? null,
    });

    // Step 5 — only once both checks pass. `input.allocType`/`input.minChargeApplies` may be
    // omitted (the DB column DEFAULTs fire); the repository RETURNS what was actually stored
    // (round-2 review finding 2).
    const allocation = await deps.repo.insertAllocation(tx, {
      entityId,
      contractId: input.contractId,
      clientId: input.clientId,
      blockId: input.blockId,
      allocType: input.allocType ?? null,
      qty: input.qty,
      uom: input.uom,
      serviceId: input.serviceId ?? null,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      minChargeApplies: input.minChargeApplies ?? null,
      createdBy: actorId,
    });

    // Step 6 — ONE audit row (D6), last. `allocType`/`minChargeApplies`/`qty` come from the INSERT's
    // own RETURNING — never from `input` or an application-side default (round-2 review finding 2,
    // round-4 review finding for `qty`: CLAUDE.md "never fabricate a number/name/decision — numbers
    // come from the system").
    await deps.repo.writeAuditRow(tx, {
      entityId,
      tableName: 'space_allocations',
      recordId: allocation.id,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        id: allocation.id,
        status: allocation.status,
        contractId: input.contractId,
        clientId: input.clientId,
        blockId: input.blockId,
        allocType: allocation.allocType,
        qty: allocation.qty,
        uom: input.uom,
        serviceId: input.serviceId ?? null,
        validFrom: input.validFrom,
        validTo: input.validTo ?? null,
        minChargeApplies: allocation.minChargeApplies,
      },
      occurredAt,
    });

    return { id: allocation.id, status: allocation.status };
  });
}
