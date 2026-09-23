# SCR-AUDIT-01 — `platform.audit_hash_chain()` chains by lock order, `verify_audit_chain()` verifies by `(occurred_at, id)`: concurrent writers break the chain

**Status: OPEN — GM decision required** (raised under EXECUTION-MASTER-v4 §1.11, G-01).
Date: 2026-09-23 · Raised by: WBS 2.8 (pg-backend, sonnet) during the decision-11 concurrency scenario; verified by the Master against the schema text.
Blocks: WBS 2.8 acceptance gates (G8, G14 go red after the 1,000-movement concurrent run) and, latently, every slice that writes `platform.audit_log` from more than one connection at a time — i.e. production.

## 1. The defect

`database/schema/13B-Schema-Reference-Consolidation.sql` lines 239-258 (trigger) and the `verify_audit_chain()` function (13B, same section):

- The BEFORE INSERT trigger takes `pg_advisory_xact_lock(hashtext('platform.audit_log'))`, then selects the previous row as
  `order by occurred_at desc, id desc limit 1` and hashes `new` against it. The chain is therefore built in **lock-acquisition order**.
- `id bigserial` and `occurred_at default now()` are evaluated by the column defaults **before** the BEFORE-ROW trigger runs (PostgreSQL
  applies defaults first, then BEFORE triggers). Neither value reflects the order in which transactions acquire the lock.
- `verify_audit_chain()` recomputes the chain with `lag(row_hash) over (order by occurred_at, id)` — **timestamp/id order**.

With two overlapping transactions A and B: A gets `id 5` / `now() = t1`, B gets `id 6` / `now() = t2 > t1`; B acquires the advisory lock
first and chains after row 4; A then chains after B. The verifier orders 4 → 5 → 6, expects 5's `prev_hash` = hash(4), finds hash(6) →
row 5 reported broken, and every later row's `chain_prev` disagrees too. The same happens whenever `occurred_at` is equal (frozen
clock in tests, `original_occurred_at` back-dating, coarse clocks) or whenever lock order differs from `now()` order — which real
concurrency does not guarantee.

## 2. Reproduction (pg-backend, twice, fresh database each time)

1. `bash database/schema/apply.sh --recreate` → `select count(*) from platform.verify_audit_chain()` = 0.
2. `pnpm --filter @pg-eos/wms test` — the WBS 2.8 scenario "1,000 random movements under concurrency" posts ledger rows with ≥ 20
   transactions in flight; each posts one `platform.audit_log` row in the same transaction (doc 40 G9 / CLAUDE.md ARCHITECTURE).
3. `select count(*) from platform.verify_audit_chain()` → **~700 rows** on the first run, **~3,500+** on the second; `pnpm guards:run`
   → G8 and G14 RED. The corruption is permanent (audit rows are never deleted) until the database is recreated.
4. The Master read the trigger and the verifier text (this note §1) and confirms the mechanism without needing the run.

The 0.9 acceptance test (`modules/platform/tests/integration/schema-invariants.test.ts`) proves tamper detection with sequential
inserts only; it never exercised two concurrent audit writers.

## 3. Why this is a G-01 request and not a 2.8 fix

Trigger and verifier live in 13B (governing schema, frozen path for lanes; single-lane Master task). Nothing in `modules/wms/src/`
can make two independent transactions agree on an order that the schema itself does not define. Working around it in 2.8 (e.g.
serialising all ledger posts behind one global lock, or sleeping between posts) would hide a platform defect inside a module and
violate CLAUDE.md "never weaken a test to pass it".

## 4. Options for the GM

| # | Change | Effect | Cost |
|---|---|---|---|
| A | **Order = lock order, explicitly.** Add `chain_seq bigint not null` to `platform.audit_log` (on every partition), assigned inside the trigger *after* the advisory lock from a dedicated sequence; the trigger selects the previous row by `order by chain_seq desc limit 1`; `verify_audit_chain()` orders by `chain_seq`. `id`/`occurred_at` keep their meaning. | Deterministic chain under any concurrency; verifier and trigger use one and the same order. | 13B edit + migration `0004_M_audit-chain-seq.sql` (add column, backfill by current `(occurred_at, id)`, replace trigger + function, PK/partition untouched); doc 31 §4 / doc 40 Part F G8 prose mention the ordering key; classification row for the new column (G6). |
| B | **Allocate `id` under the lock.** In the trigger, after the lock: `new.id := nextval(pg_get_serial_sequence('platform.audit_log','id'))`; previous row by `order by id desc`; verifier orders by `id` only. | Same guarantee as A without a new column. Relies on `id` never being supplied by callers (today no caller sets it). | 13B edit + migration `0004_M_audit-chain-id-order.sql` (replace trigger + function; no column). `occurred_at` ordering in the verifier is dropped, so back-dated rows (`original_occurred_at`) no longer matter. |
| C | **Accept the design; operational rule.** Keep the schema; document that the chain is only valid if audit writers never overlap; recreate/re-chain before guard runs. | No code change. | Not viable for production (concurrent audited actions are the normal case: PDA, driver app, portal). G8/G14 cannot be trusted. |

Master recommendation: **B** (smallest change, one order for trigger and verifier, no new column), with A if the GM wants `id` to stay
a pure surrogate. Either way the migration must re-hash nothing: existing rows were chained in lock order and their `prev_hash`
values are what they are — the migration rebuilds the chain once (`chain_prev` recomputed in the new order and `row_hash`
re-derived) inside one transaction, and `verify_audit_chain()` must return 0 immediately after.

## 5. What is on hold until the decision

- WBS 2.8 close-out: implementation is functionally green (unit 12/12, integration 20/24 + 3 skipped + 1 timeout — see the
  pg-backend report) but its concurrency scenario corrupts the chain and turns G8/G14 red, so the slice cannot pass the gates
  as written. Two test-side items also wait: the append-only fixture role name must not start with `pg_` (reserved), and the
  1,000-movement test needs an explicit per-test timeout (≈ 10–12 s of real DB work).
- Phase D (WBS 1.5) — start condition "every phase-C gate green" not met.
- Carried-forward from 2.8 for the same decision meeting: `wms.verify_balance_integrity()` folds without `batch_no` while
  `wms.stock_balance` is keyed with it (false positives once a location holds several batches); 2.8 uses `batch_no = ''` only.

## 6. GM decision 2026-09-23: option A — two literal conflicts found before implementation (STOP)

The GM chose option A with this wording (directive item G2): *"`chain_seq bigint NOT NULL UNIQUE` … allocated inside the trigger
after `pg_advisory_xact_lock` from a dedicated sequence … `verify_audit_chain()` orders by `chain_seq` only and detects gaps and
duplicates."* Two parts cannot hold together on PostgreSQL 16 as written. Both were reproduced on the local server (16.15) before
any schema edit:

| # | Wording | What PostgreSQL does | Evidence |
|---|---|---|---|
| 1 | `UNIQUE` on `chain_seq` | `platform.audit_log` is partitioned by `occurred_at`; a unique constraint on a partitioned table must include every partition-key column. `unique (chain_seq)` is refused; `unique (chain_seq, occurred_at)` is accepted but does not make `chain_seq` unique. | `ERROR: unique constraint on partitioned table must include all partitioning columns — DETAIL: UNIQUE constraint on table … lacks column "occurred_at"` |
| 2 | "from a dedicated sequence" + "detects gaps" | A sequence value taken by a transaction that later rolls back is never returned. Any audited transaction that fails after its audit insert (a later constraint, an outbox error, a client disconnect) leaves a permanent hole, which the verifier would then report as a chain failure. | `begin; nextval → 1; rollback;` then `nextval → 2` |

### Resolution the Master recommends (needs the GM's word — not implemented)

- **Numbering:** `chain_seq` = previous row's `chain_seq + 1`, read in the same trigger query that already fetches the previous
  `row_hash`, after `pg_advisory_xact_lock`. The lock is held until commit or rollback, so writers are strictly serialised: no two
  rows can get the same number, and a rolled-back row releases its number to the next writer. The numbering is gapless, so a
  gap then really means a deleted row — which is the tamper signal the gap check is meant to catch. No sequence object is needed.
- **Uniqueness:** a unique index on `chain_seq` **per partition**, created by the migration and by the monthly partition job, plus
  the verifier's duplicate check across all partitions. Global uniqueness is guaranteed by the lock, not by a constraint, since
  PostgreSQL cannot declare one on this table.
- **Verifier:** orders by `chain_seq` only; reports hash mismatches, `prev_hash` mismatches, duplicate `chain_seq` values, and gaps
  (`chain_seq - lag(chain_seq) <> 1`, first row = 1).
- **Assumption kept from today's design:** audited writes run under READ COMMITTED (the default and what `withContext` uses), so the
  trigger's query sees the row committed by the previous lock holder. REPEATABLE READ / SERIALIZABLE writers would need a
  retry; ADR-0002 would state this.

Alternatives if the GM prefers to keep the wording: (i) keep the sequence and report gaps as information, not failures (the gap
check then says nothing about tampering); (ii) add a non-partitioned side table keyed by `chain_seq` for a true global unique
constraint (a new table, which needs its own G-01 approval).
