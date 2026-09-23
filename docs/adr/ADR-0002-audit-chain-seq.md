# ADR-0002 — `platform.audit_log` hash chain ordered by a lock-assigned `chain_seq`

**Status:** Accepted
**Date:** 2026-09-23
**Approved by:** GM (directive 2026-09-23 #3 — SCR-AUDIT-01 option A; decision 2026-09-23 #4 — resolution §6 of the SCR note approved, with five extra conditions)
**Reviewed & accepted: opus**
**References:** `docs/notes/SCR-AUDIT-01-hash-chain-order-race.md` (§1 defect, §6 conflicts, §7 plan, §7.5 review resolutions) · `database/schema/13B-Schema-Reference-Consolidation.sql` §13B-2 (v4.3) · `database/migrations/0004_M_audit-chain-seq.sql` · doc 31 §3-3/§4 (formula) · doc 40 §B2 and Part F G8 · `modules/platform/tests/integration/audit-chain-concurrency.test.ts` · `audit-chain-seq.test.ts` · `schema-invariants.test.ts`

## Context (السياق)

- `platform.audit_hash_chain()` (13B v4.2) took `pg_advisory_xact_lock`, then chained the new row to the row with the greatest
  `(occurred_at, id)`. `platform.verify_audit_chain()` re-derived the chain in `(occurred_at, id)` order. `id` and `occurred_at`
  are set by column defaults **before** the BEFORE-ROW trigger takes the lock, and a caller may set `occurred_at` explicitly, so
  the order the chain was built in (lock order) and the order it was verified in could differ. Any two overlapping audited
  transactions, or one back-dated row, broke the chain (SCR note §1).
- Measured **before** the fix — 8 writers × 500 single-row transactions (G4 regression test), fresh database each run:
  **2008 · 2009 · 2004** broken rows. WBS 2.8's 1,000-movement concurrency scenario had earlier produced ~700 and ~3,500+.
- `platform.audit_log` is partitioned by range on `occurred_at` (monthly + default partition). PostgreSQL refuses a unique
  constraint on a partitioned table unless it contains the partition key, and a sequence value used by a rolled-back transaction
  is never reused (both reproduced on PostgreSQL 16.15 — SCR note §6).
- The table has FORCE RLS and, since D-002, an `entity_scope` policy on the parent (13B:3049, migration 0003).

## Decision (القرار)

As approved by the GM (SCR note §6, decision #4):

- `chain_seq` = previous + 1, computed **inside the trigger after the advisory lock**, in the same query that fetches the previous
  hash (`order by chain_seq desc limit 1`). **No sequence object.**
- **A unique index on `chain_seq` in every partition**, the default one included (`<partition>_chain_seq_key`).
- `verify_audit_chain()` **orders by `chain_seq` only** and reports hash mismatch, `prev_hash` mismatch, **duplicates** and
  **gaps**, and — condition (1) — any partition without a valid single-column unique index on `chain_seq`
  (`problem = 'partition_missing_chain_seq_unique_index'`, checked by `pg_index` properties, not by name).
- The formula of doc 31 §4 is unchanged: `row_hash = sha256(prev_hash ‖ occurred_at ‖ user_id ‖ table_name ‖ record_id ‖ operation)`.

Implementation details required by the migration-gate review (SCR note §7.5), which do not change the decision:

- Trigger and verifier are `SECURITY DEFINER` with `search_path = pg_catalog, pg_temp`, so the chain head and the verification
  read the whole table under FORCE RLS. **The owner of both functions must be a superuser or hold BYPASSRLS**; migration 0004
  refuses otherwise. The 0.5/0.6 runtime-role design must keep this true.
- Both pin `timezone = 'UTC'` and `datestyle = 'ISO, YMD'`: the text of `occurred_at` inside the formula no longer depends on a
  writer's session settings.
- The trigger refuses any transaction that is not READ COMMITTED (SQLSTATE 25001): under REPEATABLE READ / SERIALIZABLE the head
  query would not see the previous lock holder's row and would hand out the same number twice.
- Verifier signature: `platform.verify_audit_chain(p_anchor_seq bigint default 1, p_anchor_prev_hash text default null)` —
  condition (3); see "Anchor" below. G8 stays `select * from platform.verify_audit_chain();` = 0 rows.
- `modules/platform` runs its test files sequentially (`fileParallelism: false`) — condition (5).

## Alternatives rejected (البدائل المرفوضة)

| Alternative | Why rejected |
|---|---|
| B — allocate `id` under the lock and verify by `id` | Not chosen by the GM (directive #3 chose A); `id` stays a pure surrogate. |
| C — keep the design and forbid overlapping audit writers | Not viable: concurrent audited actions are the normal case (PDA, driver app, portal); G8 could not be trusted. |
| `chain_seq` from a dedicated sequence, gaps reported as information | Rejected by the GM (#4): a rolled-back transaction leaves a gap, so a gap could never prove a deleted row. |
| Non-partitioned side table keyed by `chain_seq` for a global unique constraint | Rejected by the GM (#4): a new table (own G-01) for a guarantee the lock already gives. |
| `unique (chain_seq, occurred_at)` on the parent | Accepted by PostgreSQL but does not make `chain_seq` unique — decorative. |

## Consequences (الأثر)

**Results after the fix (G4 regression, 8 × 500, three consecutive runs): 0 · 0 · 0 broken rows** — condition of decision #4.
The final numbers from the repository run are recorded in `docs/CHANGELOG.md` under `fix(0.9)`.

**Serialisation (condition 4).** The advisory lock is taken when the audit row is inserted and is held **until commit or
rollback**. Every audited write in the whole system therefore passes through one lock, one transaction at a time:
- A long transaction that has already written its audit row blocks every other audited write until it ends. Rule for every
  slice: **write the audit row as the last statement before commit**, never before a slow step (network call, large batch,
  waiting on user input), and keep audited transactions short.
- Lock order: taking row locks after the audit insert while another transaction holds those rows and waits for the audit lock
  deadlocks. Writing the audit row last also removes that ordering.
- Throughput measured on the local server: 12,000 single-statement audited inserts in 10.08 s (≈ 0.84 ms per row, trigger
  included). This is the ceiling for audited writes per second on one database; it is far above the Tier-0 load (doc 42) and is
  recorded so a later load test (WBS 7.2) can watch it.

**Chain head on 24 partitions (condition 2).** Measured inside a rolled-back transaction on a scratch database with 24 partitions
(23 monthly + default), 23,506 rows, each partition with its `chain_seq` unique index:
`order by chain_seq desc limit 1` → **Merge Append of 24 `Index Scan Backward` on `<partition>_chain_seq_key`**, 70 shared
buffers hit, **execution 1.2 ms**, planning 5.8 ms (first call; plpgsql caches the plan inside the trigger), about 4 ms round
trip from psql. A partition without the index would fall back to a Sort (slower, still correct) — G8 catches it.

**Anchor for detached / archived partitions (condition 3).** Retention is 18 months operational / 10 years financial
(doc 40 §B2). When old partitions are detached or archived, the chain no longer starts at 1. The verification anchor is the
**first retained `chain_seq` together with its `prev_hash`** (the `row_hash` of the last archived row). The archival procedure
must record both in the archive manifest before detaching and verify the archived partitions against the same values, then G8
runs `platform.verify_audit_chain(<anchor_seq>, <anchor_prev_hash>)`: rows below the anchor are ignored, the first retained row
must carry exactly that number and that `prev_hash`. Deleting retained rows still shows as a gap; deleting the oldest rows below
the anchor is what archival is.
**Open G-01 item for the GM (raised now, not implemented):** where the anchor is stored so that the parameterless G8 command
keeps working after the first detach. Proposal: a `platform.settings` key (`entity_id` null, value `{"seq": …, "prev_hash": …}`)
written by the archival job and read by the verifier's defaults when present. Decision needed before the first detach — with
18-month retention from September 2026, no earlier than March 2028.

**Monthly partitions.** The scheduled job that creates next month's partition must also create `<partition>_chain_seq_key`,
enable and force RLS with the same `entity_scope` policy (G7), and classify every column (G6). G8 fails if the index is
missing (13B notes, §13B-2 and the SCH-2 list).

**Restore.** The trigger overwrites any caller-supplied `chain_seq`/`prev_hash`/`row_hash`, so a restore that fires triggers
would re-chain the data in dump order and erase the evidence. Restores of `platform.audit_log` must run with triggers disabled —
`pg_restore --disable-triggers` or `session_replication_role = replica`, by a privileged role — followed by G8 (runbook, WBS
0.20; restore test, WBS 0.8).

**One-time chain rebuild.** Migration 0004 rebuilds the existing chain once in the old `(occurred_at, id)` order, assigning
`chain_seq` 1..n and re-deriving every hash. This rewrites every `prev_hash`/`row_hash` and is allowed only because no production
audit data exists yet. It refuses to run unless `pgeos.audit_chain_rebuild = allow` is set explicitly; a database built with
`apply.sh --recreate` never reaches it (13B v4.3 creates the column). A database holding production audit data needs a separate
GM-approved procedure (CLAUDE.md HUMAN APPROVAL).

**Unchanged.** The doc 31 formula, the lock key, `id`, `occurred_at`, the partition key and G8's command and pass condition.

## Status (الحالة)

Accepted — 2026-09-23 (GM decisions 2026-09-23 #3 and #4).

## Application / bookkeeping

- 13B v4.2 → v4.3 · migration `0004_M_audit-chain-seq.sql` · doc 40 §B2 and Part F G8 → v4.3 · doc 31 §3-3 → v4.1 ·
  D-blueprints/08 signature rows · CHANGELOG-v4 · `.claude/briefs/platform.brief.md` (pg-scribe).
- Commit: `fix(0.9): SCR-AUDIT-01 audit chain_seq (ADR-0002, migration 0004)`.
