-- 0035_3_commission-daily-dispute-sod.sql — WBS 3.13 part 5a (lane 3, number issued by the Master
-- 2026-09-26 on MIGRATION-REQUEST-3 row 4).
--
-- WHAT: extends hr.guard_commission_daily_status() (migration 0033) with a DB-level backstop on the
-- calculated -> disputed edge: the acting session actor (platform.current_user_id()) must be the
-- identity.users row linked to the commission row's OWN employee. Until now only the application
-- layer (DisputeCommission step 2b, isOwnRow — modules/hr/application/dispute-commission/
-- dispute-commission.ts) enforced doc 10 §14 (l.300) "an actor may only dispute their own
-- commission"; a raw SQL UPDATE bypassing the command could dispute anyone's row.
--
-- WHY NOW: a deferred finding from WBS 3.13 part 4's slice-close review (round 2 — no round 3 per
-- REVIEW CAP, D-186/P7), carried as the `3.13 part 5a` backlog row.
--
-- PRE-MIGRATION REVIEW: pg-reviewer round 1 FAIL (7 findings). This file reflects the fix round:
--   - finding 2 (SECURITY): the EXISTS check binds to OLD.employee_id, not new.employee_id. Binding
--     to new.employee_id would let an actor linked to employee X UPDATE employee Y's row setting
--     BOTH employee_id = X and status = 'disputed' in one statement and pass the check. old is safe
--     here: the new block runs only inside the UPDATE branch, where old always exists.
--   - finding 4: the function body below restates 0033's body VERBATIM (security definer,
--     search_path, INSERT pin, transition-legality check, confirmed_by immutability, confirm-side
--     self-review / session-binding / hr.commission.confirm checks). The ONLY addition is the
--     `old.status = 'calculated' and new.status = 'disputed'` block, placed AFTER the legality
--     raise so an illegal transition still reports check_violation first. No drop function, no
--     trigger re-creation — trg_guard_commission_daily_status already points at this function by
--     name, so `create or replace function` alone is idempotent on rerun.
--   - finding 7: Arabic message citing doc 10 §14 (l.300) + WBS 3.13 part 5a, errcode
--     insufficient_privilege (SQLSTATE 42501); this header.
--   (findings 1, 5, 6 were test-side, fixed by pg-tester; finding 3 was brief-process.)
--
-- RED TESTS (pg-tester, confirmed RED before this file existed — the raw UPDATE succeeded):
--   - modules/hr/tests/dispute-commission/dispute-commission.test.ts — two new tests appended at
--     file end: (a) a raw UPDATE to 'disputed' by an actor not linked to the row's employee is
--     rejected with 42501; (b) the same, while ALSO setting employee_id to the actor's own linked
--     employee in the same UPDATE, is still rejected with 42501 (finding 2).
-- FIXTURE HELPERS pg-tester also touched (session-actor fix, so this migration does not turn their
-- already-GREEN fixtures RED — each now moves its row to 'disputed' inside a transaction with a
-- transaction-local app.user_id set to the employee's own linked driver actor):
--   - modules/hr/tests/dispute-commission/dispute-commission.test.ts
--   - modules/hr/tests/confirm-commission/confirm-commission.test.ts
--   - modules/hr/tests/confirm-commission/handlers.test.ts
--
-- NULL SESSION ACTOR: a session with no app.user_id (scheduler, apply.sh, admin) can NEVER dispute a
-- row under this check — platform.current_user_id() is NULL, the EXISTS finds nothing, the UPDATE
-- is rejected. Intentional: doc 10 §14 (l.300) makes a dispute always a human driver act. Migration
-- 0034's `current_user <> 'pgeos_app'` service-account carve-out (a different table, a different
-- concern) does not apply here.
--
-- OUT OF SCOPE (recorded as its own backlog item, `3.13 part 5b` addendum, not fixed here): 0033's
-- confirm-side self-review check (`u.employee_id = new.employee_id`, ~0033:268) has the same
-- new.employee_id exposure this migration closes on the dispute side. It is restated unchanged
-- below.
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

    if exists (
      select 1 from identity.users u
       where u.id = platform.current_user_id() and u.employee_id = new.employee_id
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
