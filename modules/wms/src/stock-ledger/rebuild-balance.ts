// modules/wms/src/stock-ledger/rebuild-balance.ts — WBS 2.8 (pg-backend).
//
// decision 8 / doc 40 P4: balances are derived and rebuildable with zero diff.
// rebuildBalance(ctx, { clientId, skuId }) recomputes qty_on_hand per (location_id, batch_no) from
// the ledger with the SAME fold wms.verify_balance_integrity() uses
// (01 §wms.verify_balance_integrity, v1.1, SCR-WMS-01):
// `sum(case when to_location_id is not null then qty else -qty end)`, grouped by the full
// stock_balance key (client_id, sku_id, coalesce(to_location_id, from_location_id),
// coalesce(batch_no, '')) and overwrites wms.stock_balance for that (client, sku) in one
// transaction: rows the ledger no longer has any movement for are deleted; qty_allocated is
// preserved (not part of the `set` clause below, so an existing row's value survives the upsert —
// 2.11's concern, not 2.8's).
//
// `last_movement_at` is set from the ledger's own last movement time for that (location, batch)
// pair — the actual last time stock moved there — rather than "now the rebuild ran", which would
// misrepresent history for a balance nobody has touched since.

import { withContext, type WithContextCtx } from '@pg-eos/db';
import { balanceRebuildLockKey } from './domain.js';
import type { LedgerDeps } from './post-movement.js';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { RebuildScopeError } from './errors.js';

/**
 * pg-reviewer gate finding 9 / doc 40 P4 (see errors.ts's RebuildScopeError doc comment): the
 * caller must see the WHOLE ledger before any read or write of it — allowed = bypass OR
 * (platform.is_internal() AND all_entities): either the role bypasses RLS entirely (superuser or
 * BYPASSRLS), or the caller is internal AND platform.allowed_entities() already covers every row of
 * platform.entities (pg-reviewer slice-close round 2 finding 2 — a non-internal caller must be
 * refused here, before any write, rather than let wms.stock_balance's own internal_only policy
 * reject the fold's upsert mid-transaction with a raw, untyped RLS error).
 */
async function assertSeesWholeLedger(tx: NodePgDatabase): Promise<void> {
  const result = await tx.execute<{
    readonly bypass: boolean;
    readonly is_internal: boolean;
    readonly all_entities: boolean;
  }>(sql`
    select (r.rolsuper or r.rolbypassrls) as bypass,
           platform.is_internal() as is_internal,
           not exists (
             select 1 from platform.entities e
              where not (e.id = any(platform.allowed_entities()))
           ) as all_entities
      from pg_roles r
     where r.rolname = current_user
  `);

  const row = result.rows[0];
  const allowed = row !== undefined && (row.bypass || (row.is_internal && row.all_entities));
  if (!allowed) {
    throw new RebuildScopeError(
      'rebuildBalance refused: caller cannot see the whole wms.stock_movements ledger under RLS ' +
        '(doc 40 P4 — balances are rebuildable with zero diff only from the FULL ledger; ' +
        'pg-reviewer gate finding 9). Nothing was written. Allowed: a superuser/BYPASSRLS role, or ' +
        'an internal caller (app.is_internal) whose platform.allowed_entities() covers every ' +
        'platform.entities row.',
    );
  }
}

export async function rebuildBalance(
  ctx: WithContextCtx,
  input: { readonly clientId: string; readonly skuId: string },
  deps: LedgerDeps,
): Promise<{ readonly rowsWritten: number }> {
  // rebuildBalance recomputes purely from the ledger's own stored occurred_at values (see file
  // header) — it never needs "now", so neither deps.clock nor deps.ids is called. `deps` is kept
  // in the signature only to match the brief's Public surface block (positional-call contract);
  // this reference exists solely so the unused parameter isn't a silent, unexplained no-op.
  void deps;

  return withContext(ctx, async (tx) => {
    await assertSeesWholeLedger(tx);

    // pg-reviewer slice-close round 2 finding 1 (doc 40 P4 / INV-C3-2): EXCLUSIVE mode on the same
    // key a posting takes SHARED (post-movement.ts's lockRebuildKeysShared) — taken AFTER the scope
    // check (a caller that can't see the whole ledger is refused before it ever waits on, let alone
    // holds, this lock) and BEFORE folding the ledger below. This waits for every posting already
    // in flight for this (client, sku) to commit, and blocks any NEW posting from starting until
    // this rebuild itself commits or rolls back — so the fold below is never torn against a
    // concurrent write, and two concurrent rebuilds of the same (client, sku) also serialize against
    // each other (exclusive vs exclusive).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${balanceRebuildLockKey(input.clientId, input.skuId)}, 0))`,
    );

    const foldResult = await tx.execute<{
      readonly location_id: string;
      readonly batch_no: string;
      readonly qty_on_hand: string;
      readonly last_movement_at: string;
    }>(sql`
      select coalesce(m.to_location_id, m.from_location_id) as location_id,
             coalesce(m.batch_no, '') as batch_no,
             sum(case when m.to_location_id is not null then m.qty else -m.qty end)::text as qty_on_hand,
             max(m.occurred_at)::text as last_movement_at
        from wms.stock_movements m
       where m.client_id = ${input.clientId}::uuid and m.sku_id = ${input.skuId}::uuid
       group by 1, 2
    `);

    // decision 8: "rows absent from the ledger -> deleted".
    await tx.execute(sql`
      delete from wms.stock_balance b
       where b.client_id = ${input.clientId}::uuid and b.sku_id = ${input.skuId}::uuid
         and not exists (
           select 1
             from wms.stock_movements m
            where m.client_id = b.client_id
              and m.sku_id = b.sku_id
              and coalesce(m.to_location_id, m.from_location_id) = b.location_id
              and coalesce(m.batch_no, '') = b.batch_no
         )
    `);

    let rowsWritten = 0;
    for (const row of foldResult.rows) {
      await tx.execute(sql`
        insert into wms.stock_balance (client_id, sku_id, location_id, batch_no, qty_on_hand, last_movement_at)
        values (${input.clientId}::uuid, ${input.skuId}::uuid, ${row.location_id}::uuid, ${row.batch_no},
                ${row.qty_on_hand}::numeric, ${row.last_movement_at}::timestamptz)
        on conflict (client_id, sku_id, location_id, batch_no)
        do update set
          qty_on_hand = excluded.qty_on_hand,
          last_movement_at = excluded.last_movement_at
      `);
      rowsWritten += 1;
    }

    return { rowsWritten };
  });
}
