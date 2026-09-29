// WBS 2.16 part 2 — port for the put-away screen.
import type { SuggestLocationInput } from '@pg-eos/contracts/wms/receive-inbound';

export interface PutawayClient {
  /** Rejects only on transport failure. */
  suggestLocation(input: SuggestLocationInput): Promise<{ locationId: string; locationCode: string }>;
}
