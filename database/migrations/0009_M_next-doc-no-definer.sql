-- 0009_M_next-doc-no-definer.sql — Lane M — WBS 2.9. Forward-only, idempotent (apply.sh re-runs
-- every file on every apply; `create or replace` keeps the owner and existing grants).
--
-- Why: platform.next_doc_no (01-Data-Model.sql:96-112) is the ONLY document-number allocator (G13,
-- wms brief §4). It increments platform.counters, whose reference_write policy (13B:3121) requires
-- has_perm('platform.reference.manage') — a permission no operational role holds. Under the
-- non-superuser app role pgeos_app (migration 0007, D-133) every allocation by an operational user
-- therefore failed ("counter not defined"). Found by the WBS 2.9 golden slice (CloseInbound → GRN).
--
-- Fix (pg-reviewer pre-migration review: APPROVED WITH CHANGES): SECURITY DEFINER with a pinned
-- search_path (pg_catalog, pg_temp — the 0004 audit-function pattern; every name in the body is
-- schema-qualified), plus an explicit gate inside the body that restores the access rule the
-- reference_write policy used to give — the caller must be internal and the entity must be one of
-- its allowed_entities() (entity scope, D-002). A security fix of the same kind as 0007, not a new
-- business rule. Sessions that already bypass RLS (guards, apply.sh — G13 runs as superuser) pass,
-- since they could update platform.counters directly anyway. The counter-row lock is unchanged
-- (UPDATE … RETURNING), so G13's 100-concurrent-unique guarantee is unchanged.
--
-- Schema-file parity: 01-Data-Model.sql carries the same body / definer / search_path. The revoke,
-- grant and owner check live here only, because pgeos_app does not exist until 0007.
--
-- Scope note (fix round 2, finding F16): the entity-scope gate above is the ONLY restriction this
-- function enforces. Any internal, in-entity caller may allocate a doc_no for ANY doc_type
-- (INB, DOC, WO, CNT, OUT, ...) — this function does not, and should not, know which doc_type a
-- given command is "allowed" to use. Restricting doc_type per caller/role is each COMMAND's own
-- business rule to enforce (e.g. modules/wms/application/receive-inbound/close-inbound.ts's own
-- role gate on CLOSE decides who may reach the code path that allocates a GRN's 'DOC' doc_no) —
-- next_doc_no itself staying doc_type-agnostic is deliberate, not an oversight. A per-doc_type
-- allocation permission is a follow-up (G-01), not invented here.

begin;

create or replace function platform.next_doc_no(
  p_entity uuid, p_doc_type text, p_period text default 'ALL'
) returns text language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v_prefix text; v_pad int; v_val bigint;
begin
  if not exists (select 1 from pg_roles where rolname = session_user and (rolsuper or rolbypassrls))
     and not (platform.is_internal() and p_entity = any(platform.allowed_entities())) then
    raise exception using errcode = '42501',
      message = format('0009: entity %s is outside the caller''s allowed_entities()', p_entity);
  end if;

  update platform.counters
     set current_val = current_val + 1
   where entity_id = p_entity and doc_type = p_doc_type and period = p_period
  returning prefix, padding, current_val into v_prefix, v_pad, v_val;

  if not found then
    raise exception 'عدّاد غير معرّف: % / % / %', p_entity, p_doc_type, p_period;
  end if;

  return v_prefix || lpad(v_val::text, v_pad, '0');
end $$;

revoke execute on function platform.next_doc_no(uuid, text, text) from public;
grant  execute on function platform.next_doc_no(uuid, text, text) to pgeos_app;

do $$ begin
  if exists (select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
              where p.oid = 'platform.next_doc_no(uuid,text,text)'::regprocedure
                and not (r.rolsuper or r.rolbypassrls)) then
    raise exception '0009: next_doc_no owner must be superuser or BYPASSRLS (ADR-0002)';
  end if;
end $$;

commit;
