# SCR-BILLING-JOURNAL-PERM-01 — permission codes for posting, reversing and adjusting journals (G-01 schema-change request)

**Status:** REQUESTED — filed 2026-09-29 by lane 2, WBS 4.20 (PR #214, claude[bot] review nit 2) under **EXECUTION-MASTER-v4 §1.11 (G-01)**. Nothing in `database/schema/*` or `database/migrations/*` changes with this file; the permission codes are data (`identity.permissions` / role grants) and are never invented by a lane.

## 1 · Context (verified on branch `lane/2-4.20`)
- 4.20 mounts POST `/billing/post-journal/{post-journal,reverse-journal,adjust-journal}`. Each route requires an Idempotency-Key and runs under `withContext` (entity scope through RLS and `billing.mark_journal_reversed`), but no `platform.has_perm` check and no SoD rule applies: any authenticated in-scope user can post, reverse or adjust.
- No source names a permission for these writes: not doc 01 / 13 / 13B / 019 / 40, not ADR-0004, not SCR-ACC-01. The only related line is ADR-0004 D3 OD-15 ("Manual journals allowed except revenue accounts; CFO approval"), which 4.20 applies by refusing every manual journal (4.20 part 2 builds the CFO approval path).
- Precedent for the mechanism (not the codes): `billing.gl_accounts.manage` checked with `platform.has_perm` (migration 0034), SoD pairs in `identity.sod_rules` (13B:615-636, e.g. CFO/ACCOUNTANT).

## 2 · Requested deltas
| # | Need | Missing | PROPOSAL (not applied) | status |
|---|---|---|---|---|
| 1 | Who may post a non-manual journal (accrual, prepayment, recurring, closing) | no permission code, no role grant | a `billing.journal.post` permission granted to ACCOUNTANT (and CFO); checked in the application layer and by the journal RLS insert policy | requested |
| 2 | Who may reverse or adjust a posted journal (D1 4 corrections) | no permission code, no SoD rule | a `billing.journal.correct` permission granted to CFO; SoD: the corrector is not the original poster | requested |
| 3 | Automatic journals from the outbox subscriber (D1 2, WBS 4.11) | no system actor defined for posting | a system role for the subscriber, named with 4.11 | requested |

## 3 · Open items
- The codes, role grants and SoD pair are a GM/CFO decision (doc 38 Owner of 4.20: CFO); the names above are proposals only.
- Applying this SCR is backlog row **4.20 part 4**; until then the routes stay without a permission gate (recorded default, PR #214).
