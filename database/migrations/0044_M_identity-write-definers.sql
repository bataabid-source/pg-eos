-- 0044_M_identity-write-definers.sql — M-core (lane M), WBS 2.16 part 1a-8 = SCR-IDENTITY-RLS-01
-- delta 2 (identity.sessions, identity.otp_codes). Forward-only, idempotent (apply.sh re-runs every
-- file on every apply; `drop policy if exists` + `create policy`, `create or replace function`,
-- revoke/grant are rerunnable, and a read-only self-check). No data change. One transaction.
--
-- WHAT: both tables carried ONE policy, `internal_only for all using (platform.is_internal())`
-- (13B generator, 13B:3088-3145 branch 2), and pgeos_app held SELECT/INSERT/UPDATE/DELETE on both.
-- Every production write runs pre-auth under an internal no-actor context (userId null), so
-- `current_user_id()` cannot gate it. After this file:
--   - each table has ONE policy, `internal_read for select using (platform.is_internal())`, and no
--     insert/update/delete policy;
--   - pgeos_app loses INSERT/UPDATE/DELETE on both (defence in depth: a direct write fails with
--     42501, it is not silently filtered by RLS);
--   - every write, and the one row-locking read (`for update` needs UPDATE privilege and applies the
--     UPDATE policies under RLS), goes through one of six SECURITY DEFINER functions in `identity`:
--       otp_lock_candidates · otp_issue · otp_record_failure · otp_consume · session_issue ·
--       session_revoke.
--     Each body is the SQL moved verbatim from packages/identity/src/{otp,session}.ts; no rule moves
--     from TS to SQL (thresholds, resend window, hourly cap, lockout stay in otp.ts; the HMAC hashes
--     are computed in TS, the key never reaches SQL).
--
-- DEFINER DISCIPLINE (0010:86-94, 0043 pattern): `language plpgsql volatile security definer
-- set search_path = pg_catalog, pg_temp`, static SQL only (no EXECUTE / format), every object
-- schema-qualified, first statement `if not platform.is_internal() then raise … 42501`,
-- `revoke all … from public`, `grant execute … to pgeos_app`.
--
-- ORDERING (0010 / 0038 precedent): 0007_M_pgeos-app-role-entity-scope.sql:95 re-grants
-- `select, insert, update, delete` on EVERY table of the schema to pgeos_app on every apply. The
-- revoke below holds only because 0044 sorts (and runs) after 0007; a later migration that
-- re-grants DML on identity.* must restate this revoke.
--
-- SCHEMA PARITY (brief Decision 3): database/schema/* is not edited. 13B's generator loop skips a
-- table that already has a policy (13B:3101-3104) and runs before the migrations, so on a fresh
-- apply it creates `internal_only` and this file replaces it; 01 carries no text for either policy.
--
-- ROLLBACK: forward-only. A new forward-only migration would restate `internal_only for all`,
-- re-grant DML and drop the six functions (not recommended — it reopens direct pre-auth writes).

begin;

-- 1. Policies: read-only for the internal context --------------------------------------------------

drop policy if exists internal_only on identity.sessions;
drop policy if exists internal_read on identity.sessions;
create policy internal_read on identity.sessions for select using (platform.is_internal());

drop policy if exists internal_only on identity.otp_codes;
drop policy if exists internal_read on identity.otp_codes;
create policy internal_read on identity.otp_codes for select using (platform.is_internal());

-- 2. No direct DML for the app role -----------------------------------------------------------------

revoke insert, update, delete on identity.sessions, identity.otp_codes from pgeos_app;

-- 3. Definers -------------------------------------------------------------------------------------

-- otp.ts verifyOtpInTx candidate select, verbatim. The `returns table` output names are plpgsql
-- variables, so every column reference is alias-qualified (an unqualified one raises 42702). The
-- row lock lasts until the caller's transaction ends.
create or replace function identity.otp_lock_candidates(
  p_email text, p_at timestamptz, p_max_attempts numeric
) returns table(id uuid, code_hash text, user_id uuid, is_active boolean)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not platform.is_internal() then
    raise exception 'identity.otp_lock_candidates: internal context required'
      using errcode = '42501';
  end if;
  return query
    select o.id,
           o.code_hash,
           u.id as user_id,
           u.is_active
      from identity.otp_codes o
      join identity.users u on u.email = o.email
     where o.email = p_email
       and o.consumed_at is null
       and o.expires_at >= p_at
       and o.attempts < p_max_attempts
     order by o.id
       for update of o;
end
$$;

-- otp.ts generateOtpInTx: consume every earlier live code at the issue instant, then insert the new
-- row — one call, atomic.
create or replace function identity.otp_issue(
  p_email text, p_code_hash text, p_issued_at timestamptz, p_expires_at timestamptz
) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id uuid;
begin
  if not platform.is_internal() then
    raise exception 'identity.otp_issue: internal context required'
      using errcode = '42501';
  end if;
  update identity.otp_codes
     set consumed_at = p_issued_at
   where email = p_email
     and consumed_at is null;
  insert into identity.otp_codes (email, code_hash, expires_at)
  values (p_email, p_code_hash, p_expires_at)
  returning identity.otp_codes.id into v_id;
  return v_id;
end
$$;

-- otp.ts verifyOtpInTx, no match: attempts += 1 on every live candidate.
create or replace function identity.otp_record_failure(p_ids uuid[]) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not platform.is_internal() then
    raise exception 'identity.otp_record_failure: internal context required'
      using errcode = '42501';
  end if;
  update identity.otp_codes
     set attempts = attempts + 1
   where id = any (p_ids);
end
$$;

-- otp.ts verifyOtpInTx, match: consume the matched row at the injected instant.
create or replace function identity.otp_consume(p_id uuid, p_at timestamptz) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not platform.is_internal() then
    raise exception 'identity.otp_consume: internal context required'
      using errcode = '42501';
  end if;
  update identity.otp_codes
     set consumed_at = p_at
   where id = p_id;
end
$$;

-- session.ts issueSessionInTx insert.
create or replace function identity.session_issue(
  p_user_id uuid, p_token_hash text, p_issued_at timestamptz, p_expires_at timestamptz
) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id uuid;
begin
  if not platform.is_internal() then
    raise exception 'identity.session_issue: internal context required'
      using errcode = '42501';
  end if;
  insert into identity.sessions (user_id, token_hash, issued_at, expires_at)
  values (p_user_id, p_token_hash, p_issued_at, p_expires_at)
  returning identity.sessions.id into v_id;
  return v_id;
end
$$;

-- session.ts revokeSession: the first revocation instant stands (`revoked_at is null`).
create or replace function identity.session_revoke(p_id uuid, p_at timestamptz) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  if not platform.is_internal() then
    raise exception 'identity.session_revoke: internal context required'
      using errcode = '42501';
  end if;
  update identity.sessions
     set revoked_at = p_at
   where id = p_id
     and revoked_at is null;
end
$$;

revoke all on function identity.otp_lock_candidates(text, timestamptz, numeric) from public;
revoke all on function identity.otp_issue(text, text, timestamptz, timestamptz) from public;
revoke all on function identity.otp_record_failure(uuid[]) from public;
revoke all on function identity.otp_consume(uuid, timestamptz) from public;
revoke all on function identity.session_issue(uuid, text, timestamptz, timestamptz) from public;
revoke all on function identity.session_revoke(uuid, timestamptz) from public;

grant execute on function identity.otp_lock_candidates(text, timestamptz, numeric) to pgeos_app;
grant execute on function identity.otp_issue(text, text, timestamptz, timestamptz) to pgeos_app;
grant execute on function identity.otp_record_failure(uuid[]) to pgeos_app;
grant execute on function identity.otp_consume(uuid, timestamptz) to pgeos_app;
grant execute on function identity.session_issue(uuid, text, timestamptz, timestamptz) to pgeos_app;
grant execute on function identity.session_revoke(uuid, timestamptz) to pgeos_app;

-- 4. Self-check (read-only; raises on any miss) ---------------------------------------------------

do $$
declare
  v_fn  text;
  v_tab text;
  v_priv text;
  v_policies int;
begin
  foreach v_fn in array array[
    'identity.otp_lock_candidates(text,timestamptz,numeric)',
    'identity.otp_issue(text,text,timestamptz,timestamptz)',
    'identity.otp_record_failure(uuid[])',
    'identity.otp_consume(uuid,timestamptz)',
    'identity.session_issue(uuid,text,timestamptz,timestamptz)',
    'identity.session_revoke(uuid,timestamptz)'
  ] loop
    if not exists (
      select 1
      from pg_catalog.pg_proc f
      join pg_catalog.pg_roles r on r.oid = f.proowner
      where f.oid = v_fn::regprocedure
        and f.prosecdef
        and f.provolatile = 'v'
        and f.proconfig = array['search_path=pg_catalog, pg_temp']
        and (r.rolsuper or r.rolbypassrls)
    ) then
      raise exception '0044: % must be SECURITY DEFINER, VOLATILE, search_path=pg_catalog, pg_temp, owned by a superuser/BYPASSRLS role', v_fn;
    end if;
    if pg_catalog.has_function_privilege('public', v_fn::regprocedure, 'EXECUTE') then
      raise exception '0044: PUBLIC must not hold EXECUTE on %', v_fn;
    end if;
    if not pg_catalog.has_function_privilege('pgeos_app', v_fn::regprocedure, 'EXECUTE') then
      raise exception '0044: pgeos_app must hold EXECUTE on %', v_fn;
    end if;
  end loop;

  foreach v_tab in array array['identity.sessions', 'identity.otp_codes'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE'] loop
      if pg_catalog.has_table_privilege('pgeos_app', v_tab, v_priv) then
        raise exception '0044: pgeos_app must not hold % on %', v_priv, v_tab;
      end if;
    end loop;

    select count(*) into v_policies
      from pg_catalog.pg_policies p
     where p.schemaname || '.' || p.tablename = v_tab;
    if v_policies <> 1 or not exists (
      select 1
        from pg_catalog.pg_policies p
       where p.schemaname || '.' || p.tablename = v_tab
         and p.policyname = 'internal_read'
         and p.cmd = 'SELECT'
         and p.qual = 'platform.is_internal()'
    ) then
      raise exception '0044: % must hold exactly one policy, internal_read (SELECT, platform.is_internal())', v_tab;
    end if;
  end loop;
end $$;

commit;
