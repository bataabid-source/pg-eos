# SCR-RLS-02 — `platform.audit_log`'s partitioned parent has RLS disabled; reads bypass every partition policy

**Status: OPEN — awaiting GM/system-owner decision.** Raised under **EXECUTION-MASTER-v4 §1.11 (G-01)**
by the WBS 0.18 slice, 2026-09-23. Type: **schema change** to frozen files
(`database/schema/13B-Schema-Reference-Consolidation.sql` and `database/schema/guards.sql`).
Single-lane Master task once approved.

**This is a reproduced RLS bypass on the audit log**, not a theoretical coverage gap. It was routed
to WBS 0.18 by a previous slice (`docs/notes/0.9-abandoned-wip.md`, reusable item 7) as a *suspicion*
about guard coverage; 0.18 confirmed it is an actual read bypass.

---

## 1. The defect

`platform.audit_log` is declaratively partitioned by month (doc 40 §B2, `platform.audit_log`
partitioned monthly, PK `(id, occurred_at)`). On the applied schema:

```
relname                relkind   relrowsecurity   policies
audit_log              p         false            0
audit_log_2026_09      r         true             1
audit_log_2026_10      r         true             1
audit_log_2026_11      r         true             1
audit_log_2026_12      r         true             1
audit_log_default      r         true             1
```

Each partition carries `entity_scope`:
`((entity_id is null) or (entity_id = any(platform.allowed_entities())))`.
**The parent carries none, and has row security switched off.**

PostgreSQL applies the RLS policies of **the relation named in the query**. A query against the
partitioned parent is therefore filtered by the parent's policies — of which there are none — and the
partitions' own policies are never consulted. Every read through `platform.audit_log` returns every
row in every partition, for any role that holds `select` on the parent.

## 2. How it happened

Two places, both filtering on `relkind = 'r'`:

- `database/schema/13B-Schema-Reference-Consolidation.sql:2978-3039` — the loop that enables RLS and
  writes a policy for every not-yet-covered base table selects `where c.relkind = 'r'`. A partitioned
  parent is `relkind = 'p'`, so the loop skipped it and covered only the five leaf partitions.
- `database/schema/guards.sql:80-88` and doc 40 Part F row G7 — the guard query is
  `... where t.relkind = 'r' and ... and not t.relrowsecurity`. The same filter makes the parent
  invisible to the guard, so **`G7 = 0` is true and the parent is still unprotected.**

13B:3047-3061 *does* run `alter table platform.audit_log force row level security` on the parent.
`FORCE` only changes whether the table OWNER is exempt; it does not enable row security and it does
not create a policy. On a table with `relrowsecurity = false` it has no effect on visibility at all.

## 3. Reproduction (verbatim, against the applied local database, 2026-09-23)

```sql
create role rls_audit login nobypassrls;
grant usage  on schema platform to rls_audit;
grant select on platform.audit_log to rls_audit;
```

then, connected as `rls_audit` (non-superuser, `NOBYPASSRLS`), with **no** entity access at all
(`platform.allowed_entities()` is `{}`) and `app.is_internal = false`:

```sql
select set_config('app.user_id', null, false),
       set_config('app.is_internal','false', false);

select count(*) from platform.audit_log;              -- 8
select count(*) from platform.audit_log_2026_09;      -- ERROR: permission denied (no grant on the leaf)
```

All eight rows present at the time carried a **non-null** `entity_id`
(`select count(*) filter (where entity_id is not null) from platform.audit_log` → `8 of 8`), so
every one of them is a row the partitions' `entity_scope` policy would have denied to this role.
They were returned anyway.

The second statement shows the corollary: a grant on the parent does **not** confer access to the
leaves, so an attacker cannot be redirected to the (protected) partitions — the unprotected parent is
the only reachable path, and it is the path the application would naturally use.

## 4. Why this matters more than an ordinary table

`platform.audit_log` is the tamper-evident record (doc 40 §B2 — eleven v4 columns plus the
`audit_hash_chain` trigger, `platform.verify_audit_chain()`). It records who did what across every
module and every legal entity. An unfiltered read of it discloses, in one query, the activity of all
four entities and every client to any role that can reach it. Integrity of the chain is intact — this
is a **confidentiality** failure, not an integrity one — but confidentiality is the whole point of
`entity_scope` existing on the partitions.

## 5. Options (the decision is the GM's / system owner's — not the agent's)

**Option A — enable RLS and put the policy on the parent (recommended).**

```sql
alter table platform.audit_log enable row level security;
create policy entity_scope on platform.audit_log
  for all using (entity_id is null or entity_id = any(platform.allowed_entities()));
```

Identical predicate to the partitions', so nothing about who-sees-what changes for a correct caller;
it only closes the path that currently sees everything. Policies on a partitioned parent are applied
to every partition automatically, so the five existing leaf policies become redundant but harmless.
The `force row level security` at 13B:3047 then starts doing what its comment says it does.

**Option B — widen G7 to `relkind in ('r','p')` as well.** Necessary regardless of A: without it the
guard cannot see this class of defect, and any future partitioned table repeats it silently. Note
this changes a **doc 40 Part F guard definition** (row G7 is quoted verbatim there), so it is a
change to a rank-1 document under BOOTSTRAP-v5 §1, not only to `guards.sql`. Doc 40 Part F's own
prose already says *"'Operational table' for G7 means any base table in the fourteen business
schemas"* — a partitioned parent is a base table in every sense that matters here, so this reads as
correcting the query to match the stated intent rather than changing the intent.

**Option C — also fix the 13B loop** (`relkind = 'r'` → `relkind in ('r','p')`) so future
partitioned tables get covered at creation. Do this together with A and B, not instead of either.

**Recommended: A + B + C together.** A closes the hole, B makes the guard able to see it, C stops it
recurring. None of the three changes any application code.

## 6. What 0.18 did in the meantime

Nothing in the schema — G-01 forbids it. 0.18 records the defect here, reports it in
`docs/PROJECT_STATE.md` and `tasks/MASTER_BACKLOG.md`, and closes **NOT DONE**: the backlog title of
row 0.18 is *"RLS enabled on every operational table in 01/13/13B/019"*, and while this parent has
`relrowsecurity = false` that sentence is not true, whatever G7 returns.

No test pins this one. The 0.18 suite's fixture role is scoped to the five client-scoped tables and
`platform.audit_log` is not one of them; adding it would mean granting the fixture role `select` on
the audit log, which is exactly the privilege whose absence limits the blast radius today. The
reproduction in §3 is the record instead. **If the GM prefers an executable pin, say so and it will
be added — it is a deliberate omission, not an oversight.**

## 7. Related, separate

`docs/notes/SCR-RLS-01-entity-scope-defeats-client-isolation.md` — a different defect (permissive
policy composition on seven client-scoped tables), also raised by 0.18, also OPEN. The two share a
root cause only in the loose sense that both are about RLS *coverage* being assumed rather than
proven; they need different fixes and can be decided independently.
