// WBS 2.16 part 3 — mock PickClient (same precedent as receive/mock-client.ts): no HTTP client
// exists until the host serves the handlers (X part 5).
import type { PickClient } from './client';

export const MOCK_ORDER_ID = 'a1b2c3d4-0001-4a1b-8c2d-3e4f5a6b7c01';
export const MOCK_LINE_ID = 'a1b2c3d4-0002-4a1b-8c2d-3e4f5a6b7c02';
export const MOCK_EXPECTED_VERSION = 3;

export const MOCK_PICK_LINE = { skuCode: 'SKU-100', locationCode: 'A-01-01', qtyReserved: '10' };

// The mock line's qtyOrdered equals its qtyReserved.
export const mockPickClient: PickClient = {
  checkPick: (scan) => {
    const qty = Number(scan.qtyActual);
    const reserved = Number(MOCK_PICK_LINE.qtyReserved);
    const blankReason = (scan.varianceReason ?? '').trim().length === 0;
    const refusals: Array<[boolean, 'lineNotFound' | 'qtyExceedsReserved' | 'varianceReasonRequired']> = [
      [scan.lineId !== MOCK_LINE_ID, 'lineNotFound'],
      [qty > reserved, 'qtyExceedsReserved'],
      [qty < reserved && blankReason, 'varianceReasonRequired'],
    ];
    const refused = refusals.find(([hit]) => hit);
    return Promise.resolve(
      refused ? { accepted: false, code: refused[1] } : { accepted: true, expectedVersion: MOCK_EXPECTED_VERSION },
    );
  },
};
