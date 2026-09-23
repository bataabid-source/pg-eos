-- ═══════════════════════════════════════════════════════════════════════════
-- 0004_M_audit-chain-seq.sql — SCR-AUDIT-01 · ADR-0002 · قرار GM 23/09/2026 (الخيار A بحلّ §6)
-- مسار واحد (M) · WBS 0.9 (إصلاح) · ترحيل أمامي، قابل لإعادة التشغيل على قاعدة بُنيت من 13B القديم
-- (بلا chain_seq) أو من 13B v4.3 (العمود والفهارس والدالتان موجودة سلفاً).
--
-- في معاملة واحدة:
--   1. timezone/datestyle مثبّتان، وقفل ACCESS EXCLUSIVE على platform.audit_log.
--   2. إضافة chain_seq bigint (إن لم يوجد).
--   3. إن وُجد صف بلا chain_seq: إعادة بناء السلسلة كلها مرة واحدة بالترتيب الحالي (occurred_at, id) —
--      chain_seq = 1..n، prev_hash = row_hash السابق الجديد، row_hash بصيغة وثيقة 31 §3-3 دون تغيير.
--      ممنوعة إلا بتفعيل صريح (pgeos.audit_chain_rebuild=allow) — ADR-0002؛ قاعدة إنتاجية تحتاج موافقة GM.
--   4. NOT NULL على chain_seq.
--   5. فهرس فريد <القسم>_chain_seq_key على كل قسم (الافتراضي ضمناً) — لا قيد فريداً ممكناً على الأب المقسَّم.
--   6-7. استبدال المشغّل ودالة التحقق (حذف الدالة القديمة بلا معاملات أولاً — وإلا صار الاستدعاء ملتبساً).
--   8. تصنيف chain_seq = public للأب ولكل قسم (G6).
--   9. شرطان لاحقان: مالك الدالتين superuser أو BYPASSRLS، وverify_audit_chain() = صفر صفوف.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';

lock table platform.audit_log in access exclusive mode;

alter table platform.audit_log add column if not exists chain_seq bigint;

do $$
declare
  r      record;
  v_prev text   := null;
  v_seq  bigint := 0;
  v_hash text;
begin
  if exists (select 1 from platform.audit_log where chain_seq is null) then
    if coalesce(current_setting('pgeos.audit_chain_rebuild', true), '') <> 'allow' then
      raise exception '0004: platform.audit_log holds rows without chain_seq; rebuilding the chain rewrites every hash. Refused without explicit opt-in: PGOPTIONS=''-c pgeos.audit_chain_rebuild=allow'' (ADR-0002).';
    end if;
    for r in
      select a.id, a.occurred_at, a.user_id, a.table_name, a.record_id, a.operation
        from platform.audit_log a
       order by a.occurred_at, a.id
    loop
      v_seq  := v_seq + 1;
      v_hash := encode(sha256(convert_to(
          coalesce(v_prev,'')
          || coalesce(r.occurred_at::text,'')
          || coalesce(r.user_id::text,'')
          || coalesce(r.table_name,'')
          || coalesce(r.record_id::text,'')
          || coalesce(r.operation,''), 'UTF8')), 'hex');
      update platform.audit_log
         set chain_seq = v_seq, prev_hash = v_prev, row_hash = v_hash
       where id = r.id and occurred_at = r.occurred_at;
      v_prev := v_hash;
    end loop;
    raise notice '0004: audit chain rebuilt once in (occurred_at, id) order — % rows', v_seq;
  end if;
end $$;

alter table platform.audit_log alter column chain_seq set not null;

do $$
declare r record;
begin
  for r in
    select n.nspname, c.relname
      from pg_inherits i
      join pg_class c     on c.oid = i.inhrelid
      join pg_namespace n on n.oid = c.relnamespace
     where i.inhparent = 'platform.audit_log'::regclass
  loop
    execute format('create unique index if not exists %I on %I.%I (chain_seq)',
                   r.relname || '_chain_seq_key', r.nspname, r.relname);
  end loop;
end $$;

drop function if exists platform.verify_audit_chain();

-- المصدر: وثيقة 31 §3-3 — row_hash = sha256(prev_hash || occurred_at || user_id || table_name || record_id || operation)
-- v4.3 · SCR-AUDIT-01 / ADR-0002 (قرار GM 23/09/2026): ترتيب السلسلة = chain_seq = السابق + 1، يُحسب هنا بعد
--   القفل الاستشاري في الاستعلام نفسه الذي يجلب التجزئة السابقة (بلا كائن تسلسل؛ التراجع لا يترك فجوة).
--   · القفل محجوز حتى الالتزام أو التراجع ⇒ كل كتابات التدقيق متسلسلة (ADR-0002 §الأثر).
--   · security definer: audit_log تحت FORCE RLS وentity_scope على الأب (D-002) — الرأس يُقرأ كاملاً.
--     يشترط أن يكون مالك الدالة superuser أو BYPASSRLS (يتحقق الترحيل 0004 من ذلك).
--   · READ COMMITTED فقط: تحت REPEATABLE READ/SERIALIZABLE لا يرى الاستعلام صف حامل القفل السابق فيتكرر الرقم.
--   · timezone/datestyle مثبّتان: تمثيل occurred_at::text في الصيغة لا يتبع إعدادات جلسة الكاتب.
create or replace function platform.audit_hash_chain()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $$
declare
  v_prev text;
  v_seq  bigint;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'platform.audit_hash_chain: audited writes must run under READ COMMITTED (current: %)',
      current_setting('transaction_isolation')
      using errcode = '25001';
  end if;

  perform pg_advisory_xact_lock(hashtext('platform.audit_log'));
  select a.chain_seq, a.row_hash
    into v_seq, v_prev
    from platform.audit_log a
   order by a.chain_seq desc
   limit 1;

  new.chain_seq := coalesce(v_seq, 0) + 1;
  new.prev_hash := v_prev;
  new.row_hash  := encode(sha256(convert_to(
      coalesce(v_prev,'')
      || coalesce(new.occurred_at::text,'')
      || coalesce(new.user_id::text,'')
      || coalesce(new.table_name,'')
      || coalesce(new.record_id::text,'')
      || coalesce(new.operation,''), 'UTF8')), 'hex');
  return new;
end $$;

-- G8 (40 Part F): يجب أن تعيد صفر صفوف. ترتّب بـ chain_seq فقط. نقطة الارتكاز (ADR-0002): بعد فصل أقسام
-- قديمة أو أرشفتها تُستدعى بأول chain_seq محتفَظ به وبتجزئته السابقة. security definer للسبب نفسه أعلاه:
-- مستدعٍ لا يتجاوز RLS سيرى جزءاً من السلسلة فتظهر فجوات زائفة.
create or replace function platform.verify_audit_chain(
  p_anchor_seq       bigint default 1,
  p_anchor_prev_hash text   default null)
returns table (chain_seq bigint, id bigint, occurred_at timestamptz, problem text, detail text,
               expected_hash text, actual_hash text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
set timezone = 'UTC'
set datestyle = 'ISO, YMD'
as $$
  with ordered as (
    select a.chain_seq, a.id, a.occurred_at, a.user_id, a.table_name, a.record_id, a.operation,
           a.prev_hash, a.row_hash,
           row_number()     over w as rn,
           lag(a.chain_seq) over w as seq_prev,
           lag(a.row_hash)  over w as hash_prev
      from platform.audit_log a
     where a.chain_seq >= p_anchor_seq
    window w as (order by a.chain_seq, a.id)
  ), checked as (
    select o.*,
           case when o.rn = 1 then p_anchor_prev_hash else o.hash_prev    end as expected_prev,
           case when o.rn = 1 then p_anchor_seq       else o.seq_prev + 1 end as expected_seq,
           (o.rn > 1 and o.chain_seq = o.seq_prev)                           as is_duplicate
      from ordered o
  ), hashed as (
    select c.*,
           encode(sha256(convert_to(
             coalesce(c.expected_prev,'')
             || coalesce(c.occurred_at::text,'')
             || coalesce(c.user_id::text,'')
             || coalesce(c.table_name,'')
             || coalesce(c.record_id::text,'')
             || coalesce(c.operation,''), 'UTF8')), 'hex') as expected_row_hash
      from checked c
  )
  select h.chain_seq, h.id, h.occurred_at, p.problem, p.detail, p.expected, p.actual
    from hashed h
   cross join lateral (values
     ('duplicate_chain_seq', 'chain_seq repeated', null::text, null::text,
        h.is_duplicate),
     ('chain_seq_gap', 'expected chain_seq ' || h.expected_seq, null, null,
        h.chain_seq <> h.expected_seq and not h.is_duplicate),
     ('prev_hash_mismatch', 'expected/actual are prev_hash values', h.expected_prev, h.prev_hash,
        h.prev_hash is distinct from h.expected_prev),
     ('hash_mismatch', 'expected/actual are row_hash values', h.expected_row_hash, h.row_hash,
        h.row_hash is distinct from h.expected_row_hash)
   ) as p(problem, detail, expected, actual, failed)
   where p.failed
  union all
  -- نقطة ارتكاز فارغة أو أعلى من رأس السلسلة لا تُرجع «سليم» بصمت (مراجعة الجولة 2، الملاحظة 3).
  select null, null, null, 'anchor_invalid', 'p_anchor_seq is null', null, null
   where p_anchor_seq is null
  union all
  select null, null, null, 'anchor_not_found', 'no row with chain_seq >= ' || p_anchor_seq, null, null
   where p_anchor_seq is not null
     and exists (select 1 from platform.audit_log)
     and not exists (select 1 from platform.audit_log a where a.chain_seq >= p_anchor_seq)
  union all
  -- الدالتان security definer: مالكهما يجب أن يتجاوز FORCE RLS، وإلا رأت الدالتان جزءاً من السلسلة
  -- وأعاد G8 «صفر» على سلسلة مكسورة. يُفحص في كل تشغيل لا عند الترحيل فقط (الملاحظة 2).
  select null, null, null, 'definer_owner_cannot_bypass_rls', 'platform.' || p.proname || ' owned by ' || r.rolname, null, null
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.pronamespace = 'platform'::regnamespace
     and p.proname in ('audit_hash_chain', 'verify_audit_chain')
     and not (r.rolsuper or r.rolbypassrls)
  union all
  -- شرط GM (1): كل قسم — الافتراضي ضمناً — يحمل فهرساً فريداً صالحاً، بلا شرط ولا تعبير، مفتاحه chain_seq وحده.
  -- الفحص بخصائص pg_index لا باسم الفهرس.
  select null, null, null, 'partition_missing_chain_seq_unique_index', n.nspname || '.' || c.relname, null, null
    from pg_catalog.pg_inherits i
    join pg_catalog.pg_class c     on c.oid = i.inhrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where i.inhparent = 'platform.audit_log'::regclass
     and not exists (
       select 1
         from pg_catalog.pg_index x
         join pg_catalog.pg_attribute att
           on att.attrelid = c.oid and att.attname = 'chain_seq' and att.attnum = x.indkey[0]
        where x.indrelid = c.oid
          and x.indisunique and x.indisvalid
          and x.indpred is null and x.indexprs is null
          and x.indnatts = 1)
$$;

comment on function platform.verify_audit_chain(bigint, text) is
  'G8 (40 Part F): صفر صفوف. ترتيب chain_seq فقط؛ يكشف عدم تطابق row_hash وprev_hash والتكرار والفجوات وقسماً بلا فهرس chain_seq الفريد ونقطة ارتكاز فارغة أو غائبة ومالكاً لا يتجاوز RLS. الارتكاز بعد فصل الأقسام: ADR-0002.';
revoke all on function platform.verify_audit_chain(bigint, text) from public;
-- الملاحظة 1: دالة المشغّل security definer — لا تُتاح لأي دور لإلحاقها بجدول آخر. المشغّل القائم يعمل
-- لأن صلاحية EXECUTE تُفحص عند create trigger فقط.
revoke all on function platform.audit_hash_chain() from public;

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity)
select 'platform', c.relname, 'chain_seq', 'public'
  from pg_class c
 where c.oid = 'platform.audit_log'::regclass
    or c.oid in (select inhrelid from pg_inherits where inhparent = 'platform.audit_log'::regclass)
on conflict (schema_name, table_name, column_name) do nothing;

do $$
declare
  v_bad    text;
  v_broken bigint;
begin
  select string_agg(p.proname || ' owned by ' || r.rolname, ', ')
    into v_bad
    from pg_proc p
    join pg_roles r on r.oid = p.proowner
   where p.pronamespace = 'platform'::regnamespace
     and p.proname in ('audit_hash_chain', 'verify_audit_chain')
     and not (r.rolsuper or r.rolbypassrls);
  if v_bad is not null then
    raise exception '0004: % — SECURITY DEFINER needs an owner that is superuser or BYPASSRLS (ADR-0002)', v_bad;
  end if;

  select count(*) into v_broken from platform.verify_audit_chain();
  if v_broken > 0 then
    raise exception '0004: platform.verify_audit_chain() returned % rows after the migration', v_broken;
  end if;
end $$;

commit;
