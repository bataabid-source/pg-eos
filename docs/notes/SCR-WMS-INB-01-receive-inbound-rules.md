# SCR-WMS-INB-01 — receive-inbound rules not written in doc 40 §C3, and the variance photo

**Status: §1–§6 RESOLVED.** §1–§4: GM decision sheet 3 (superseded — answers recorded verbatim as D-150–D-159 in `docs/DECISION_LOG.md`): §1 Q3
ب, §2 Q4 أ, §3 Q5 أ, §4 Q6 أ. See each item's own "Resolution (sheet 3)" line below; item 4's
schema addition is applied in `database/migrations/0010_M_idempotency-keys-variance-photo.sql`.
Filed under **EXECUTION-MASTER-v4 §1.11 (G-01)** by the Master during WBS 2.9 (golden slice),
2026-09-24, on pg-reviewer's golden-slice review (round 2, finding 3).

## 1. Close straight from `received` when no line needs a put-away

doc 40 §C3 draws `… received → putaway → closed(WH_SUP)`. An order whose **every** line was received with quantity 0 (fully short, with a variance reason) has nothing to put away, so it can never reach `putaway` and could never close. **Built:** the machine has an edge `received —CLOSE→ closed`; CloseInbound's own rule ("no line may still be open") decides whether it can be taken. **GM decides:** keep this edge, or require such an order to be cancelled instead.

**Resolution (sheet 3): §1 Q3 ب** — no close; the order is cancelled instead. The
`received —CLOSE→ closed` edge is REMOVED from `modules/wms/domain/receive-inbound/machine.ts`.
CANCEL stays legal from `draft`, `approved` and `received` ONLY — Q5 أ's "cancel refused after
any receipt" stands as a status gate (no `receiving —CANCEL→ cancelled` edge at all); Q3 ب only
adds a narrow exception once the order reaches `received`: an order whose EVERY line was received
at qty_actual = 0 may still be cancelled from there, because CancelInbound's own business rule
(§3) is a SEPARATE qty_actual > 0 check that such an order always passes. See §3 for the exact
rule.

## 2. A zero-quantity line completes without a put-away

**Built:** a line received with `qty_actual = 0` plus a `variance_reason` posts **no** ledger row and is stored `status = 'complete'` with `location_id` null; CloseInbound treats it as closed. doc 40 §C3 does not say how a fully short line ends. **GM decides:** accept, or add a line-cancel command instead.

**Resolution (sheet 3): §2 Q4 أ** — accepted as built: a qty-0 line completes without a
put-away and posts no ledger row, and (per Q3 ب above, a mixed order that also has non-zero
lines) still counts as complete for CloseInbound's own gate even without a `location_id`.

## 3. CloseInbound and CancelInbound as named commands

doc 40 §C3 lists the commands `ApproveInbound, ReceiveLine, SuggestLocation, ConfirmPutaway`. The state machine's `closed(WH_SUP)` and `cancelled` states need commands to reach them. **Built:** `CloseInbound` (role WH_SUP) and `CancelInbound` (role WH_MGR, refused once any line is received). **GM decides:** confirm both, and the WH_MGR gate on cancel.

**Resolution (sheet 3): §3 Q5 أ** — confirmed as built: `CloseInbound` (WH_SUP), `CancelInbound`
(WH_MGR, "refused after any receipt"). The exact rule, combining Q5 أ and Q3 ب: (1) the machine
allows CANCEL only from `draft`, `approved` or `received` — never `receiving`, so an order still
mid-receipt is always refused; (2) CancelInbound's own business rule additionally refuses it if
any line already has `qty_actual > 0` (stock physically moved). Together, the ONLY order that may
be cancelled once receiving has started is one that reached `received` with EVERY line at
qty_actual = 0 — every other received-or-later order is refused, exactly as Q5 أ confirmed.

## 4. Variance photo — no column (schema gap)

doc 40 §C3 `ReceiveLine` says "photo if variance". `wms.order_lines` has **no** photo column. The golden slice therefore does **not** accept a photo (it was removed from the contract rather than silently dropped). **Requested:** on `wms.order_lines`, `variance_photo_url text` plus `variance_photo_sha256 text` (the same proof-of-image pattern as `tms.proof_of_delivery.sha256`), both classified; the upload mechanism arrives with the PDA screen slice. **GM decides:** approve the columns, or keep variance photos out of the pilot (D-127).

**Resolution (sheet 3): §4 Q6 أ** — approved. Columns added in migration
0010_M_idempotency-keys-variance-photo.sql (`variance_photo_pair` CHECK: both null or both set,
sha256 hex). `packages/contracts/wms/receive-inbound.ts`'s `ReceiveLineInputSchema` accepts
`variancePhotoUrl`/`variancePhotoSha256`; a photo is allowed only on a variance receipt
(`VariancePhotoWithoutVarianceError`, 422, `modules/wms/domain/receive-inbound/invariants.ts`);
persisted to `wms.order_lines` and included in the GRN snapshot line only when present. The upload
mechanism itself still arrives with the PDA screen slice.

## 5. Not in this request (recorded elsewhere)

- Storing Idempotency-Key values for replay: requested in SCR-PLAT-IDEM-01 — **APPROVED**, D-150 (table)/D-151 (30-day retention), `docs/DECISION_LOG.md`.
- Observability (a logger and a monitoring dashboard, doc 36 §5-4 #10): sheet 3 Q7 أ — pino wired as `ReceiveInboundDeps.logger` via the shared `@pg-eos/logger` package (`modules/wms/infrastructure/receive-inbound/logger.ts`); every unknown (500) api error is logged. The monitoring dashboard remains a follow-up.
- `audit_log.device_id` from the PDA (CHANGELOG carried item): arrives with the PDA screen slice, which is the first caller that has a device id.

## 6. All-zero order: GRN and billing event before cancel — WAITING_GM

An order whose every line is received at qty_actual = 0 still reaches `received` through the
normal `ReceiveLine` flow (`modules/wms/application/receive-inbound/receive-line.ts`), and that
command — unconditionally, on every order reaching `received` — allocates a GRN document and
writes the `wms.inbound.received` outbox event (doc 40 §C3 line 262), which billing consumes as
an `HD-*` billable event. §1's resolution then lets that SAME order be CANCELLED from `received`.
So a fully-short order gets a GRN and a billing event BEFORE it is cancelled — no suppression is
built for this case; the code is unchanged from §1/§2's resolution. **GM decides:**

- (a) keep the GRN and the event as built. The billable event then STANDS after the cancel: CancelInbound writes only an audit row, and no `wms.inbound.cancelled` event exists in `packages/events/catalog.ts`. Voiding it would need a new catalogued cancel event — a new rule the GM would approve by name; or
- (b) suppress the GRN and the `wms.inbound.received` event when every line of the order is
  qty_actual = 0 (a code change to `receive-line.ts`, not built in this slice).

**Resolution: (b) applied** — no GRN and no `wms.inbound.received` for an all-zero order. When
`ReceiveLine` completes the LAST line and every line of the order has qty_actual = 0,
`receive-line.ts` writes no `platform.documents` row, allocates no GRN doc_no (no
`platform.counters` row lock), and writes no `wms.inbound.received` outbox event or its audit row.
The line write, the transition to `received`, the version bump, the line's own audit row, and the
`wms.inbound.variance` event for the zero line are unchanged. A mixed order (some lines non-zero)
still gets its GRN and event exactly as before. See
`modules/wms/domain/receive-inbound/invariants.ts`'s `isAllZeroOrder` and
`modules/wms/application/receive-inbound/receive-line.ts` steps 5b/6/8.

## 7. Schedule the inbound (appointment) — GM observation D-168 (2026-09-24)

**Observation (verbatim):** "هناك ملاحظة: طلب التسليم أو التوريد (مسودة) الذي يصدره العميل لنا — لاحظت أن الخيارات التي يقدمها النظام هي القبول أم الرفض؛ هناك خيار آخر يجب أن يُضاف: الجدولة وتحديد الوقت والتاريخ"

**What exists:** `wms.inbound_orders.expected_at timestamptz` (01:742, nullable, never set by any command today) and `arrived_at`. The golden slice offers `ApproveInbound` (draft → approved) and `CancelInbound` (draft/approved → cancelled). There is no way to give the client a date and time, and no reason travels back to the client on a cancel.

**Requested (no new state — an appointment is a fact on the order, not a status):**
- Command **`ScheduleInbound`** — roles `WH_MGR` or `WH_SUP`; legal in `draft` and `approved` (self-transition, version bump); input `expectedAt` (timestamptz, must be in the future, warehouse working days/hours when Q12 of D-141 is ever set — until then any time), optional `dockCode` and `scheduleNote`; writes `expected_at`, `scheduled_by`, `scheduled_at` (new columns: `scheduled_by uuid`, `scheduled_at timestamptz`), outbox event **`wms.inbound.scheduled`** + audit row in the same transaction. Rescheduling = the same command again (history is the audit chain).
- **Approve and schedule together:** `ApproveInbound` gains an optional `expectedAt` so the manager can accept and give the slot in one step; when present it emits both `wms.inbound.approved` and `wms.inbound.scheduled`.
- **Reject with reason:** `CancelInbound` from `draft`/`approved` gains a mandatory `cancelReason` (new column `cancel_reason text`) — today the client learns nothing. Event `wms.inbound.cancelled` carries it.
- **Client side:** the portal ASN screen (doc 27 §6 screen 5, WBS 6.1) shows the three outcomes — approved with appointment · rescheduled · rejected with reason — and the appointment on "my orders"; the client API (6.2) exposes `expected_at`. Notification to the client on schedule/reschedule/reject through `alert_rules` channels (new rule, code proposed **N-23** "inbound scheduled / rescheduled / rejected", target CLIENT_ADMIN + CLIENT_CREATOR, in-app + email).
- **Board:** the WH_SUP board's "استلام" group shows today's appointments ordered by `expected_at`; an approved order without an appointment is a card "بلا موعد" (no schema — a query).

**Schema (G-01, with this note):** `wms.inbound_orders` + `scheduled_by`, `scheduled_at`, `cancel_reason`, `dock_code` (nullable; docks are not modelled today — free code until a docks table is requested). Column classification `public`. `chk_inbound_orders_status` unchanged.

**Timing (default taken):** staged as **2.9b "Schedule inbound (appointment)"** in `tasks/backlog/` — the first slice to be replicated from the golden template (`new-slice.sh wms schedule-inbound`), lane 2, depends 2.9; migration number issued when it starts, pg-reviewer pre-migration review first. It does not reopen 2.9.

## 8. Logistics terms on the order — GM directive D-169 (2026-09-24)

**Directive (verbatim):** "سيناريوهات التسليم: مخزن بريميوم - موقع العميل · الشحن والتوصيل: بواسطة العميل - بواسطة بريميوم · نوع المركبة · عمال شحن وتفريغ"

**Reading (default recorded):** every inbound *and* outbound order carries four **logistics terms**, agreed at approval/scheduling time (§7), that decide who moves the goods, where hands change, which vehicle, and who loads/unloads — and therefore which catalog events are generated:

| Term | Values | Inbound meaning | Outbound meaning |
|---|---|---|---|
| `handover_point` | `premium_warehouse` · `client_site` | goods are handed to us at our warehouse (client/carrier brings them) **or** collected by us at the client's site | goods are collected by the client at our warehouse **or** delivered to the client's site |
| `transport_by` | `client` · `premium` | who moves the goods to the handover point | who moves them from it |
| `vehicle_type` | `container_20` · `container_40` · `truck` · `trailer` · `van` · `pickup` · `other` (closed list; `vehicle_type text` exists on `wms.inbound_orders` 01:744 and gains the check) | drives the receiving service: HD-01 / HD-02 / HD-03 | drives loading OF-09 and, if `transport_by = premium`, the delivery service (DL-02 B2B / DL-03 dedicated trip / DL-06 by distance per contract) |
| `labour_by` + `labour_count` | `client` · `premium` · `shared`; integer ≥ 0 | who unloads; when `premium`, HD-04 (palletised) or HD-05 (manual cartons) events are generated per unit and, outside working hours, HD-13 per hour | who loads; OF-09 per unit |

**Consequences:**
- `transport_by = premium` on an inbound whose `handover_point = client_site` **creates a `tms.delivery_task` of type `pickup_delivery`** (SCR-TMS-PICKUP-01, D-137) from the client site (`platform.sites`, SCR-HR-SHIFT-01 §2.4) to the warehouse, linked by `inbound_orders.delivery_task_id` (new column; outbound already has `delivery_task_id` 01:765). Its arrival is the `arrived_at` of the order.
- `labour_count` feeds the WH_SUP board (workers to assign for the appointment) and, when 2.20 work orders exist, becomes the work order's crew size. No labour is billed unless `labour_by ∈ {premium, shared}` and the contract carries the HD line (price precedence rules of doc 04 unchanged).
- The four terms default from the **contract** (`sales.contracts` gains `default_handover_point`, `default_transport_by`, `default_labour_by`) and may be overridden per order by WH_MGR/WH_SUP at approval or scheduling; the client may propose them on the portal ASN/outbound screens (6.1) and the API (6.2).
- Billing events are derived at `received` (inbound) / `dispatched` (outbound) from the stored terms — never re-typed by hand; `wms.inbound.received` and `wms.outbound.dispatched` payloads carry the four terms so Phase-4 billing prices them without a second read.

**Schema (G-01, with the slice):** `wms.inbound_orders` + `handover_point`, `transport_by`, `labour_by`, `labour_count`, `delivery_task_id`, check on `vehicle_type`; the same four on `wms.outbound_orders` (which already has `delivery_task_id`); three defaults on `sales.contracts`. All classified `commercial`. Check lists as above.

**Scope (default taken):** folded into **2.9b** (terms are set in the same approve/schedule step) for the inbound side; the outbound side rides the first outbound slice (2.11). Nothing in 2.9 is reopened.
