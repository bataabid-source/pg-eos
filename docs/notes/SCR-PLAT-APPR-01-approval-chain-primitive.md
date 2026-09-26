# SCR-PLAT-APPR-01 — `platform.is_approval_chain_approver()`, the shared approval-chain primitive (G-01 schema-change request)

**Status:** APPLIED — migration `0034_2_gl-account-change-requests.sql` (WBS 4.1a part 2, lane 2, 2026-09-26).
Filed under **EXECUTION-MASTER-v4 §1.11 (G-01)** by the Master/evaluation-session ruling during
4.1a part 2's pre-migration review (round 1, finding 2 — no approver write-path existed at all for
`billing.gl_accounts`, and the withheld `platform.reference.manage` permission from 4.1a part 1
blocked the naive fix). Recorded here per D-190.

## 1 · The primitive

```sql
create or replace function platform.is_approval_chain_approver(p_request_type text, p_step int default 1)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1
    from platform.approval_chains ac
    join identity.roles r on r.code = ac.approver_role
    join identity.user_roles ur on ur.role_id = r.id
    where ur.user_id = platform.current_user_id()
      and ur.revoked_at is null
      and ac.request_type = p_request_type
      and ac.step_no = p_step
      and ac.is_active
  )
$$;
```

`stable`, `security definer`, `set search_path = pg_catalog, pg_temp` (0009 `platform.next_doc_no`
pinned-search-path style). `revoke execute ... from public; grant execute ... to pgeos_app;`
Ownership asserted superuser/BYPASSRLS at migration time (ADR-0002 guard, same pattern as every
other SECURITY DEFINER function in this codebase).

## 2 · SECURITY DEFINER justification

SECURITY DEFINER was banned by the Master as a bypass mechanism in 4.1a part 1 (a proposed
`platform.reference.manage` → SYSADMIN grant was withdrawn as a SoD violation, doc 22:186). This
function is accepted as a narrow exception: it performs a **read-only role-membership lookup**
(`identity.user_roles` joined to `platform.approval_chains`) with no write side effect and no
caller-supplied table/column target — the same class of exception already granted to
`platform.allowed_entities()` and `platform.next_doc_no()`. It answers exactly one question — does
the calling session hold the role that `platform.approval_chains` names as `approver_role` for a
given `(request_type, step_no)` — and nothing else. It does not grant any write privilege itself;
callers still need a matching RLS policy or trigger.

## 3 · Condition 1 (Master's exact wording) — the bypass path

Every trigger built on top of this mechanism (`billing.assert_gl_account_change_approved()`,
`billing.assert_gl_account_change_immutable_fields()`, in this migration) keys its bypass on
`current_user <> 'pgeos_app'`, **never** on the `app.user_id` GUC being empty or missing. This lets
`apply.sh`, the D-127 synthetic seed, and a later real-CoA import — all running as `postgres` with
no application context — write freely, while a `pgeos_app` session with an empty/missing
`app.user_id` GUC is REJECTED by the trigger even if RLS would otherwise have let the statement
through (RLS is not relied on alone for this — tested explicitly, `approver-mechanism.test.ts`).

## 4 · Condition 2 (Master's ruling) — the one approval-chain primitive from now on

`platform.is_approval_chain_approver()` is, from this migration forward, **the only**
approval-chain primitive in the codebase — no slice writes its own copy or an equivalent inline
join. WBS 4.19 (fiscal-period locking), 4.20 (journal posting reversal/adjustment approval), 4.22
(AP vendor-bill approval) and 5.11b each reuse this exact function, parameterised by their own
`request_type`. The Master records this primitive separately in `.claude/briefs/platform.brief.md`
(a frozen path during parallel phases, Master-only edit) — not duplicated here.

## 5 · First consumer

`billing.gl_account_change_requests` (WBS 4.1a part 2): approver SELECT/UPDATE RLS policies keyed
on `platform.is_approval_chain_approver('gl_account_change')`; a `gl_accounts` INSERT/UPDATE policy
OR-ed with the existing `reference_write` policy; both `assert_gl_account_change_approved()` and
`assert_gl_account_change_immutable_fields()` triggers use the Condition-1 bypass above.

## 6 · Disposition

Applied. No further schema change requested by this note — future consumers (4.19/4.20/4.22/5.11b)
call the existing function with their own `request_type`; they do not re-request it.
