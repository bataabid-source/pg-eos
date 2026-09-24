// modules/platform/infrastructure/maintain-site/repository.ts — WBS 5.5a part 1 (lane 2).
//
// infrastructure/ layer: every DB statement for the maintain-site use case, run against the `tx`
// a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/maintain-site/ports.ts's `SiteRepository`.
//
// LOCK ORDER — the one every command follows, same discipline as the hr/register-employee
// precedent (../../../hr/infrastructure/register-employee/repository.ts):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's own
//      input carries an `idem` (every write command in this use case).
//   1. getSiteForUpdate — `select ... for update` on the ONE aggregate row, UpdateSite only.
//      CreateSite never takes this lock: it only inserts a fresh row (nothing to lock yet).
//   2. no other row lock this use case needs (no counters, no ledger).
//   3. the INSERT/UPDATE, then the outbox insert, then writeAuditRow, last (ADR-0002).
//
// brief D5: insertSite's own INSERT statement omits the `radius_m` column entirely when the
// caller supplied none, so `platform.att_geofence_radius_m()` (migration 0015's column default)
// fires — never a literal 500 in application code (CLAUDE.md · AGENT CONSTRAINTS "No magic
// numbers"). Two literal INSERT statements (radius_m present / absent) rather than a
// hand-assembled dynamic column list, same decision the wms sku-registration precedent
// (modules/wms/src/sku-registration/register-sku.ts) took against dynamic column lists in
// general — this is the one exception the brief calls for, kept to exactly one column.
//
// updateSite uses `coalesce($new, current)` per column — an omitted field (undefined) keeps the
// row's current value; isActive/geoLat/geoLng use an explicit `::boolean`/`::numeric` cast so a
// SQL NULL parameter (the caller passing an explicit null through JSON is not part of this
// contract — every optional field is `T | undefined`, never `T | null`) never ambiguously binds.

const SITE_SCHEMA = 'platform'; // REPLACE-ON-COPY: the module schema.
const SITE_TABLE_NAME = 'sites'; // REPLACE-ON-COPY: the aggregate table.
const SITE_TABLE = `${SITE_SCHEMA}.${SITE_TABLE_NAME}`; // dotted, so sed-rename catches both halves.
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { SiteNotFoundError, EntityScopeAmbiguousError } from '../../domain/maintain-site/errors.js';
import type {
  InsertSiteColumns,
  InsertedSite,
  SiteRepository,
  SiteRow,
  UpdateSiteColumns,
} from '../../application/maintain-site/ports.js';

async function getSiteForUpdate(tx: NodePgDatabase, siteId: string): Promise<SiteRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    version: number;
    is_active: boolean;
    kind: string;
    account_id: string | null;
  }>(sql`
    select id, entity_id, version, is_active, kind, account_id
      from ${sql.raw(SITE_TABLE)} where id = ${siteId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new SiteNotFoundError(
      `no ${SITE_TABLE} row visible for id ${siteId} (Allowed: an existing site in the caller's entities)`,
    );
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    version: row.version,
    isActive: row.is_active,
    kind: row.kind,
    accountId: row.account_id,
  };
}

async function insertSite(tx: NodePgDatabase, columns: InsertSiteColumns): Promise<InsertedSite> {
  const result =
    columns.radiusM === undefined
      ? await tx.execute<{ id: string; version: number; radius_m: string }>(sql`
          insert into ${sql.raw(SITE_TABLE)}
            (entity_id, kind, account_id, warehouse_id, name_ar, name_en, address, geo_lat, geo_lng,
             contact_phone)
          values
            (${columns.entityId}::uuid, ${columns.kind}, ${columns.accountId}::uuid, ${columns.warehouseId}::uuid,
             ${columns.nameAr}, ${columns.nameEn}, ${columns.address}, ${columns.geoLat}::numeric,
             ${columns.geoLng}::numeric, ${columns.contactPhone})
          returning id, version, radius_m::text as radius_m
        `)
      : await tx.execute<{ id: string; version: number; radius_m: string }>(sql`
          insert into ${sql.raw(SITE_TABLE)}
            (entity_id, kind, account_id, warehouse_id, name_ar, name_en, address, geo_lat, geo_lng,
             radius_m, contact_phone)
          values
            (${columns.entityId}::uuid, ${columns.kind}, ${columns.accountId}::uuid, ${columns.warehouseId}::uuid,
             ${columns.nameAr}, ${columns.nameEn}, ${columns.address}, ${columns.geoLat}::numeric,
             ${columns.geoLng}::numeric, ${columns.radiusM}::numeric, ${columns.contactPhone})
          returning id, version, radius_m::text as radius_m
        `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${SITE_TABLE} returned no row`);
  return { id: row.id, version: row.version, radiusM: Number(row.radius_m) };
}

async function updateSite(
  tx: NodePgDatabase,
  siteId: string,
  columns: UpdateSiteColumns,
): Promise<{ readonly version: number }> {
  // drizzle's `sql` template omits the placeholder entirely for a JS `undefined` parameter
  // (producing an empty `coalesce(, col)` — a syntax error), rather than binding SQL NULL — so
  // every optional column here is normalised to `null` first; `coalesce` then keeps the row's
  // current value exactly the same as it would for an omitted key.
  const kind = columns.kind ?? null;
  const accountId = columns.accountId ?? null;
  const warehouseId = columns.warehouseId ?? null;
  const nameAr = columns.nameAr ?? null;
  const nameEn = columns.nameEn ?? null;
  const address = columns.address ?? null;
  const geoLat = columns.geoLat ?? null;
  const geoLng = columns.geoLng ?? null;
  const radiusM = columns.radiusM ?? null;
  const contactPhone = columns.contactPhone ?? null;
  const isActive = columns.isActive ?? null;

  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(SITE_TABLE)}
       set kind          = coalesce(${kind}, kind),
           account_id    = coalesce(${accountId}::uuid, account_id),
           warehouse_id  = coalesce(${warehouseId}::uuid, warehouse_id),
           name_ar       = coalesce(${nameAr}, name_ar),
           name_en       = coalesce(${nameEn}, name_en),
           address       = coalesce(${address}, address),
           geo_lat       = coalesce(${geoLat}::numeric, geo_lat),
           geo_lng       = coalesce(${geoLng}::numeric, geo_lng),
           radius_m      = coalesce(${radiusM}::numeric, radius_m),
           contact_phone = coalesce(${contactPhone}, contact_phone),
           is_active     = coalesce(${isActive}::boolean, is_active),
           version       = version + 1
     where id = ${siteId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateSite: no ${SITE_TABLE} row for id ${siteId} (lock was already held)`);
  }
  return { version: row.version };
}

async function hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roleCodes.some((roleCode) => roles.includes(roleCode));
}

/** brief D6: "entity_id = ctx.entityId (never caller-supplied)". WithContextCtx carries no
 *  `entityId` field, so the caller's own entity is resolved from the session's own identity, via
 *  `platform.allowed_entities()` (01-Data-Model.sql:327, `security definer`, scoped to
 *  `platform.current_user_id()`), never trusted from the request body. Fails closed:
 *  cardinality(platform.allowed_entities()) = 1 -> use it; otherwise (zero, or more than one)
 *  throw EntityScopeAmbiguousError BEFORE any write — never guess by picking `[1]`. */
async function resolveCallerEntityId(tx: NodePgDatabase): Promise<string> {
  const result = await tx.execute<{ entity_id: string; entity_count: number }>(sql`
    select (platform.allowed_entities())[1] as entity_id, array_length(platform.allowed_entities(), 1) as entity_count
  `);
  const row = result.rows[0];
  const entityCount = row?.entity_count ?? 0;
  if (entityCount !== 1) {
    throw new EntityScopeAmbiguousError(
      `platform.allowed_entities() returned ${entityCount} entities for the caller, not exactly one ` +
        `(brief D6). (Allowed: a caller scoped to exactly one entity)`,
    );
  }
  const entityId = row?.entity_id;
  if (!entityId) {
    throw new EntityScopeAmbiguousError(
      `platform.allowed_entities() returned no entity for the caller. (Allowed: a caller scoped to exactly one entity)`,
    );
  }
  return entityId;
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the outbox row the
 *  same call writes (G9). `occurredAt` is mandatory (always from the injected Clock, never the
 *  column's own `default now()`). */
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
       ${params.entityId}::uuid, ${SITE_SCHEMA}, ${SITE_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const siteRepository: SiteRepository = {
  getSiteForUpdate,
  insertSite,
  updateSite,
  hasAnyRole,
  resolveCallerEntityId,
  writeAuditRow,
};

// REPLACE-ON-COPY: the module-schema-qualified constants a later slice's copy must change.
export { SITE_SCHEMA, SITE_TABLE_NAME, SITE_TABLE };
