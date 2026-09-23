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

## 7. GM decision 2026-09-23 (#4): §6 resolution approved — implementation plan (for pg-reviewer's migration gate)

Approved: `chain_seq` = previous + 1, computed inside the trigger after the advisory lock, in the same query that fetches the
previous hash; no sequence object; a unique index on `chain_seq` in every partition; the verifier orders by `chain_seq` only and
reports hash mismatch, duplicates and gaps. Rejected: the gap-tolerant sequence and the side table. Extra conditions: (1) every
partition, the default one included, carries the unique index, checked by schema-invariants and by G8; (2) the head lookup uses the
partition indexes, timed on 24 partitions; (3) ADR-0002 documents the verification anchor for detached/archived partitions, with an
anchor parameter if needed; (4) ADR-0002 documents that the lock serialises all audited writes until commit; (5) vitest
`fileParallelism: false` for modules/platform. Acceptance: the 8 × 500 regression test returns 0 broken rows in 3 consecutive runs.

### 7.1 Interface (fixed — the tests are written against it)

- Column `platform.audit_log.chain_seq bigint not null` (parent; inherited by every partition). Assigned only by the trigger; any
  caller-supplied value is overwritten.
- Index `<partition>_chain_seq_key` = `create unique index … on platform.<partition> (chain_seq)` on every partition, default
  included. No index on the parent (a unique one is impossible there; a non-unique one would duplicate the partition indexes).
- Trigger function `platform.audit_hash_chain()` — `security definer`, `set search_path = pg_catalog, pg_temp`, fully qualified
  names. After `pg_advisory_xact_lock(hashtext('platform.audit_log'))`:
  `select a.chain_seq, a.row_hash into v_seq, v_prev from platform.audit_log a order by a.chain_seq desc limit 1;`
  `new.chain_seq := coalesce(v_seq, 0) + 1; new.prev_hash := v_prev;` and `row_hash` with the unchanged doc-31 §4 formula
  (`prev_hash || occurred_at || user_id || table_name || record_id || operation`). SECURITY DEFINER is required because
  `platform.audit_log` has FORCE RLS and, since D-002, an `entity_scope` policy on the parent: an invoker-rights head lookup by a
  non-internal writer would see only its visible rows and fork the chain. The function owner (the schema owner) bypasses RLS.
- Verifier `platform.verify_audit_chain(p_anchor_seq bigint default 1, p_anchor_prev_hash text default null)` returns
  `(chain_seq bigint, id bigint, occurred_at timestamptz, problem text, detail text, expected_hash text, actual_hash text)`.
  Called with no argument it behaves as today's G8 (`select * from platform.verify_audit_chain()` = 0 rows). Rows with
  `chain_seq < p_anchor_seq` are ignored; the first retained row must carry `chain_seq = p_anchor_seq` and
  `prev_hash = p_anchor_prev_hash` (NULL = genesis). `problem` ∈
  `hash_mismatch` · `prev_hash_mismatch` · `duplicate_chain_seq` · `chain_seq_gap` · `partition_missing_chain_seq_unique_index`
  (the last one has null chain_seq/id/occurred_at and the partition name in `detail`). The old zero-argument function is dropped
  (a defaulted overload beside it would make `verify_audit_chain()` ambiguous).

### 7.2 13B edits (v4.2 → v4.3)

`create table platform.audit_log` gains `chain_seq bigint not null`; after the five partitions, five `create unique index`
statements; the trigger and verifier replaced as in 7.1; the two "scheduled task creates next month's partition" notes (13B
lines ~1444 and ~3100) state that the task must also create `<partition>_chain_seq_key` and that G8 fails if it does not.
Formula comment unchanged. No other object touched.

### 7.3 Migration `0004_M_audit-chain-seq.sql` (one transaction, re-runnable on an old-13B or a new-13B database)

1. `lock table platform.audit_log in exclusive mode;` (no audited write during the rebuild).
2. `alter table platform.audit_log add column if not exists chain_seq bigint;`
3. If any row has `chain_seq is null`: one-time rebuild of the whole chain in the current `(occurred_at, id)` order —
   `chain_seq` = 1..n, `prev_hash` = previous row's new `row_hash`, `row_hash` recomputed with the doc-31 formula (row by row,
   plpgsql loop). Allowed only because no production audit data exists yet (ADR-0002); a production database would need a
   separate, GM-approved procedure.
4. `alter column chain_seq set not null`.
5. For every partition of `platform.audit_log` (pg_inherits): `create unique index if not exists <relname>_chain_seq_key`.
6. `create or replace function platform.audit_hash_chain()` (7.1).
7. `drop function if exists platform.verify_audit_chain();` then create the new verifier (7.1).
8. `identity.column_classification`: `chain_seq` = `public` for the parent and every partition, `on conflict do nothing`
   (priority-5 default of migration 0002 — an integrity counter, not a sensitive value).
9. Post-condition inside the transaction: `raise exception` if `platform.verify_audit_chain()` returns any row.

### 7.4 Other changes

- doc 40: §B2 line 143 (the chain is ordered by `chain_seq`, assigned under the lock) and Part F G8 prose/row (verifier orders by
  `chain_seq`; reports gaps, duplicates and a partition without the unique index; concurrency regression test 8 × 500) → v4.3,
  CHANGELOG-v4 entry.
- Tests (pg-tester): new `modules/platform/tests/integration/audit-chain-seq.test.ts` (+ .feature); the isolation suite's
  tail-only teardown switches from `(occurred_at, id)` to `chain_seq`.
- `modules/platform/vitest.config.ts`: `fileParallelism: false` (Master — runner config is outside pg-tester's write scope).
- Timing: head query `EXPLAIN (ANALYZE, BUFFERS)` on 24 partitions, inside a rolled-back transaction, reported in ADR-0002.

### 7.5 Migration-gate review round 1 (pg-reviewer, opus): FAIL(14) — how each finding is resolved

| # | Finding | Resolution (drafts: scratchpad `audit-chain-functions.sql`, `0004_M_audit-chain-seq.sql`, `13B-v4.3.diff`) |
|---|---|---|
| 1 | SECURITY DEFINER bypasses FORCE RLS only with a superuser/BYPASSRLS owner | 0004 post-condition raises unless both functions' owner has `rolsuper or rolbypassrls`; ADR-0002 states the owner requirement for the 0.5/0.6 role design |
| 2 | Verifier rights | Verifier is SECURITY DEFINER too (same search_path/owner rule); `revoke all … from public` |
| 3 | READ COMMITTED not enforced | Trigger raises SQLSTATE 25001 unless `transaction_isolation = 'read committed'` |
| 4 | 13B re-apply / overload / names | 13B drops the zero-arg verifier before creating the new one; comment names `(bigint, text)`; indexes named `<partition>_chain_seq_key` explicitly; 0004 uses `create or replace` with the identical text (one source file). Note: re-applying the schema without `--recreate` already stops at 01 ("relation entities already exists") — pre-existing, unchanged |
| 5 | Rebuild must fail closed | Rebuild branch raises unless `pgeos.audit_chain_rebuild = 'allow'` (PGOPTIONS); old-13B acceptance run done on a scratch DB: refused without opt-in, rebuilt with it (6 broken → 0), rerun no-op |
| 6 | Lock upgrade | `lock table … in access exclusive mode` first |
| 7 | TimeZone/DateStyle in the hash text | `set timezone = 'UTC'`, `set datestyle = 'ISO, YMD'` on trigger and verifier; `set local` in 0004. Proven: insert under Asia/Kolkata, verify under America/New_York → 0 rows |
| 8 | Index check by properties | `indisunique and indisvalid and indpred is null and indexprs is null and indnatts = 1` and key = chain_seq attnum |
| 9 | schema-invariants must check it | pg-tester adds the check to schema-invariants.test.ts |
| 10 | Partition job needs more than the index | 13B notes (both places) list: unique index, RLS enable + force + entity_scope, column classification |
| 11 | Docs | doc 31 §3-3 quotes + ordering row → v4.1; D-blueprints 08 signature rows; platform brief via pg-scribe; CHANGELOG-v4 |
| 12 | Isolation teardown race | Teardown runs in one transaction that first takes the advisory lock (pg-tester) |
| 13 | G8 anchor after the first detach | ADR-0002 raises a G-01 item now: where the anchor lives (proposal: `platform.settings` key read by the verifier's defaults) — decision needed before the first detach (18-month retention ⇒ earliest 2028-03). Until then the defaults (1, NULL) are correct |
| 14 | Restore re-chains | ADR-0002 restore procedure: `pg_restore --disable-triggers` (or `session_replication_role = replica`) by a privileged role, then G8 |
| advisory | Lock-hold / deadlock ordering | ADR-0002: write the audit row as the last statement before commit |
