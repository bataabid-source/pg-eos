// modules/wms/tests/receive-inbound/invariants.property.test.ts — WBS 2.9, THE GOLDEN SLICE.
//
// Property tests (fast-check) for the pure domain invariants in
// modules/wms/domain/receive-inbound/invariants.ts — one property per invariant (CLAUDE.md TESTING).
//
// Expected new surface (RED until it exists):
//   modules/wms/domain/receive-inbound/invariants.ts
//     - `assertSkuBelongsToOrderClient(skuClientId: string, orderClientId: string): void` —
//       INV-C3-3. Throws SkuClientMismatchError (../errors.js) iff skuClientId !== orderClientId;
//       returns (no throw) when they match. Pure: no I/O, no Date, no Math.random().
//     - `assertVarianceHasReason(qtyActual: Quantity, qtyOrdered: Quantity, varianceReason: string
//       | null | undefined): void` — INV-C3-5. Throws VarianceReasonRequiredError iff
//       !qtyActual.equals(qtyOrdered) and varianceReason is null/undefined/empty; returns
//       otherwise (equal quantities never throw, regardless of varianceReason; unequal quantities
//       WITH a non-empty reason never throw — this covers the zero-qty-with-reason case too, same
//       rule, no special-casing).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Quantity } from '@pg-eos/domain-kit';

// The module under test — does not exist yet (RED).
import {
  assertSkuBelongsToOrderClient,
  assertVarianceHasReason,
} from '../../domain/receive-inbound/invariants.js';
import { SkuClientMismatchError, VarianceReasonRequiredError } from '../../domain/receive-inbound/errors.js';

const uuidArb = fc.uuid();
// numeric(14,3) fixture range — same pad width other suites in this module use.
const qtyArb = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 999 }))
  .map(([whole, frac]) => Quantity.of(`${whole}.${String(frac).padStart(3, '0')}`));

describe('assertSkuBelongsToOrderClient — property (INV-C3-3)', () => {
  it('never throws when skuClientId === orderClientId', () => {
    fc.assert(
      fc.property(uuidArb, (clientId) => {
        expect(() => assertSkuBelongsToOrderClient(clientId, clientId)).not.toThrow();
      }),
    );
  });

  it('always throws SkuClientMismatchError when skuClientId !== orderClientId', () => {
    fc.assert(
      fc.property(uuidArb, uuidArb, (a, b) => {
        fc.pre(a !== b);
        expect(() => assertSkuBelongsToOrderClient(a, b)).toThrow(SkuClientMismatchError);
      }),
    );
  });
});

describe('assertVarianceHasReason — property (INV-C3-5)', () => {
  it('never throws when qtyActual equals qtyOrdered, regardless of varianceReason', () => {
    fc.assert(
      fc.property(qtyArb, fc.option(fc.string(), { nil: undefined }), (qty, reason) => {
        expect(() => assertVarianceHasReason(qty, qty, reason)).not.toThrow();
      }),
    );
  });

  it('always throws VarianceReasonRequiredError when quantities differ and no reason is given', () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (a, b) => {
        fc.pre(!a.equals(b));
        expect(() => assertVarianceHasReason(a, b, undefined)).toThrow(VarianceReasonRequiredError);
        expect(() => assertVarianceHasReason(a, b, null)).toThrow(VarianceReasonRequiredError);
        expect(() => assertVarianceHasReason(a, b, '')).toThrow(VarianceReasonRequiredError);
      }),
    );
  });

  it('never throws when quantities differ and a non-empty reason is given (covers the zero-qty case too)', () => {
    fc.assert(
      fc.property(
        qtyArb,
        qtyArb,
        fc.string({ minLength: 1 }),
        (a, b, reason) => {
          fc.pre(!a.equals(b));
          expect(() => assertVarianceHasReason(a, b, reason)).not.toThrow();
        },
      ),
    );
  });

  it('a zero-quantity actual against a non-zero ordered quantity, with a reason, does not throw', () => {
    fc.assert(
      fc.property(qtyArb.filter((q) => !q.equals(Quantity.zero())), (ordered) => {
        expect(() => assertVarianceHasReason(Quantity.zero(), ordered, 'short-shipped')).not.toThrow();
      }),
    );
  });
});
