// modules/billing/infrastructure/post-journal/repository.ts — WBS 4.20 (lane 2).
//
// infrastructure/ layer: every DB statement of the post-journal use case except the lines (those
// are ./ledger.ts), run against the `tx` a caller's own withContext(ctx, fn) already opened
// (entity_scope RLS applies). Implements ../../application/post-journal/ports.ts's
// `JournalRepository` (golden slice: modules/wms/infrastructure/receive-inbound/repository.ts).
//
// Grants (migration 0041): pgeos_app may select and insert billing.journal_entries/journal_lines,
// never update/delete/truncate — so no statement here row-locks (FOR UPDATE needs UPDATE) or
// updates an entry. The one in-place write, reversed_by + version, goes through the SECURITY
// DEFINER billing.mark_journal_reversed() (T6), which takes the row lock itself and re-checks the
// guards; its refusals (23514, constraint name) are mapped to the typed errors below.

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { AuditRowInput, JournalEntryRow, JournalRepository, PeriodRow } from '../../application/post-journal/ports.js';
import { AlreadyReversedError, JournalEntryNotFoundError, StaleVersionError } from '../../domain/post-journal/errors.js';
import type { AccountFacts } from '../../domain/post-journal/invariants.js';

const JOURNAL_SCHEMA = 'billing';
const ENTRIES_TABLE_NAME = 'journal_entries';
const ENTRIES_TABLE = `${JOURNAL_SCHEMA}.${ENTRIES_TABLE_NAME}`;
const JE_DOC_TYPE = 'JE';
const AUDIT_ACTOR_TYPE_USER = 'user'; // every actor is ctx.userId — never 'system' here.

// billing.mark_journal_reversed() refusals (migration 0041 T6) — SQLSTATE 23514 + constraint name.
const CHECK_VIOLATION_SQLSTATE = '23514';
const REVERSAL_ONCE_CONSTRAINT = 'chk_journal_reversal_once';
const REVERSAL_VERSION_CONSTRAINT = 'chk_journal_reversal_version';
const REVERSAL_SCOPE_CONSTRAINT = 'chk_journal_reversal_scope';

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

async function isEntityInScope(tx: NodePgDatabase, entityId: string): Promise<boolean> {
  const result = await tx.execute<{ in_scope: boolean }>(sql`
    select (${entityId}::uuid = any (platform.allowed_entities())) as in_scope
  `);
  return result.rows[0]?.in_scope === true;
}

async function hasRole(tx: NodePgDatabase, roleCode: string): Promise<boolean> {
  const result = await tx.execute<{ roles: readonly string[] }>(sql`select platform.my_roles() as roles`);
  return (result.rows[0]?.roles ?? []).includes(roleCode);
}

async function getPeriod(tx: NodePgDatabase, periodId: string): Promise<PeriodRow | null> {
  const result = await tx.execute<{ id: string; entity_id: string; start_date: string; end_date: string; status: string }>(sql`
    select id, entity_id, start_date::text as start_date, end_date::text as end_date, status
      from billing.accounting_periods where id = ${periodId}::uuid
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, entityId: row.entity_id, startDate: row.start_date, endDate: row.end_date, status: row.status };
}

async function getAccounts(tx: NodePgDatabase, accountIds: readonly string[]): Promise<ReadonlyMap<string, AccountFacts>> {
  const result = await tx.execute<{ id: string; entity_id: string; is_postable: boolean; account_type: string }>(sql`
    select ga.id, ga.entity_id, ga.is_postable, ga.account_type
      from billing.gl_accounts ga
     where ga.id in (select ids.value::uuid from jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb) as ids)
  `);
  return new Map(
    result.rows.map((row) => [row.id, { entityId: row.entity_id, isPostable: row.is_postable, accountType: row.account_type }]),
  );
}

async function nextDocNo(tx: NodePgDatabase, entityId: string): Promise<string> {
  const result = await tx.execute<{ doc_no: string }>(sql`
    select platform.next_doc_no(${entityId}::uuid, ${JE_DOC_TYPE}) as doc_no
  `);
  const docNo = result.rows[0]?.doc_no;
  if (docNo === undefined) throw new Error(`nextDocNo: platform.next_doc_no returned no row for entity ${entityId}`);
  return docNo;
}

async function insertEntry(
  tx: NodePgDatabase,
  params: {
    readonly entityId: string;
    readonly docNo: string;
    readonly entryDate: string;
    readonly description: string;
    readonly periodId: string;
    readonly entryType: string;
    readonly postedAt: Date;
    readonly postedBy: string;
  },
): Promise<{ readonly id: string; readonly version: number }> {
  const result = await tx.execute<{ id: string; version: number }>(sql`
    insert into ${sql.raw(ENTRIES_TABLE)}
      (entity_id, doc_no, entry_date, description, period_id, entry_type, posted_at, posted_by)
    values
      (${params.entityId}::uuid, ${params.docNo}, ${params.entryDate}::date, ${params.description},
       ${params.periodId}::uuid, ${params.entryType}, ${params.postedAt.toISOString()}::timestamptz,
       ${params.postedBy}::uuid)
    returning id, version
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`insertEntry: no ${ENTRIES_TABLE} row returned`);
  return { id: row.id, version: row.version };
}

async function getPostedEntry(tx: NodePgDatabase, entryId: string): Promise<JournalEntryRow> {
  const result = await tx.execute<{ id: string; entity_id: string; doc_no: string; reversed_by: string | null; version: number }>(sql`
    select id, entity_id, doc_no, reversed_by, version
      from ${sql.raw(ENTRIES_TABLE)} where id = ${entryId}::uuid and posted_at is not null
  `);
  const row = result.rows[0];
  if (!row) {
    throw new JournalEntryNotFoundError(
      `no posted ${ENTRIES_TABLE} row visible for id ${entryId} (Allowed: a posted entry of the caller's entities)`,
    );
  }
  return { id: row.id, entityId: row.entity_id, docNo: row.doc_no, reversedBy: row.reversed_by, version: row.version };
}

async function markReversed(tx: NodePgDatabase, entryId: string, reversingId: string, expectedVersion: number): Promise<number> {
  try {
    const result = await tx.execute<{ version: number }>(sql`
      select billing.mark_journal_reversed(${entryId}::uuid, ${reversingId}::uuid, ${expectedVersion}::int) as version
    `);
    const version = result.rows[0]?.version;
    if (version === undefined) throw new Error('markReversed: billing.mark_journal_reversed returned no row');
    return version;
  } catch (error) {
    const pgError = findPgError(error);
    if (pgError?.code === CHECK_VIOLATION_SQLSTATE) {
      if (pgError.constraint === REVERSAL_ONCE_CONSTRAINT) {
        throw new AlreadyReversedError(`journal entry ${entryId} is already reversed (Allowed: one reversal per entry)`);
      }
      if (pgError.constraint === REVERSAL_VERSION_CONSTRAINT) {
        throw new StaleVersionError(`expectedVersion ${expectedVersion} no longer matches journal entry ${entryId} (optimistic lock)`);
      }
      if (pgError.constraint === REVERSAL_SCOPE_CONSTRAINT) {
        throw new JournalEntryNotFoundError(`no posted ${ENTRIES_TABLE} row visible for id ${entryId}`);
      }
    }
    throw error;
  }
}

/** doc 40 P3/P7: one append-only audit_log row, correlation_id shared with the outbox row the same
 *  call writes (G9). `occurredAt` always comes from the injected Clock. */
async function writeAuditRow(tx: NodePgDatabase, params: AuditRowInput): Promise<void> {
  await tx.execute(sql`
    insert into platform.audit_log
      (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
       new_value, correlation_id)
    values
      (${params.occurredAt.toISOString()}::timestamptz, ${params.actorId}::uuid, ${AUDIT_ACTOR_TYPE_USER},
       ${params.entityId}::uuid, ${JOURNAL_SCHEMA}, ${ENTRIES_TABLE_NAME}, ${params.recordId}::uuid,
       ${params.operation}, ${JSON.stringify(params.newValue)}::jsonb, ${params.correlationId}::uuid)
  `);
}

/** A fresh plain-object repository (tests spread it and replace single methods). */
export function createJournalRepository(): JournalRepository {
  return {
    isEntityInScope,
    hasRole,
    getPeriod,
    getAccounts,
    nextDocNo,
    insertEntry,
    getPostedEntry,
    markReversed,
    writeAuditRow,
  };
}
