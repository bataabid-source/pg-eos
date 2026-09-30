// WBS 2.16 part 3 — mock CheckClient (same precedent as receive/mock-client.ts). It reproduces the
// server's SelfCheckNotAllowedError; the screen itself does not re-implement the rule.
import type { CheckClient } from './client';

export const MOCK_ORDER_ID = 'b2c3d4e5-0001-4b2c-9d3e-4f5a6b7c8d01';
export const MOCK_ORDER_CODE = 'PCC-OUT-00001';
export const MOCK_EXPECTED_VERSION = 5;
export const MOCK_PICKER_ID = 'b2c3d4e5-0002-4b2c-9d3e-4f5a6b7c8d02';
export const MOCK_CHECKER_ID = 'b2c3d4e5-0003-4b2c-9d3e-4f5a6b7c8d03';
export const MOCK_PICKER_IDS: readonly string[] = [MOCK_PICKER_ID];

export const mockCheckClient: CheckClient = {
  checkOrder: (scan) => {
    const refusals: Array<[boolean, 'orderNotFound' | 'selfCheckNotAllowed']> = [
      [scan.orderCode !== MOCK_ORDER_CODE, 'orderNotFound'],
      [MOCK_PICKER_IDS.includes(scan.checkerId), 'selfCheckNotAllowed'],
    ];
    const refused = refusals.find(([hit]) => hit);
    return Promise.resolve(
      refused
        ? { accepted: false, code: refused[1] }
        : { accepted: true, orderId: MOCK_ORDER_ID, expectedVersion: MOCK_EXPECTED_VERSION },
    );
  },
};
