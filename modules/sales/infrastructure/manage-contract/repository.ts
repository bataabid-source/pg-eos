// modules/sales/infrastructure/manage-contract/repository.ts — WBS 1.7, M02 sales.
//
// infrastructure/ layer: every DB statement for the manage-contract use case, run against the `tx`
// a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/manage-contract/ports.ts's `ContractRepository`.
//
// LOCK ORDER — the one every command follows (each command's own header points here):
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's own
//      input carries an `idem` (every write command in this use case except the read-only
//      getContractForOrder).
//   1. getContractForUpdate — `select ... for update` on the ONE aggregate row (every command
//      except CreateContract, which takes no lock — a fresh insert). Held for the rest of the
//      transaction; the caller compares its own version to expectedVersion here.
//   2. role gate, business invariants, price-list reads — no further row lock.
//   3. writes: insertContractSla (no version bump — Master decision 9), then updateContract (the
//      version bump, on the row already locked in step 1 — no new lock), then writeAuditRow, last
//      (ADR-0002 — no row lock may be taken after the audit-chain discipline).

const SALES_SCHEMA = 'sales';
const CONTRACT_TABLE_NAME = 'contracts';
const CONTRACT_TABLE = `${SALES_SCHEMA}.${CONTRACT_TABLE_NAME}`;
const CONTRACT_SLA_TABLE_NAME = 'contract_sla';
const CONTRACT_SLA_TABLE = `${SALES_SCHEMA}.${CONTRACT_SLA_TABLE_NAME}`;
const ACCOUNT_TABLE = `${SALES_SCHEMA}.accounts`;
const CATALOG_SCHEMA = 'catalog';
const PRICE_LIST_TABLE = `${CATALOG_SCHEMA}.price_lists`;
const DOC_TYPE_CONTRACT = 'CTR';
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
const AUDIT_TABLE_BY_TARGET = { contract: CONTRACT_TABLE_NAME, sla: CONTRACT_SLA_TABLE_NAME } as const;

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { ContractNotFoundError } from '../../domain/manage-contract/errors.js';
import type { ContractStatus } from '../../domain/manage-contract/machine.js';
import type {
  AccountRow,
  ContractForOrderRow,
  ContractRepository,
  ContractRow,
  ContractUpdateColumns,
  InsertContractParams,
  InsertContractSlaParams,
  PriceListRow,
  WriteAuditRowParams,
} from '../../application/manage-contract/ports.js';

async function hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roles.includes(roleCode);
}

async function getAccountById(tx: NodePgDatabase, accountId: string): Promise<AccountRow | null> {
  const result = await tx.execute<{ id: string; status: string; cr_number: string | null }>(sql`
    select id, status, cr_number from ${sql.raw(ACCOUNT_TABLE)} where id = ${accountId}::uuid and deleted_at is null
  `);
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, crNumber: row.cr_number } : null;
}

async function getPriceListById(tx: NodePgDatabase, priceListId: string): Promise<PriceListRow | null> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    client_id: string | null;
    segment_id: string | null;
    is_internal: boolean;
    status: string;
  }>(sql`
    select id, entity_id, client_id, segment_id, is_internal, status
      from ${sql.raw(PRICE_LIST_TABLE)} where id = ${priceListId}::uuid
  `);
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        entityId: row.entity_id,
        clientId: row.client_id,
        segmentId: row.segment_id,
        isInternal: row.is_internal,
        status: row.status,
      }
    : null;
}

/** pg-reviewer fix round 1, finding 3: `null` when no row is visible — the caller's
 *  assertPriceListApplicable treats that as "no segment to match" (segment_id is null on the
 *  price list still matches). */
async function getAccountSegmentId(tx: NodePgDatabase, accountId: string): Promise<string | null> {
  const result = await tx.execute<{ segment_id: string | null }>(sql`
    select segment_id from ${sql.raw(ACCOUNT_TABLE)} where id = ${accountId}::uuid and deleted_at is null
  `);
  return result.rows[0]?.segment_id ?? null;
}

async function insertContract(
  tx: NodePgDatabase,
  params: InsertContractParams,
): Promise<{ readonly id: string; readonly docNo: string; readonly version: number }> {
  const docNoResult = await tx.execute<{ doc_no: string }>(
    sql`select platform.next_doc_no(${params.entityId}::uuid, ${DOC_TYPE_CONTRACT}) as doc_no`,
  );
  const docNoRow = docNoResult.rows[0];
  if (!docNoRow) throw new Error(`platform.next_doc_no returned no row for entity ${params.entityId} / doc type ${DOC_TYPE_CONTRACT}`);
  const docNo = docNoRow.doc_no;

  const result = await tx.execute<{ id: string; version: number }>(sql`
    insert into ${sql.raw(CONTRACT_TABLE)}
      (entity_id, doc_no, account_id, quote_id, title, start_date, end_date, billing_cycle,
       payment_terms_days, auto_renew, notice_days, min_monthly_charge, sla_enabled,
       bills_failed_attempt, bills_return, bills_waiting, bills_reschedule, bills_partial_delivery)
    values
      (${params.entityId}::uuid, ${docNo}, ${params.accountId}::uuid, ${params.quoteId}::uuid, ${params.title},
       ${params.startDate}::date, ${params.endDate}::date, ${params.billingCycle}, ${params.paymentTermsDays},
       ${params.autoRenew}, ${params.noticeDays}, ${params.minMonthlyCharge}::numeric, ${params.slaEnabled},
       ${params.billsFailedAttempt}, ${params.billsReturn}, ${params.billsWaiting}, ${params.billsReschedule},
       ${params.billsPartialDelivery})
    returning id, version
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${CONTRACT_TABLE} returned no row`);
  return { id: row.id, docNo, version: row.version };
}

async function getContractForUpdate(tx: NodePgDatabase, contractId: string): Promise<ContractRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    doc_no: string;
    account_id: string;
    quote_id: string | null;
    title: string;
    status: string;
    start_date: string;
    end_date: string | null;
    price_list_id: string | null;
    sla_enabled: boolean;
    signed_at: Date | null;
    version: number;
  }>(sql`
    select id, entity_id, doc_no, account_id, quote_id, title, status, start_date::text as start_date,
           end_date::text as end_date, price_list_id, sla_enabled, signed_at, version
      from ${sql.raw(CONTRACT_TABLE)} where id = ${contractId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new ContractNotFoundError(
      `no ${CONTRACT_TABLE} row visible for id ${contractId} (Allowed: an existing contract in the caller's entities).`,
    );
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    docNo: row.doc_no,
    accountId: row.account_id,
    quoteId: row.quote_id,
    title: row.title,
    status: row.status as ContractStatus,
    startDate: row.start_date,
    endDate: row.end_date,
    priceListId: row.price_list_id,
    slaEnabled: row.sla_enabled,
    signedAt: row.signed_at,
    version: row.version,
  };
}

async function updateContract(tx: NodePgDatabase, contractId: string, columns: ContractUpdateColumns): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(CONTRACT_TABLE)}
       set version = version + 1,
           status = coalesce(${columns.status ?? null}, status),
           price_list_id = coalesce(${columns.priceListId ?? null}::uuid, price_list_id),
           signed_at = coalesce(${columns.signedAt?.toISOString() ?? null}::timestamptz, signed_at),
           signed_by_client = coalesce(${columns.signedByClient ?? null}, signed_by_client)
     where id = ${contractId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateContract: no ${CONTRACT_TABLE} row for id ${contractId} (lock was already held)`);
  }
  return row.version;
}

async function insertContractSla(tx: NodePgDatabase, params: InsertContractSlaParams): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into ${sql.raw(CONTRACT_SLA_TABLE)}
      (contract_id, metric, target_value, direction, penalty_type, penalty_value, bonus_value)
    values
      (${params.contractId}::uuid, ${params.metric}, ${params.targetValue}::numeric, ${params.direction},
       ${params.penaltyType}, ${params.penaltyValue}::numeric, ${params.bonusValue}::numeric)
    returning id
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insert into ${CONTRACT_SLA_TABLE} returned no row`);
  return { id: row.id };
}

async function findContractForAccountEntity(
  tx: NodePgDatabase,
  params: { readonly accountId: string; readonly entityId: string; readonly asOfDate: string },
): Promise<ContractForOrderRow | null> {
  const result = await tx.execute<{
    id: string;
    status: string;
    price_list_id: string | null;
    end_date: string | null;
  }>(sql`
    select id, status, price_list_id, end_date::text as end_date
      from ${sql.raw(CONTRACT_TABLE)}
     where account_id = ${params.accountId}::uuid and entity_id = ${params.entityId}::uuid
       and start_date <= ${params.asOfDate}::date
     order by start_date desc, id desc
     limit 1
  `);
  const row = result.rows[0];
  return row
    ? { contractId: row.id, status: row.status as ContractStatus, priceListId: row.price_list_id, endDate: row.end_date }
    : null;
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with any outbox row the same
 *  call writes (G9). `occurredAt` is mandatory (always from the injected Clock, never the
 *  column's own `default now()`). */
async function writeAuditRow(tx: NodePgDatabase, params: WriteAuditRowParams): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${SALES_SCHEMA}, ${AUDIT_TABLE_BY_TARGET[params.target]},
       ${params.recordId}::uuid, ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb,
       ${params.correlationId}::uuid)
  `);
}

export const contractRepository: ContractRepository = {
  hasRole,
  getAccountById,
  getAccountSegmentId,
  getPriceListById,
  insertContract,
  getContractForUpdate,
  updateContract,
  insertContractSla,
  findContractForAccountEntity,
  writeAuditRow,
};

// exported for a later slice's own reference (REPLACE-ON-COPY pattern the golden slice sets).
export { SALES_SCHEMA, CONTRACT_TABLE_NAME, CONTRACT_TABLE, CONTRACT_SLA_TABLE_NAME, CONTRACT_SLA_TABLE };
