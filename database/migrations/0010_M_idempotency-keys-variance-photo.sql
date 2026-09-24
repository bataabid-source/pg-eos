-- 0010_M_idempotency-keys-variance-photo.sql — Lane M — WBS 2.9 (part 2). Forward-only,
-- idempotent (apply.sh re-runs every file on every apply).
--
-- GM decision sheet 3 (docs/notes/2026-09-24-gm-decision-sheet-3.md), verbatim answers
-- "Q1: أ · Q2: ب (30) · … · Q6: أ":
--   Q1 أ  — approve platform.idempotency_keys as specified in
--           docs/notes/SCR-PLAT-IDEM-01-idempotency-key-store.md, shared by every module.
--   Q2 ب  — retention 30 days (overrides doc 40 §A4's 7), held in platform.thresholds, never a
--           literal in code.
--   Q6 أ  — wms.order_lines gains variance_photo_url + variance_photo_sha256
--           (docs/notes/SCR-WMS-INB-01-receive-inbound-rules.md §4); the upload arrives with the
--           PDA screen slice.
--
-- pg-reviewer pre-migration review: APPROVED WITH CHANGES — this text. Design notes:
--   * RLS: own rows only (idem_own, permissive) AND a RESTRICTIVE entity check (idem_entity_scope).
--     The entity policy is deliberately NOT named `entity_scope`: 0007's loop raises on any
--     non-permissive `entity_scope` policy, and it re-runs on every apply.
--   * expires_at defaults through platform.idempotency_ttl() — SECURITY DEFINER, because only
--     internal sessions may read platform.thresholds (reference_read), and portal callers write
--     keys too.
--   * pgeos_app has no DELETE: 0007's grant loop re-grants it on every apply, this file revokes it
--     again, so every apply converges. Expired rows are removed by platform.purge_idempotency_keys()
--     (definer; the pg-boss job that calls it is wired in a later slice) or reclaimed in place by the
--     helper (packages/db/src/idempotency.ts).
--   * Not audited: a replay cache; the command it guards writes its own audit row.
--   * No parity edit in 01/13B (0008 precedent: the migration alone).

begin;

insert into platform.thresholds (key, value, unit, description_ar, changed_by) values
 ('idempotency.retention_days', 30.000, 'days',
  'مدة الاحتفاظ بمفاتيح Idempotency-Key — قرار GM ورقة 3 Q2 (يتجاوز 40 §A4: 7)',
  '00000000-0000-0000-0000-000000000000')
on conflict (key) do nothing;

create or replace function platform.idempotency_ttl() returns interval
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v numeric;
begin
  select t.value into v from platform.thresholds t where t.key = 'idempotency.retention_days';
  if v is null then
    raise exception '0010: threshold idempotency.retention_days missing';
  end if;
  return make_interval(days => v::int);
end $$;

create table if not exists platform.idempotency_keys (
  user_id uuid not null references identity.users(id),
  key text not null,
  entity_id uuid references platform.entities(id),
  endpoint text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + platform.idempotency_ttl()),
  primary key (user_id, key)
);
create index if not exists idempotency_keys_expires_idx on platform.idempotency_keys (expires_at);

alter table platform.idempotency_keys enable row level security;
alter table platform.idempotency_keys force row level security;

drop policy if exists idem_own on platform.idempotency_keys;
create policy idem_own on platform.idempotency_keys for all
  using (user_id = platform.current_user_id())
  with check (user_id is not null and user_id = platform.current_user_id());

drop policy if exists idem_entity_scope on platform.idempotency_keys;
create policy idem_entity_scope on platform.idempotency_keys as restrictive for all
  using (entity_id is null or entity_id = any(platform.allowed_entities()))
  with check (entity_id is null or entity_id = any(platform.allowed_entities()));

grant select, insert, update on platform.idempotency_keys to pgeos_app;
revoke delete on platform.idempotency_keys from pgeos_app;

create or replace function platform.purge_idempotency_keys() returns bigint
language sql security definer set search_path = pg_catalog, pg_temp as $$
  with d as (delete from platform.idempotency_keys where expires_at <= now() returning 1)
  select count(*) from d
$$;

revoke execute on function platform.idempotency_ttl(), platform.purge_idempotency_keys() from public;
grant  execute on function platform.idempotency_ttl(), platform.purge_idempotency_keys() to pgeos_app;

-- ADR-0002 / 0009 pattern: a SECURITY DEFINER function must be owned by a role that bypasses RLS.
do $$ begin
  if exists (select 1 from pg_proc p join pg_roles r on r.oid = p.proowner
              where p.oid in ('platform.idempotency_ttl()'::regprocedure,
                              'platform.purge_idempotency_keys()'::regprocedure)
                and not (r.rolsuper or r.rolbypassrls)) then
    raise exception '0010: idempotency definer functions must be owned by a superuser or BYPASSRLS role (ADR-0002)';
  end if;
end $$;

alter table wms.order_lines add column if not exists variance_photo_url text;
alter table wms.order_lines add column if not exists variance_photo_sha256 text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'variance_photo_pair') then
    alter table wms.order_lines add constraint variance_photo_pair check (
      (variance_photo_url is null) = (variance_photo_sha256 is null)
      and (variance_photo_sha256 is null or variance_photo_sha256 ~ '^[0-9a-f]{64}$'));
  end if;
end $$;

insert into identity.column_classification (schema_name, table_name, column_name, sensitivity) values
 ('platform', 'idempotency_keys', 'user_id',         'public'),
 ('platform', 'idempotency_keys', 'key',             'public'),
 ('platform', 'idempotency_keys', 'entity_id',       'public'),
 ('platform', 'idempotency_keys', 'endpoint',        'public'),
 ('platform', 'idempotency_keys', 'request_hash',    'public'),
 ('platform', 'idempotency_keys', 'response_status', 'public'),
 ('platform', 'idempotency_keys', 'response_body',   'personal'),
 ('platform', 'idempotency_keys', 'created_at',      'public'),
 ('platform', 'idempotency_keys', 'expires_at',      'public'),
 ('wms',      'order_lines',      'variance_photo_url',    'personal'),
 ('wms',      'order_lines',      'variance_photo_sha256', 'public')
on conflict (schema_name, table_name, column_name) do nothing;

commit;
