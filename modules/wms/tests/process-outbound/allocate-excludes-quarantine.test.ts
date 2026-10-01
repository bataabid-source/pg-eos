// modules/wms/tests/process-outbound/allocate-excludes-quarantine.test.ts — WBS 2.9 part 3 step 2
// (pg-tester, RED-first). Decision 4b of _slice-2.9-p3-s2-qrt-quarantine.brief.md: a lot whose
// balance sits on a quarantine-zone location is never a FEFO allocation candidate
// (outboundOrderRepository.getCandidateLots joins wms.zones and excludes zone_type 'quarantine').

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withContext } from '@pg-eos/db';
import { FixedClock, Quantity, SequentialIdGenerator } from '@pg-eos/domain-kit';

import { postMovement, type LedgerDeps } from '../../index.js';
import { outboundOrderRepository } from '../../infrastructure/process-outbound/repository.js';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 5,
});

const ACTOR_UUID = '5a1e0b0c-0000-4000-8000-00000000e301';
const CLIENT_UUID = '5a1e0b0c-0000-4000-8000-00000000e302';
const SKU_UUID = '5a1e0b0c-0000-4000-8000-00000000e303';
const ctx = { userId: ACTOR_UUID, clientId: null, isInternal: true };
const ledgerDeps: LedgerDeps = {
  clock: new FixedClock(new Date('2026-09-29T00:00:00.000Z')),
  ids: new SequentialIdGenerator(2130),
};

const QRT_BATCH = 'ALLOC-QRT';
const STORAGE_BATCH = 'ALLOC-STO';
// The quarantined lot expires EARLIER, so plain FEFO would rank it first if it were not excluded.
const QRT_EXPIRY = '2027-01-01';
const STORAGE_EXPIRY = '2027-06-01';
const QTY = '10.000';
const UOM = 'EA';
const PICKING_POLICY_FEFO = 'FEFO';
const SKU_GROSS_WEIGHT_KG = '0.100';
const SKU_VOLUME_CBM = '0.001';

let entityId: string;
let warehouseId: string;
let qrtLocationId: string;
let storageLocationId: string;
const correlationIds: string[] = [];

async function receiveTo(locationId: string, batchNo: string, expiryDate: string): Promise<void> {
  const correlationId = randomUUID();
  correlationIds.push(correlationId);
  await postMovement(
    ctx,
    {
      entityId,
      entry: {
        clientId: CLIENT_UUID,
        skuId: SKU_UUID,
        fromLocationId: null,
        toLocationId: locationId,
        qty: Quantity.of(QTY),
        batchNo,
        movementType: 'receipt',
        uom: UOM,
      },
      correlationId,
      performedBy: ACTOR_UUID,
      expiryDate,
    },
    ledgerDeps,
  );
}

beforeAll(async () => {
  const entity: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities where code = 'PST'`);
  entityId = (entity.rows[0] as { id: string }).id;
  const wh: QueryResult<{ id: string }> = await pool.query(`select id from wms.warehouses where code = 'WH1'`);
  warehouseId = (wh.rows[0] as { id: string }).id;

  await pool.query(
    `insert into identity.users (id, email, full_name_ar, user_type) values ($1, $2, $3, 'internal')`,
    [ACTOR_UUID, `_alloc_qrt_fixture_actor_${randomUUID()}@test.invalid`, 'ممثل اختبار تخصيص الحجر — WBS 2.9'],
  );
  const entities: QueryResult<{ id: string }> = await pool.query(`select id from platform.entities`);
  for (const row of entities.rows) {
    await pool.query(`insert into identity.user_entities (user_id, entity_id) values ($1, $2)`, [ACTOR_UUID, row.id]);
  }
  await pool.query(
    `insert into sales.accounts (id, code, name_ar, account_type) values ($1, $2, $3, 'client')`,
    [CLIENT_UUID, `_alloc_qrt_fixture_${randomUUID()}`, 'عميل اختبار تخصيص الحجر — WBS 2.9'],
  );
  await pool.query(
    `insert into wms.skus (id, client_id, code, name_ar, gross_weight_kg, volume_cbm, picking_policy)
     values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7)`,
    [SKU_UUID, CLIENT_UUID, `ALLOC-QRT-SKU-${randomUUID()}`, 'صنف اختبار تخصيص الحجر', SKU_GROSS_WEIGHT_KG, SKU_VOLUME_CBM, PICKING_POLICY_FEFO],
  );

  const qrt: QueryResult<{ id: string }> = await pool.query(
    `select l.id from wms.locations l join wms.zones z on z.id = l.zone_id
      where l.warehouse_id = $1 and z.zone_type = 'quarantine' and l.location_type = 'operational' and l.is_blocked = false
      order by l.code limit 1`,
    [warehouseId],
  );
  const qrtRow = qrt.rows[0];
  if (!qrtRow) throw new Error('no unblocked operational location in a quarantine zone of WH1 (seed 019:290)');
  qrtLocationId = qrtRow.id;
  const storage: QueryResult<{ id: string }> = await pool.query(
    `select l.id from wms.locations l join wms.zones z on z.id = l.zone_id
      where l.warehouse_id = $1 and z.zone_type = 'storage' and l.is_blocked = false
      order by l.code limit 1`,
    [warehouseId],
  );
  const storageRow = storage.rows[0];
  if (!storageRow) throw new Error('no unblocked storage location in WH1');
  storageLocationId = storageRow.id;

  await receiveTo(qrtLocationId, QRT_BATCH, QRT_EXPIRY);
  await receiveTo(storageLocationId, STORAGE_BATCH, STORAGE_EXPIRY);
});

afterAll(async () => {
  await pool.query(`delete from wms.stock_balance where client_id = $1`, [CLIENT_UUID]);
  await pool.query(`delete from wms.stock_movements where client_id = $1`, [CLIENT_UUID]);
  if (correlationIds.length > 0) {
    await pool.query(`delete from platform.outbox where correlation_id = any($1::uuid[])`, [correlationIds]);
  }
  await pool.query(`delete from wms.skus where id = $1`, [SKU_UUID]);
  await pool.query(`delete from sales.accounts where id = $1`, [CLIENT_UUID]);
  await pool.query(`delete from identity.user_entities where user_id = $1`, [ACTOR_UUID]);
  await pool.query(`delete from identity.users where id = $1`, [ACTOR_UUID]);
  await pool.end();
});

describe('Scenario: a lot held on a quarantine-zone location is never an outbound allocation candidate', () => {
  it('getCandidateLots (FEFO) returns the storage lot and not the earlier-expiring quarantined lot', async () => {
    const lots = await withContext(ctx, (tx) =>
      outboundOrderRepository.getCandidateLots(tx, {
        clientId: CLIENT_UUID,
        skuId: SKU_UUID,
        warehouseId,
        pickingPolicy: PICKING_POLICY_FEFO,
      }),
    );
    expect(lots.map((l) => l.batchNo)).toEqual([STORAGE_BATCH]);
    expect(lots.map((l) => l.locationId)).not.toContain(qrtLocationId);
    expect(lots.map((l) => l.locationId)).toContain(storageLocationId);
  });
});
