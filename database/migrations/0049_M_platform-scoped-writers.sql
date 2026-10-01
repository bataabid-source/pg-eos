-- 0049_M_platform-scoped-writers.sql — M-core (lane M), task X = SCR-RLS-NULL-ENTITY-01 / D-213,
-- step 1 of 3. Forward-only, idempotent (apply.sh re-runs every file on every apply;
-- `create or replace function`, revoke/grant are rerunnable, and a read-only self-check). No data
-- change. One transaction.
--
-- WHAT: two named SECURITY DEFINER writers for platform-scoped (no-entity) rows.
-- D-213 (GM 2026-09-30 19:25Z, #207, verbatim):
--   «`platform.audit_log` و`platform.outbox`: سياسة `entity_scope` لم تعد تقبل `entity_id IS NULL` لأي INSERT من الأدوار التطبيقية (`pgeos_app`، `pgeos_worker`)؛ الصفوف ذات النطاق المنصّي (بلا كيان) تُكتب **فقط** عبر دوال SECURITY DEFINER معتمدة ومسمّاة، مع اختبار RED لكل مسار (رفض الإدراج المباشر بلا كيان من كلا الدورين، وقبوله عبر الدالة المعتمدة).»
--   «فحص أن أي كود حالي يكتب صفًا بلا كيان يُحوَّل إلى الدالة المعتمدة قبل الترحيل (لا كسر لـCI)».
-- M16 ruling (#207 20:06Z items 3-4; 20:46Z): 0049 issued to M-core; definer functions
-- `platform.write_platform_audit()` / `platform.write_platform_event()`; one RED test per path;
-- `audit_append` tightened as well. The three-step split is accepted as execution of D-213:
--   1. 0049 (this file): the two definer writers — additive, opens no new path, merges first;
--   2. the null-entity writers convert to them (packages/events, modules/platform, modules/imile,
--      modules/wms register-sku);
--   3. 0050: the tightening (entity_scope WITH CHECK without the null branch on audit_log and
--      outbox, audit_append + entity_id is not null).
-- Step 1 alone does not satisfy D-213: the direct null-entity INSERT stays open until step 3.
-- After this file:
--   - platform.write_platform_audit(...) returns bigint — one platform.audit_log row with
--     entity_id null, user_id = platform.current_user_id(), actor_type 'system' when that is null
--     else 'user', for exactly one of six approved (schema, table) pairs (static allowlist);
--   - platform.write_platform_event(...) returns bigint — one platform.outbox row with entity_id
--     null, actor_id = platform.current_user_id(), only for a platform.* / identity.* aggregate
--     type (the outbox_business_needs_entity expression, 13B:1653-1655).
--
-- DEFINER DISCIPLINE (0044 / 0048 pattern): `language plpgsql volatile security definer
-- set search_path = pg_catalog, pg_temp`, static SQL only (no EXECUTE / format / regclass cast of
-- text), every object schema-qualified. Gate order in each body: platform.is_internal() → 42501;
-- platform.system_actor_permitted() → 42501 (the 0048 binding — the definer bypasses
-- audit_append's RLS, so it enforces D-212 item 2 itself); null required argument → 42501; target
-- gate → 42501. The insert names no chain_seq / row_hash / prev_hash column (audit_hash_chain()
-- fills them). The owner must be rolsuper or rolbypassrls (asserted below): under FORCE RLS the
-- 0050 WITH CHECK would otherwise refuse the definer's own null-entity rows.
-- `revoke all … from public, pgeos_worker; grant execute … to pgeos_app` — no worker path writes
-- platform-scoped rows. The 0048 binding is untouched.
--
-- ORDERING: a later `grant … on all functions in schema platform` (or a default privilege on
-- functions) would re-grant EXECUTE on both writers to PUBLIC or pgeos_worker — any such migration
-- restates this revoke. The self-check below fails the apply if EXECUTE is held by anyone but
-- pgeos_app (and the owner).
--
-- SCHEMA PARITY: database/schema/* is not edited (frozen for lanes — lane-guard); this migration
-- is the source of both functions. Adding a table to the allowlist = a new migration + review
-- (the «معتمدة ومسمّاة» of D-213).
--
-- ROLLBACK: forward-only. A new forward-only migration would drop both functions (only once no
-- writer calls them; after 0050 that leaves no path for platform-scoped rows — not recommended).
--
-- RED tests (tasks/backlog/MIGRATION-REQUEST-M.md): tests/isolation/tests/platform-scoped-writers.test.ts ·
-- tests/isolation/platform-scoped-writers.feature. No new column → identity.column_classification
-- unchanged (G6).

begin;

-- 1. platform.write_platform_audit ----------------------------------------------------------------

create or replace function platform.write_platform_audit(
  p_occurred_at timestamptz,
  p_schema_name text,
  p_table_name text,
  p_record_id uuid,
  p_operation text,
  p_new_value jsonb,
  p_correlation_id uuid,
  p_old_value jsonb default null
) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_user_id uuid;
  v_id bigint;
begin
  if not platform.is_internal() then
    raise exception 'platform.write_platform_audit: internal context required'
      using errcode = '42501';
  end if;
  if not platform.system_actor_permitted() then
    raise exception 'platform.write_platform_audit: system actor outside pgeos_worker'
      using errcode = '42501';
  end if;
  if p_occurred_at is null or p_schema_name is null or p_table_name is null
     or p_operation is null or p_correlation_id is null then
    raise exception 'platform.write_platform_audit: required argument is null'
      using errcode = '42501';
  end if;
  if not exists (
    select 1
      from (values ('platform', 'alert_log'),
                   ('imile', 'agent_health'),
                   ('imile', 'shipments'),
                   ('imile', 'driver_ids'),
                   ('imile', 'dtl_problems'),
                   ('wms', 'skus')) as approved(schema_name, table_name)
     where approved.schema_name = p_schema_name
       and approved.table_name = p_table_name
  ) then
    raise exception 'platform.write_platform_audit: target is not an approved platform-scoped table'
      using errcode = '42501';
  end if;

  v_user_id := platform.current_user_id();

  insert into platform.audit_log
    (occurred_at, user_id, actor_type, entity_id, schema_name, table_name, record_id, operation,
     old_value, new_value, correlation_id)
  values
    (p_occurred_at, v_user_id,
     case when v_user_id is null then 'system' else 'user' end,
     null, p_schema_name, p_table_name, p_record_id, p_operation,
     p_old_value, p_new_value, p_correlation_id)
  returning id into v_id;

  return v_id;
end $$;

-- 2. platform.write_platform_event ----------------------------------------------------------------

create or replace function platform.write_platform_event(
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_payload jsonb,
  p_correlation_id uuid,
  p_causation_id uuid default null
) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id bigint;
begin
  if not platform.is_internal() then
    raise exception 'platform.write_platform_event: internal context required'
      using errcode = '42501';
  end if;
  if not platform.system_actor_permitted() then
    raise exception 'platform.write_platform_event: system actor outside pgeos_worker'
      using errcode = '42501';
  end if;
  if p_aggregate_type is null or p_aggregate_id is null or p_event_type is null
     or p_payload is null or p_correlation_id is null then
    raise exception 'platform.write_platform_event: required argument is null'
      using errcode = '42501';
  end if;
  if pg_catalog.split_part(p_aggregate_type, '.', 1) not in ('platform', 'identity') then
    raise exception 'platform.write_platform_event: aggregate type is not platform-scoped'
      using errcode = '42501';
  end if;

  insert into platform.outbox
    (entity_id, aggregate_type, aggregate_id, event_type, payload, correlation_id, causation_id,
     actor_id)
  values
    (null, p_aggregate_type, p_aggregate_id, p_event_type, p_payload, p_correlation_id,
     p_causation_id, platform.current_user_id())
  returning id into v_id;

  return v_id;
end $$;

-- 3. Grants --------------------------------------------------------------------------------------

revoke all on function platform.write_platform_audit(timestamptz, text, text, uuid, text, jsonb, uuid, jsonb) from public, pgeos_worker;
revoke all on function platform.write_platform_event(text, uuid, text, jsonb, uuid, uuid) from public, pgeos_worker;
grant execute on function platform.write_platform_audit(timestamptz, text, text, uuid, text, jsonb, uuid, jsonb) to pgeos_app;
grant execute on function platform.write_platform_event(text, uuid, text, jsonb, uuid, uuid) to pgeos_app;

-- 4. Read-only self-check ------------------------------------------------------------------------

do $$
declare
  v_fn regprocedure;
  v_bad text;
begin
  foreach v_fn in array array[
    'platform.write_platform_audit(timestamptz, text, text, uuid, text, jsonb, uuid, jsonb)'::regprocedure,
    'platform.write_platform_event(text, uuid, text, jsonb, uuid, uuid)'::regprocedure
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = v_fn
         and p.prosecdef
         and 'search_path=pg_catalog, pg_temp' = any (coalesce(p.proconfig, '{}'::text[]))
    ) then
      raise exception '0049: % is not SECURITY DEFINER with search_path=pg_catalog, pg_temp', v_fn;
    end if;

    select pg_catalog.string_agg(case when a.grantee = 0 then 'PUBLIC' else r.rolname::text end, ', ')
      into v_bad
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(p.proacl) a
      left join pg_catalog.pg_roles r on r.oid = a.grantee
     where p.oid = v_fn
       and a.privilege_type = 'EXECUTE'
       and a.grantee <> p.proowner
       and (a.grantee = 0 or r.rolname <> 'pgeos_app');
    if v_bad is not null then
      raise exception '0049: EXECUTE on % held by % (only pgeos_app allowed)', v_fn, v_bad;
    end if;
    if not pg_catalog.has_function_privilege('pgeos_app', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('pgeos_worker', v_fn, 'EXECUTE') then
      raise exception '0049: EXECUTE on % must be held by pgeos_app and not by pgeos_worker', v_fn;
    end if;

    if not exists (
      select 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_roles r on r.oid = p.proowner
       where p.oid = v_fn and (r.rolsuper or r.rolbypassrls)
    ) then
      raise exception '0049: owner of % is neither rolsuper nor rolbypassrls', v_fn;
    end if;
  end loop;

  select pg_catalog.string_agg(approved.schema_name || '.' || approved.table_name, ', ')
    into v_bad
    from (values ('platform', 'alert_log'),
                 ('imile', 'agent_health'),
                 ('imile', 'shipments'),
                 ('imile', 'driver_ids'),
                 ('imile', 'dtl_problems'),
                 ('wms', 'skus')) as approved(schema_name, table_name)
   where not exists (
           select 1 from pg_catalog.pg_class c
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
            where n.nspname = approved.schema_name
              and c.relname = approved.table_name
              and c.relkind in ('r', 'p'))
      or exists (
           select 1 from pg_catalog.pg_class c
             join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             join pg_catalog.pg_attribute att on att.attrelid = c.oid
            where n.nspname = approved.schema_name
              and c.relname = approved.table_name
              and att.attname = 'entity_id'
              and not att.attisdropped);
  if v_bad is not null then
    raise exception '0049: allowlisted pair(s) missing as a table or carrying entity_id: %', v_bad;
  end if;
end $$;

commit;
