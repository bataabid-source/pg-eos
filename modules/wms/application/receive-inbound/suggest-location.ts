// modules/wms/application/receive-inbound/suggest-location.ts — WBS 2.9, THE GOLDEN SLICE.
//
// A pure read — no lock, no write, no ledger row, no expectedVersion (it does not mutate the
// order). Fetches an already-filtered candidate set through the InboundOrderRepository port and
// ranks it with the pure domain function ../../domain/receive-inbound/suggest-location-ranking.ts.

import { withContext, type WithContextCtx } from '@pg-eos/db';

import { rankLocationCandidates } from '../../domain/receive-inbound/suggest-location-ranking.js';
import type { ReceiveInboundDeps } from './ports.js';

export interface SuggestLocationInput {
  readonly skuId: string;
  readonly qty: string;
  readonly warehouseId: string;
}

export interface LocationCandidate {
  readonly locationId: string;
  readonly code: string;
  readonly locationType: string;
  readonly clientAssignedMatch: boolean;
  readonly positionNo: number;
}

export interface SuggestLocationResult {
  readonly candidates: readonly LocationCandidate[];
}

export async function suggestLocation(
  ctx: WithContextCtx,
  input: SuggestLocationInput,
  deps: ReceiveInboundDeps,
): Promise<SuggestLocationResult> {
  return withContext(ctx, async (tx) => {
    const clientId = await deps.repo.getSkuClientId(tx, input.skuId);
    const rows = await deps.repo.suggestLocationCandidatesQuery(tx, {
      skuId: input.skuId,
      qty: input.qty,
      warehouseId: input.warehouseId,
      clientId,
    });
    const byLocationId = new Map(rows.map((row) => [row.locationId, row]));
    const ranked = rankLocationCandidates(rows);

    const candidates: LocationCandidate[] = ranked.map((candidate) => {
      const raw = byLocationId.get(candidate.locationId);
      if (!raw) {
        // Unreachable: rankLocationCandidates is permutation-preserving over the same ids.
        throw new Error(`ranked candidate ${candidate.locationId} missing from source rows`);
      }
      return {
        locationId: candidate.locationId,
        code: raw.code,
        locationType: raw.locationType,
        clientAssignedMatch: candidate.clientAssignedMatch,
        positionNo: candidate.positionNo,
      };
    });

    return { candidates };
  });
}
