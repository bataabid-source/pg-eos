// modules/wms/tests/unit/sku-registration.domain.test.ts — WBS 2.6 (pg-tester), written RED-first
// on 2026-09-23 against `modules/wms/src/sku-registration/domain.ts`'s contract, exactly the
// "Public surface" block pins down (docs/notes/slice-briefs/_slice-2.6.brief.md) — same RED-first
// precedent as modules/wms/tests/unit/stock-ledger.domain.test.ts (WBS 2.8). It is now the
// permanent unit + property proof suite for that surface.
//
// Pure domain only: no DB, no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS). Every
// arbitrary is built from fast-check primitives, never a raw invented literal.
//
// Property list, copied verbatim from the brief's "Property tests" section:
//   - validateSkuInput accepts any input with clientId/code/nameAr non-empty and status/
//     pickingPolicy inside (or absent from) their enums.
//   - validateSkuInput rejects (InvalidSkuInputError) whenever clientId, code or nameAr is
//     empty/whitespace-only, or status/pickingPolicy is present and outside its enum — for every
//     arbitrary combination.
//   - validateSkuInput never mutates its input (returns an equal, not identical, object is
//     acceptable; no field is silently dropped for a valid input).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

// The module under test, per the brief's Public surface block.
import {
  PICKING_POLICIES,
  SKU_STATUSES,
  validateSkuInput,
  type PickingPolicy,
  type RegisterSkuInput,
  type SkuStatus,
} from '../../index.js';
import { CrossClientSkuError, InvalidSkuInputError, registerSku } from '../../index.js';
import type { RegisterSkuDeps } from '../../index.js';

import { FixedClock } from '@pg-eos/domain-kit';

const PROPERTY_SEED = 2_006_000; // WBS 2.6 — fixed, printed seed (test names below), reproducible.
const NUM_RUNS = 1000; // packages/domain-kit / modules/wms 2.8 precedent: 1,000 property runs.

// decision 12 precedent (sku-registration.test.ts): a fixed actor uuid — audit_log.user_id carries
// no FK, and this file never asserts on audit_log itself.
const ACTOR_UUID = '00000000-0000-4000-8000-0000000206a1';
const clock = new FixedClock(new Date('2026-09-23T00:00:00.000Z'));
const deps: RegisterSkuDeps = { clock };

// --- arbitraries ---------------------------------------------------------------------------

// A non-empty, non-whitespace-only string — the shape validateSkuInput requires for
// clientId/code/nameAr (brief decision 4: "missing or empty").
const nonEmptyStringArb = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);

// Empty-or-whitespace-only — the exact rejection boundary brief decision 4 states.
const emptyOrWhitespaceStringArb = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constant(''),
    fc.constantFrom(' ', '  ', '\t', '\n', '   \t\n  '),
  );

const skuStatusArb = (): fc.Arbitrary<SkuStatus> => fc.constantFrom(...SKU_STATUSES);
const pickingPolicyArb = (): fc.Arbitrary<PickingPolicy> => fc.constantFrom(...PICKING_POLICIES);

// A string guaranteed to be outside SKU_STATUSES.
const invalidStatusArb = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 20 }).filter(
    (s) => !(SKU_STATUSES as readonly string[]).includes(s),
  );

// A string guaranteed to be outside PICKING_POLICIES.
const invalidPickingPolicyArb = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 1, maxLength: 20 }).filter(
    (s) => !(PICKING_POLICIES as readonly string[]).includes(s),
  );

// A minimal, otherwise-valid RegisterSkuInput (decision 3: required fields clientId/code/nameAr).
const baseValidInputArb = (): fc.Arbitrary<RegisterSkuInput> =>
  fc
    .record({
      clientId: fc.uuid(),
      code: nonEmptyStringArb(),
      nameAr: nonEmptyStringArb(),
    })
    .map((r) => ({ clientId: r.clientId, code: r.code, nameAr: r.nameAr }));

// --- SKU_STATUSES / PICKING_POLICIES — smoke unit tests, cited to 13B constraints -----------

describe('SKU_STATUSES (13B chk_skus_status)', () => {
  it('is exactly active, on_hold, discontinued, no other', () => {
    expect(SKU_STATUSES).toEqual(['active', 'on_hold', 'discontinued']);
  });
});

describe('PICKING_POLICIES (13B chk_skus_picking_policy)', () => {
  it('is exactly FIFO, FEFO, LIFO, no other', () => {
    expect(PICKING_POLICIES).toEqual(['FIFO', 'FEFO', 'LIFO']);
  });
});

// --- property: validateSkuInput accepts a valid input, status/pickingPolicy inside or absent ---

describe('validateSkuInput accepts any input with clientId/code/nameAr non-empty and status/pickingPolicy inside (or absent from) their enums', () => {
  it(`holds for ${NUM_RUNS} random valid inputs (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(
        baseValidInputArb(),
        fc.option(skuStatusArb(), { nil: undefined }),
        fc.option(pickingPolicyArb(), { nil: undefined }),
        (base, status, pickingPolicy) => {
          // finding 5 (pg-reviewer, WBS 2.6 round 1): never pass an explicit `undefined` for an
          // absent optional field — that is what forced the public-surface type to widen with
          // `| undefined`, which is a test defect, not a legitimate type fix. Omit the key entirely
          // when the option resolved to "absent".
          const input: RegisterSkuInput = {
            ...base,
            ...(status !== undefined ? { status } : {}),
            ...(pickingPolicy !== undefined ? { pickingPolicy } : {}),
          };
          expect(() => validateSkuInput(input)).not.toThrow();
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

// --- property: validateSkuInput rejects every invalid combination ------------------------------

describe('validateSkuInput rejects (InvalidSkuInputError) whenever clientId, code or nameAr is empty/whitespace-only, or status/pickingPolicy is present and outside its enum', () => {
  it(`rejects an empty/whitespace-only clientId (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(
        emptyOrWhitespaceStringArb(),
        nonEmptyStringArb(),
        nonEmptyStringArb(),
        (clientId, code, nameAr) => {
          expect(() => validateSkuInput({ clientId, code, nameAr })).toThrow(InvalidSkuInputError);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it(`rejects an empty/whitespace-only code (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        emptyOrWhitespaceStringArb(),
        nonEmptyStringArb(),
        (clientId, code, nameAr) => {
          expect(() => validateSkuInput({ clientId, code, nameAr })).toThrow(InvalidSkuInputError);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it(`rejects an empty/whitespace-only nameAr (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        nonEmptyStringArb(),
        emptyOrWhitespaceStringArb(),
        (clientId, code, nameAr) => {
          expect(() => validateSkuInput({ clientId, code, nameAr })).toThrow(InvalidSkuInputError);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it(`rejects a status outside SKU_STATUSES (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(baseValidInputArb(), invalidStatusArb(), (base, status) => {
        expect(() =>
          validateSkuInput({ ...base, status: status as unknown as SkuStatus }),
        ).toThrow(InvalidSkuInputError);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it(`rejects a pickingPolicy outside PICKING_POLICIES (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(baseValidInputArb(), invalidPickingPolicyArb(), (base, pickingPolicy) => {
        expect(() =>
          validateSkuInput({ ...base, pickingPolicy: pickingPolicy as unknown as PickingPolicy }),
        ).toThrow(InvalidSkuInputError);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

// --- property: validateSkuInput never mutates its input, drops no field for a valid input ------

describe('validateSkuInput never mutates its input (equal, not identical, is acceptable; no field silently dropped)', () => {
  it(`holds for ${NUM_RUNS} random valid inputs (fast-check seed ${PROPERTY_SEED})`, () => {
    fc.assert(
      fc.property(
        baseValidInputArb(),
        nonEmptyStringArb(),
        nonEmptyStringArb(),
        fc.integer({ min: 0, max: 100_000 }),
        (base, nameEn, category, minStock) => {
          const input: RegisterSkuInput = { ...base, nameEn, category, minStock };
          const snapshotBefore = JSON.parse(JSON.stringify(input)) as unknown;

          const result = validateSkuInput(input);

          // the argument object itself is never mutated in place.
          expect(input).toEqual(snapshotBefore);
          // the returned object carries every field the input had (equal, not necessarily identical).
          expect(result).toEqual(input);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

// --- property: registerSku's own cross-client invariant (finding 3, pg-reviewer WBS 2.6 round 1) --
//
// decision 5 (the brief): registerSku throws CrossClientSkuError itself, before withContext is
// opened, whenever a portal caller (!ctx.isInternal) attempts to register a SKU under a clientId
// other than its own — this is the acceptance criterion's "application layer" proof and the slice's
// own invariant, not just a smoke case. The rejecting branch never reaches withContext, so it is a
// pure property test (no database needed) and belongs in this file.
//
// Its two counterparts (input.clientId === ctx.clientId; an internal caller) proceed PAST the
// CrossClientSkuError guard into withContext — a real DB round trip. pg-reviewer WBS 2.6 round 2
// finding 1: a DB-touching property does not belong in a "Pure domain only: no DB" unit file, and a
// try/catch that only asserts "not CrossClientSkuError" is vacuous if the DB connection itself
// fails. Moved to modules/wms/tests/integration/sku-registration.test.ts, asserting the concrete
// outcome (UnknownClientError, since the generated clientId is a random uuid, not a fixture).

describe('registerSku rejects a cross-client attempt with CrossClientSkuError before any DB call (decision 5, INV-C3-3)', () => {
  it(`throws CrossClientSkuError for every distinct (ctx.clientId, input.clientId) pair when isInternal is false (fast-check seed ${PROPERTY_SEED})`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        nonEmptyStringArb(),
        nonEmptyStringArb(),
        fc.uuid(),
        async (ctxClientId, inputClientId, code, nameAr, correlationId) => {
          fc.pre(ctxClientId !== inputClientId);
          const ctx = { userId: ACTOR_UUID, clientId: ctxClientId, isInternal: false };
          await expect(
            registerSku(ctx, { clientId: inputClientId, code, nameAr, correlationId }, deps),
          ).rejects.toBeInstanceOf(CrossClientSkuError);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});
