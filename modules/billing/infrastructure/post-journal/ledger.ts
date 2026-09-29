// modules/billing/infrastructure/post-journal/ledger.ts — WBS 4.20 (lane 2).
//
// infrastructure/ layer: the append-only book of this use case — billing.journal_lines and each
// line's billing.line_dimensions rows (SCR-ACC-01 #9; ADR-0004 D1 6: every axis other than
// entity_id travels as dimension data). Implements ../../application/post-journal/ports.ts's
// `JournalLedgerPort` (golden slice counterpart: modules/wms/infrastructure/receive-inbound/ledger.ts).
// Lines are only ever inserted (migration 0041 revokes UPDATE/DELETE/TRUNCATE); the database
// checks each line's account (T3) on insert and the entry's balance at COMMIT (T1/T2).

import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { JournalLedgerPort, JournalLine } from '../../application/post-journal/ports.js';

/** journal_lines.debit/credit default (01:1206-1207): an omitted side is zero. */
const ZERO_AMOUNT = '0';

async function appendLines(
  tx: NodePgDatabase,
  params: { readonly entryId: string; readonly entityId: string; readonly lines: readonly JournalLine[] },
): Promise<void> {
  for (const line of params.lines) {
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into billing.journal_lines (entry_id, account_id, debit, credit, description)
      values (${params.entryId}::uuid, ${line.accountId}::uuid, ${line.debit ?? ZERO_AMOUNT}::numeric,
              ${line.credit ?? ZERO_AMOUNT}::numeric, ${line.description ?? null})
      returning id
    `);
    const lineId = inserted.rows[0]?.id;
    if (!lineId) throw new Error('appendLines: no billing.journal_lines row returned');
    for (const dimension of line.dimensions ?? []) {
      await tx.execute(sql`
        insert into billing.line_dimensions (journal_line_id, entity_id, dimension_type_id, value_id)
        values (${lineId}::uuid, ${params.entityId}::uuid, ${dimension.dimensionTypeId}::uuid, ${dimension.valueId}::uuid)
      `);
    }
  }
}

async function readLines(tx: NodePgDatabase, entryId: string): Promise<JournalLine[]> {
  const result = await tx.execute<{
    id: string;
    account_id: string;
    debit: string | null;
    credit: string | null;
    description: string | null;
    dimensions: Array<{ dimensionTypeId: string; valueId: string }>;
  }>(sql`
    select jl.id, jl.account_id, nullif(jl.debit, 0)::text as debit, nullif(jl.credit, 0)::text as credit, jl.description,
           coalesce((select jsonb_agg(jsonb_build_object('dimensionTypeId', ld.dimension_type_id, 'valueId', ld.value_id)
                                      order by ld.dimension_type_id)
                       from billing.line_dimensions ld where ld.journal_line_id = jl.id), '[]'::jsonb) as dimensions
      from billing.journal_lines jl
     where jl.entry_id = ${entryId}::uuid
     order by jl.id
  `);
  // One-side-only (01:1212): the zero side comes back null (nullif) and is omitted, as the contract
  // carries it — no float arithmetic on the amounts.
  return result.rows.map((row) => ({
    accountId: row.account_id,
    ...(row.debit === null ? {} : { debit: row.debit }),
    ...(row.credit === null ? {} : { credit: row.credit }),
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.dimensions.length > 0 ? { dimensions: row.dimensions } : {}),
  }));
}

export const journalLedgerPort: JournalLedgerPort = {
  appendLines,
  readLines,
};
