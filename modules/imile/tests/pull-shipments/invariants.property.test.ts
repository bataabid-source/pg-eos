// modules/imile/tests/pull-shipments/invariants.property.test.ts — WBS 3.14 (part 2).
//
// Property tests (fast-check) for the pure domain invariants in
// modules/imile/domain/pull-shipments/invariants.ts, plus the module brief's cross-cutting
// invariants over a full pull cycle (run against the real database, same fixture discipline as
// ./pull-shipments.test.ts).
//
// Expected new surface (RED until it exists):
//   modules/imile/domain/pull-shipments/errors.ts
//     - StaleVersionError, PortalUnreachableError, PortalNotConfiguredError.
//   modules/imile/domain/pull-shipments/invariants.ts
//     - `validatePortalRecord(raw: unknown): PortalShipmentRecord | null` — pure. Returns null iff
//       `raw` is not an object, or its `tracking_no` is missing/not a non-empty string. Never
//       throws for ANY input (including primitives, null, arrays, garbage objects) — a malformed
//       record is data, not a crash.
//     - `iMileFieldsChanged(existing, incoming): boolean` — pure. False iff every iMile-sourced
//       field (merchant, zone_code, area, recipient_phone, is_cod, cod_amount, is_fresh,
//       imile_status) is unchanged; true iff at least one differs. Never inspects internal_status,
//       cage_code, driver_code or delivery_task_id (those are not iMile-sourced — brief, Contract
//       line).
//
// Cross-cutting invariants from the module brief (exercised against the real PullShipments command
// + a FakeImilePortalAdapter, same construction as ./pull-shipments.test.ts, since they concern the
// whole pull cycle, not one pure function):
//   - any valid portal record (well-formed tracking_no, not already known locally) produces an
//     insert;
//   - any record missing a tracking number is always skipped and never aborts the rest of the pull
//     cycle;
//   - the result counts (inserted + updated + skipped + unchanged) always equal the number of
//     portal records returned for that pull.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

// The modules under test — do not exist yet (RED).
import { validatePortalRecord, iMileFieldsChanged } from '../../domain/pull-shipments/invariants.js';
import { pullShipments } from '../../application/pull-shipments/index.js';
import { createPullShipmentsDeps } from '../../api/pull-shipments/composition.js';
import type { ImilePortalPort, PortalShipmentRecord } from '../../application/pull-shipments/ports.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const FIXTURE_ACTOR_UUID = '00000000-0000-4000-8000-0000003140b1';
const clock = new FixedClock(new Date('2026-09-25T01:00:00.000Z'));
const ids = new SequentialIdGenerator(31401);
const ctx = { userId: FIXTURE_ACTOR_UUID, clientId: null, isInternal: true };

const usedTrackingNos = new Set<string>();

beforeAll(async () => {
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [FIXTURE_ACTOR_UUID, `_imilepull_props_${randomUUID()}@test.invalid`, 'ممثل اختبار خصائص سحب شحنات iMile'],
  );
});

afterAll(async () => {
  if (usedTrackingNos.size > 0) {
    await pool.query(`delete from imile.shipments where tracking_no = any($1::text[])`, [[...usedTrackingNos]]);
  }
  await pool.query(`delete from platform.idempotency_keys where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_roles where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [FIXTURE_ACTOR_UUID]);
  await pool.end();
});

function fakePortal(records: readonly unknown[]): ImilePortalPort {
  return { fetchShipments: async () => records };
}

function validRecordArb(trackingNo: string): fc.Arbitrary<PortalShipmentRecord> {
  return fc.record({
    tracking_no: fc.constant(trackingNo),
    merchant: fc.option(fc.string(), { nil: null }),
    zone_code: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
    area: fc.option(fc.string(), { nil: null }),
    recipient_phone: fc.option(fc.string(), { nil: null }),
    is_cod: fc.boolean(),
    cod_amount: fc.option(fc.constant('9.500'), { nil: null }),
    is_fresh: fc.boolean(),
    imile_status: fc.constantFrom('created', 'picked_up', 'in_transit', 'delivered'),
    raw: fc.constant({ note: 'property-generated fixture' }),
  });
}

// --- validatePortalRecord — pure property tests --------------------------------------------------

describe('validatePortalRecord — property (pure, no I/O)', () => {
  it('never throws for arbitrary garbage input', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => validatePortalRecord(raw)).not.toThrow();
      }),
    );
  });

  it('returns null whenever tracking_no is missing, empty, or not a string', () => {
    const malformedArb = fc.record({
      tracking_no: fc.oneof(fc.constant(undefined), fc.constant(null), fc.constant(''), fc.integer(), fc.boolean()),
    });
    fc.assert(
      fc.property(malformedArb, (raw) => {
        expect(validatePortalRecord(raw)).toBeNull();
      }),
    );
  });

  it('returns a non-null validated record whenever tracking_no is a non-empty string', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (trackingNo) => {
        fc.pre(trackingNo.trim().length > 0);
        const result = validatePortalRecord({ tracking_no: trackingNo });
        expect(result).not.toBeNull();
        expect(result?.tracking_no).toBe(trackingNo);
      }),
    );
  });
});

// --- iMileFieldsChanged — pure property tests ------------------------------------------------------

describe('iMileFieldsChanged — property (pure, no I/O)', () => {
  it('is false when incoming is a structural copy of existing', () => {
    fc.assert(
      fc.property(validRecordArb('SHP-PROP-STABLE'), (record) => {
        const copy = { ...record };
        expect(iMileFieldsChanged(record, copy)).toBe(false);
      }),
    );
  });

  it('is true whenever imile_status alone differs', () => {
    fc.assert(
      fc.property(
        validRecordArb('SHP-PROP-CHANGED'),
        fc.constantFrom('created', 'picked_up', 'in_transit', 'delivered'),
        (record, newStatus) => {
          fc.pre(newStatus !== record.imile_status);
          const incoming = { ...record, imile_status: newStatus };
          expect(iMileFieldsChanged(record, incoming)).toBe(true);
        },
      ),
    );
  });

  // Reviewer round 1 fix (domain/pull-shipments/invariants.ts's IS_FRESH_DEFAULT, 2026-09-25):
  // imile.shipments.is_fresh is `boolean not null default false` — a portal record that
  // OMITS is_fresh (null/undefined) must normalize to `false` on comparison, never to `null`, or
  // every such row would read as "changed" on every pull cycle. The property tests above never
  // exercise this — both sides always carry a real boolean (validRecordArb's `is_fresh:
  // fc.boolean()`) — so removing IS_FRESH_DEFAULT from iMileChangedFieldKeys would leave every
  // existing test green. This property pins the null/omitted-vs-stored-false case directly.
  it('is false when is_fresh is null/omitted on one side and stored false on the other (IS_FRESH_DEFAULT normalization)', () => {
    fc.assert(
      fc.property(
        validRecordArb('SHP-PROP-ISFRESH-NORMALIZE'),
        fc.constantFrom('null', 'omitted-key'),
        (record, omittedIsFreshMode) => {
          const storedFalse = { ...record, is_fresh: false };
          // `exactOptionalPropertyTypes` forbids `is_fresh: undefined` on the optional
          // `IMileSourcedFields.is_fresh?: boolean | null` — "omitted" must mean the KEY is
          // genuinely absent, not present-and-undefined, so build it with the key destructured
          // out rather than set to `undefined`.
          const omitted: typeof record =
            omittedIsFreshMode === 'null'
              ? { ...record, is_fresh: null }
              : (Object.fromEntries(
                  Object.entries(record).filter(([key]) => key !== 'is_fresh'),
                ) as typeof record);
          expect(iMileFieldsChanged(storedFalse, omitted)).toBe(false);
          expect(iMileFieldsChanged(omitted, storedFalse)).toBe(false);
        },
      ),
    );
  });
});

// --- cross-cutting invariants over a full pull cycle (module brief) --------------------------------

describe('PullShipments — property: every valid new record inserts, every malformed record is skipped, counts always sum', () => {
  it('inserted + updated + skipped + unchanged === number of portal records returned', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 0, maxLength: 4 }), // true = malformed (no tracking_no), false = valid+new.
        async (malformedFlags) => {
          const records: unknown[] = malformedFlags.map((isMalformed) => {
            if (isMalformed) return { merchant: 'No Tracking Co' };
            const trackingNo = `SHP-PROP-BATCH-${randomUUID()}`;
            usedTrackingNos.add(trackingNo);
            return {
              tracking_no: trackingNo,
              merchant: 'Prop Merchant',
              zone_code: 'Z-99',
              area: 'Farwaniya',
              recipient_phone: '+96555511111',
              is_cod: false,
              cod_amount: null,
              is_fresh: false,
              imile_status: 'created',
              raw: { fixture: true },
            };
          });
          const expectedInserted = malformedFlags.filter((f) => !f).length;
          const expectedSkipped = malformedFlags.filter((f) => f).length;

          const deps = createPullShipmentsDeps({ clock, ids, portal: fakePortal(records) });
          const result = await pullShipments(ctx, { correlationId: randomUUID() }, deps);

          expect(result.inserted + result.updated + result.skipped + result.unchanged).toBe(records.length);
          expect(result.inserted).toBe(expectedInserted);
          expect(result.skipped).toBe(expectedSkipped);
        },
      ),
      { numRuns: 5 },
    );
  });
});
