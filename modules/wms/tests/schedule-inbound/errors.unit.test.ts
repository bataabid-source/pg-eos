// modules/wms/tests/schedule-inbound/errors.unit.test.ts — domain unit tests for
// modules/wms/domain/schedule-inbound/errors.ts (Stryker mutation gate, doc 40 Part F G16).
//
// Pure, no DB, no I/O. Constructs EVERY error class exported by errors.ts and pins `.name` (exact
// string), `.message` (exact pass-through, including the empty string), `instanceof Error`, and
// name uniqueness across the file.

import { describe, expect, it } from 'vitest';

import {
  CancelReasonRequiredError,
  IllegalTransitionError,
  InvalidHandoverPointError,
  InvalidLabourByError,
  InvalidLabourCountError,
  InvalidTransportByError,
  InvalidVehicleTypeError,
  LogisticsTermsRequireExpectedAtError,
  MissingActorError,
  OrderNotFoundError,
  RoleRequiredError,
  ScheduleInPastError,
  StaleVersionError,
} from '../../domain/schedule-inbound/errors.js';

const cases: ReadonlyArray<{ readonly ctor: new (message: string) => Error; readonly name: string }> = [
  { ctor: ScheduleInPastError, name: 'ScheduleInPastError' },
  { ctor: InvalidVehicleTypeError, name: 'InvalidVehicleTypeError' },
  { ctor: InvalidHandoverPointError, name: 'InvalidHandoverPointError' },
  { ctor: InvalidTransportByError, name: 'InvalidTransportByError' },
  { ctor: InvalidLabourByError, name: 'InvalidLabourByError' },
  { ctor: InvalidLabourCountError, name: 'InvalidLabourCountError' },
  { ctor: LogisticsTermsRequireExpectedAtError, name: 'LogisticsTermsRequireExpectedAtError' },
  { ctor: IllegalTransitionError, name: 'IllegalTransitionError' },
  { ctor: RoleRequiredError, name: 'RoleRequiredError' },
  { ctor: OrderNotFoundError, name: 'OrderNotFoundError' },
  { ctor: StaleVersionError, name: 'StaleVersionError' },
  { ctor: CancelReasonRequiredError, name: 'CancelReasonRequiredError' },
  { ctor: MissingActorError, name: 'MissingActorError' },
];

describe('schedule-inbound errors — name, message, instanceof', () => {
  it.each(cases)('$name carries the exact name and the exact message given', ({ ctor, name }) => {
    const err = new ctor('a distinctive message for ' + name);
    expect(err.name).toBe(name);
    expect(err.message).toBe('a distinctive message for ' + name);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ctor);
  });

  it.each(cases)('$name carries the empty-string message unchanged', ({ ctor, name }) => {
    const err = new ctor('');
    expect(err.name).toBe(name);
    expect(err.message).toBe('');
  });

  it('every name above is unique (no copy/paste collision across 13 classes)', () => {
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(13);
  });
});
