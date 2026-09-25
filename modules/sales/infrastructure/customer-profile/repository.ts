// modules/sales/infrastructure/customer-profile/repository.ts — WBS 1.9, M02 sales.
//
// infrastructure/ layer: every DB statement for the customer-profile use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/customer-profile/ports.ts's `CustomerProfileRepository`.
//
// No row lock anywhere in this file — the whole use case is a pure read (Master decision 1).
// `sales.accounts` carries no `entity_id` column at all (group-level); RLS (client_portal_scope)
// hides an account the caller cannot see, surfacing as `null` here — the application layer maps
// that to AccountNotFoundError (never a second, distinguishable error).

const SALES_SCHEMA = 'sales';
const ACCOUNT_TABLE = `${SALES_SCHEMA}.accounts`;
const CONTRACT_TABLE = `${SALES_SCHEMA}.contracts`;

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { AccountRow, ContractRow, CustomerProfileRepository } from '../../application/customer-profile/ports.js';

async function getAccountById(tx: NodePgDatabase, accountId: string): Promise<AccountRow | null> {
  const result = await tx.execute<{
    id: string;
    code: string;
    name_ar: string;
    name_en: string | null;
    cr_number: string | null;
    credit_limit: string | null;
    credit_limit_positive: boolean;
    credit_hold: boolean;
    hold_reason: string | null;
    payment_terms_days: number | null;
    segment_id: string | null;
    segment_code: string | null;
    segment_name_ar: string | null;
    owner_user_id: string | null;
    owner_name_ar: string | null;
  }>(sql`
    select a.id, a.code, a.name_ar, a.name_en, a.cr_number,
           a.credit_limit::text as credit_limit,
           coalesce(a.credit_limit > 0, false) as credit_limit_positive,
           a.credit_hold, a.hold_reason,
           a.payment_terms_days, a.segment_id,
           seg.code as segment_code, seg.name_ar as segment_name_ar,
           a.owner_user_id, owner.full_name_ar as owner_name_ar
      from ${sql.raw(ACCOUNT_TABLE)} a
      left join catalog.segments seg on seg.id = a.segment_id
      left join identity.users owner on owner.id = a.owner_user_id
     where a.id = ${accountId}::uuid and a.deleted_at is null
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    nameAr: row.name_ar,
    nameEn: row.name_en,
    crNumber: row.cr_number,
    creditLimit: row.credit_limit,
    creditLimitPositive: row.credit_limit_positive,
    creditHold: row.credit_hold,
    holdReason: row.hold_reason,
    paymentTermsDays: row.payment_terms_days,
    segmentId: row.segment_id,
    segmentCode: row.segment_code,
    segmentNameAr: row.segment_name_ar,
    ownerUserId: row.owner_user_id,
    ownerNameAr: row.owner_name_ar,
  };
}

async function getContractsForAccount(tx: NodePgDatabase, accountId: string): Promise<readonly ContractRow[]> {
  const result = await tx.execute<{
    id: string;
    entity_code: string;
    status: string;
    start_date: string;
    end_date: string | null;
    has_price_list: boolean;
  }>(sql`
    select c.id, e.code as entity_code, c.status, c.start_date::text as start_date,
           c.end_date::text as end_date, (c.price_list_id is not null) as has_price_list
      from ${sql.raw(CONTRACT_TABLE)} c
      join platform.entities e on e.id = c.entity_id
     where c.account_id = ${accountId}::uuid
     order by c.start_date desc, c.id
  `);
  return result.rows.map((row) => ({
    contractId: row.id,
    entityCode: row.entity_code,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    hasPriceList: row.has_price_list,
  }));
}

export const customerProfileRepository: CustomerProfileRepository = {
  getAccountById,
  getContractsForAccount,
};

// exported for a later slice's own reference (REPLACE-ON-COPY pattern the golden slice sets).
export { SALES_SCHEMA, ACCOUNT_TABLE, CONTRACT_TABLE };
