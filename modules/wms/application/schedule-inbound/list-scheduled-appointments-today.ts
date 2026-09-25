// modules/wms/application/schedule-inbound/list-scheduled-appointments-today.ts — WBS 2.9b
// (lane 2).
//
// A pure read — no lock, no write, no expectedVersion (it does not mutate any order). Same "pure
// read" shape as ../receive-inbound/suggest-location.ts (THE GOLDEN SLICE precedent): a plain
// withContext, no idempotency. "Today" is computed from the injected clock (deps.clock.now()),
// never `new Date()` (CLAUDE.md domain/application discipline) — the UTC calendar day containing
// `now`. An order whose expected_at is still null ("بلا موعد") is excluded by the repository's
// own WHERE clause (brief Scenario section).

import { withContext, type WithContextCtx } from '@pg-eos/db';

import type { ScheduleInboundDeps, ScheduledAppointmentRow } from './ports.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ListScheduledAppointmentsTodayInput {
  readonly warehouseId: string;
}

export async function listScheduledAppointmentsToday(
  ctx: WithContextCtx,
  input: ListScheduledAppointmentsTodayInput,
  deps: ScheduleInboundDeps,
): Promise<readonly ScheduledAppointmentRow[]> {
  return withContext(ctx, async (tx) => {
    const now = deps.clock.now();
    // Round-1 review finding 11 — recorded default (D9, not in the brief's D1-D8; batched to the
    // GM/Master for the CHANGELOG line at slice close): "today" = the UTC calendar day containing
    // `now`. Warehouse-local timezone boundary handling is deferred — no timezone data is modeled
    // anywhere in this slice (no warehouse-timezone column exists to compute a local boundary
    // from).
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + MS_PER_DAY);

    return deps.repo.listScheduledAppointmentsToday(tx, {
      warehouseId: input.warehouseId,
      startOfDay: startOfDay.toISOString(),
      endOfDay: endOfDay.toISOString(),
    });
  });
}
