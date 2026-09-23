// modules/wms/src/stock-ledger/rebuild-balance.ts — WBS 2.8 (pg-backend).
//
// decision 8 / doc 40 P4: balances are derived and rebuildable with zero diff.
// rebuildBalance(ctx, { clientId, skuId }) recomputes qty_on_hand per (location_id, batch_no) from
// the ledger with the SAME fold wms.verify_balance_integrity() uses (01:1493:
// `sum(case when to_location_id is not null then qty else -qty end)`, grouped by
// (client_id, sku_id, coalesce(to_location_id, from_location_id))) and overwrites wms.stock_balance
// for that (client, sku) in one transaction: rows the ledger no longer has any movement for are
// deleted; qty_allocated is preserved (not part of the `set` clause below, so an existing row's
// value survives the upsert — 2.11's concern, not 2.8's).
//
// `last_movement_at` is set from the ledger's own last movement time for that (location, batch)
// pair — the actual last time stock moved there — rather than "now the rebuild ran", which would
// misrepresent history for a balance nobody has touched since.

import { withContext, type WithContextCtx } from '@pg-eos/db';
import type { LedgerDeps } from './post-movement.js';
import { sql } from 'drizzle-orm';

export async function rebuildBalance(
  ctx: WithContextCtx,
  input: { readonly clientId: string; readonly skuId: string },
  // Not used: rebuildBalance recomputes purely from the ledger's own stored occurred_at values
  // (see file header) — it never needs "now", so no Clock/IdGenerator call is needed here. Kept in
  // the signature per the brief's Public surface block (positional-call contract).
  _deps: LedgerDeps,
): Promise<{ readonly rowsWritten: number }> {
  return withContext(ctx, async (tx) => {
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
