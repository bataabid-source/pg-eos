// modules/wms/src/sku-registration/register-sku.ts — WBS 2.6 (pg-backend).
//
// registerSku — a pure INSERT mechanism (decision 1: registration only, no update command). Every
// DB access goes through withContext(ctx, fn) (@pg-eos/db, CLAUDE.md · ARCHITECTURE); SQL via
// drizzle `sql` tags on tx.execute (the 0.12/0.17/2.8 style), naming every column explicitly in
// the INSERT (decision 3 — never a dynamic column list; unitsPerPallet is never in that list, it
// is a generated column).
//
// decision 9: NO outbox event is written in this slice (G-01 open item — wms.skus has no
// entity_id column and platform.outbox's outbox_business_needs_entity check requires one for any
// non-platform/identity aggregate). Only the platform.audit_log row is written, in the SAME
// transaction as the insert.

import { withContext, type WithContextCtx } from '@pg-eos/db';
import type { Clock } from '@pg-eos/domain-kit';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { validateSkuInput, type RegisterSkuInput } from './domain.js';
import { CrossClientSkuError, DuplicateSkuCodeError, UnknownClientError } from './errors.js';

// decision 6/7: SQLSTATEs and the exact, live-verified constraint names on wms.skus (brief "Read
// ONLY" — never a guessed Postgres auto-generated name).
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const FOREIGN_KEY_VIOLATION_SQLSTATE = '23503';
const SKUS_CLIENT_ID_CODE_UNIQUE_CONSTRAINT = 'skus_client_id_code_key';
const SKUS_CLIENT_ID_FKEY_CONSTRAINT = 'skus_client_id_fkey';

// decision 9: literal schema/table/operation for the audit_log row this mechanism writes.
const AUDIT_SCHEMA_NAME = 'wms';
const AUDIT_TABLE_NAME = 'skus';
const AUDIT_OPERATION_INSERT = 'insert';
const AUDIT_ACTOR_TYPE_USER = 'user';
const AUDIT_ACTOR_TYPE_SYSTEM = 'system';

// decision 3: DDL-literal defaults applied explicitly by the mechanism when a field is omitted —
// never left to a dynamic column list.
const DEFAULT_STACKABLE = true;
const DEFAULT_IS_FRAGILE = false;
const DEFAULT_IS_HAZMAT = false;
const DEFAULT_LIGHT_SENSITIVE = false;
const DEFAULT_TRACK_BATCH = false;
const DEFAULT_TRACK_SERIAL = false;
const DEFAULT_TRACK_EXPIRY = false;
const DEFAULT_PICKING_POLICY = 'FIFO';
const DEFAULT_QUARANTINE_DAYS = 0;
const DEFAULT_STATUS = 'active';

export interface RegisterSkuDeps {
  readonly clock: Clock;
}

export interface RegisterSkuCommandInput extends RegisterSkuInput {
  readonly correlationId: string;
}

export interface RegisteredSku {
  readonly skuId: string;
  readonly correlationId: string;
}

/**
 * True only for wms.skus's `skus_client_id_code_key` unique violation. The whole `cause` chain is
 * walked (drizzle wraps the failing query in its own error, carrying pg's DatabaseError — which
 * holds the SQLSTATE and constraint name — as `cause`), bounded by `seen` against a cyclic chain.
 * Same pattern as modules/wms/src/stock-ledger/post-movement.ts's isNegativeStockViolation.
 */
function isDuplicateSkuCode(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    const constraint = 'constraint' in current ? current.constraint : undefined;
    if (code === UNIQUE_VIOLATION_SQLSTATE && constraint === SKUS_CLIENT_ID_CODE_UNIQUE_CONSTRAINT) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

/** True only for wms.skus's `skus_client_id_fkey` foreign-key violation. Same walk as above. */
function isUnknownClient(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    const constraint = 'constraint' in current ? current.constraint : undefined;
    if (code === FOREIGN_KEY_VIOLATION_SQLSTATE && constraint === SKUS_CLIENT_ID_FKEY_CONSTRAINT) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

async function insertSkuRow(
  tx: NodePgDatabase,
  input: RegisterSkuInput,
): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ readonly id: string }>(sql`
    insert into wms.skus
      (client_id, code, client_sku, barcode, carton_barcode, name_ar, name_en, category,
       subcategory, brand, origin_country, length_cm, width_cm, height_cm, net_weight_kg,
       gross_weight_kg, volume_cbm, units_per_pack, packs_per_carton, cartons_per_layer,
       layers_per_pallet, temp_min, temp_max, stackable, max_stack_height, is_fragile, is_hazmat,
       un_class, light_sensitive, track_batch, track_serial, track_expiry, picking_policy,
       shelf_life_days, min_remaining_life_receipt_days, min_remaining_life_issue_days,
       quarantine_days, min_stock, max_stock, reorder_point, abc_class, unit_value, image_url,
       msds_url, status)
    values
      (${input.clientId}::uuid, ${input.code}, ${input.clientSku ?? null}, ${input.barcode ?? null},
       ${input.cartonBarcode ?? null}, ${input.nameAr}, ${input.nameEn ?? null},
       ${input.category ?? null}, ${input.subcategory ?? null}, ${input.brand ?? null},
       ${input.originCountry ?? null}, ${input.lengthCm ?? null}, ${input.widthCm ?? null},
       ${input.heightCm ?? null}, ${input.netWeightKg ?? null}, ${input.grossWeightKg ?? null},
       ${input.volumeCbm ?? null}, ${input.unitsPerPack ?? null}, ${input.packsPerCarton ?? null},
       ${input.cartonsPerLayer ?? null}, ${input.layersPerPallet ?? null}, ${input.tempMin ?? null},
       ${input.tempMax ?? null}, ${input.stackable ?? DEFAULT_STACKABLE},
       ${input.maxStackHeight ?? null}, ${input.isFragile ?? DEFAULT_IS_FRAGILE},
       ${input.isHazmat ?? DEFAULT_IS_HAZMAT}, ${input.unClass ?? null},
       ${input.lightSensitive ?? DEFAULT_LIGHT_SENSITIVE}, ${input.trackBatch ?? DEFAULT_TRACK_BATCH},
       ${input.trackSerial ?? DEFAULT_TRACK_SERIAL}, ${input.trackExpiry ?? DEFAULT_TRACK_EXPIRY},
       ${input.pickingPolicy ?? DEFAULT_PICKING_POLICY}, ${input.shelfLifeDays ?? null},
       ${input.minRemainingLifeReceiptDays ?? null}, ${input.minRemainingLifeIssueDays ?? null},
       ${input.quarantineDays ?? DEFAULT_QUARANTINE_DAYS}, ${input.minStock ?? null},
       ${input.maxStock ?? null}, ${input.reorderPoint ?? null}, ${input.abcClass ?? null},
       ${input.unitValue ?? null}, ${input.imageUrl ?? null}, ${input.msdsUrl ?? null},
       ${input.status ?? DEFAULT_STATUS})
    returning id
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error('insert into wms.skus returned no row');
  }
  return row;
}

/** decision 9: the single platform.audit_log row this mechanism writes — no outbox row. */
async function writeSkuAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly skuId: string;
    readonly occurredAt: Date;
    readonly correlationId: string;
    readonly actorId: string | null;
    readonly newValue: RegisterSkuInput;
  },
): Promise<void> {
  const actorType = params.actorId === null ? AUDIT_ACTOR_TYPE_SYSTEM : AUDIT_ACTOR_TYPE_USER;
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${actorType}, null,
       ${AUDIT_SCHEMA_NAME}, ${AUDIT_TABLE_NAME}, ${params.skuId}::uuid, ${AUDIT_OPERATION_INSERT},
       ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

/**
 * decision 1: a pure INSERT mechanism, registration only. decision 4: validateSkuInput runs before
 * withContext is even opened — no DB call for a rejected input. decision 5: CrossClientSkuError is
 * thrown by registerSku itself, also before withContext is opened, when a portal caller
 * (!ctx.isInternal) attempts to register a SKU under a clientId other than its own.
 */
export async function registerSku(
  ctx: WithContextCtx,
  input: RegisterSkuCommandInput,
  deps: RegisterSkuDeps,
): Promise<RegisteredSku> {
  const { correlationId, ...skuInput } = input;
  const validated = validateSkuInput(skuInput);

  if (!ctx.isInternal && ctx.clientId !== input.clientId) {
    throw new CrossClientSkuError(
      `portal caller (clientId=${JSON.stringify(ctx.clientId)}) may not register a SKU for a ` +
        `different clientId (${JSON.stringify(input.clientId)}) (decision 5, INV-C3-3). ` +
        `Allowed: a portal caller registers only under its own clientId (${JSON.stringify(ctx.clientId)}).`,
    );
  }

  return withContext(ctx, async (tx) => {
    let row: { readonly id: string };
    try {
      row = await insertSkuRow(tx, validated);
    } catch (error) {
      if (isDuplicateSkuCode(error)) {
        throw new DuplicateSkuCodeError(
          `a wms.skus row for (client_id=${input.clientId}, code=${JSON.stringify(input.code)}) ` +
            `already exists (01-Data-Model.sql skus_client_id_code_key). Allowed: a unique ` +
            `(client_id, code) pair.`,
          { cause: error },
        );
      }
      if (isUnknownClient(error)) {
        throw new UnknownClientError(
          `clientId ${JSON.stringify(input.clientId)} does not reference an existing ` +
            `sales.accounts row (01-Data-Model.sql skus_client_id_fkey). Allowed: the id of an ` +
            `existing sales.accounts row.`,
          { cause: error },
        );
      }
      throw error;
    }

    const occurredAt = deps.clock.now();
    await writeSkuAuditRow(tx, {
      skuId: row.id,
      occurredAt,
      correlationId,
      actorId: ctx.userId,
      newValue: validated,
    });

    return { skuId: row.id, correlationId };
  });
}
