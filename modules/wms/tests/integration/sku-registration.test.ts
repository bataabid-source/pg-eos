// modules/wms/tests/integration/sku-registration.test.ts — WBS 2.6 (pg-tester), written RED-first
// on 2026-09-23 against docs/notes/slice-briefs/_slice-2.6.brief.md's "Public surface" block, ahead
// of `modules/wms/src/sku-registration/{domain,errors,register-sku,index}.ts` and the re-export
// from `modules/wms/index.ts` — same RED-first precedent as
// modules/wms/tests/integration/stock-ledger.test.ts (WBS 2.8). It is now the permanent DB-backed
// proof suite for that surface.
//
// This file is the permanent DB-backed proof suite for doc 38 row 2.6's acceptance ("Cross-client
// SKU mix rejected") at BOTH layers the brief's acceptance criterion names: (1) the application
// layer (registerSku rejects a portal cross-client attempt with CrossClientSkuError, before any DB
// call — the layer that actually protects the live system today, since the runtime connection is
// superuser, PROJECT_STATE §0.18 item 7); (2) the database layer (an ephemeral, non-superuser,
// NOBYPASSRLS role scoped to client A cannot INSERT a wms.skus row with client_id = client B, and
// cannot SELECT client B's rows). It follows the Gherkin in ./sku-registration.feature
// scenario-by-scenario, in file order.
//
// Connects like stock-ledger.test.ts (pg Pool, PG* env, same defaults). Test ctx is exactly what
// the brief's decision 12 specifies: internal `{ userId: <fixture uuid>, clientId: null, isInternal:
// true }`; portal `{ userId: <fixture uuid>, clientId: <fixture client A id>, isInternal: false }`.
//
// OPEN G-01 ITEM (brief decision 9, amended 2026-09-23, superseding this file's earlier "OPEN
// QUESTION" note): `platform.outbox` carries a check constraint `outbox_business_needs_entity`:
// `entity_id IS NOT NULL OR split_part(aggregate_type,'.',1) = ANY ('platform','identity')`.
// `wms.skus` has no `entity_id` column at all (decision 2), and doc 40 §B3/§C3 name no `wms.sku.*`
// event — inventing an entityId source or misusing the platform/identity exemption would itself be
// an invented business rule (CLAUDE.md "never invent"). This slice therefore does NOT call
// `writeOutboxEvent` and does NOT write to `packages/events/catalog.ts`; this is now an open G-01
// item for the GM (recorded in the slice CHANGELOG entry), not a defect this test works around. The
// behavioural claim this suite proves instead: `registerSku` succeeding writes ZERO rows to
// `platform.outbox` for its correlation_id — so a future accidental `writeOutboxEvent` call
// regresses this test, which is the point.

import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock } from '@pg-eos/domain-kit';

// The module under test, per the brief's Public surface block.
import {
  CrossClientSkuError,
  DuplicateSkuCodeError,
  InvalidSkuInputError,
  UnknownClientError,
  registerSku,
  type RegisterSkuCommandInput,
  type RegisterSkuDeps,
} from '../../index.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 20,
});

// --- literals, each cited to the decision/scenario they come from -----------------------------

// decision 12: "userId: <fixture uuid>" for both the internal and the portal ctx (audit_log.user_id
// carries no FK — confirmed against pg_constraint, brief precedent).
const ACTOR_FIXTURE_UUID = '00000000-0000-4000-8000-0000000206a1';

// property seed for the two counterpart-property tests below, moved here from the unit suite
// (pg-reviewer WBS 2.6 round 2 finding 1 — a DB-touching property does not belong in a "no DB" unit
// file). Small run count: each run is a real DB round trip.
const PROPERTY_SEED = 2_006_000; // same fixed seed as sku-registration.domain.test.ts
const CROSS_CLIENT_COUNTERPART_NUM_RUNS = 20;

// Gherkin scenario "an internal caller registers a SKU for client A" — full-field fixture,
// covering decision 3's required fields plus dimensions, storage conditions and tracking policy.
const FULL_SKU_CODE = 'SKU-FULL-001';
const FULL_SKU_NAME_AR = 'صنف كامل الحقول — اختبار 2.6';
const FULL_SKU_UNITS_PER_PACK = 12;
const FULL_SKU_PACKS_PER_CARTON = 6;
const FULL_SKU_CARTONS_PER_LAYER = 5;
const FULL_SKU_LAYERS_PER_PALLET = 4;
// decision 3 / DDL 01-Data-Model.sql:651-653: units_per_pallet = product of the four packaging
// fields above (coalesce(...,1) each) — 12*6*5*4.
const FULL_SKU_EXPECTED_UNITS_PER_PALLET =
  FULL_SKU_UNITS_PER_PACK * FULL_SKU_PACKS_PER_CARTON * FULL_SKU_CARTONS_PER_LAYER * FULL_SKU_LAYERS_PER_PALLET;

// Gherkin scenario "the same code is rejected only within the same client".
const DUPLICATE_SKU_CODE = 'SKU-001';

const clock = new FixedClock(new Date('2026-09-23T00:00:00.000Z'));
const deps: RegisterSkuDeps = { clock };

interface SkuRow {
  id: string;
  client_id: string;
  code: string;
  client_sku: string | null;
  barcode: string | null;
  carton_barcode: string | null;
  name_ar: string;
  name_en: string | null;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  origin_country: string | null;
  length_cm: string | null;
  width_cm: string | null;
  height_cm: string | null;
  net_weight_kg: string | null;
  gross_weight_kg: string | null;
  volume_cbm: string | null;
  units_per_pack: number | null;
  packs_per_carton: number | null;
  cartons_per_layer: number | null;
  layers_per_pallet: number | null;
  units_per_pallet: number;
  temp_min: string | null;
  temp_max: string | null;
  stackable: boolean;
  max_stack_height: number | null;
  is_fragile: boolean;
  is_hazmat: boolean;
  un_class: string | null;
  light_sensitive: boolean;
  track_batch: boolean;
  track_serial: boolean;
  track_expiry: boolean;
  picking_policy: string;
  shelf_life_days: number | null;
  min_remaining_life_receipt_days: number | null;
  min_remaining_life_issue_days: number | null;
  quarantine_days: number;
  min_stock: string | null;
  max_stock: string | null;
  reorder_point: string | null;
  abc_class: string | null;
  unit_value: string | null;
  image_url: string | null;
  msds_url: string | null;
  status: string;
}

// --- fixture state (decision 12) ---------------------------------------------------------------

let clientAId: string;
let clientBId: string;
const fixtureClientACode = `_sku_fixture_a_${randomUUID()}`;
const fixtureClientBCode = `_sku_fixture_b_${randomUUID()}`;
const fixtureSkuIds: string[] = [];
const usedCorrelationIds = new Set<string>();

function nextCorrelationId(): string {
  const id = randomUUID();
  usedCorrelationIds.add(id);
  return id;
}

async function countSkuRows(clientId: string, code: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from wms.skus where client_id = $1 and code = $2`,
    [clientId, code],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function countOutboxRows(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.outbox where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function countAuditRows(correlationId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n from platform.audit_log where correlation_id = $1`,
    [correlationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  const clientAResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [fixtureClientACode, 'عميل أ — اختبار تسجيل الأصناف WBS 2.6'],
  );
  const clientARow = clientAResult.rows[0];
  if (!clientARow) throw new Error('fixture sales.accounts insert (client A) returned no row');
  clientAId = clientARow.id;

  const clientBResult: QueryResult<{ id: string }> = await pool.query(
    `insert into sales.accounts (code, name_ar, account_type) values ($1, $2, 'client') returning id`,
    [fixtureClientBCode, 'عميل ب — اختبار تسجيل الأصناف WBS 2.6'],
  );
  const clientBRow = clientBResult.rows[0];
  if (!clientBRow) throw new Error('fixture sales.accounts insert (client B) returned no row');
  clientBId = clientBRow.id;
});

afterAll(async () => {
  // decision 12: fixture wms.skus rows deleted, fixture outbox rows deleted by correlation_id,
  // audit rows stay (hash chain, the 0.18 tail-only rule) — they reference fixture ids only.
  if (fixtureSkuIds.length > 0) {
    await pool.query(`delete from wms.skus where id = any($1::uuid[])`, [fixtureSkuIds]);
  }
  if (usedCorrelationIds.size > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [
      [...usedCorrelationIds],
    ]);
  }
  await pool.query(`delete from sales.accounts where id = any($1::uuid[])`, [
    [clientAId, clientBId],
  ]);
  await pool.end();
});

// --- Scenario: an internal caller registers a SKU for client A ---------------------------------

describe('Scenario: an internal caller registers a SKU for client A', () => {
  const internalCtx = { userId: ACTOR_FIXTURE_UUID, clientId: null, isInternal: true };
  let correlationId: string;
  let skuId: string;

  const fullInput: RegisterSkuCommandInput = {
    clientId: '', // filled in beforeAll once clientAId is known
    code: FULL_SKU_CODE,
    nameAr: FULL_SKU_NAME_AR,
    clientSku: 'CSKU-001',
    barcode: '6291000000001',
    cartonBarcode: '6291000000018',
    nameEn: 'Full-field SKU',
    category: 'general',
    subcategory: 'sub-general',
    brand: 'Acme',
    originCountry: 'SA',
    lengthCm: 30.5,
    widthCm: 20.25,
    heightCm: 15.1,
    netWeightKg: 2.5,
    grossWeightKg: 3,
    volumeCbm: 0.025,
    unitsPerPack: FULL_SKU_UNITS_PER_PACK,
    packsPerCarton: FULL_SKU_PACKS_PER_CARTON,
    cartonsPerLayer: FULL_SKU_CARTONS_PER_LAYER,
    layersPerPallet: FULL_SKU_LAYERS_PER_PALLET,
    tempMin: 2,
    tempMax: 8,
    stackable: true,
    maxStackHeight: 3,
    isFragile: true,
    isHazmat: false,
    unClass: null,
    lightSensitive: true,
    trackBatch: true,
    trackSerial: false,
    trackExpiry: true,
    pickingPolicy: 'FEFO',
    shelfLifeDays: 365,
    minRemainingLifeReceiptDays: 300,
    minRemainingLifeIssueDays: 30,
    quarantineDays: 2,
    minStock: 100,
    maxStock: 500,
    reorderPoint: 150,
    abcClass: 'A',
    unitValue: 25.75,
    imageUrl: 'https://example.test/sku.png',
    msdsUrl: 'https://example.test/sku-msds.pdf',
    status: 'active',
    correlationId: '', // filled in below
  };

  it('registerSku (internal ctx) registers a SKU for client A with every field', async () => {
    correlationId = nextCorrelationId();
    const result = await registerSku(
      internalCtx,
      { ...fullInput, clientId: clientAId, correlationId },
      deps,
    );
    expect(result.correlationId).toBe(correlationId);
    skuId = result.skuId;
    fixtureSkuIds.push(skuId);
  });

  it('wms.skus has one new row with client_id = client A and every supplied field stored as given', async () => {
    const result: QueryResult<SkuRow> = await pool.query(`select * from wms.skus where id = $1`, [
      skuId,
    ]);
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row?.client_id).toBe(clientAId);
    expect(row?.code).toBe(FULL_SKU_CODE);
    expect(row?.client_sku).toBe('CSKU-001');
    expect(row?.barcode).toBe('6291000000001');
    expect(row?.carton_barcode).toBe('6291000000018');
    expect(row?.name_ar).toBe(FULL_SKU_NAME_AR);
    expect(row?.name_en).toBe('Full-field SKU');
    expect(row?.category).toBe('general');
    expect(row?.subcategory).toBe('sub-general');
    expect(row?.brand).toBe('Acme');
    expect(row?.origin_country).toBe('SA');
    // finding 2 (pg-reviewer, WBS 2.6 round 1): compare numeric columns as the driver's own text
    // representation at the DDL's declared scale (01-Data-Model.sql:647-648), never a JS float —
    // length_cm/width_cm/height_cm numeric(8,2), net_weight_kg/gross_weight_kg numeric(10,3),
    // volume_cbm numeric(10,4).
    expect(row?.length_cm).toBe('30.50');
    expect(row?.width_cm).toBe('20.25');
    expect(row?.height_cm).toBe('15.10');
    expect(row?.net_weight_kg).toBe('2.500');
    expect(row?.gross_weight_kg).toBe('3.000');
    expect(row?.volume_cbm).toBe('0.0250');
    expect(row?.units_per_pack).toBe(FULL_SKU_UNITS_PER_PACK);
    expect(row?.packs_per_carton).toBe(FULL_SKU_PACKS_PER_CARTON);
    expect(row?.cartons_per_layer).toBe(FULL_SKU_CARTONS_PER_LAYER);
    expect(row?.layers_per_pallet).toBe(FULL_SKU_LAYERS_PER_PALLET);
    // temp_min/temp_max numeric(6,2) (01-Data-Model.sql:655).
    expect(row?.temp_min).toBe('2.00');
    expect(row?.temp_max).toBe('8.00');
    expect(row?.stackable).toBe(true);
    expect(row?.max_stack_height).toBe(3);
    expect(row?.is_fragile).toBe(true);
    expect(row?.is_hazmat).toBe(false);
    expect(row?.un_class).toBeNull();
    expect(row?.light_sensitive).toBe(true);
    expect(row?.track_batch).toBe(true);
    expect(row?.track_serial).toBe(false);
    expect(row?.track_expiry).toBe(true);
    expect(row?.picking_policy).toBe('FEFO');
    expect(row?.shelf_life_days).toBe(365);
    expect(row?.min_remaining_life_receipt_days).toBe(300);
    expect(row?.min_remaining_life_issue_days).toBe(30);
    expect(row?.quarantine_days).toBe(2);
    // min_stock/max_stock/reorder_point/unit_value numeric(14,3) (01-Data-Model.sql:669,671).
    expect(row?.min_stock).toBe('100.000');
    expect(row?.max_stock).toBe('500.000');
    expect(row?.reorder_point).toBe('150.000');
    expect(row?.abc_class).toBe('A');
    expect(row?.unit_value).toBe('25.750');
    expect(row?.image_url).toBe('https://example.test/sku.png');
    expect(row?.msds_url).toBe('https://example.test/sku-msds.pdf');
    expect(row?.status).toBe('active');
  });

  it("units_per_pallet on that row equals the packaging fields' product (descriptive check of the existing generated column)", async () => {
    const result: QueryResult<{ units_per_pallet: number }> = await pool.query(
      `select units_per_pallet from wms.skus where id = $1`,
      [skuId],
    );
    expect(result.rows[0]?.units_per_pallet).toBe(FULL_SKU_EXPECTED_UNITS_PER_PALLET);
  });

  it('platform.audit_log has one row (wms, skus, that record_id, insert) with the same correlation_id', async () => {
    const result: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from platform.audit_log
        where correlation_id = $1 and schema_name = 'wms' and table_name = 'skus'
          and record_id = $2 and operation = 'insert'`,
      [correlationId, skuId],
    );
    expect(result.rows[0]?.n).toBe('1');
  });

  it('platform.outbox has NO row for that correlation_id (decision 9 — no entity_id on wms.skus, G-01 open item)', async () => {
    expect(await countOutboxRows(correlationId)).toBe(0);
  });
});

// --- Scenario: a portal caller registers a SKU for their own client ----------------------------

describe('Scenario: a portal caller registers a SKU for their own client', () => {
  it('registerSku (client A portal ctx) registers a SKU with clientId = client A — the row is written', async () => {
    const portalCtx = { userId: ACTOR_FIXTURE_UUID, clientId: clientAId, isInternal: false };
    const correlationId = nextCorrelationId();
    const code = 'SKU-PORTAL-OWN-001';

    const result = await registerSku(
      portalCtx,
      { clientId: clientAId, code, nameAr: 'صنف بوابة العميل أ', correlationId },
      deps,
    );

    fixtureSkuIds.push(result.skuId);
    const count = await countSkuRows(clientAId, code);
    expect(count).toBe(1);
  });
});

// --- Scenario: a portal caller cannot register a SKU for a different client --------------------

describe('Scenario: a portal caller cannot register a SKU for a different client', () => {
  it('registerSku (client A portal ctx) with clientId = client B throws CrossClientSkuError, nothing is written', async () => {
    const portalCtx = { userId: ACTOR_FIXTURE_UUID, clientId: clientAId, isInternal: false };
    const correlationId = nextCorrelationId();
    const code = 'SKU-PORTAL-CROSS-001';

    await expect(
      registerSku(
        portalCtx,
        { clientId: clientBId, code, nameAr: 'محاولة خلط عملاء', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(CrossClientSkuError);

    expect(await countSkuRows(clientBId, code)).toBe(0);
    expect(await countOutboxRows(correlationId)).toBe(0);
    expect(await countAuditRows(correlationId)).toBe(0);
  });
});

// --- Scenario: the same code is rejected only within the same client ---------------------------

describe('Scenario: the same code is rejected only within the same client', () => {
  const internalCtx = { userId: ACTOR_FIXTURE_UUID, clientId: null, isInternal: true };

  beforeAll(async () => {
    const correlationId = nextCorrelationId();
    const result = await registerSku(
      internalCtx,
      { clientId: clientAId, code: DUPLICATE_SKU_CODE, nameAr: 'صنف أساسي أ', correlationId },
      deps,
    );
    fixtureSkuIds.push(result.skuId);
  });

  it('registerSku (internal ctx) with the same code under client A throws DuplicateSkuCodeError', async () => {
    const correlationId = nextCorrelationId();
    await expect(
      registerSku(
        internalCtx,
        { clientId: clientAId, code: DUPLICATE_SKU_CODE, nameAr: 'صنف مكرر أ', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(DuplicateSkuCodeError);

    const count = await countSkuRows(clientAId, DUPLICATE_SKU_CODE);
    expect(count).toBe(1);
  });

  it('registerSku (internal ctx) with the same code under client B is written — not a mix', async () => {
    const correlationId = nextCorrelationId();
    const result = await registerSku(
      internalCtx,
      { clientId: clientBId, code: DUPLICATE_SKU_CODE, nameAr: 'صنف أساسي ب', correlationId },
      deps,
    );
    fixtureSkuIds.push(result.skuId);

    const count = await countSkuRows(clientBId, DUPLICATE_SKU_CODE);
    expect(count).toBe(1);
  });
});

// --- Scenario: an unknown client is rejected ----------------------------------------------------

describe('Scenario: an unknown client is rejected', () => {
  it('registerSku (internal ctx) with a random uuid clientId with no sales.accounts row throws UnknownClientError', async () => {
    const internalCtx = { userId: ACTOR_FIXTURE_UUID, clientId: null, isInternal: true };
    const correlationId = nextCorrelationId();
    const unknownClientId = randomUUID();

    await expect(
      registerSku(
        internalCtx,
        { clientId: unknownClientId, code: 'SKU-UNKNOWN-CLIENT-001', nameAr: 'صنف عميل غير معروف', correlationId },
        deps,
      ),
    ).rejects.toBeInstanceOf(UnknownClientError);

    expect(await countOutboxRows(correlationId)).toBe(0);
    expect(await countAuditRows(correlationId)).toBe(0);
  });
});

// --- property: registerSku's cross-client counterparts (decision 5) — moved from the unit suite --
//
// pg-reviewer WBS 2.6 round 2 finding 1: these two properties proceed PAST the CrossClientSkuError
// guard into withContext — a real DB round trip — so they belong here, not in the "Pure domain
// only: no DB" unit file (sku-registration.domain.test.ts, which keeps only the pure rejecting
// property). Each generated clientId is a random uuid with no matching sales.accounts row, so the
// concrete, non-vacuous outcome is UnknownClientError — never CrossClientSkuError, and never a
// silently-swallowed connection failure (a prior version of this test only asserted "not
// CrossClientSkuError" inside a try/catch, which passes even if the database round trip itself
// throws for an unrelated reason).

describe('registerSku does not throw CrossClientSkuError when clientId matches ctx.clientId, or when the caller is internal (property, decision 5 counterparts)', () => {
  it(`portal caller, input.clientId === ctx.clientId: an unknown clientId throws UnknownClientError, never CrossClientSkuError (fast-check seed ${PROPERTY_SEED})`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (clientId) => {
        const portalCtx = { userId: ACTOR_FIXTURE_UUID, clientId, isInternal: false };
        const correlationId = nextCorrelationId();
        await expect(
          registerSku(
            portalCtx,
            { clientId, code: `SKU-PROP-${randomUUID()}`, nameAr: 'صنف عشوائي', correlationId },
            deps,
          ),
        ).rejects.toBeInstanceOf(UnknownClientError);
      }),
      { seed: PROPERTY_SEED, numRuns: CROSS_CLIENT_COUNTERPART_NUM_RUNS },
    );
  });

  it(`internal caller: an unknown clientId throws UnknownClientError, never CrossClientSkuError, for any clientId (fast-check seed ${PROPERTY_SEED})`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (clientId) => {
        const internalCtx = { userId: ACTOR_FIXTURE_UUID, clientId: null, isInternal: true };
        const correlationId = nextCorrelationId();
        await expect(
          registerSku(
            internalCtx,
            { clientId, code: `SKU-PROP-${randomUUID()}`, nameAr: 'صنف عشوائي', correlationId },
            deps,
          ),
        ).rejects.toBeInstanceOf(UnknownClientError);
      }),
      { seed: PROPERTY_SEED, numRuns: CROSS_CLIENT_COUNTERPART_NUM_RUNS },
    );
  });
});

// --- Scenario: invalid status or picking policy is rejected before the database -----------------

describe('Scenario: invalid status or picking policy is rejected before the database', () => {
  const internalCtx = { userId: ACTOR_FIXTURE_UUID, clientId: null, isInternal: true };

  it('registerSku with status "closed" (outside SKU_STATUSES) throws InvalidSkuInputError, no DB call was made', async () => {
    const correlationId = nextCorrelationId();
    const code = 'SKU-INVALID-STATUS-001';

    await expect(
      registerSku(
        internalCtx,
        {
          clientId: clientAId,
          code,
          nameAr: 'صنف حالة غير صالحة',
          // @ts-expect-error — deliberately outside SkuStatus, exactly what this test proves is rejected.
          status: 'closed',
          correlationId,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidSkuInputError);

    expect(await countSkuRows(clientAId, code)).toBe(0);
    expect(await countOutboxRows(correlationId)).toBe(0);
  });

  it('registerSku with pickingPolicy "LEFO" (outside PICKING_POLICIES) throws InvalidSkuInputError, no DB call was made', async () => {
    const correlationId = nextCorrelationId();
    const code = 'SKU-INVALID-PICKING-001';

    await expect(
      registerSku(
        internalCtx,
        {
          clientId: clientAId,
          code,
          nameAr: 'صنف سياسة غير صالحة',
          // @ts-expect-error — deliberately outside PickingPolicy, exactly what this test proves is rejected.
          pickingPolicy: 'LEFO',
          correlationId,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(InvalidSkuInputError);

    expect(await countSkuRows(clientAId, code)).toBe(0);
    expect(await countOutboxRows(correlationId)).toBe(0);
  });
});

// --- Scenario: the RLS policy itself rejects a cross-client insert under a genuine non-superuser role

describe('Scenario: the RLS policy itself rejects a cross-client insert under a genuine non-superuser role', () => {
  // pg-reviewer finding precedent, SCR-WMS-01 (2.8): PostgreSQL reserves the `pg_` role-name
  // prefix; `pgeos_t_` is this suite's own test-fixture-role prefix (never `pg_`).
  const roleName = `pgeos_t_2_6_proof_${randomUUID().replace(/-/g, '')}`;
  const rolePassword = randomUUID();
  let rolePool: Pool;
  // finding 1 (pg-reviewer, round 1): a client B row must exist BEFORE the SELECT-filtering test,
  // written by the superuser pool, or that test is vacuous (zero rows could mean "correctly
  // filtered" or "there was nothing to filter").
  let clientBControlSkuId: string;

  beforeAll(async () => {
    await pool.query(
      `create role ${roleName} login password '${rolePassword}' nosuperuser nobypassrls`,
    );
    await pool.query(`grant usage on schema wms to ${roleName}`);
    await pool.query(`grant select, insert on wms.skus to ${roleName}`);
    // OPEN QUESTION resolved (brief decision 11): confirmed directly against this schema (bare
    // psql insert, non-superuser role, no grant on sales.accounts) that Postgres's FK check for
    // wms.skus.client_id -> sales.accounts.id runs regardless of the referencing role's own SELECT
    // privilege on sales.accounts — no `grant select on sales.accounts` is needed here.

    const clientBControlResult: QueryResult<{ id: string }> = await pool.query(
      `insert into wms.skus (client_id, code, name_ar) values ($1, $2, $3) returning id`,
      [clientBId, 'SKU-RLS-CONTROL-CLIENT-B-001', 'صنف ضبط عميل ب — إثبات RLS'],
    );
    const clientBControlRow = clientBControlResult.rows[0];
    if (!clientBControlRow) throw new Error('fixture wms.skus insert (client B control) returned no row');
    clientBControlSkuId = clientBControlRow.id;
    fixtureSkuIds.push(clientBControlSkuId);

    rolePool = new Pool({
      host: process.env['PGHOST'] ?? 'localhost',
      port: Number(process.env['PGPORT'] ?? '5432'),
      user: roleName,
      password: rolePassword,
      database: process.env['PGDATABASE'] ?? 'pgeos',
      max: 2,
    });
  });

  afterAll(async () => {
    await rolePool.end();
    await pool.query(`revoke select, insert on wms.skus from ${roleName}`);
    await pool.query(`revoke usage on schema wms from ${roleName}`);
    await pool.query(`drop role ${roleName}`);
  });

  it('that role inserting a wms.skus row with client_id = client B fails with SQLSTATE 42501 (sku_client_scope), while a same-client A insert succeeds', async () => {
    const client = await rolePool.connect();
    try {
      await client.query(`select set_config('app.client_id', $1, false)`, [clientAId]);
      await client.query(`select set_config('app.is_internal', 'false', false)`);

      // finding 1 (pg-reviewer, round 1): a positive control on the SAME role connection and GUCs —
      // a same-client (A) insert must SUCCEED, proving the role/GUC/grant setup works at all, so the
      // cross-client rejection below is specifically sku_client_scope, not a missing privilege.
      const controlResult: QueryResult<{ id: string }> = await client.query(
        `insert into wms.skus (client_id, code, name_ar) values ($1, $2, $3) returning id`,
        [clientAId, 'SKU-RLS-PROOF-CONTROL-A-001', 'صنف ضبط عميل أ — إثبات RLS'],
      );
      const controlRow = controlResult.rows[0];
      expect(controlRow).toBeDefined();
      if (controlRow) fixtureSkuIds.push(controlRow.id);

      // finding 1 (pg-reviewer, round 1): match the SQLSTATE AND the error message against
      // /row-level security/ — SQLSTATE 42501 alone is also returned for other missing privileges
      // (e.g. EXECUTE revoked on platform.current_client_id()/is_internal()); the message is what
      // distinguishes "the RLS policy itself rejected this" from "some other privilege is missing".
      await expect(
        client.query(
          `insert into wms.skus (client_id, code, name_ar) values ($1, $2, $3)`,
          [clientBId, 'SKU-RLS-PROOF-001', 'صنف إثبات RLS'],
        ),
      ).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/row-level security/i) });
    } finally {
      client.release();
    }
  });

  it("that role selecting wms.skus rows sees the client-A row(s) but none belonging to client B", async () => {
    // finding 1 (pg-reviewer, round 1): confirm, via the superuser pool, that client B actually has
    // at least one wms.skus row before asserting the role's SELECT sees none of it — otherwise the
    // "sees none" assertion below would be vacuously true.
    const clientBRowCount: QueryResult<{ n: string }> = await pool.query(
      `select count(*)::text as n from wms.skus where client_id = $1`,
      [clientBId],
    );
    expect(Number(clientBRowCount.rows[0]?.n ?? '0')).toBeGreaterThan(0);

    const client = await rolePool.connect();
    try {
      await client.query(`select set_config('app.client_id', $1, false)`, [clientAId]);
      await client.query(`select set_config('app.is_internal', 'false', false)`);

      const clientARows: QueryResult<{ id: string }> = await client.query(
        `select id from wms.skus where client_id = $1`,
        [clientAId],
      );
      expect(clientARows.rows.length).toBeGreaterThan(0);

      const clientBRows: QueryResult<{ id: string }> = await client.query(
        `select id from wms.skus where client_id = $1`,
        [clientBId],
      );
      expect(clientBRows.rows).toEqual([]);
    } finally {
      client.release();
    }
  });
});
