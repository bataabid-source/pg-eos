// WBS 2.16 part 2 — mock PutawayClient (same precedent as otp-login/mock-client.ts).
import type { SuggestLocationInput } from '@pg-eos/contracts/wms/receive-inbound';

import type { PutawayClient } from './client';

export const MOCK_ORDER_ID = '11111111-1111-4111-8111-111111111111';
export const MOCK_LINE_ID = '22222222-2222-4222-8222-222222222222';
export const MOCK_EXPECTED_VERSION = 2;
export const MOCK_SUGGEST_INPUT: SuggestLocationInput = {
  skuId: '66666666-6666-4666-8666-666666666666',
  qty: '10',
  warehouseId: '77777777-7777-4777-8777-777777777777',
};
export const MOCK_SUGGESTED_LOCATION_CODE = 'QRT-01-A';
const MOCK_LOCATION_ID = '55555555-5555-4555-8555-555555555555';

export const mockPutawayClient: PutawayClient = {
  suggestLocation: () =>
    Promise.resolve({ locationId: MOCK_LOCATION_ID, locationCode: MOCK_SUGGESTED_LOCATION_CODE }),
};
