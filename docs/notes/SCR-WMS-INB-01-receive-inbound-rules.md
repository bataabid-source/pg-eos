# SCR-WMS-INB-01 — receive-inbound rules not written in doc 40 §C3, and the variance photo

**Status: WAITING_GM. Blocks `.golden-slice-accepted`** — items 1–3 are built into code the template copies, so a GM ruling against any of them changes that code before it may be replicated. Filed under **EXECUTION-MASTER-v4 §1.11 (G-01)** by the Master during WBS 2.9 (golden slice), 2026-09-24, on pg-reviewer's golden-slice review (round 2, finding 3). Items 1–3 are **Master defaults already built** into the golden slice and need a GM ruling to stand; item 4 is a **schema gap** (no DDL until approved). Nothing in `database/schema/*` or `database/migrations/*` is touched by this request.

## 1. Close straight from `received` when no line needs a put-away

doc 40 §C3 draws `… received → putaway → closed(WH_SUP)`. An order whose **every** line was received with quantity 0 (fully short, with a variance reason) has nothing to put away, so it can never reach `putaway` and could never close. **Built:** the machine has an edge `received —CLOSE→ closed`; CloseInbound's own rule ("no line may still be open") decides whether it can be taken. **GM decides:** keep this edge, or require such an order to be cancelled instead.

## 2. A zero-quantity line completes without a put-away

**Built:** a line received with `qty_actual = 0` plus a `variance_reason` posts **no** ledger row and is stored `status = 'complete'` with `location_id` null; CloseInbound treats it as closed. doc 40 §C3 does not say how a fully short line ends. **GM decides:** accept, or add a line-cancel command instead.

## 3. CloseInbound and CancelInbound as named commands

doc 40 §C3 lists the commands `ApproveInbound, ReceiveLine, SuggestLocation, ConfirmPutaway`. The state machine's `closed(WH_SUP)` and `cancelled` states need commands to reach them. **Built:** `CloseInbound` (role WH_SUP) and `CancelInbound` (role WH_MGR, refused once any line is received). **GM decides:** confirm both, and the WH_MGR gate on cancel.

## 4. Variance photo — no column (schema gap)

doc 40 §C3 `ReceiveLine` says "photo if variance". `wms.order_lines` has **no** photo column. The golden slice therefore does **not** accept a photo (it was removed from the contract rather than silently dropped). **Requested:** on `wms.order_lines`, `variance_photo_url text` plus `variance_photo_sha256 text` (the same proof-of-image pattern as `tms.proof_of_delivery.sha256`), both classified; the upload mechanism arrives with the PDA screen slice. **GM decides:** approve the columns, or keep variance photos out of the pilot (D-127).

## 5. Not in this request (recorded elsewhere)

- The Idempotency-Key store: SCR-PLAT-IDEM-01.
- Observability (a logger and a monitoring dashboard, doc 36 §5-4 #10): pino is not yet a dependency — a GM batch question, not a schema change.
- `audit_log.device_id` from the PDA (CHANGELOG carried item): arrives with the PDA screen slice, which is the first caller that has a device id.
