-- 0048_M_system-actor-identity.sql — M-core (lane M), WBS 4.3 part 1a = SCR-BILLING-SYSTEM-ACTOR-01
-- ratified by D-212 (GM 2026-09-30 13:38Z). Forward-only, idempotent (apply.sh re-runs every file
-- on every apply; `create or replace function`, `on conflict do nothing`, `drop policy if exists`
-- before each `create policy`, and a read-only self-check). One transaction.
--
-- WHAT: the system actor identity for outbox subscribers, usable ONLY under pgeos_worker.
-- D-212 (verbatim, GM 13:38Z):
--   1. «نعم — صف واحد في `identity.users` لمستخدم نظام، مع صفوف `identity.user_entities` لكل كيان في `platform.entities`.»
--   2. «نعم (إلزامي) — القيد الأمني: هذه الهوية تعمل فقط تحت دور قاعدة البيانات `pgeos_worker`؛ أي `withContext` يفتحها من دور آخر (pgeos_app/API) يُرفض على مستوى قاعدة البيانات (دالة/سياسة تتحقق من `current_user`)، مع اختبار RED يثبت الرفض.»
--   3. «`user_type = 'internal'` (القائم في doc 01، بلا تغيير مخطط)؛ صفوف التدقيق تحمل `actor_type = 'system'`.»
-- After this file:
--   - platform.system_actor_id() — the well-known id (the nil uuid every seed already uses as
--     changed_by); policies and functions name the function, never the literal;
--   - platform.system_actor_permitted() — false only when app.user_id is the system id and the
--     login role is not pgeos_worker;
--   - platform.allowed_entities() — the 0031 body wrapped: '{}' when not permitted (every
--     entity_scope policy hides rows and refuses writes with 42501 under pgeos_app);
--   - audit_append (platform.audit_log, parent only) — adds the binding and requires
--     actor_type = 'system' for the system actor's rows (D-212 item 3, second half);
--   - idem_own (platform.idempotency_keys) — adds the binding in using and with check (so
--     pgeos_app with the system id cannot read or pre-claim the worker's null-entity keys);
--     idem_entity_scope untouched;
--   - one identity.users row (internal, active, no employee/client) and one identity.user_entities
--     row per platform.entities row. No session, no OTP, no credential, no user_roles row.
--
-- REVIEW: pg-reviewer pre-build review PASS and pre-migration review PASS (2 rounds); every
-- finding and nit is applied in this file (binding on idem_own, actor_type on audit_append,
-- definer on system_actor_id, ORDERING paragraph, zero user_roles/sessions self-check).
--
-- DEFINER DISCIPLINE (0031 / 0044 pattern): each function is `language sql … security definer
-- set search_path = pg_catalog, pg_temp`, static SQL only (no EXECUTE / format), every object
-- schema-qualified.
--
-- DECISION 3 — session_user, not current_user: D-212 item 2 reads «دالة/سياسة تتحقق من
-- `current_user`». Inside a SECURITY DEFINER body current_user is the owner (definer), never the
-- caller; session_user is the login role (apps/worker connects directly as pgeos_worker, the API
-- as pgeos_app). The binding therefore reads session_user — stricter: a superuser doing
-- `set role pgeos_worker` is refused (session_user = postgres), fail-closed; recorded in the
-- CHANGELOG with the GM's wording.
--
-- ORDERING (0044 precedent): apply.sh re-runs 0007 (`audit_append`), 0010 (`idem_own`) and 0031
-- (`allowed_entities`) before 0048 on every apply, each in its own transaction. An apply that
-- aborts between them and 0048 leaves the binding off until the next full apply. Any later
-- migration restating any of those three objects must keep the binding. Granting the system actor
-- any role reopens `has_perm`, `my_roles`, `is_approval_chain_approver` and `own_commission` for
-- the system id under pgeos_app and would need the binding in `has_perm`. apply.sh also re-runs
-- 0039 before 0048: its `revoke all on platform.audit_log from pgeos_worker` executes on every
-- apply, so 0048 restates the INSERT grant (section 6) after it on every apply.
--
-- GRANTS (section 6) — Master ruling verbatim (Master M15, issue #207, 15:26Z): "the system
-- identity runs only under `pgeos_worker`, so 0048 also carries that role's minimum grants for the
-- 4.2 port, exactly as lane 2 listed: `SELECT` on `catalog.services` and `wms.outbound_orders`;
-- `SELECT, INSERT` on `billing.billable_events`; `INSERT` on `platform.audit_log` and
-- `platform.outbox`; `EXECUTE` on `platform.allowed_entities()` and `current_user_id()` if the role
-- lacks it. No other grant. RLS still applies (no BYPASSRLS), and the pre-migration review (opus)
-- checks each grant."
-- Recorded defaults — the three prerequisites of the ruled grants, not "another grant":
--   (1) USAGE on schemas catalog, wms, billing (the role held USAGE on platform only; a table
--       grant alone leaves 42501 on the schema);
--   (2) USAGE on sequence platform.audit_log_id_seq (audit_log.id bigserial, needed by the INSERT);
--   (3) USAGE on sequence platform.outbox_id_seq (outbox.id bigserial, needed by the INSERT).
-- 0048 supersedes 0039:58-60 (the worker never reads or writes the audit book) for INSERT only —
-- SELECT, UPDATE, DELETE on platform.audit_log stay withheld.
-- No `grant execute` — EXECUTE already held via PUBLIC; asserted in the self-check.
-- The exact-set proof that pgeos_worker holds these grants and nothing more lives in
-- tests/isolation/tests/system-actor-rls.test.ts, not here: apply.sh re-runs this file after every
-- later migration, so an in-file exact set would refuse any future grant (Master M16, #207 20:06Z).
--
-- SCHEMA PARITY: database/schema/* is not edited (frozen for lanes — lane-guard); this migration
-- is the source of the three functions, the two policies and the row.
--
-- ROLLBACK: forward-only. A new forward-only migration would restate the 0031 body, the 0007
-- audit_append and the 0010 idem_own (not recommended — it reopens the system id to pgeos_app).
--
-- RED tests (tasks/backlog/MIGRATION-REQUEST-M.md): tests/isolation/tests/system-actor-rls.test.ts ·
-- tests/isolation/system-actor-rls.feature. No new column → identity.column_classification
-- unchanged (G6).

begin;

-- 1. The well-known id and the role binding ---------------------------------------------------

create or replace function platform.system_actor_id() returns uuid language sql immutable security definer set search_path = pg_catalog, pg_temp as $$
  select '00000000-0000-0000-0000-000000000000'::uuid $$;

create or replace function platform.system_actor_permitted() returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select platform.current_user_id() is distinct from platform.system_actor_id() or session_user = 'pgeos_worker' $$;

-- 2. allowed_entities: the 0031 body, wrapped by the binding ----------------------------------

create or replace function platform.allowed_entities() returns uuid[] language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case when not platform.system_actor_permitted() then '{}'::uuid[] else (
  select coalesce(array_agg(distinct ue.entity_id), '{}') from identity.user_entities ue
  where ue.user_id = platform.current_user_id()
    and (nullif(current_setting('app.entity_id', true), '') is null or ue.entity_id = nullif(current_setting('app.entity_id', true), '')::uuid)
  ) end $$;

-- 3. audit_append (platform.audit_log PARENT ONLY — never on a partition, 0007 §4) --------------

drop policy if exists audit_append on platform.audit_log;
create policy audit_append on platform.audit_log
  for insert with check (user_id is not null and user_id = platform.current_user_id() and platform.system_actor_permitted() and (user_id <> platform.system_actor_id() or actor_type = 'system'));

-- 4. idem_own (0010 shape + the binding); idem_entity_scope untouched --------------------------

drop policy if exists idem_own on platform.idempotency_keys;
create policy idem_own on platform.idempotency_keys for all
  using (user_id = platform.current_user_id() and platform.system_actor_permitted())
  with check (user_id is not null and user_id = platform.current_user_id() and platform.system_actor_permitted());

-- 5. The system actor row and its entity scope ------------------------------------------------

insert into identity.users (id, email, full_name_ar, full_name_en, user_type, is_active)
values (platform.system_actor_id(), 'system@pg-eos.invalid', 'نظام PG-EOS', 'PG-EOS system actor', 'internal', true)
on conflict (id) do nothing;

insert into identity.user_entities (user_id, entity_id)
select platform.system_actor_id(), e.id from platform.entities e
on conflict do nothing;

-- 6. pgeos_worker minimum grants (Master ruling #207 15:26Z; see GRANTS) ------------------------

grant usage on schema catalog, wms, billing to pgeos_worker;
grant select on catalog.services, wms.outbound_orders to pgeos_worker;
grant select, insert on billing.billable_events to pgeos_worker;
grant insert on platform.audit_log to pgeos_worker;

do $$
begin
  if pg_catalog.pg_get_serial_sequence('platform.audit_log', 'id') is distinct from 'platform.audit_log_id_seq'
     or pg_catalog.pg_get_serial_sequence('platform.outbox', 'id') is distinct from 'platform.outbox_id_seq' then
    raise exception '0048: platform.audit_log.id / platform.outbox.id are not owned by platform.audit_log_id_seq / platform.outbox_id_seq';
  end if;
end $$;

grant usage on sequence platform.audit_log_id_seq to pgeos_worker;
grant insert on platform.outbox to pgeos_worker;
grant usage on sequence platform.outbox_id_seq to pgeos_worker;

-- 7. Read-only self-check --------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array['platform.system_actor_id()', 'platform.system_actor_permitted()', 'platform.allowed_entities()'] loop
    if not exists (select 1 from pg_catalog.pg_proc where oid = fn::regprocedure and prosecdef and proconfig @> array['search_path=pg_catalog, pg_temp']) then
      raise exception '0048: % not definer/pinned', fn;
    end if;
  end loop;
  if position('system_actor_permitted' in pg_catalog.pg_get_functiondef('platform.allowed_entities()'::regprocedure)) = 0 then
    raise exception '0048: allowed_entities lacks system_actor_permitted';
  end if;
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'platform' and tablename = 'audit_log' and policyname = 'audit_append' and with_check like '%system_actor_permitted%') then
    raise exception '0048: audit_append missing on platform.audit_log or lacks system_actor_permitted';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p join pg_catalog.pg_inherits i on i.inhrelid = p.polrelid where p.polname = 'audit_append' and i.inhparent = 'platform.audit_log'::regclass) then
    raise exception '0048: audit_append exists on a platform.audit_log partition';
  end if;
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'platform' and tablename = 'idempotency_keys' and policyname = 'idem_own' and qual like '%system_actor_permitted%' and with_check like '%system_actor_permitted%') then
    raise exception '0048: idem_own missing or lacks system_actor_permitted';
  end if;
  if (select count(*) from identity.users u where u.id = platform.system_actor_id()) <> 1 then
    raise exception '0048: system actor row count is not 1';
  end if;
  if not exists (select 1 from identity.users u where u.id = platform.system_actor_id() and u.user_type = 'internal' and u.is_active and u.employee_id is null and u.client_id is null) then
    raise exception '0048: system actor row is not internal/active or has employee_id/client_id';
  end if;
  if (select count(*) from identity.user_entities ue where ue.user_id = platform.system_actor_id()) <> (select count(*) from platform.entities) then
    raise exception '0048: system actor user_entities count differs from platform.entities count';
  end if;
  if exists (select 1 from identity.user_roles ur where ur.user_id = platform.system_actor_id()) then
    raise exception '0048: system actor holds an identity.user_roles row';
  end if;
  if exists (select 1 from identity.sessions s where s.user_id = platform.system_actor_id()) then
    raise exception '0048: system actor holds an identity.sessions row';
  end if;
  -- The exact-set grant checks moved to tests/isolation/tests/system-actor-rls.test.ts (M16, #207 20:06Z).
  -- (a) EXECUTE held (through PUBLIC) on the four platform functions — no grant execute written.
  foreach fn in array array['platform.allowed_entities()', 'platform.current_user_id()', 'platform.system_actor_permitted()', 'platform.system_actor_id()'] loop
    if not pg_catalog.has_function_privilege('pgeos_worker', fn, 'EXECUTE') then
      raise exception '0048: pgeos_worker lacks EXECUTE on %', fn;
    end if;
  end loop;
  -- (b) RLS still applies: no BYPASSRLS, no superuser.
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'pgeos_worker' and (r.rolbypassrls or r.rolsuper)) then
    raise exception '0048: pgeos_worker has BYPASSRLS or SUPERUSER';
  end if;
end $$;

commit;
