// WBS 2.16 part 2 — mock ReceiveClient (same precedent as otp-login/mock-client.ts): no HTTP
// client exists until the host serves the handlers (X part 5).
import type { ReceiveClient } from './client';

export const MOCK_ORDER_ID = '11111111-1111-4111-8111-111111111111';
export const MOCK_LINE_ID = '22222222-2222-4222-8222-222222222222';
export const MOCK_EXPECTED_VERSION = 1;

export const ACCEPTED_SCAN_FIXTURE = {
  skuCode: 'SKU-100',
  batchNo: 'B2409-7',
  expiryDate: '2027-01-27',
  qty: '10',
};

export const mockReceiveClient: ReceiveClient = {
  checkScan: (scan) => {
    if (scan.skuCode === ACCEPTED_SCAN_FIXTURE.skuCode) {
      return Promise.resolve({ accepted: true, lineId: MOCK_LINE_ID, expectedVersion: MOCK_EXPECTED_VERSION });
    }
    return Promise.resolve({ accepted: false, code: 'lineNotFound' });
  },
};
