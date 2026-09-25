# SCR-RLS-03 — `client_portal_scope` lets ANY internal user read every entity's rows (G-01 schema-change request)

**Status:** filed 2026-09-25 by the Master on lane 1's report (WBS 2.11 part 1, RED scenario "internal user of entity A cannot read entity B's outbound order"). Security / RLS → pg-reviewer (opus) pre-migration review is mandatory before `0025_M_*` is written (CLAUDE.md · SLICE SEQUENCE).
**Class:** same as D-002 (SCR-RLS-01, migration 0003) — permissive-policy composition — but the mirror side: 0003 closed *client → other client*; this closes *internal → other entity*.

## 1 · The defect (reproduced on the live database, 2026-09-25)

Seven operational tables carry two permissive policies:

| table | `entity_scope` (FOR ALL, after 0003) | `client_portal_scope` (FOR SELECT) |
|---|---|---|
| `wms.outbound_orders` · `wms.work_orders` · `wms.occupancy_snapshots` · `wms.space_allocations` · `wms.space_reservations` · `tms.delivery_tasks` · `billing.invoices` | `platform.is_internal() and entity_id = any(platform.allowed_entities())` | `platform.is_internal() or client_id = platform.current_client_id()` |

Postgres OR-combines permissive policies of the same command. For SELECT, `client_portal_scope`'s `platform.is_internal()` clause is therefore satisfied by **every** internal session, and `entity_scope`'s entity restriction is never consulted for reads. Writes stay entity-scoped (`entity_scope` is the only FOR ALL policy, so its USING doubles as WITH CHECK).

Reproduction (psql, `set local role pgeos_app`, `app.is_internal = true`, `app.user_id` = a uuid with **no** `identity.user_entities` row, so `platform.allowed_entities()` = `{}`; probe rows seeded by the superuser in the same rolled-back transaction):

```
allowed_entities=0
PROBE outbound visible=1        -- wms.outbound_orders row of an entity the user does not hold
PROBE snapshot visible=1        -- wms.occupancy_snapshots, same
```

Doc 40 P6 ("RLS on every operational table") and 01-Data-Model.sql's own "نمط 1: الجداول التشغيلية" (entity scoping through `platform.allowed_entities()`) make internal entity isolation the requirement; 0003's header states the two policies were meant to "address disjoint populations — internal users via entity access, portal users via client identity". The `is_internal()` clause inside the portal policy contradicts that intent for SELECT.

**Not in scope (by design, not oversight):**
- `sales.accounts` — has no `entity_id`; internal access is group-wide by D-177 (`internal_only for all using (platform.is_internal())`, migration 0021). Its `client_portal_scope` OR-clause is redundant, not a leak.
- `wms.skus` — "نمط 3", client-partitioned, no `entity_id`, `sku_client_scope` is its only policy and is FOR ALL; removing `is_internal()` there would lock internal staff out of every SKU. Untouched.
- The 13B view at `13B-Schema-Reference-Consolidation.sql:4712` — a view filter, not a policy. pg-reviewer (finding 4): `wms.space_by_type`, `wms.space_trend_30d`, `wms.reservations_aging` and `platform.my_work` read the seven tables, are owned by the superuser and lack `security_invoker`, so they bypass RLS for whoever can query them — harmless today only because `pgeos_app` has no SELECT on them (only `space_dashboard` and `client_space_overview` are granted and apply RLS to the caller). Recorded, not changed here; a grant on any of the four is a future G-01 item.
- Eight reference tables with `entity_id` carry `reference_read using (platform.is_internal())` only (`billing.gl_accounts`, `catalog.services`, `hr.org_units`, `hr.teams`, `platform.counters`, `platform.document_templates`, `platform.settings`, `wms.warehouses`) — reference data for the whole group by 13B ق-9; outside this class, no finding.

## 2 · Migration `0025_M_client-portal-scope-internal-bypass.sql`

**pg-reviewer pre-migration review (opus, 2026-09-25): APPROVED WITH CHANGES, 5 findings, all applied** — the file on disk is authoritative; the draft below is kept as the reviewed input. Changes: (1) BLOCKER — predicate is `not platform.is_internal() and client_id = platform.current_client_id()` (mirror of 0003 Option B): an internal session that also carries `app.client_id` would otherwise still read that client's rows in every entity (reproduced: draft `seesA=1 seesB=1`, fix `seesA=1 seesB=0`); (2) MAJOR — the draft's drift guard ran after an unconditional rewrite and could never fire; replaced by 0003's inspect-then-rewrite loop (missing policy / non-SELECT / unknown predicate → raise; fixed text → skip with NOTICE) plus a final count of exactly seven; (3) MINOR — header states the review and the 0003 dependency, D-181 recorded in the same commit; (4) MINOR — §1 view sentence corrected; (5) MINOR — live `identity.user_entities` has 0 rows, so every internal read of these tables by a seeded/dev user worked only through the hole: wms module suite + `tests/isolation` run before commit, empty reads fixed in fixtures, never in code.

Draft as reviewed:

```sql
-- 0025_M_client-portal-scope-internal-bypass.sql — Master — SCR-RLS-03 (D-181). Forward-only,
-- idempotent (apply.sh re-runs every file on every apply; drop-then-create is the repo's pattern
-- for re-runnable policies, 13B-SP-3 / 0021).
--
-- Seven tables carried client_portal_scope FOR SELECT USING (platform.is_internal() OR client_id =
-- platform.current_client_id()). Permissive policies OR together, so every internal session read
-- every entity's rows and entity_scope (0003) was never consulted for SELECT. Reproduced 2026-09-25
-- (docs/notes/SCR-RLS-03-client-portal-scope-internal-bypass.md §1). After this file the two
-- policies address disjoint populations, as 0003's header already states the intent:
-- internal → entity_scope only · client-portal → client_portal_scope only.
-- sales.accounts (no entity_id, D-177 internal_only) and wms.skus (client-partitioned, sole FOR ALL
-- policy) are deliberately untouched — see the SCR note.
begin;

do $$
declare t text;
begin
  foreach t in array array[
    'wms.outbound_orders', 'wms.work_orders', 'wms.occupancy_snapshots',
    'wms.space_allocations', 'wms.space_reservations',
    'tms.delivery_tasks', 'billing.invoices'
  ] loop
    execute format('drop policy if exists client_portal_scope on %s', t);
    execute format(
      'create policy client_portal_scope on %s for select using (client_id = platform.current_client_id())', t);
  end loop;
end $$;

-- Refuse to commit if any of the seven still carries the OR-clause (drift guard, 0003's pattern).
do $$
declare n int;
begin
  select count(*) into n from pg_policies
   where policyname = 'client_portal_scope'
     and schemaname || '.' || tablename in ('wms.outbound_orders','wms.work_orders','wms.occupancy_snapshots',
       'wms.space_allocations','wms.space_reservations','tms.delivery_tasks','billing.invoices')
     and qual ilike '%is_internal()%';
  if n > 0 then
    raise exception 'SCR-RLS-03: % client_portal_scope policies still reference platform.is_internal()', n;
  end if;
end $$;

commit;
```

## 3 · Consequences (recorded, not defects of the migration)

1. An internal session reads these seven tables only for entities in `platform.allowed_entities()` — exactly what it already needed to **write** them since 0003. Any internal test fixture whose user has no `identity.user_entities` row now reads nothing on these tables; that is the correct behaviour and the fixture is what changes (pg-tester, not a code workaround).
2. `wms.inbound_orders` and the tables without a client policy are unaffected (no OR-clause to remove).
3. A future `client_portal_scope` written with `platform.is_internal() or …` re-opens the hole silently — the same caveat 0003 recorded for entity_scope. Guard: add the drift check of §2 as a G-01 candidate for `pnpm guards:run` (the SCR's ask, not part of this migration).
4. `tests/isolation/tests/app-role-rls.test.ts` "as pgeos_app in entity A: SELECT returns no entity-B row" and the sibling INSERT test are **vacuous** (pg-reviewer answer): `entityACtx()` returns `isInternal: false`, so `entity_scope` is `false AND …` and `client_portal_scope` is `false OR client_id = NULL` — the session is not internal at all and sees nothing, entity A included; the 42501 on INSERT comes from `is_internal()` being false, not from the entity check. pg-tester changes (RED for 0025): (a) `entityACtx` → `isInternal: true`; (b) positive control — an admin-seeded entity-A row IS returned / an entity-A INSERT succeeds; (c) internal + `clientId` = the row's client → still no entity-B row (fails on the draft, passes only with finding 1); (d) portal session (`isInternal: false`, `clientId` = account id) → own rows visible, another client's not.

## 4 · Review ask (pg-reviewer, opus, pre-migration)

Approve / approve-with-changes / reject the §2 SQL against: 01 "نمط 1/2" intent, 0003's stated population split, 13B ق-9, doc 40 P6; the seven-table list (nothing missing, nothing wrongly included); idempotency on re-apply; the §3-4 test question.
