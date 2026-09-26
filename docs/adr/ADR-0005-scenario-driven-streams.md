# ADR-0005 — Scenario-driven value streams, one Master, stream locks, tool-enforced governance

**Status:** Accepted
**Date:** 2026-09-26
**Approved by:** GM (verbatim, Master session 2026-09-26: "نعم اعتمد نفذ" — approving items 11.1–11.5 of the final plan presented in the same session; D-192)
**Reviewed & accepted: opus**
**References:** CLAUDE.md (BUILD METHOD, PARALLEL LANES, OPERATING RULES, DEFINITION OF DONE) · doc 40 Part E (S1–S20) · doc 38 v4.7 (154 rows) · `docs/STREAMS.md` (the stream map this ADR authorises) · `packages/db/src/client.ts` · `.github/workflows/ci.yml:70-72,151-153` · `database/migrations/0034_2_gl-account-change-requests.sql:238,394`

**Precedence:** CLAUDE.md governs until its enablement-week amendment lands (`docs/STREAMS.md` §Enablement item 7). Where §1, §2, §4 and §5 below differ from CLAUDE.md · DEFINITION OF DONE, PARALLEL LANES and MODEL ROUTING, they are the approved target state, not yet the operating rule.

## Context (السياق)
- Pilot scope is 33% DONE — 42 of 125 automated rows carry `DONE @ <hash>` in the status column of `tasks/MASTER_BACKLOG.md` (counted 2026-09-26; rows DEFERRED-POST-PILOT excluded); phases 3–7 are at 0–10% by the same count; the critical path 0.8→0.6a→2.3→2.4→2.9 is closed (`.golden-slice-accepted`).
- Acceptance scenarios S1–S20 (doc 40 Part E) are 0/20: no Playwright configuration or spec exists in the repository; CI gate ④ counts `tests/scenarios/*.spec.ts` (= 0, `.github/workflows/ci.yml`). Coverage ≥ 90% and mutation ≥ 75% (doc 36 §5-5) have no tooling (no coverage block in any `vitest.config.ts`, no Stryker config); `scripts/deploy.sh` (G15–G17) does not exist.
- 7 WBS rows were split into 3–8 commits each (`git log --oneline` on main, `part n` suffixes: 2.11, 2.12, 2.16, 3.12, 3.13, 4.1a, 4.2); 20 of 59 `docs/CHANGELOG.md` entries are DONE-in-part; the average `Review: PASS(n findings, r rounds)` trailer on main carries 7.2 findings; feat/fix share is 56% (`bash scripts/gov-ratio.sh`, 2026-09-26) against the ≥ 60% target.
- `modules/billing` has domain-only use cases and no application/api layer because rows were built module-first; `tms` (3.4) has not started although six rows in three phases depend on it.
- `packages/db/src/client.ts` (before this ADR, line 38) fell back to `PGUSER` (a superuser) when `PG_APP_USER` was unset, which bypasses RLS and the three `current_user <> 'pgeos_app'` trigger guards (`0034:422`, `0034:608`, `0036:108`) outside CI.
- The documented lane mechanism assumes sibling worktrees on one machine; cloud sessions run one container each, so the lane↔Master link is a branch push plus a one-shot trigger (built 2026-09-26).

## Decision (القرار)
1. **Unit of planning = a doc 40 Part E scenario.** A stream is the minimal set of slices, across modules, that turns its scenarios green in Playwright. Streams and their order are recorded in `docs/STREAMS.md`; doc 38 stays the row register, the stream decides the order. **A row is DONE only when its scenario(s) are green**; "all use cases of the module built" is no longer a completion criterion.
2. **One Master session** owns state, merges, migration numbers and the wave's contracts. Two build lanes (one stream each) plus one integration lane that owns Playwright, the scenarios and continuous greening. Lanes are ephemeral: one slice, own branch `lane/<id>-<wbs>`, own database from the SessionStart hook, one report by trigger, then exit.
3. **Contract-first waves:** before a wave starts, the Master commits every Zod contract and `packages/events/catalog.ts` name the wave needs. The catalog stays frozen during the wave.
4. **Locks are per stream** (a stream may span modules); `scripts/check-locks.sh` is adjusted accordingly. Frozen paths are unchanged.
5. **Agents: four.** pg-tester (tests only) · pg-builder (replaces pg-backend / pg-backend-core / pg-frontend; the brief's `builder:` line selects the profile; opus when the slice carries a migration, RLS or permissions) · pg-reviewer (opus; reviews the brief + RED **before** build and again at close; findings are `blocking` or `nit`, nits are fixed in the same round, no "polish" backlog rows) · `scripts/scribe.mjs` replaces pg-scribe for PROJECT_STATE, LANE_LOCKS and the CHANGELOG template. REVIEW CAP stays at two rounds.
6. **Tool-enforced governance:** a rule without a hook, lint or CI gate is removed from CLAUDE.md (target ≤ 80 lines; history moves to `docs/GOVERNANCE-HISTORY.md`); PROJECT_STATE is generated; every promised gate (Playwright, coverage, Stryker, `deploy.sh`) is built in the enablement week or deleted from the text.
7. **Security, effective now:** `withContext` refuses to run unless `PG_APP_USER` names a role that is neither `postgres` nor, per `pg_roles` on first connect, SUPERUSER/BYPASSRLS; the pool never falls back to `PGUSER` (`packages/db/src/client.ts` `requireAppUser`/`assertAppRole`, `packages/db/src/with-context.ts`, test `packages/db/tests/client-app-user.test.ts`). The approval chain already binds the approver to the session (`0034:394` `approved_by = platform.current_user_id()` in the approver policy; `0034:238` `approved_by <> requested_by`); no further Master migration is required unless the pre-migration review of 4.1b part 2 finds otherwise.
8. Reserved to the GM, unchanged: production deploy, financial transactions, policy values, real chart of accounts, deleting branches outside the merge rule.

## Alternatives rejected (البدائل المرفوضة)
| Alternative | Why rejected |
|---|---|
| Keep phase × module planning, reorder only | Reproduces the observed failure modes: module layers built without a consumer (billing), the highest-fan-in row (3.4) waiting on its phase, zero scenarios green after 42 DONE rows. |
| Three build lanes, no integration lane | Scenario tooling stayed at 0/20 for the whole project; nobody owned it. Three writers also produced the most merge conflicts on the shared state files. |
| Keep pg-scribe as an LLM agent | It is the origin of the `<this commit>` placeholders, state lines > 2,000 chars and one recorded case of unbuilt features written into a commit (D-191 amendment). |
| Keep the `PGUSER` fallback for local convenience | A superuser pool disables RLS silently. CI and the remote SessionStart hook set `PG_APP_USER`; a local shell exports it once (`docs/RUNBOOK.md`, `infra/docker/.env.example`); `scripts/check-setup.sh` fails when it is missing. |
| Check the role name at import time | Broke pure domain unit tests that import the package barrel without a database (`modules/wms/tests/unit/*.domain.test.ts`, `packages/db/tests/entity-scope.property.test.ts`), and `PGUSER=someadmin` would pass a name check — the catalog check at first connect covers every superuser name. |

## Consequences (الأثر)
- Positive: first business proof (S1/S2) in days and first automated invoice (4.18) in ~10 working days (estimates from the wave plan in `docs/STREAMS.md`, at the observed 2026-09-26 rate of ~27 feat commits/day across three lanes); integration risk surfaces per stream; startup reading per session drops from ~600 lines (CLAUDE.md ~200 + PROJECT_STATE 40 long lines + a brief ≤ 120 + lane.md/slice.md) to ≤ 150 (target, STREAMS §Targets).
- Negative / risks: one Master day to re-cut doc 38 into streams and adjust `check-locks.sh`; local developers must export `PG_APP_USER` (documented in RUNBOOK); rows outside the streams are decided by the GM after seeing the streams run.
- Unchanged: ARCHITECTURE rules, the twelve-step slice, RED first, the golden slice, guards G1–G18, conventional commits, the migration register.
- Open for the GM: which of the non-stream rows (3.8–3.11, 4.12–4.13, 4.21–4.23, 5.7–5.10, 5.12–5.14, 6.2, 6.5) join the pilot; `close/0.6a-d166` (101 commits ahead of main) and `lane/3-3.13` (2 ahead) are not merged and were not named for deletion.

## Status (الحالة)
Accepted — 2026-09-26 (GM "نعم اعتمد نفذ"). Applied in stages: §7 and `docs/STREAMS.md` in the same commit set; §5–§6 in the enablement week (`docs/STREAMS.md` §Enablement).
