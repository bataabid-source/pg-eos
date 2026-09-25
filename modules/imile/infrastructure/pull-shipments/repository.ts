// modules/imile/infrastructure/pull-shipments/repository.ts — WBS 3.14 (part 2).
//
// infrastructure/ layer: every DB statement for the pull-shipments use case, run against the `tx`
// a caller's own withIdempotentContext(ctx, idem, fn) already opened. Implements
// ../../application/pull-shipments/ports.ts's `ShipmentsRepository`.
//
// LOCK ORDER: `findShipmentByTrackingNo` takes NO row lock (plain SELECT, no FOR UPDATE) — two
// concurrent pull cycles racing on the same tracking_no both read the SAME pre-update version
// (brief, Scenario "Two concurrent pull cycles racing on the same shipment": "two pull cycles
// both read ... before either writes"). Whichever transaction's own `updateShipmentIMileFields`
// commits FIRST wins the row-level lock Postgres itself takes on UPDATE; the second transaction's
// UPDATE then blocks until the first commits, and its own `WHERE version=$2` no longer matches
// (the first transaction already bumped it) — zero rows returned, which the application layer
// turns into a thrown StaleVersionError. A `SELECT ... FOR UPDATE` here would defeat this: the
// second transaction's SELECT would block until the first committed, then read the ALREADY-BUMPED
// version and silently "succeed" against it — exactly the silent overwrite the scenario forbids.
//
// `insertAgentHealth` reuses the exact SQL shape
// ../../infrastructure/report-agent-health/repository.ts's own `insertAgentHealth` uses (brief:
// "same repository pattern as report-agent-health part 1") — kept as its own statement here
// (not imported) so this use case's own infrastructure never depends on another use case's own
// module (report-agent-health's own ports.ts: "do not import this file from another use case").
//
// `writeAuditRow` reuses the same doc 40 P3/P7 append-only platform.audit_log insert
// ../../infrastructure/report-agent-health/repository.ts's own `writeAuditRow` uses — same
// hash-chain mechanism (a DB trigger, trg_audit_hash_chain; this file never computes a hash
// itself), kept as its own statement here for the same reason `insertAgentHealth` is.

const SHIPMENTS_SCHEMA = 'imile';
const SHIPMENTS_TABLE_NAME = 'shipments';
const SHIPMENTS_TABLE = `${SHIPMENTS_SCHEMA}.${SHIPMENTS_TABLE_NAME}`;
const AGENT_HEALTH_TABLE = `${SHIPMENTS_SCHEMA}.agent_health`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  ExistingShipmentRow,
  InsertAgentHealthParams,
  InsertShipmentParams,
  InsertedAgentHealthRow,
  ShipmentsRepository,
  UpdateShipmentIMileFieldsParams,
} from '../../application/pull-shipments/ports.js';

async function findShipmentByTrackingNo(tx: NodePgDatabase, trackingNo: string): Promise<ExistingShipmentRow | null> {
  const result = await tx.execute<{
    id: string;
    version: number;
    merchant: string | null;
    zone_code: string | null;
    area: string | null;
    recipient_phone: string | null;
    is_cod: boolean | null;
    cod_amount: string | null;
    is_fresh: boolean | null;
    imile_status: string | null;
    raw: unknown;
    last_sync_at: string | null;
  }>(sql`
    select id, version, merchant, zone_code, area, recipient_phone, is_cod, cod_amount::text as cod_amount,
           is_fresh, imile_status, raw, last_sync_at
      from ${sql.raw(SHIPMENTS_TABLE)}
     where tracking_no = ${trackingNo}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    merchant: row.merchant,
    zoneCode: row.zone_code,
    area: row.area,
    recipientPhone: row.recipient_phone,
    isCod: row.is_cod,
    codAmount: row.cod_amount,
    isFresh: row.is_fresh,
    imileStatus: row.imile_status,
    raw: row.raw,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
  };
}

/** internal_status/station_code are never passed here — they stay at their table defaults
 *  ('expected' / 'CSP04'), untouched by this use case (brief, Contract line). */
async function insertShipment(tx: NodePgDatabase, params: InsertShipmentParams): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${sql.raw(SHIPMENTS_TABLE)}
      (tracking_no, merchant, zone_code, area, recipient_phone, is_cod, cod_amount, is_fresh,
       imile_status, raw, last_sync_at)
    values
      (${params.trackingNo}, ${params.merchant}, ${params.zoneCode}, ${params.area},
       ${params.recipientPhone}, ${params.isCod}, ${params.codAmount}::numeric, ${params.isFresh},
       ${params.imileStatus}, ${JSON.stringify(params.raw ?? null)}::jsonb,
       ${params.lastSyncAt.toISOString()}::timestamptz)
    returning id
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`insertShipment: insert into ${SHIPMENTS_TABLE} returned no row`);
  }
  return { id: row.id };
}

/** `WHERE id=$1 AND version=$2` (migration 0024) — never touches internal_status/cage_code/
 *  driver_code/delivery_task_id. Returns null when zero rows matched (stale version); the
 *  application layer turns that into a thrown StaleVersionError. */
async function updateShipmentIMileFields(
  tx: NodePgDatabase,
  params: UpdateShipmentIMileFieldsParams,
): Promise<{ readonly version: number } | null> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(SHIPMENTS_TABLE)}
       set merchant = ${params.merchant},
           zone_code = ${params.zoneCode},
           area = ${params.area},
           recipient_phone = ${params.recipientPhone},
           is_cod = ${params.isCod},
           cod_amount = ${params.codAmount}::numeric,
           is_fresh = ${params.isFresh},
           imile_status = ${params.imileStatus},
           raw = ${JSON.stringify(params.raw ?? null)}::jsonb,
           last_sync_at = ${params.lastSyncAt.toISOString()}::timestamptz,
           version = version + 1
     where id = ${params.id}::uuid and version = ${params.expectedVersion}
    returning version
  `);
  const row = result.rows[0];
  return row ? { version: row.version } : null;
}

/** append-only INSERT — same shape as
 *  ../../infrastructure/report-agent-health/repository.ts's own `insertAgentHealth`. */
async function insertAgentHealth(
  tx: NodePgDatabase,
  params: InsertAgentHealthParams,
): Promise<InsertedAgentHealthRow> {
  const result = await tx.execute<{ id: string; reported_at: string }>(sql`
    insert into ${sql.raw(AGENT_HEALTH_TABLE)}
      (agent_id, session_valid, last_pull_at, pending_pushes, engine_version, error_message, reported_at)
    values
      (${params.agentId}, ${params.sessionValid}, ${params.lastPullAt?.toISOString() ?? null}::timestamptz,
       ${params.pendingPushes}, ${params.engineVersion}, ${params.errorMessage},
       ${params.reportedAt.toISOString()}::timestamptz)
    returning id, reported_at
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`insertAgentHealth: insert into ${AGENT_HEALTH_TABLE} returned no row`);
  }
  return { id: row.id, reportedAt: new Date(row.reported_at) };
}

/** doc 40 P3/P7: one append-only audit_log row per write this use case makes — `entity_id` is
 *  always null (neither imile.shipments nor imile.agent_health carries one; brief §2). `oldValue`
 *  is passed straight through as-is (undefined on an insert, the pre-update before/after bag on an
 *  update) — the caller (../../application/pull-shipments/pull-shipments.ts) already narrows it to
 *  a genuine before/after of only the columns whose VALUE this update actually changed (its own
 *  `changedKeys`/`rawChanged`/`lastSyncAtChanged`), never every column the UPDATE statement
 *  happened to write and never the whole row. `changedFields`
 *  maps 1:1 to `platform.audit_log.changed_fields text[]` (database/schema/
 *  13B-Schema-Reference-Consolidation.sql — "الحقول المتغيّرة فقط"/"changed fields only") — left
 *  `null` on an insert (the whole row is new, not a diff). The hash chain itself
 *  (prev_hash/row_hash/chain_seq) is filled by the DB trigger trg_audit_hash_chain — this
 *  statement never computes it. */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly schemaName: string;
    readonly tableName: string;
    readonly recordId: string;
    readonly operation: string;
    readonly correlationId: string;
    readonly actorId: string;
    readonly oldValue?: unknown;
    readonly newValue: unknown;
    readonly changedFields?: readonly string[];
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       changed_fields, old_value, new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       null, ${params.schemaName}, ${params.tableName}, ${params.recordId}::uuid,
       ${params.operation},
       ${params.changedFields && params.changedFields.length > 0 ? sql.param(params.changedFields) : null}::text[],
       ${params.oldValue === undefined ? null : JSON.stringify(params.oldValue)}::jsonb,
       ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const shipmentsRepository: ShipmentsRepository = {
  findShipmentByTrackingNo,
  insertShipment,
  updateShipmentIMileFields,
  insertAgentHealth,
  writeAuditRow,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export { SHIPMENTS_SCHEMA, SHIPMENTS_TABLE_NAME, SHIPMENTS_TABLE };
