// modules/fleet/tests/assert-vehicle-assignable/errors.unit.test.ts — WBS 3.1 part 2, domain unit.
//
// The typed error's public shape is the api/ layer's Problem body (i18nKey + params); pin it so a
// refactor cannot silently drop a field the PDA/admin i18n rendering reads.
import { describe, expect, it } from 'vitest';

import { VehicleNotAssignableError } from '../../domain/assert-vehicle-assignable/errors.js';

const EXPIRED = [{ docType: 'insurance', expiryDate: '2026-01-31' }] as const;

describe('VehicleNotAssignableError', () => {
  it('carries the i18n key and the structured params the Problem body renders', () => {
    const error = new VehicleNotAssignableError('vehicle KWT-123 has expired documents', {
      plateNo: 'KWT-123',
      expiredDocuments: EXPIRED,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VehicleNotAssignableError');
    expect(error.message).toBe('vehicle KWT-123 has expired documents');
    expect(error.i18nKey).toBe('fleet.vehicle.notAssignable');
    expect(error.plateNo).toBe('KWT-123');
    expect(error.expiredDocuments).toEqual(EXPIRED);
  });
});
