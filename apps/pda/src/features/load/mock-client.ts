// WBS 2.16 part 3 — mock LoadClient (same precedent as receive/mock-client.ts). Pack is not one of
// D4's nine screens, so the load mock starts from a packed order (brief decision 3).
import type { LoadClient } from './client';

export const MOCK_ORDER_ID = 'c3d4e5f6-0001-4c3d-8e4f-5a6b7c8d9e01';
export const MOCK_PACKED_ORDER_CODE = 'PCC-OUT-00002';
export const MOCK_UNPACKED_ORDER_CODE = 'PCC-OUT-00003';
export const MOCK_EXPECTED_VERSION = 7;

export const mockLoadClient: LoadClient = {
  checkLoad: (scan) => {
    const refusals: Array<[boolean, 'orderNotFound' | 'orderNotPacked']> = [
      [scan.orderCode !== MOCK_PACKED_ORDER_CODE && scan.orderCode !== MOCK_UNPACKED_ORDER_CODE, 'orderNotFound'],
      [scan.orderCode === MOCK_UNPACKED_ORDER_CODE, 'orderNotPacked'],
    ];
    const refused = refusals.find(([hit]) => hit);
    return Promise.resolve(
      refused
        ? { accepted: false, code: refused[1] }
        : { accepted: true, orderId: MOCK_ORDER_ID, expectedVersion: MOCK_EXPECTED_VERSION },
    );
  },
};
