-- 0037_M_commission-confirm-sod.sql — WBS 3.13, Master security task (number issued by the Master
-- 2026-09-26; builder pg-backend-core, opus, D-191).
--
-- WHAT: restates hr.guard_commission_daily_status() (current body = migration 0035) and closes the
-- confirm-side `new.employee_id` exposure — the MASTER_BACKLOG item "3.13 — confirm-side
-- new.employee_id exposure" (recorded by 0035's own header, OUT OF SCOPE note). Until now the
-- confirm-side self-review EXISTS bound to `new.employee_id`, so an actor linked to employee X could
-- UPDATE employee Y's row setting BOTH employee_id = X and status = 'confirmed' / confirmed_by in
-- one statement and pass the self-review check. This migration CLOSES that backlog item.
--
-- PRE-MIGRATION REVIEW: pg-reviewer (opus) FAIL(7); the binding findings are applied here:
--   1. employee_id is IMMUTABLE on EVERY UPDATE — a new check placed right after the INSERT pin,
--      OUTSIDE the `new.status is distinct from old.status` block, so a status-less UPDATE that
--      only re-attributes a row is rejected too (doc 38 row 3.13: "frozen snapshot",
--      "Attribution through assignment table only"). errcode insufficient_privilege (42501).
--   2. The confirm-side self-review EXISTS binds to
--      `case when tg_op = 'UPDATE' then old.employee_id else new.employee_id end` — not a bare
--      old.employee_id, so the (defensive, currently unreachable) INSERT branch keeps working.
--   3. No bypass / role carve-out is added; order kept exactly: INSERT pin -> employee_id
--      immutability -> legality raise -> dispute block -> confirmed_by immutability -> confirm branch.
--   4. No audit trigger or hash chain is touched.
--   5. Forward-only: `create or replace function` only — no DROP, no trigger re-creation
--      (trg_guard_commission_daily_status already points at this function by name), so the file is
--      idempotent on rerun. Everything else in the body is 0035's body VERBATIM.
--   6. Tests (pg-tester, test-side): an employee_id immutability case on a 'calculated' row, and
--      the RED file's test titles retitled accordingly.
--   7. Registers, same change: database/migrations/README.md (applied range 0001–0037 + a 0037
--      line) and tasks/LANE_LOCKS.md (0037 row with this review record; next free number 0038).
--
-- RED TESTS (pg-tester, RED before this file existed):
--   - tests/isolation/tests/hr-commission-confirm-sod.test.ts
--
-- No new table, column, permission or trigger.

begin;

create or replace function hr.guard_commission_daily_status() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Round-4 review finding 2: an INSERT has no prior state to transition FROM, so the
  -- state-machine check above never ran for one — an INSERT could carry status='disputed',
  -- 'confirmed' or even 'paid' directly, contradicting doc 10:275's own lifecycle start
  -- (`calculated`, always written first by CalculateDailyCommission) and this trigger's own
  -- header claim that no path reaches 'paid' yet.
  if tg_op = 'INSERT' and new.status <> 'calculated' then
    raise exception 'صف عمولة يومية جديد يجب أن يبدأ بحالة calculated، لا % — WBS 3.13 part 4', new.status
      using errcode = 'check_violation';
  end if;

  -- Migration 0037 (pre-migration review finding 1): employee_id is IMMUTABLE on every UPDATE,
  -- with or without a status change — a commission row is a frozen snapshot attributed through the
  -- assignment table only (doc 38 row 3.13).
  if tg_op = 'UPDATE' and new.employee_id is distinct from old.employee_id then
    raise exception 'employee_id غير قابل للتعديل — صف العمولة لقطة مجمَّدة (frozen snapshot) والإسناد عبر جدول الإسناد فقط (Attribution through assignment table only) — doc 38 row 3.13, migration 0037'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
         (old.status = 'calculated' and new.status in ('disputed', 'confirmed'))
      or (old.status = 'disputed'   and new.status = 'confirmed')
    ) then
      raise exception 'انتقال حالة عمولة يومية غير مسموح: % ⇒ % — WBS 3.13 part 4', old.status, new.status
        using errcode = 'check_violation';
    end if;

    -- WBS 3.13 part 5a (migration 0035): only the row's OWN employee's linked user may dispute it
    -- (doc 10 §14 l.300). Bound to old.employee_id (pre-migration review finding 2).
    if old.status = 'calculated' and new.status = 'disputed' then
      if not exists (
        select 1 from identity.users u
         where u.id = platform.current_user_id() and u.employee_id = old.employee_id
      ) then
        raise exception 'لا يجوز الاعتراض إلا على عمولة الموظف نفسه — doc 10 §14 (l.300), WBS 3.13 part 5a'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;

  -- SoD (doc 10:300): checked whenever a row becomes/stays 'confirmed' with a confirmer set,
  -- not only on a status change — an UPDATE that merely changes confirmed_by on an
  -- already-confirmed row must not be able to quietly reassign it to the driver themselves.
  -- Fires on INSERT too (round-1 review finding 4, though INSERT is now pinned to 'calculated'
  -- above, round-4 finding 2, so this specific INSERT case is currently unreachable — the check
  -- stays as defense in depth). Current, final state (superseding two now-stale earlier
  -- descriptions of this same block, left as history above in the header, not restated here):
  -- `hr.commission.read_all` is VISIBILITY-only and does not gate this table at all any more —
  -- `own_commission` (below, in the SQL body) now checks the NEW `hr.driver_commission.read_all`
  -- permission instead (SCR-HR-COMM-01, APPROVED). The WRITE authority for resolving a dispute is
  -- the NEW `hr.commission.confirm` permission (seeded to DEL_SUP below), checked via
  -- `platform.has_perm()` — the same mechanism every other authorization check in this codebase
  -- uses — scoped to the disputed -> confirmed edge only (round-4 finding 3). No role-code check
  -- remains anywhere in this function.
  --
  -- Round-3 review findings 1/2 (SECURITY, applied): the checks below must bind to the ACTING
  -- session user (platform.current_user_id()), never to the client-supplied `new.confirmed_by`
  -- column alone — otherwise any internal actor visible to `internal_update` (e.g. a read_all
  -- holder who is not DEL_SUP) could name an arbitrary real DEL_SUP user id in `confirmed_by` and
  -- pass both EXISTS checks despite never having authenticated as that user. Every OTHER
  -- authorization check in this codebase (has_perm(), my_employee_id()) binds to the session actor
  -- for exactly this reason. Also: a NULL `confirmed_by` is the exempted path ONLY for the
  -- `calculated -> confirmed` window-expiry auto-confirm edge (round-1 finding 5) — a
  -- `disputed -> confirmed` transition, which doc 10:300 says is ALWAYS a DEL_SUP human review,
  -- must never leave `confirmed_by` null.
  -- Round-4 review finding 1: the previous "old.status is distinct from 'disputed'" exemption
  -- was too wide — it also silently allowed (i) an INSERT with status='confirmed' and a NULL
  -- confirmer (bypassing any window/dispute check entirely — now moot anyway, INSERT is pinned
  -- to 'calculated' above) and (ii) an UPDATE on an ALREADY-confirmed row that nulls out its own
  -- confirmed_by, erasing who confirmed it. The auto-confirm NULL exemption is now scoped to
  -- EXACTLY the one edge round-1 finding 5 approved: an UPDATE, FROM 'calculated', TO 'confirmed'.
  -- Round-5 review finding 1 (SECURITY, applied): once a row IS 'confirmed', `confirmed_by`
  -- becomes IMMUTABLE — no actor, DEL_SUP or otherwise, may reassign or null out who resolved a
  -- dispute after the fact (doc 10:300's record of who reviewed it must not be erasable). This
  -- also closes finding 2's root cause: any later UPDATE that does NOT touch `confirmed_by` on an
  -- already-confirmed row (e.g. writing `payroll_period`, WBS 5.6's own future consumer) must not
  -- be caught by the exemption/rejection logic below at all — checked first, before it.
  if tg_op = 'UPDATE' and old.status = 'confirmed' and new.status = 'confirmed'
     and new.confirmed_by is distinct from old.confirmed_by
  then
    raise exception 'confirmed_by غير قابل للتعديل بعد الاعتماد — WBS 3.13 part 4'
      using errcode = 'insufficient_privilege';
  end if;

  if new.status = 'confirmed' and tg_op = 'UPDATE' and old.status = 'calculated'
     and new.confirmed_by is null
  then
    null; -- the window-expiry auto-confirm path (round-1 finding 5) — intentionally exempt.
  elsif new.status = 'confirmed' and new.confirmed_by is null
     and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
  then
    -- Round-5 review finding 2: an UPDATE that leaves an already-confirmed row's NULL
    -- confirmed_by untouched (old.status = 'confirmed', both old and new confirmed_by null) must
    -- NOT reach this rejection — the immutability check above already lets it through
    -- unmolested (confirmed_by is distinct from confirmed_by is false), so it never gets here.
    -- Every other way to reach 'confirmed' with no confirmer is rejected: a disputed row
    -- (doc 10:300 — always a DEL_SUP human review), and (defensively, though INSERT is already
    -- pinned above) any other path.
    raise exception 'اعتماد عمولة يتطلب مشرف توصيل محدد (DEL_SUP) — لا يجوز ترك confirmed_by فارغاً هنا — doc 10 §14 (l.300), WBS 3.13 part 4'
      using errcode = 'not_null_violation';
  elsif new.status = 'confirmed'
     and new.confirmed_by is not null
     and (tg_op = 'INSERT' or old.status is distinct from 'confirmed')
  then
    -- The immutability check above already handles old.status = 'confirmed' with a CHANGED
    -- confirmed_by (rejected before this point) — so by construction, reaching this branch with
    -- old.status = 'confirmed' is impossible; this branch only ever runs for a FRESH transition
    -- into 'confirmed' (from calculated or disputed) or an INSERT.
    if new.confirmed_by is distinct from platform.current_user_id() then
      raise exception 'confirmed_by يجب أن يطابق هوية الجلسة الفعلية — لا يجوز انتحال معتمِد آخر — WBS 3.13 part 4'
        using errcode = 'insufficient_privilege';
    end if;

    -- Migration 0037 (pre-migration review finding 2): bound to old.employee_id on UPDATE
    -- (new.employee_id only on the defensive INSERT branch, where no old row exists).
    -- unreachable on UPDATE once employee_id is immutable (see the immutability check above); kept as defense in depth, not independently testable
    if exists (
      select 1 from identity.users u
       where u.id = platform.current_user_id()
         and u.employee_id = case when tg_op = 'UPDATE' then old.employee_id else new.employee_id end
    ) then
      raise exception 'لا يجوز للسائق اعتماد اعتراضه بنفسه — مشرف التوصيل (DEL_SUP) فقط — doc 10 §14, WBS 3.13 part 4'
        using errcode = 'insufficient_privilege';
    end if;

    -- D-190 ruling (round-3 review, permission split): the interim DEL_SUP-role-code check is
    -- REPLACED by the real, permanent write permission `hr.commission.confirm` (seeded below to
    -- DEL_SUP) — checked via `platform.has_perm()`, the SAME mechanism every other authorization
    -- check in this codebase uses. Round-4 review finding 3: no document (01/13/13B/40/10) makes
    -- DEL_SUP a gate on the plain window-expiry auto-confirm path (`old.status = 'calculated'`,
    -- e.g. a manual early confirm of an undisputed row by any authorized internal actor) — doc
    -- 10:300 names DEL_SUP only for reviewing an actual DISPUTE. The permission check is therefore
    -- scoped to exactly that: resolving a dispute (`old.status = 'disputed'`). The self-review and
    -- session-actor-binding checks above still apply unconditionally either way.
    if old.status = 'disputed' and not platform.has_perm('hr.commission.confirm') then
      raise exception 'حل اعتراض عمولة يتطلب صلاحية hr.commission.confirm (مشرف التوصيل DEL_SUP) — doc 10 §14 (l.300), WBS 3.13 part 4'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end $$;

commit;
