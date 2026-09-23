# SCR-RLS-01 — `entity_scope` OR-defeats `client_portal_scope`, breaking client isolation

**Status: APPROVED (GM, "نفذ الاصلاحات", 2026-09-23) — APPLIED as Options B + C in `database/migrations/0003_M_rls-scr-01-02.sql`, recorded as D-002 in `docs/DECISION_LOG.md`.** Raised under **EXECUTION-MASTER-v4 §1.11 (G-01)**
by the WBS 0.18 slice, 2026-09-23. Type: **schema change** (RLS policy shape) affecting policies
declared in two frozen files — `database/schema/01-Data-Model.sql` (three tables) and
`database/schema/13B-Schema-Reference-Consolidation.sql` (four more) — **delivered as the forward-only
migration `database/migrations/0003_M_rls-scr-01-02.sql`** (CLAUDE.md · GIT: migrations are
forward-only); those two files deliberately keep their original text. Single-lane Master task.

This is a **security finding, reproduced against the live applied schema**, not a theoretical one.

---

## 1. The defect

**Seven** tables carry **two permissive policies at once**. Enumerated from live `pg_policy` on the
applied schema, not from reading the SQL files — the query is:

```sql
select c.relnamespace::regnamespace || '.' || c.relname
from pg_class c
where exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive
                and pg_get_expr(p.polqual, p.polrelid) like '%allowed_entities%')
  and exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive
                and pg_get_expr(p.polqual, p.polrelid) like '%current_client_id%')
order by 1;
```

| table | declared in |
|---|---|
| `billing.invoices` | `01-Data-Model.sql:1445-1475` |
| `tms.delivery_tasks` | `01-Data-Model.sql:1445-1475` |
| `wms.outbound_orders` | `01-Data-Model.sql:1445-1475` |
| `wms.occupancy_snapshots` | `13B-Schema-Reference-Consolidation.sql:4793-4794` |
| `wms.space_allocations` | `13B-Schema-Reference-Consolidation.sql:1403` |
| `wms.space_reservations` | `13B-Schema-Reference-Consolidation.sql:4797-4798` |
| `wms.work_orders` | `13B-Schema-Reference-Consolidation.sql:4167` |

All seven carry the same two predicates: `entity_scope` permissive / `cmd=*` /
`entity_id = any(platform.allowed_entities())`, and `client_portal_scope` permissive / `cmd=r` /
`platform.is_internal() or client_id = platform.current_client_id()`. They are vulnerable
identically. The four in 13B are hand-written `create policy` statements, not products of the §12
auto-loop, which is why reading the loop alone does not surface them.

Confirmed live in `pg_policy` for `billing.invoices`:

```
client_portal_scope | permissive=true | cmd=r | (platform.is_internal() OR (client_id = platform.current_client_id()))
entity_scope        | permissive=true | cmd=* | (entity_id = ANY (platform.allowed_entities()))
```

PostgreSQL combines **permissive** policies with `OR`. For a `SELECT`, both policies apply, so a row
is visible when **either** leg is true. `client_portal_scope` is therefore not a *restriction* on a
portal user — it is an *additional grant* layered beside `entity_scope`.

The client boundary holds only while `platform.allowed_entities()` is empty for every portal user,
i.e. only while no portal user ever has a row in `identity.user_entities`. Nothing in the schema
enforces that. There is no constraint, no trigger, and no check tying `identity.users.user_type =
'client'` to the absence of `user_entities` rows — verified: `identity.user_entities` has no such
constraint, and `identity.users.user_type` is a plain `text not null default 'internal'`.

## 2. Reproduction (verbatim, against the applied local database, 2026-09-23)

```sql
create role rls_dual login nobypassrls;
grant usage  on schema sales, wms, tms, billing, platform, identity to rls_dual;
grant select on sales.accounts, billing.invoices to rls_dual;

insert into sales.accounts (code, name_ar, account_type)
  values ('dualA','A','client'), ('dualB','B','client');
insert into billing.invoices (entity_id, client_id)
  select (select id from platform.entities where code='PCC'), id
    from sales.accounts where code in ('dualA','dualB');

-- a PORTAL user of client A that ALSO holds entity access to PCC
insert into identity.users (id, email, full_name_ar, user_type, client_id)
  values ('11111111-1111-1111-1111-111111111111','dual@test.local','user A','client',
          (select id from sales.accounts where code='dualA'));
insert into identity.user_entities (user_id, entity_id)
  select '11111111-1111-1111-1111-111111111111', id
    from platform.entities where code='PCC';
```

then, connected as `rls_dual` (non-superuser, `NOBYPASSRLS`):

```sql
select set_config('app.user_id',   '11111111-1111-1111-1111-111111111111', false),
       set_config('app.client_id', (select id::text from sales.accounts where code='dualA'), false),
       set_config('app.is_internal','false', false);

select count(*) from billing.invoices where id = '<client B''s invoice id>';
```

**Result: `1`.** Client A's portal context returns client B's invoice by direct ID substitution.

The acceptance criterion of **doc 38 row 0.18** — *"User A returns zero rows from B's data on direct
ID substitution, with no error"* — and **doc 40 Part F row G14** are **violated** in this case.

For contrast, the same probe with `app.user_id` set to a user that has **no** `user_entities` row
returns `0`. That is the case `tests/isolation/tests/client-isolation.test.ts` proves green, 18/18.

## 3. Why this was not caught earlier

- **G7** only asks whether `relrowsecurity` is true. It says nothing about whether the policies
  *compose* correctly. Two individually-correct permissive policies can be jointly wrong; G7 cannot
  see that, and no guard in `database/schema/guards.sql` does.
- 13B §12's auto-generated policy loop (`13B-Schema-Reference-Consolidation.sql:2978-3039`) writes
  one policy per previously-unpolicied table. It never inspects tables that already have two.
- Nobody had enumerated the composition from `pg_policy` before. Both previous passes read the SQL
  files, and four of the seven policies are hand-written in 13B far from the 01 block, so reading
  01's RLS section alone under-counts the blast radius by more than half. §1's query is the
  reproducible form; use it, not a grep.
- The 0.9 abandoned-WIP note (`docs/notes/0.9-abandoned-wip.md`, reusable item 7) already routed one
  RLS coverage concern to 0.18 — `platform.audit_log`'s partitioned parent. 0.18 reproduced it and
  raised it separately as
  **`docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md`**. This SCR does not cover it,
  and the two must be decided independently.

## 4. Options (the decision is the GM's / system owner's — not the agent's)

**Option A — make `entity_scope` restrictive. Rejected.** A restrictive policy is AND-ed with the
permissive OR-set, so it must hold for *every* caller. An internal user is unaffected in practice
(it already satisfies the permissive leg via `platform.is_internal()`, and it holds entity access by
definition). The fatal case is the **portal user**: it would then have to satisfy
`entity_id = any(platform.allowed_entities())`, which is empty for every portal user *by design* —
so Option A **denies the client portal everything on all seven tables**. It closes the hole by
closing the feature. Not viable.

**Option B — gate `entity_scope` on `platform.is_internal()` (recommended).**

```sql
create policy entity_scope on billing.invoices
  for all using (platform.is_internal() and entity_id = any(platform.allowed_entities()));
```

The two policies then address disjoint populations, which is what the schema's own comments say was
intended (`01-Data-Model.sql:1443` "نمط 1: الجداول التشغيلية" vs `:1460` "نمط 2: نافذة العميل").
A portal user (`is_internal = false`) falls through to `client_portal_scope` alone. Internal users
are unaffected. Smallest change that closes the hole. Applies to `wms.outbound_orders`,
`tms.delivery_tasks`, `billing.invoices`, **and equally to `wms.occupancy_snapshots`,
`wms.space_allocations`, `wms.space_reservations` and `wms.work_orders`** — all seven from §1. Worth
extending to `wms.inbound_orders`, `cc.tickets` and the four `13-Schema-Additions.sql:702-708`
tables for consistency, even though those carry no client policy today and so are not vulnerable
yet; a client policy added to any of them later would open the same hole silently.

**Option C — forbid the dual role in `identity`.** A check/trigger making `user_type = 'client'` and
a `user_entities` row mutually exclusive. Defends in depth but leaves the RLS composition itself
wrong, so a future second client-scoped policy re-opens the same hole. Worth doing **in addition to**
B, never instead of it.

## 5. What 0.18 did in the meantime

**Interim record — superseded by the APPLIED status above (0003, D-002, 2026-09-23).** Until approval,
nothing in the schema changed — G-01 forbids it. The slice:

1. delivers `tests/isolation` and the `pnpm test:isolation` runner doc 40 Part F names (G14), proving
   the criterion holds for a pure portal user across all five client-scoped tables, in both
   directions, under a genuine `NOBYPASSRLS` role;
2. **(superseded once applied)** originally pinned this defect with `it.fails(...)`; after 0003 the
   same three tests (`billing.invoices`, `tms.delivery_tasks`, `wms.outbound_orders`) assert the
   requirement directly and pass — Option B is proven independently of Option C by constructing the
   dual-role user with `session_replication_role = replica` in the fixture, and Option C is proven by
   two tests expecting SQLSTATE `23514` on the front-door path. The other four tables
   (`wms.occupancy_snapshots`, `wms.space_allocations`, `wms.space_reservations`, `wms.work_orders`)
   are **not** pinned by a test — they are outside the suite's fixture surface, and seeding them was
   judged disproportionate for a defect already recorded here. That is a deliberate omission;
3. recorded 0.18 as **NOT DONE / BLOCKED on this SCR** in `docs/PROJECT_STATE.md` and
   `tasks/MASTER_BACKLOG.md` (commit `428a565`); lifted once 0003 was applied and the suite went
   green on a freshly recreated database.

## 6. Consequences of Option B recorded at application (D-002) — OPEN, deliberately not changed here

1. **`is_internal` becomes load-bearing for internal reads AND writes on the seven tables.**
   `platform.is_internal()` is GUC-only and returns `false` when `app.is_internal` is unset;
   `entity_scope` is `FOR ALL` with a `USING` clause only, so the same predicate is the `WITH CHECK`
   for INSERT/UPDATE. Every internal caller must pass `isInternal: true` through `withContext` or it
   silently reads and writes nothing. Verified at application: the only non-test callers
   (`packages/identity/src/context.ts`) already do; the client portal reads through
   `client_portal_scope` / `sku_client_scope` (untouched); drivers, partners and imile were already
   `is_internal = true` by necessity (13B ق-9 gives housing/partners/hr no client-facing policy). No
   caller is broken today. To be decided with the 0.5/0.6 application-role design, alongside
   SCR-RLS-02 §7.
2. **Not extended** to `wms.inbound_orders`, `cc.tickets` or the four `13-Schema-Additions.sql:702-708`
   tables. Not vulnerable today (no client policy on them); a client policy added later re-opens the
   hole silently. Deliberate scope decision — the "worth extending" in §4 was an aside, not part of
   the approved recommendation. Recorded in `tasks/MASTER_BACKLOG.md` row 0.18.
3. **No guard detects this defect class.** G7 got a detector for SCR-RLS-02's class; the
   permissive-composition class has none — §1's enumeration query is the candidate. A new guard
   changes doc 40 Part F (rank-1) and needs its own G-01 request; not invented here.
4. **`identity.users.user_type` has no CHECK constraint**, so Option C binds only the literal
   `'client'` (the same literal the schema's own `client_user_has_client` CHECK uses). Any other
   non-internal `user_type` value would escape both triggers. A CHECK on `user_type` is its own SCR.

## 7. Also still open, and NOT covered here

- The runtime still connects as superuser `postgres` (`packages/db/src/client.ts:23-33`), which
  bypasses RLS unconditionally. A production `NOBYPASSRLS` application role with scoped GRANTs is
  **WBS 0.5/0.6** deployment work. Until it exists, *none* of these policies has any effect in a
  running system — the 0.18 suite proves the policies, not the deployment.
- `platform.audit_log`'s partitioned parent has RLS **disabled** and no policy, and reads through it
  bypass every partition's policy. Reproduced by 0.18 and raised separately as
  **`docs/notes/SCR-RLS-02-audit-log-partitioned-parent-has-no-rls.md`** — a different defect with a
  different fix; do not fold the two decisions together.
