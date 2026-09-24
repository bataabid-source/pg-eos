# SCR-WMS-INB-01 — receive-inbound rules not written in doc 40 §C3, and the variance photo

**Status: §1–§4 RESOLVED; §6 WAITING_GM and blocks `.golden-slice-accepted`** (answer (b) would change `receive-line.ts`, which every copy inherits). §1–§4: GM decision sheet 3 (`docs/notes/2026-09-24-gm-decision-sheet-3.md`): §1 Q3
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

- Storing Idempotency-Key values for replay: requested in SCR-PLAT-IDEM-01 — **APPROVED**, sheet 3 Q1/Q2.
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
