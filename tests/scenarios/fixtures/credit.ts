// tests/scenarios/fixtures/credit.ts — S6 (docs/notes/slice-briefs/_slice-X-s6.brief.md): a single
// overdue billing.invoices insert/delete helper. No fixture for billing.invoices exists in
// ./seed.ts or ./partners.ts (grep-checked) — same discipline as those two files: a fresh row per
// call, FK-safe, own-rows-only delete, `platform.next_doc_no` for the doc-numbered column, exactly
// as seed.ts's own `insertContract` / partners.ts's own `insertPartnerInvoice` do.
//
// `balance` is a GENERATED column (13B, `\d billing.invoices`) — never inserted here, only read
// back. `doc_no` must be NOT NULL because `status = 'overdue'` is outside `('draft','review')`
// (`doc_no_only_when_approved` CHECK) — `platform.next_doc_no` supplies it.

import type { Pool, QueryResult } from 'pg';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

// `platform.counters` carries an `INV` row for every entity (psql-checked: PST-INV- current_val
// 100) — the doc-type code this fixture's `next_doc_no` call uses.
const INVOICE_DOC_TYPE = 'INV';
// billing.invoices.invoice_type / .currency schema defaults (`\d billing.invoices`) — set
// explicitly here rather than relied on, since the brief names both as columns to populate.
const INVOICE_TYPE_STANDARD = 'standard';
const INVOICE_CURRENCY_KWD = 'KWD';
// legal under `chk_invoices_status` (`\d billing.invoices`, psql-checked) — exported so callers
// assert against the same named constant this fixture inserts, never a second bare literal.
export const INVOICE_STATUS_OVERDUE = 'overdue';

export interface InsertOverdueInvoiceParams {
  readonly entityId: string;
  readonly clientId: string;
  readonly contractId: string;
  /** subtotal is set equal to total (no tax/discount in this fixture); balance is GENERATED as
   *  (total - paid_amount), paid_amount stays at its own NOT NULL DEFAULT 0. */
  readonly total: string;
  readonly issueDate: string;
  readonly dueDate: string;
}

export async function insertOverdueInvoice(pool: Pool, params: InsertOverdueInvoiceParams): Promise<string> {
  const docNoResult: QueryResult<{ doc_no: string }> = await pool.query(`select platform.next_doc_no($1, $2) as doc_no`, [
    params.entityId,
    INVOICE_DOC_TYPE,
  ]);
  const docNo = docNoResult.rows[0]?.doc_no;
  if (!docNo) throw new Error(`platform.next_doc_no returned no row for ${INVOICE_DOC_TYPE}`);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into billing.invoices
       (entity_id, doc_no, client_id, contract_id, invoice_type, status, issue_date, due_date, currency, subtotal, total)
     values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10::numeric, $10::numeric)
     returning id`,
    [
      params.entityId,
      docNo,
      params.clientId,
      params.contractId,
      INVOICE_TYPE_STANDARD,
      INVOICE_STATUS_OVERDUE,
      params.issueDate,
      params.dueDate,
      INVOICE_CURRENCY_KWD,
      params.total,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('fixture billing.invoices insert returned no row');
  return row.id;
}

export async function deleteInvoice(pool: Pool, invoiceId: string): Promise<void> {
  await pool.query(`delete from billing.invoices where id = $1`, [invoiceId]);
}
