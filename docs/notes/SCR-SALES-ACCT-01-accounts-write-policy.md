# SCR-SALES-ACCT-01 — `sales.accounts` has no internal write RLS policy (G-01)

**Status: APPROVED by the Master, 2026-09-25.** Filed by lane 1 during WBS 1.8 (group-level credit
limit and hold), a REAL BLOCKER: `sales.accounts` carries no `for all`/write RLS policy at all.

## Finding

`pg_policies` shows exactly one policy on `sales.accounts`: `client_portal_scope`, command
`SELECT` only. No `INSERT`/`UPDATE`/`DELETE` policy exists. Empirically confirmed as `pgeos_app`:
`update sales.accounts set credit_limit = 999 where …` → `UPDATE 0`, zero rows, no error — every
write silently no-ops for any role, including internal staff, because Postgres RLS with no
matching write policy denies by default rather than erroring.

## Root cause

13B's dynamic policy-generation loop grants `internal_only for all using (platform.is_internal())`
to every non-entity-scoped, non-reference operational table (e.g. `wms.work_order_tasks`,
`wms.work_order_events`). `sales.accounts` has no `entity_id` column, so it falls outside the
loop's entity-scope branch; it received a hand-added `client_portal_scope` SELECT-only policy for
the client-portal read use case instead of going through the generic loop that would also have
added `internal_only for all` alongside it. An oversight in the table's original policy authoring,
not a deliberate restriction — no doc (01/13/13B/019/40) states accounts should be internal-write-
blocked.

## Fix (APPROVED)

```sql
create policy internal_only on sales.accounts for all using (platform.is_internal());
```

Additive and safe: Postgres RLS policies for the same command OR together, so this grants full
read/write to internal staff (`platform.is_internal()`) while leaving the existing
`client_portal_scope` SELECT scoping on the portal role untouched. Matches the exact policy every
other non-entity-scoped internal table already carries — no new pattern invented.

**Rejected alternative:** a narrower `has_perm(...)`-gated write policy (CFO/GM-only at the RLS
layer). Rejected because RLS in this codebase is entity/internal scoping only — fine-grained role
authorization (who may call `SetCreditLimit`, `PlaceHold`, etc.) lives in application/domain code,
same layering as every other M02 slice (1.4/1.6/1.7's own role gates). Duplicating role logic into
RLS would create two sources of truth for the same rule.

## Migration

`database/migrations/0021_1_accounts-internal-write-policy.sql` — issued by the Master, lane 1,
2026-09-25. RLS-touching: pg-reviewer pre-migration review is mandatory (CLAUDE.md · BUILD METHOD)
and is run by the lane before the file is written, same procedure as the version-column
migrations.
