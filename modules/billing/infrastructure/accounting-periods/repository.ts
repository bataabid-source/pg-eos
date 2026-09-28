// modules/billing/infrastructure/accounting-periods/repository.ts — WBS 4.19 (lane 2).
//
// infrastructure/ layer: every DB statement for the accounting-periods use case, run against the
// `tx` a caller's own withContext(ctx, fn) already opened (entity_scope RLS applies). Implements
// ../../application/accounting-periods/ports.ts's `AccountingPeriodRepository` (golden slice:
// modules/wms/infrastructure/receive-inbound/repository.ts).
//
// LOCK ORDER (every command follows it): 0. the idempotency advisory lock (withIdempotentContext)
// when input.idem is set; 1. getPeriodForUpdate — `select ... for update` on the one period row (the
// caller compares version to expectedVersion here); 2. outbox insert, then updatePeriodStatus (the
// version bump on the row already locked), then writeAuditRow, last (ADR-0002). A posting into the
// period takes the same row FOR SHARE (billing.assert_posting_period(), migration 0040), so a close
// and a posting of the same period serialise.
//
// Grants (migration 0040, D6): pgeos_app may select and insert both tables and update only
// (status, version) on billing.accounting_periods — no statement here touches any other column
// after insert, and none updates or deletes a fiscal year.
//
// The reopen decision's title_ar (platform.decisions.title_ar is NOT NULL, 13B:444) is the Arabic
// text of the i18n key REOPEN_DECISION_TITLE_KEY in packages/i18n/ar/billing.json (CLAUDE.md "No
// embedded UI strings — i18n"), read once from the workspace at first use.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  AccountingPeriodRepository,
  AuditTarget,
  FiscalYearRow,
  PeriodRow,
  ReopenDecisionContext,
  ReopenDecisionRow,
} from '../../application/accounting-periods/ports.js';
import {
  EntityNotInScopeError,
  FiscalYearNotFoundError,
  FiscalYearOverlapError,
  PeriodNotFoundError,
  PeriodOutsideFiscalYearError,
  PeriodOverlapError,
} from '../../domain/accounting-periods/errors.js';
import type { PeriodStatus } from '../../domain/accounting-periods/machine.js';

const PERIOD_SCHEMA = 'billing';
const FISCAL_YEAR_TABLE_NAME = 'fiscal_years';
const PERIOD_TABLE_NAME = 'accounting_periods';
const FISCAL_YEAR_TABLE = `${PERIOD_SCHEMA}.${FISCAL_YEAR_TABLE_NAME}`;
const PERIOD_TABLE = `${PERIOD_SCHEMA}.${PERIOD_TABLE_NAME}`;
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.
// The audited table for each AuditTarget — the application layer names a target, never a table.
const AUDIT_TABLE_BY_TARGET: Readonly<Record<AuditTarget, string>> = {
  fiscal_year: FISCAL_YEAR_TABLE_NAME,
  period: PERIOD_TABLE_NAME,
};

// The Decision Inbox request (4.19 pre-build review D1/D8) — the same literals the DB trigger
// billing.guard_accounting_period() matches on (migration 0040).
const REOPEN_DECISION_KIND = 'accounting_period_reopen';
const REOPEN_APPROVAL_STEP = 1;
const DECISION_STATUS_OPEN = 'open';

// packages/i18n/<lang>/billing.json — flat keys, the apps/admin/src/i18n convention.
const REOPEN_DECISION_TITLE_KEY = 'billing.accountingPeriods.reopenDecision.title';
const I18N_ARABIC_BILLING_FILE = join('packages', 'i18n', 'ar', 'billing.json');

let reopenDecisionTitleAr: string | undefined;

// Close review round 1 #3: the database refusals an insert can meet, mapped by SQLSTATE and
// constraint name (migration 0040) to typed 422 errors — never an unmapped 500.
const EXCLUSION_VIOLATION_SQLSTATE = '23P01';
const CHECK_VIOLATION_SQLSTATE = '23514';
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';
const FISCAL_YEAR_OVERLAP_CONSTRAINT = 'ex_fiscal_years_no_overlap';
const PERIOD_OVERLAP_CONSTRAINT = 'ex_accounting_periods_no_overlap';
const PERIOD_IN_FISCAL_YEAR_CONSTRAINT = 'chk_accounting_periods_in_fiscal_year';

interface DbRefusal {
  readonly sqlstate: string;
  /** undefined: any constraint (or none) with this SQLSTATE. */
  readonly constraint?: string;
  readonly toError: () => Error;
}

/** Walks `error`'s cause chain (drizzle wraps the pg error) for the first Postgres error carrying a
 *  SQLSTATE; returns its code and constraint name. */
function findPgError(error: unknown): { readonly code: string; readonly constraint: string | undefined } | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = 'code' in current ? current.code : undefined;
    if (typeof code === 'string') {
      const constraint = 'constraint' in current ? current.constraint : undefined;
      return { code, constraint: typeof constraint === 'string' ? constraint : undefined };
    }
    current = current.cause;
  }
  return undefined;
}

/** Runs `statement`; a refusal listed in `refusals` is rethrown as its typed error, anything else
 *  unchanged. */
async function mapDbRefusals<T>(statement: () => Promise<T>, refusals: readonly DbRefusal[]): Promise<T> {
  try {
    return await statement();
  } catch (error) {
    const pgError = findPgError(error);
    const refusal = pgError
      ? refusals.find(
          (candidate) =>
            candidate.sqlstate === pgError.code &&
            (candidate.constraint === undefined || candidate.constraint === pgError.constraint),
        )
      : undefined;
    if (refusal) throw refusal.toError();
    throw error;
  }
}

function entityNotInScope(entityId: string): DbRefusal {
  return {
    sqlstate: INSUFFICIENT_PRIVILEGE_SQLSTATE,
    toError: () =>
      new EntityNotInScopeError(
        `entity ${entityId} is not one of the caller's entities (Allowed: an entity the caller belongs to)`,
      ),
  };
}

/** Walks up from this file to the workspace directory holding packages/i18n (works from source and
 *  from dist/), then reads the Arabic title once. Throws if the key is missing or empty. */
function getReopenDecisionTitleAr(): string {
  if (reopenDecisionTitleAr !== undefined) return reopenDecisionTitleAr;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, I18N_ARABIC_BILLING_FILE))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${I18N_ARABIC_BILLING_FILE} not found above ${fileURLToPath(import.meta.url)}`);
    dir = parent;
  }
  const messages: unknown = JSON.parse(readFileSync(join(dir, I18N_ARABIC_BILLING_FILE), 'utf8'));
  const title =
    typeof messages === 'object' && messages !== null
      ? (messages as Record<string, unknown>)[REOPEN_DECISION_TITLE_KEY]
      : undefined;
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error(`i18n key ${REOPEN_DECISION_TITLE_KEY} missing from ${I18N_ARABIC_BILLING_FILE}`);
  }
  reopenDecisionTitleAr = title;
  return title;
}

async function insertFiscalYear(
  tx: NodePgDatabase,
  params: { readonly entityId: string; readonly startDate: string; readonly endDate: string },
): Promise<{ readonly id: string; readonly version: number }> {
  const result = await mapDbRefusals(
    () =>
      tx.execute<{ id: string; version: number }>(sql`
        insert into ${sql.raw(FISCAL_YEAR_TABLE)} (entity_id, start_date, end_date)
        values (${params.entityId}::uuid, ${params.startDate}::date, ${params.endDate}::date)
        returning id, version
      `),
    [
      {
        sqlstate: EXCLUSION_VIOLATION_SQLSTATE,
        constraint: FISCAL_YEAR_OVERLAP_CONSTRAINT,
        toError: () =>
          new FiscalYearOverlapError(
            `fiscal year ${params.startDate}..${params.endDate} overlaps another fiscal year of entity ` +
              `${params.entityId} (Allowed: a date range no other fiscal year of the entity covers)`,
          ),
      },
      entityNotInScope(params.entityId),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`insertFiscalYear: no ${FISCAL_YEAR_TABLE} row returned`);
  return { id: row.id, version: row.version };
}

async function getFiscalYear(tx: NodePgDatabase, entityId: string, fiscalYearId: string): Promise<FiscalYearRow> {
  const result = await tx.execute<{ id: string; entity_id: string; start_date: string; end_date: string }>(sql`
    select id, entity_id, start_date::text as start_date, end_date::text as end_date
      from ${sql.raw(FISCAL_YEAR_TABLE)}
     where id = ${fiscalYearId}::uuid and entity_id = ${entityId}::uuid
  `);
  const row = result.rows[0];
  if (!row) {
    throw new FiscalYearNotFoundError(
      `no ${FISCAL_YEAR_TABLE} row visible for id ${fiscalYearId} of entity ${entityId} ` +
        "(Allowed: an existing fiscal year of the same entity, in the caller's entities)",
    );
  }
  return { id: row.id, entityId: row.entity_id, startDate: row.start_date, endDate: row.end_date };
}

async function insertPeriod(
  tx: NodePgDatabase,
  params: { readonly entityId: string; readonly fiscalYearId: string; readonly startDate: string; readonly endDate: string },
): Promise<{ readonly id: string; readonly version: number; readonly status: PeriodStatus }> {
  const result = await mapDbRefusals(
    () =>
      tx.execute<{ id: string; version: number; status: PeriodStatus }>(sql`
        insert into ${sql.raw(PERIOD_TABLE)} (entity_id, fiscal_year_id, start_date, end_date)
        values (${params.entityId}::uuid, ${params.fiscalYearId}::uuid, ${params.startDate}::date, ${params.endDate}::date)
        returning id, version, status
      `),
    [
      {
        sqlstate: EXCLUSION_VIOLATION_SQLSTATE,
        constraint: PERIOD_OVERLAP_CONSTRAINT,
        toError: () =>
          new PeriodOverlapError(
            `accounting period ${params.startDate}..${params.endDate} overlaps another period of entity ` +
              `${params.entityId} (Allowed: a date range no other period of the entity covers)`,
          ),
      },
      {
        sqlstate: CHECK_VIOLATION_SQLSTATE,
        constraint: PERIOD_IN_FISCAL_YEAR_CONSTRAINT,
        toError: () =>
          new PeriodOutsideFiscalYearError(
            `accounting period ${params.startDate}..${params.endDate} lies outside fiscal year ` +
              `${params.fiscalYearId} (Allowed: a date range inside that fiscal year)`,
          ),
      },
      entityNotInScope(params.entityId),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`insertPeriod: no ${PERIOD_TABLE} row returned`);
  return { id: row.id, version: row.version, status: row.status };
}

async function getPeriodForUpdate(tx: NodePgDatabase, periodId: string): Promise<PeriodRow> {
  const result = await tx.execute<{
    id: string;
    entity_id: string;
    fiscal_year_id: string;
    start_date: string;
    end_date: string;
    status: PeriodStatus;
    version: number;
  }>(sql`
    select id, entity_id, fiscal_year_id, start_date::text as start_date, end_date::text as end_date,
           status, version
      from ${sql.raw(PERIOD_TABLE)} where id = ${periodId}::uuid for update
  `);
  const row = result.rows[0];
  if (!row) {
    throw new PeriodNotFoundError(
      `no ${PERIOD_TABLE} row visible for id ${periodId} (Allowed: an existing period in the caller's entities)`,
    );
  }
  return {
    id: row.id,
    entityId: row.entity_id,
    fiscalYearId: row.fiscal_year_id,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    version: row.version,
  };
}

async function updatePeriodStatus(tx: NodePgDatabase, periodId: string, status: PeriodStatus): Promise<number> {
  const result = await tx.execute<{ version: number }>(sql`
    update ${sql.raw(PERIOD_TABLE)} set status = ${status}, version = version + 1
     where id = ${periodId}::uuid
    returning version
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`updatePeriodStatus: no ${PERIOD_TABLE} row for id ${periodId} (lock was already held)`);
  return row.version;
}

async function hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  return (result.rows[0]?.roles ?? []).includes(roleCode);
}

async function isReopenApprover(tx: NodePgDatabase): Promise<boolean> {
  const result = await tx.execute<{ is_approver: boolean }>(sql`
    select platform.is_approval_chain_approver(${REOPEN_DECISION_KIND}, ${REOPEN_APPROVAL_STEP}::int) as is_approver
  `);
  return result.rows[0]?.is_approver === true;
}

async function insertReopenDecision(
  tx: NodePgDatabase,
  params: { readonly entityId: string; readonly context: ReopenDecisionContext },
): Promise<{ readonly id: string }> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into platform.decisions
      (entity_id, kind, title_ar, context, source_table, source_id, assigned_role, status)
    select ${params.entityId}::uuid, ${REOPEN_DECISION_KIND}, ${getReopenDecisionTitleAr()},
           ${JSON.stringify(params.context)}::jsonb, ${PERIOD_TABLE}, ${params.context.periodId}::uuid,
           ac.approver_role, ${DECISION_STATUS_OPEN}
      from platform.approval_chains ac
     where ac.request_type = ${REOPEN_DECISION_KIND} and ac.step_no = ${REOPEN_APPROVAL_STEP} and ac.is_active
    returning id
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `insertReopenDecision: no active platform.approval_chains row for (${REOPEN_DECISION_KIND}, step ${REOPEN_APPROVAL_STEP})`,
    );
  }
  return { id: row.id };
}

async function getReopenDecision(tx: NodePgDatabase, decisionId: string): Promise<ReopenDecisionRow | null> {
  const result = await tx.execute<{
    id: string;
    source_id: string;
    status: string;
    decision: string | null;
    decided_by: string | null;
    requested_by: string | null;
    period_version: string | null;
  }>(sql`
    select id, source_id, status, decision, decided_by,
           context ->> 'requestedBy' as requested_by, context ->> 'periodVersion' as period_version
      from platform.decisions
     where id = ${decisionId}::uuid and kind = ${REOPEN_DECISION_KIND} and source_table = ${PERIOD_TABLE}
       and source_id is not null
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    periodId: row.source_id,
    status: row.status,
    decision: row.decision,
    decidedBy: row.decided_by,
    requestedBy: row.requested_by,
    periodVersion: row.period_version === null ? null : Number(row.period_version),
  };
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the outbox row the same
 *  call writes (G9). `occurredAt` always comes from the injected Clock. */
async function writeAuditRow(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly target: AuditTarget;
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
       ${params.entityId}::uuid, ${PERIOD_SCHEMA}, ${AUDIT_TABLE_BY_TARGET[params.target]}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

export const accountingPeriodRepository: AccountingPeriodRepository = {
  insertFiscalYear,
  getFiscalYear,
  insertPeriod,
  getPeriodForUpdate,
  updatePeriodStatus,
  hasRole,
  isReopenApprover,
  insertReopenDecision,
  getReopenDecision,
  writeAuditRow,
};
