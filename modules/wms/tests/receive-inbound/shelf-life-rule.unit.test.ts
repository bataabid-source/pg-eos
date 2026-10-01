// modules/wms/tests/receive-inbound/shelf-life-rule.unit.test.ts — WBS 2.9 part 3 step 2 (pg-tester, RED-first).
//
// Decision 1 of _slice-2.9-p3-s2-qrt-quarantine.brief.md, expected new surface (RED until built):
//   modules/wms/domain/receive-inbound/invariants.ts
//     isShortShelfLifeReceipt(input: {
//       expiryDate: string | null;                 // ISO 'YYYY-MM-DD'
//       today: Date;                               // deps.clock.now() — injected, never new Date() in domain/
//       minRemainingLifeReceiptDays: number | null;
//       trackExpiry: boolean;
//     }): boolean
//   true iff trackExpiry, non-null minimum, non-null expiry and
//   (expiryDate - today) in Asia/Kuwait calendar days < minimum (strict).

import { describe, expect, it } from 'vitest';

import { isShortShelfLifeReceipt } from '../../domain/receive-inbound/invariants.js';

// Kuwait is UTC+3 with no DST: 2026-09-30T09:00Z is 12:00 on 2026-09-30 in Asia/Kuwait.
const TODAY = new Date('2026-09-30T09:00:00.000Z');
const MIN_DAYS = 10;
// TODAY + 9 / 10 / 11 calendar days.
const EXPIRY_BELOW = '2026-10-09';
const EXPIRY_EQUAL = '2026-10-10';
const EXPIRY_ABOVE = '2026-10-11';

const base = { expiryDate: EXPIRY_BELOW, today: TODAY, minRemainingLifeReceiptDays: MIN_DAYS, trackExpiry: true };

describe('isShortShelfLifeReceipt', () => {
  it('is true when remaining days are below the minimum', () => {
    expect(isShortShelfLifeReceipt(base)).toBe(true);
  });

  it('is false when remaining days equal the minimum (strict less-than)', () => {
    expect(isShortShelfLifeReceipt({ ...base, expiryDate: EXPIRY_EQUAL })).toBe(false);
  });

  it('is false when remaining days are above the minimum', () => {
    expect(isShortShelfLifeReceipt({ ...base, expiryDate: EXPIRY_ABOVE })).toBe(false);
  });

  it('is false when the SKU has no minimum', () => {
    expect(isShortShelfLifeReceipt({ ...base, minRemainingLifeReceiptDays: null })).toBe(false);
  });

  it('is false when the receipt carries no expiry', () => {
    expect(isShortShelfLifeReceipt({ ...base, expiryDate: null })).toBe(false);
  });

  it('is false when the SKU does not track expiry, even below the minimum', () => {
    expect(isShortShelfLifeReceipt({ ...base, trackExpiry: false })).toBe(false);
  });

  it('counts calendar days in Asia/Kuwait, not UTC: 21:30Z on 09-29 is already 09-30 in Kuwait', () => {
    const nearUtcMidnight = new Date('2026-09-29T21:30:00.000Z'); // Kuwait: 2026-09-30 00:30
    // Kuwait remaining to 2026-10-10 is exactly MIN_DAYS (not short); the UTC date would give MIN_DAYS + 1.
    expect(isShortShelfLifeReceipt({ ...base, today: nearUtcMidnight, expiryDate: EXPIRY_EQUAL })).toBe(false);
    // Kuwait remaining to 2026-10-09 is MIN_DAYS - 1 (short); the UTC date would give MIN_DAYS (not short).
    expect(isShortShelfLifeReceipt({ ...base, today: nearUtcMidnight, expiryDate: EXPIRY_BELOW })).toBe(true);
  });

  it('a moment just before Kuwait midnight still belongs to the same Kuwait date', () => {
    const lateKuwait = new Date('2026-09-30T20:59:00.000Z'); // Kuwait: 2026-09-30 23:59
    expect(isShortShelfLifeReceipt({ ...base, today: lateKuwait, expiryDate: EXPIRY_EQUAL })).toBe(false);
    expect(isShortShelfLifeReceipt({ ...base, today: lateKuwait, expiryDate: EXPIRY_BELOW })).toBe(true);
  });
});
