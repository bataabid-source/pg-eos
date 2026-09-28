// modules/billing/infrastructure/dimensions/repository.ts — WBS 4.1b PART 2 (lane 2).
//
// infrastructure/ layer: every DB statement for the dimensions use case, run against the `tx` a
// caller's own withContext(ctx, fn) already opened (entity_scope RLS applies). Implements
// ../../application/dimensions/ports.ts's `DimensionValueRepository`. Golden-slice shape
// (modules/wms/infrastructure/receive-inbound/repository.ts).
//
// LOCK ORDER (every command follows it): 0. the idempotency advisory lock (withIdempotentContext)
// when input.idem is set; 1. getValueForUpdate — `select ... for update` on the one value row (the
// caller compares version to expectedVersion here); 2. outbox insert, then updateValueStatus (the
// version bump on the row already locked), then writeAuditRow, last (ADR-0002).
//
// Grants (migration 0038, C4): pgeos_app may insert and update only (is_active, version) on
// billing.dimension_values — no statement here touches any other column after insert.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  DimensionValueRepository,
  DimensionValueRow,
  NewDimensionValue,
} from '../../application/dimensions/ports.js';
import { DimensionValueNotFoundError } from '../../domain/dimensions/errors.js';
import { DIMENSION_VALUE_STATUS, type DimensionValueStatus } from '../../domain/dimensions/machine.js';

const VALUE_SCHEMA = 'billing';
const VALUE_TABLE_NAME = 'dimension_values';
const VALUE_TABLE = `${VALUE_SCHEMA}.${VALUE_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

/** The is_active column value each machine status is stored as. */
const IS_ACTIVE_BY_STATUS: Readonly<Record<DimensionValueStatus, boolean>> = {
  [DIMENSION_VALUE_STATUS.ACTIVE]: true,
  [DIMENSION_VALUE_STATUS.INACTIVE]: false,
};

async function insertValue(
  tx: NodePgDatabase,
  value: NewDimensionValue,
): Promise<{ readonly id: string; readonly version: number }> {
  const result = await tx.execute<{ id: string; version: number }>(sql`
    insert into ${sql.raw(VALUE_TABLE)} (entity_id, dimension_type_id, code, name)
    values (${value.entityId}::uuid, ${value.dimensionTypeId}::uuid, ${value.code}, ${value.name})
    returning id, version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`insertValue: no ${VALUE_TABLE} row returned`);
  }
  return { id: row.id, version: row.version };
}

async function getValueForUpdate(tx: NodePgDatabase, dimensionValueId: string): Promise<DimensionValueRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    dimension_type_id: string;
    status: DimensionValueStatus;
    version: number;
  }>(sql`
    select id, entity_id, dimension_type_id,
           case when is_active then ${DIMENSION_VALUE_STATUS.ACTIVE} else ${DIMENSION_VALUE_STATUS.INACTIVE} end as status,
           version
      from ${sql.raw(VALUE_TABLE)} where id = ${dimensionValueId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new DimensionValueNotFoundError(
      `no ${VALUE_TABLE} row visible for id ${dimensionValueId} (Allowed: an existing value in the caller's entities)`,
      dimensionValueId,
    );
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    dimensionTypeId: row.dimension_type_id,
    status: row.status,
    version: row.version,
  };
}

async function updateValueStatus(
  tx: NodePgDatabase,
  dimensionValueId: string,
  status: DimensionValueStatus,
): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(VALUE_TABLE)}
       set is_active = ${IS_ACTIVE_BY_STATUS[status]}, version = version + 1
     where id = ${dimensionValueId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateValueStatus: no ${VALUE_TABLE} row for id ${dimensionValueId} (lock was already held)`);
  }
  return row.version;
}

async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly recordId: string;
    readonly operation: string;
    readonly correlationId: string;
    readonly actorId: string;
    readonly newValue: unknown;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${VALUE_SCHEMA}, ${VALUE_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const dimensionValueRepository: DimensionValueRepository = {
  insertValue,
  getValueForUpdate,
  updateValueStatus,
  writeAuditRow,
};
