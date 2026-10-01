// modules/billing/domain/record-billable-event/outbound-checked-services.ts — WBS 4.3 part 1 (lane 2).
//
// domain/ layer: the pure mapping `wms.outbound.checked` -> the fulfilment services billed at
// checked. No I/O, no Date, no Math.random() (CLAUDE.md · AGENT CONSTRAINTS).
//
// Source (doc 40 line 444, S1 step verbatim): "And after checked, billable events OF-01×1, OF-02×1,
// OF-06×1, OF-07×1 exist with status pending". Each entry carries only the catalog `code` and the
// exact decimal `qty` (numeric(14,3) text, see ./invariants.ts assertPositiveQty). `uom` is NOT
// part of the domain: it comes from the `catalog.services` row at run time (brief Decision 2), and
// the service id is read by code, never hard-coded.

/** One service billed for a checked outbound order. */
export interface OutboundCheckedService {
  readonly code: string;
  readonly qty: string;
}

/** doc 40 line 444: "×1" for each code. */
const QTY_ONE = '1';

/** doc 40 line 444 — the services billed when a `wms.outbound_orders` row reaches `checked`, in
 *  the order the spec lists them. */
export const OUTBOUND_CHECKED_SERVICES: readonly OutboundCheckedService[] = [
  { code: 'OF-01', qty: QTY_ONE },
  { code: 'OF-02', qty: QTY_ONE },
  { code: 'OF-06', qty: QTY_ONE },
  { code: 'OF-07', qty: QTY_ONE },
];
