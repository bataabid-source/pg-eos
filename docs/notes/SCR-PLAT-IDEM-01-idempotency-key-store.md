# SCR-PLAT-IDEM-01 — Idempotency-Key store (409 on reuse, 30-day replay)

**Status: APPROVED** — GM decision sheet 3 (`docs/notes/2026-09-24-gm-decision-sheet-3.md`), Q1 أ
(approve `platform.idempotency_keys` as specified, shared by every module) / Q2 ب (retention 30
days, overriding doc 40 §A4's 7, held in `platform.thresholds` — never a literal in code). Applied
in `database/migrations/0010_M_idempotency-keys-variance-photo.sql`. The shared helper is
`packages/db/src/idempotency.ts`'s `withIdempotentContext`, wired into every write command of
`modules/wms/application/receive-inbound/*` and its `api/receive-inbound/handlers.ts`.

Filed under **EXECUTION-MASTER-v4 §1.11 (G-01)** by the Master during WBS 2.9 (golden slice),
2026-09-24. Originally blocked `.golden-slice-accepted` — pg-reviewer (golden-slice review, round
2, finding 2): a presence-only Idempotency-Key check must not become the pattern every copied
slice inherits.

## 1. Why this is a gap and not an invention

| doc 40 §A4 requires | Present in 01 / 13 / 13B / 019? |
|---|---|
| every write endpoint carries an `Idempotency-Key` | yes, as a header rule — enforced for presence in `modules/wms/api/receive-inbound/handlers.ts` (`requireIdempotencyKey`) |
| **409** when a key is reused with a **different** body | **no** — no table records which body a key was first used with |
| a **replay** of the prior result for **7 days** | **no** — no table stores the prior response, and no retention job exists |

`select table_name from information_schema.tables where table_name ilike '%idempot%'` returns nothing on the live schema (2026-09-24).

## 2. Requested addition (shape for GM approval; DDL only after approval)

`platform.idempotency_keys` — one row per (key, caller):

| column | type | note |
|---|---|---|
| `key` | `text not null` | the header value |
| `user_id` | `uuid not null` | the caller (`platform.current_user_id()`); keys are scoped per user |
| `entity_id` | `uuid` | entity scope, like every operational table |
| `endpoint` | `text not null` | e.g. `wms.receive-inbound.approve` |
| `request_hash` | `text not null` | sha256 of the canonical request body |
| `response_status` | `int` | null while the first call is in flight |
| `response_body` | `jsonb` | the prior result, returned on replay |
| `created_at` | `timestamptz not null default now()` | |
| `expires_at` | `timestamptz not null` | created_at + the retention value below |

Unique `(user_id, key)`. RLS: own rows only (`user_id = platform.current_user_id()`), plus `entity_scope`. Every column classified in `identity.column_classification`.

**Retention:** 7 days per doc 40 §A4 — as a `platform.thresholds` value, not a literal (CLAUDE.md "no magic numbers"). A purge job (pg-boss) deletes expired rows; this is operational data, not a ledger.

**Behaviour (api layer, one shared helper every slice's handlers call):** insert the key in the command's own transaction; same key + same hash → return the stored response; same key + different hash → 409 Problem; key in flight → 409 (retry later).

## 3. What the GM decides

1. Approve the table and its placement in `platform` (shared by every module), or name another schema.
2. The retention value (doc 40 says 7 days).
3. Whether 2.9 may be accepted with this SCR open and the helper wired later, or must wait for it.

## Resolution (sheet 3)

Q1 أ · Q2 ب (30 days). Applied in migration 0010; the helper (`packages/db/src/idempotency.ts`) is
wired into every write command's handler in `modules/wms/api/receive-inbound/handlers.ts`.

**§2 note — entity scope is inert today:** the api layer builds `IdempotencyInput.entityId` as
`null` for every write handler — the request body has not been parsed into a command yet at the
point the key is claimed, and the command itself is what resolves which entity the target row
belongs to, so no entity id is available to the api layer before the command runs. `entity_id`
therefore stays `null` on every key row written so far, and the `idem_entity_scope` RESTRICTIVE
policy (migration 0010) is scoped per-user only in practice: it has nothing to restrict against
until a caller supplies a non-null `entityId`. This is not a gap to fix in this slice — recorded
here so a future caller that DOES know its entity up front is not surprised the column is unused.
