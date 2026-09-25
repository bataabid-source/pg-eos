// modules/sales/infrastructure/manage-account-credit/repository.ts — WBS 1.8, M02 sales.
//
// infrastructure/ layer: every DB statement for the manage-account-credit use case, run against
// the `tx` a caller's own withContext(ctx, fn) already opened. Implements
// ../../application/manage-account-credit/ports.ts's `AccountCreditRepository`.
//
// LOCK ORDER — the one every write command's own header points here:
//   0. the idempotency advisory lock + platform.idempotency_keys upsert (packages/db/src/
//      idempotency.ts's withIdempotentContext), FIRST — before step 1 — whenever the command's own
//      input carries an `idem` (every write command in this use case except the read-only
//      getAccountCreditStatus).
//   1. getAccountForUpdate — `select ... for update` on the ONE aggregate row. Held for the rest
//      of the transaction; the caller compares its own version to expectedVersion here.
//   2. role gate, business invariants — no further row lock.
//   3. the write: updateCreditLimit/updateCreditHold (the version bump, on the row already locked
//      in step 1 — no new lock). No audit row this slice — no audit target is named in the brief
//      for sales.accounts, and Master decision 9 records "No outbox event this slice."

const SALES_SCHEMA = 'sales';
const ACCOUNT_TABLE_NAME = 'accounts';
const ACCOUNT_TABLE = `${SALES_SCHEMA}.${ACCOUNT_TABLE_NAME}`;

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { AccountNotFoundError } from '../../domain/manage-account-credit/errors.js';
import type {
  AccountCreditRepository,
  AccountCreditRow,
  UpdateCreditHoldColumns,
  UpdateCreditLimitColumns,
} from '../../application/manage-account-credit/ports.js';

async function hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  const roles = result.rows[0]?.roles ?? [];
  return roles.includes(roleCode);
}

function toAccountCreditRow(row: {
  id: string;
  credit_limit: string | null;
  credit_hold: boolean;
  hold_reason: string | null;
  hold_set_by: string | null;
  hold_set_at: Date | null;
  version: number;
}): AccountCreditRow {
  return {
    id: row.id,
    creditLimit: row.credit_limit,
    creditHold: row.credit_hold,
    holdReason: row.hold_reason,
    holdSetBy: row.hold_set_by,
    holdSetAt: row.hold_set_at,
    version: row.version,
  };
}

async function getAccountForUpdate(tx: NodePgDatabase, accountId: string): Promise<AccountCreditRow> {
  const result = await tx.execute<{
    id: string;
    credit_limit: string | null;
    credit_hold: boolean;
    hold_reason: string | null;
    hold_set_by: string | null;
    hold_set_at: Date | null;
    version: number;
  }>(sql`
    select id, credit_limit::text as credit_limit, credit_hold, hold_reason, hold_set_by, hold_set_at, version
      from ${sql.raw(ACCOUNT_TABLE)} where id = ${accountId}::uuid and deleted_at is null for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new AccountNotFoundError(
      `no ${ACCOUNT_TABLE} row visible for id ${accountId} (Allowed: an existing, visible account).`,
    );
  }
  return toAccountCreditRow(row);
}

async function getAccountById(tx: NodePgDatabase, accountId: string): Promise<AccountCreditRow | null> {
  const result = await tx.execute<{
    id: string;
    credit_limit: string | null;
    credit_hold: boolean;
    hold_reason: string | null;
    hold_set_by: string | null;
    hold_set_at: Date | null;
    version: number;
  }>(sql`
    select id, credit_limit::text as credit_limit, credit_hold, hold_reason, hold_set_by, hold_set_at, version
      from ${sql.raw(ACCOUNT_TABLE)} where id = ${accountId}::uuid and deleted_at is null
  `);
  const row = result.rows[0];
  return row ? toAccountCreditRow(row) : null;
}

async function updateCreditLimit(tx: NodePgDatabase, accountId: string, columns: UpdateCreditLimitColumns): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(ACCOUNT_TABLE)}
       set version = version + 1,
           credit_limit = ${columns.creditLimit}::numeric
     where id = ${accountId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateCreditLimit: no ${ACCOUNT_TABLE} row for id ${accountId} (lock was already held)`);
  }
  return row.version;
}

async function updateCreditHold(tx: NodePgDatabase, accountId: string, columns: UpdateCreditHoldColumns): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(ACCOUNT_TABLE)}
       set version = version + 1,
           credit_hold = ${columns.creditHold},
           hold_reason = ${columns.holdReason},
           hold_set_by = ${columns.holdSetBy}::uuid,
           hold_set_at = ${columns.holdSetAt.toISOString()}::timestamptz
     where id = ${accountId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateCreditHold: no ${ACCOUNT_TABLE} row for id ${accountId} (lock was already held)`);
  }
  return row.version;
}

export const accountCreditRepository: AccountCreditRepository = {
  hasRole,
  getAccountForUpdate,
  getAccountById,
  updateCreditLimit,
  updateCreditHold,
};

// exported for a later slice's own reference (REPLACE-ON-COPY pattern the golden slice sets).
export { SALES_SCHEMA, ACCOUNT_TABLE_NAME, ACCOUNT_TABLE };
