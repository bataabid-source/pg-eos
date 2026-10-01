// modules/billing/tests/record-billable-event/outbound-checked-services.unit.test.ts — WBS 4.3 part 1.
//
// Pure mapping wms.outbound.checked -> [OF-01, OF-02, OF-06, OF-07], each qty '1' (doc 40 line 444:
// "OF-01×1, OF-02×1, OF-06×1, OF-07×1"). Brief Decision 2: a named constant list; `uom` is NOT part
// of the domain (it comes from the catalog.services row).
//
// SURFACE EXPECTED (modules/billing/domain/record-billable-event/outbound-checked-services.ts):
//   export const OUTBOUND_CHECKED_SERVICES: readonly { readonly code: string; readonly qty: string }[]

import { describe, expect, it } from 'vitest';

import { OUTBOUND_CHECKED_SERVICES } from '../../domain/record-billable-event/outbound-checked-services.js';

const EXPECTED_CODES = ['OF-01', 'OF-02', 'OF-06', 'OF-07'];
const EXPECTED_QTY = '1';

describe('OUTBOUND_CHECKED_SERVICES (wms.outbound.checked mapping)', () => {
  it('lists exactly OF-01, OF-02, OF-06, OF-07, in that order', () => {
    expect(OUTBOUND_CHECKED_SERVICES.map((s) => s.code)).toEqual(EXPECTED_CODES);
  });

  it('carries qty "1" for every service', () => {
    for (const service of OUTBOUND_CHECKED_SERVICES) expect(service.qty).toBe(EXPECTED_QTY);
  });

  it('has no duplicate service code', () => {
    const codes = OUTBOUND_CHECKED_SERVICES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('carries no uom (the uom comes from the catalog.services row, never the domain)', () => {
    for (const service of OUTBOUND_CHECKED_SERVICES) expect(Object.keys(service).sort()).toEqual(['code', 'qty']);
  });
});
