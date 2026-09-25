// modules/wms/application/take-occupancy-snapshot/take-occupancy-snapshot.ts — WBS 2.14 (lane 2).
//
// ONE withIdempotentContext transaction (step 0 — see ../../../../packages/db/src/idempotency.ts —
// runs first when input.idem is set). Order (docs/notes/slice-briefs/_slice-2.14.brief.md, D1-D9):
//   1. the role gate (D7: WH_MGR only) — FIRST, before any read.
//   2. resolve the warehouse's own entity, fail-closed (D8) — WarehouseNotFoundError otherwise.
//   3. the snapshot date: caller-supplied, or the injected Clock's own Asia/Kuwait business date
//      (D6, ../../domain/take-occupancy-snapshot/invariants.ts's businessDateOf).
//   4. look up ST-01/ST-12's own catalog.services ids (pre-seeded at 13B, never inserted here).
//   5. read every (client, space_block) pair's occupied locations (CORRECTION/D2) and that same
//      block's own contracted pallet capacity (CORRECTION/D3) for the warehouse, in one pass
//      each — no per-client-per-block query. A location with no space_block_id is excluded
//      entirely (a data-quality gap outside this slice's scope).
//   6. for each (client, space_block) pair with at least one occupied location: upsert the
//      snapshot row (round-1 review finding 2: ON CONFLICT DO NOTHING — the FIRST snapshot of a
//      given (day, client, block) stands permanently; a same-day re-run returns that SAME row's
//      own frozen pallets_occupied, never a freshly recomputed one). Round-2 review finding 1:
//      `contracted` (the allocation sum) is read fresh every call and is never itself stored on
//      the snapshot row, so the ST-01/ST-12 billable rows (D4) are written ONLY on the branch
//      where the upsert's own `created` flag is true — a genuinely new snapshot. A re-run
//      (`created` false) writes NO billing rows at all, even if the freshly-read `contracted`
//      would now put the frozen pallets_occupied into overflow. Round-3 review finding 2: on that
//      re-run the REPORTED overflow is not recomputed either — it is whether an ST-12 row for the
//      standing snapshot already exists (repo.hasBillableEvent). A pair with zero occupied
//      locations never appears in step 5's own result set — there is no separate "skip" check to
//      write, iterating the result set already excludes it.
//   7. ONE platform.audit_log row for the whole call (D8), aggregate wms.occupancy_snapshots,
//      record_id null (no single row represents a multi-client batch) — last.
//
// Round-1 review finding 1: clientsSnapshotted/clientsInOverflow count DISTINCT clientId values
// (a client in two blocks counts once), never a per-(client, block)-group increment.
//
// D9: Idempotency-Key required on the write (handled by withIdempotentContext, same as every
// other command here), even though D1/D5 already make the command naturally idempotent.

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import { countOccupiedLocations, overflowQty, businessDateOf, type OccupiedLocationRow } from '../../domain/take-occupancy-snapshot/invariants.js';
import { MissingActorError, RoleRequiredError } from '../../domain/take-occupancy-snapshot/errors.js';
import type { TakeOccupancySnapshotDeps } from './ports.js';

// brief D7: WH_MGR only (narrower than 2.13's counting roles — this generates billing-relevant
// financial records).
const TAKE_SNAPSHOT_ROLES = ['WH_MGR'] as const;
const AUDIT_OPERATION_SNAPSHOT = 'upsert';
const PALLET_LOCATION_TYPE = 'pallet';
const ST01_SERVICE_CODE = 'ST-01';
const ST12_SERVICE_CODE = 'ST-12';
// doc 40 line 262: "wms.occupancy.snapshot → ST-* daily" — the Master added this entry to
// packages/events/catalog.ts (frozen path) after the request; typed as CatalogedEventType so a
// typo or drift from the catalog fails typecheck, same pattern every prior slice this session
// uses once its own catalog entry lands.
const OCCUPANCY_SNAPSHOT_EVENT_TYPE: CatalogedEventType = 'wms.occupancy.snapshot';
const OCCUPANCY_SNAPSHOTS_AGGREGATE_TYPE = 'wms.occupancy_snapshots';

// CORRECTION (brief Facts): the snapshot grain is (client, space_block), matching
// `occupancy_snapshots_grain_uq` — this key lines up the occupied-locations pass with the
// contracted-capacity pass without a per-group query.
function groupKey(clientId: string, spaceBlockId: string): string {
  return `${clientId}:${spaceBlockId}`;
}

export interface TakeOccupancySnapshotInput {
  readonly warehouseId: string;
  readonly snapshotDate?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface TakeOccupancySnapshotResult {
  readonly warehouseId: string;
  readonly snapshotDate: string;
  readonly clientsSnapshotted: number;
  readonly clientsInOverflow: number;
}

export async function takeOccupancySnapshot(
  ctx: WithContextCtx,
  input: TakeOccupancySnapshotInput,
  deps: TakeOccupancySnapshotDeps,
): Promise<TakeOccupancySnapshotResult> {
  if (!ctx.userId) throw new MissingActorError('TakeOccupancySnapshot requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<TakeOccupancySnapshotResult>(ctx, input.idem, async (tx) => {
    // Step 1 — the role gate, FIRST (brief D7).
    if (!(await deps.repo.hasAnyRole(tx, TAKE_SNAPSHOT_ROLES))) {
      throw new RoleRequiredError(
        `TakeOccupancySnapshot requires role ${TAKE_SNAPSHOT_ROLES.join(' or ')} (platform.my_roles()). ` +
          `(Allowed: WH_MGR only)`,
      );
    }

    // Step 2 — resolve the warehouse's own entity, fail-closed (brief D8).
    const entityId = await deps.repo.getWarehouseEntityId(tx, input.warehouseId);

    const occurredAt = deps.clock.now();
    // Step 3 — brief D6: default to the Clock's own Asia/Kuwait business date.
    const snapshotDate = input.snapshotDate ?? businessDateOf(occurredAt);

    // Step 4 — pre-seeded (13B), looked up, never inserted here.
    const st01ServiceId = await deps.repo.getServiceIdByCode(tx, ST01_SERVICE_CODE);
    const st12ServiceId = await deps.repo.getServiceIdByCode(tx, ST12_SERVICE_CODE);

    // Step 5 — one pass each, not one query per (client, block) pair.
    const occupiedRows = await deps.repo.getOccupiedLocationsByClient(tx, input.warehouseId);
    const contractedRows = await deps.repo.getContractedPalletsByClient(tx, {
      warehouseId: input.warehouseId,
      snapshotDate,
    });
    // CORRECTION: keyed by (client, block) — the block itself already pins the warehouse, so a
    // client occupying two blocks gets two independent contracted-capacity lookups.
    const contractedByGroup = new Map(
      contractedRows.map((row) => [groupKey(row.clientId, row.blockId), row.contractedPallets]),
    );

    interface OccupiedGroup {
      readonly clientId: string;
      readonly spaceBlockId: string;
      readonly rows: OccupiedLocationRow[];
    }
    const rowsByGroup = new Map<string, OccupiedGroup>();
    for (const row of occupiedRows) {
      const key = groupKey(row.clientId, row.spaceBlockId);
      const group = rowsByGroup.get(key) ?? { clientId: row.clientId, spaceBlockId: row.spaceBlockId, rows: [] };
      group.rows.push({ type: row.locationType, occupied: true });
      rowsByGroup.set(key, group);
    }

    // Finding 1 (round-1 review): a client occupying two blocks must count once, not once per
    // (client, block) group — DISTINCT clientId, not a per-group increment.
    const snapshottedClientIds = new Set<string>();
    const overflowClientIds = new Set<string>();

    // Step 6 — a (client, block) pair with zero occupied locations never appears in rowsByGroup
    // (step 5's own result set), so it is excluded by construction, never a separate skip-check.
    for (const [key, group] of rowsByGroup) {
      const rawPalletsOccupied = countOccupiedLocations(group.rows, { typeFilter: PALLET_LOCATION_TYPE });
      const rawLocationsUsed = countOccupiedLocations(group.rows);

      // Finding 2 (round-1 review): ON CONFLICT DO NOTHING — the snapshot returned is either the
      // just-inserted row or the FIRST run's row that already stands. Billing must price off the
      // snapshot's OWN (frozen) values, never the freshly recomputed ones, so a same-day re-run
      // after a stock change stays a genuine no-op for both the snapshot row and its billing rows.
      const snapshot = await deps.repo.upsertSnapshot(tx, {
        entityId,
        clientId: group.clientId,
        warehouseId: input.warehouseId,
        snapshotDate,
        palletsOccupied: rawPalletsOccupied,
        locationsUsed: rawLocationsUsed,
        spaceBlockId: group.spaceBlockId,
      });

      const palletsOccupied = snapshot.palletsOccupied;

      // Round-2 review finding 1: `contracted` is read fresh on every call (never stored on the
      // snapshot row), so freezing `palletsOccupied` alone is not enough — a same-day re-run whose
      // allocation changed between runs could still price a NEW ST-12 row against the SAME frozen
      // snapshot id (the (source_table, source_id, service_id) pair never existed before, so
      // ON CONFLICT DO NOTHING on billable_events does not block it). `snapshot.created` (true only
      // when THIS call's own insert won the row) is the one signal that distinguishes "genuinely
      // new snapshot" from "re-run" — on a re-run, skip BOTH billing inserts entirely; a re-run
      // writes no billing rows of any kind, full stop, matching "the first snapshot of the day
      // stands" (brief D1/D5).
      //
      // Round-3 review finding 2: the REPORTED overflow (clientsInOverflow → result, outbox payload,
      // audit new_value) must follow the same rule — a re-run recomputes nothing. On the `created`
      // branch, `overflow > 0` is the genuine first-time computation that also drives the ST-12
      // write. On a re-run, "in overflow" is whether an ST-12 row for this snapshot ALREADY stands,
      // never a fresh `overflowQty` against a since-changed `contracted` — so the count always
      // matches the billing rows that genuinely exist, whoever wrote them.
      let inOverflow: boolean;
      if (snapshot.created) {
        const contracted = contractedByGroup.get(key) ?? 0;
        const overflow = overflowQty(palletsOccupied, contracted);
        inOverflow = overflow > 0;
        await deps.repo.insertBillableEvent(tx, {
          entityId,
          occurredAt,
          clientId: group.clientId,
          serviceId: st01ServiceId,
          qty: palletsOccupied,
          sourceId: snapshot.id,
        });

        if (inOverflow) {
          await deps.repo.insertBillableEvent(tx, {
            entityId,
            occurredAt,
            clientId: group.clientId,
            serviceId: st12ServiceId,
            qty: overflow,
            sourceId: snapshot.id,
          });
        }
      } else {
        inOverflow = await deps.repo.hasBillableEvent(tx, { sourceId: snapshot.id, serviceId: st12ServiceId });
      }
      snapshottedClientIds.add(group.clientId);
      if (inOverflow) {
        overflowClientIds.add(group.clientId);
      }
    }

    const clientsSnapshotted = snapshottedClientIds.size;
    const clientsInOverflow = overflowClientIds.size;

    await writeOutboxEvent(tx, {
      entityId,
      aggregateType: OCCUPANCY_SNAPSHOTS_AGGREGATE_TYPE,
      aggregateId: input.warehouseId,
      eventType: OCCUPANCY_SNAPSHOT_EVENT_TYPE,
      payload: { warehouseId: input.warehouseId, snapshotDate, clientsSnapshotted, clientsInOverflow },
      correlationId: input.correlationId,
      actorId,
    });

    // Step 7 — ONE audit row for the whole call (brief D8), last.
    await deps.repo.writeAuditRow(tx, {
      entityId,
      operation: AUDIT_OPERATION_SNAPSHOT,
      correlationId: input.correlationId,
      actorId,
      newValue: { warehouseId: input.warehouseId, snapshotDate, clientsSnapshotted, clientsInOverflow },
      occurredAt,
    });

    return { warehouseId: input.warehouseId, snapshotDate, clientsSnapshotted, clientsInOverflow };
  });
}
