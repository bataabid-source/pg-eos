# ADR-0007 — Cloud sessions and roles: five concurrent sessions, M-core for frozen paths, session limits and rotation

**Status:** Accepted — Phase 1 (D-196, 2026-09-28) · Phase 2 Proposed, evaluation scheduled 2026-09-30
**Date:** 2026-09-28
**Approved by:** GM — D-196: "موافق على المرحلة 1، ابدأ التنفيذ مع جدوله المرجله الثانيه مع وضع محدادت للجلسات بما فيها جلسه الماستر احلال وتجديد مع الحفاظ علي السياق باحترافيه" (drafted on the directive "نعم جهّز مسودة تقسيم الأدوار").
**Reviewed & accepted: opus** — drafted on opus in the GM's advisory session; pg-reviewer verdict recorded in the commit trailer.
**References:** CLAUDE.md · AGENTS AND SESSIONS · `docs/RUNBOOK.md:74` (memory rule) · `docs/GOVERNANCE-HISTORY.md:145` · D-171, D-174, D-179, D-180, D-192, D-195 (`docs/DECISION_LOG.md`) · `docs/STREAMS.md` · `tasks/MASTER_BACKLOG.md` rows 2.12, 3.1, 3.4, 3.14, 2.16 part 1a-5, 2.9 part 2 (fix), 6.4 · `docs/package/38-WBS.md` (Lane column) · `.claude/hooks/lane-guard.sh` · `scripts/check-locks.sh` · `scripts/scribe.mjs` · `tests/hooks/run.sh` · `.claude/hooks/session-start.sh` · `.github/workflows/ci.yml` · cloud session metadata read 2026-09-28 ≈ 00:25Z (`list_sessions`).

## Context (السياق)
- **Why three sessions.** The limit protected a local Windows host: the 2026-09-25 Docker/WSL outage was host memory starvation (`docs/RUNBOOK.md:74`). The second reason is the shared quota (D-171, D-174).
- **The cloud removes the first reason, not the second.** Every cloud session is its own container, clone and PostgreSQL 16 (`session-start.sh`, `CLAUDE_CODE_REMOTE=true`). The quota is unchanged.
- **Cloud lanes were outside lane-guard until now.**
  - `lane-guard.sh` refused a lane write unless the directory was `pg-eos-lane-<id>`, and a cloud clone is `/home/user/pg-eos`.
  - A cloud session cannot receive `PG_LANE` from the Master: `create_session` takes no environment variables.
  - The result: cloud lanes ran with no `PG_LANE`, which lane-guard treats as the Master, so no lock was enforced for them.
- **Unblocked work outside wave 1:**
  - 3.4 depends on 2.12 (DONE @ `830bfaf`) and 3.1 (DONE @ `8d2ead9`), but needs the INV-C4-1 guard (a migration).
  - 6.4 is READY.
  - 3.14 is not available: parts 1–2 are DONE @ `e667821` and the remainder waits on D-149.
- **Bottlenecks:**
  - The frozen-path tasks wait for the Master. D-171(6): "the Master never builds while a build session is alive". This includes 2.16 part 1a-5, which gates `/login` (D-193).
  - The Master merges every PR by hand, one after another.
  - A lane can be silent for hours unnoticed (the integration lane on 2026-09-27).
- **Context and cost at 2026-09-28 ≈ 00:25Z (session metadata, the Phase-2 baseline):**
  - Every live session runs opus, effort high. D-174 sets sonnet for lanes and for the Master's merge work.

  | Session | Context used | Cost (USD) |
  |---|---|---|
  | Master M2 | 559k / 1M | 44.4 |
  | Lane B (4.1b part 2, one slice) | 265k | 40.4 |
  | Integration (S3–S20 RED) | 190k | 19.5 |
  | The previous Master when it stood down | 533k | 228.7 |

## Decision (القرار)
1. **Ceiling: five concurrent cloud sessions**: the Master, M-core, lane 1, lane 2 and the integration session. Local hosts keep the RUNBOOK §1 memory rule. A sixth needs Phase 2.
2. **Roles, Phase 1.** Every session carries the tag of its role (`pg-eos:master` · `pg-eos:core` · `pg-eos:lane-<id>` · `pg-eos:integration`). A lane reports to the live session tagged `pg-eos:master`, found with `list_sessions`, never by a stored id.

   | Session | Role | Writes | Queue now | Model (D-174) |
   |---|---|---|---|---|
   | **Master** | Orchestrates only: briefs, migration numbers, wave contracts, merges, session launch, rotation, and the watchdog. Builds nothing. | `tasks/*`, `docs/state/*`, CHANGELOG, DECISION_LOG, CLAUDE.md | briefs for 2.16 part 1a-5 and 2.9 part 2 (fix) → launch M-core and lane 1 → relaunch lane 2 for 4.19 → replace the integration session | sonnet; opus only for ADR, security or RLS work |
   | **M-core** | Frozen-path tasks under a lane-`M` lock; merged first | `packages/*`, `database/schema/*` (G-01 only), `packages/contracts/_shared/*`, `.claude/*` | 2.16 part 1a-5 → SCR-IDENTITY-RLS-01 → SCR-AUDIT-CHAIN-01 1/4 → the Master batch | sonnet; pg-builder-core opus inside |
   | **Lane 1** (stream A) | S1, S2, S18 | `wms/receive-inbound`, then `pda` | 2.9 part 2 (fix) → 2.16 part 1a-4c → PDA screens on the real client after 1a-5 merges → 2.18 | sonnet; pg-builder |
   | **Lane 2** (stream B) | Finance | `billing` | 4.19 → 4.20 (0040 · 0041 issued) | sonnet; pg-builder-core |
   | **Integration** | Playwright and scenarios | `tests/**` | X part 5d → S1/S2 with lane 1 → S18 → S8/S11 RED | sonnet |

3. **Mechanisms in this commit:**
   - (a) **Branch rule.** In a cloud session, `lane-guard.sh` replaces the directory rule with the branch rule: the checkout must be on `lane/<id>-<wbs>`.
   - (b) **Lane id from git config.** A cloud lane's id may come from `git config pgeos.lane <id>`, which is the lane's first command. `PG_LANE` wins when both exist, and local sessions ignore the git config.
   - (c) **Cloud lock rows.** `check-locks.sh` accepts the worktree value `cloud:session_<id>`, and `scribe.mjs --claim <module> <lane> <task> [cloud:session_<id>]` writes it.
   - (d) **Hook tests.** 15 new cases in `tests/hooks/run.sh` (169 → 184 passing; the cloud cases fail on the old guard).
   - (e) **CLAUDE.md** · AGENTS AND SESSIONS and DOCUMENTS amended.
   - One lane holding two lock rows on different modules was already allowed (check-locks rule 1 is per module, rule 4 counts distinct lanes), so nothing changes there.
4. **Auto-merge and 3.4** are Phase 2, below.

## Session limits and rotation (§6)
**Limits.** The context ceiling is `context_usage.used_tokens` as reported by `get_session`. All numbers are defaults recorded under this ADR; the GM may change them in one CHANGELOG line.

| Role | Unit of work | Context ceiling | Time ceiling | Rotation point |
|---|---|---|---|---|
| Master | the merge queue | 400k | 24 h from creation, and every wave boundary | after a completed merge, never mid-rebase |
| M-core | one Master task (one WBS part) | 300k | — | a loop step boundary (brief · RED · build · review round) |
| Build lane | one slice (unchanged) | 300k | — | a loop step boundary |
| Integration | one batch of ≤ 3 scenarios | 300k | — | after a pushed scenario |
| Advisory (GM) | the GM's question set | 400k | — | the end of an answer |

The ceilings sit above the one-slice figure measured for lane B (265k), so a normal slice never rotates. A lane that reaches 300k is already about 2× its slice budget, which CLAUDE.md treats as a split signal.

**Handover packet.** The packet is the only carrier of context, so a successor never re-derives what its predecessor already knew and never re-runs a spent review.
- Location: `docs/state/handover-<role>.md` for the Master, M-core and integration (≤ 40 lines, overwritten at each rotation). For a lane, it is a `## Handover <n>` section of its slice brief, which the slice deletes in its own commit.
- Contents, in this order:
  1. Role · outgoing session id · UTC time · reason (ceiling, time, wave, or GM).
  2. Git: main head, own branch and head, pushed yes/no, working tree clean yes/no. Lanes add the `wip(<WBS>)` commit that carries unfinished work.
  3. In flight: the loop step and review round, or, for the Master, each PR or branch in the queue with its state and next action.
  4. Master only: live sessions (id · role tag · branch · slice · last report) and the routines it owns (trigger ids).
  5. Verified, not to redo: gates run, reviews spent (round numbers), decisions taken with their CHANGELOG line.
  6. Open questions for the GM, and defaults recorded.
  7. Next three actions.

**Sequence (one writer per role at every moment).**
1. **Trigger.** The watchdog reads a session at its ceiling, or the session sees it in its own `get_session`, or the GM asks.
2. **Clean point.** The outgoing session reaches its rotation point. It commits unfinished work as `wip(<WBS>)` on its own branch, pushes, and writes and pushes the packet. From then on it writes nothing.
3. **Successor.** The outgoing session (for the Master: itself) calls `create_session`:
   - same repository, `source_revision` and `outcome_branch` = the branch;
   - the role tag and the D-174 model;
   - title `<role> <n+1>`;
   - prompt: the role's bootstrap line plus the packet verbatim.

   A lane or M-core successor is launched by the Master.
4. **Verification.** The successor reads CLAUDE.md, PROJECT_STATE and the packet. It checks the packet against `git log`, against `get_session` for each listed session and against `get_trigger` for each routine, then sends ACK to the outgoing session.
5. **Routines.** The successor creates its own routines, including the watchdog. The outgoing session deletes its own, because a routine cannot move to another session.
6. **Archive.** The Master (or, for a Master rotation, the successor) archives the outgoing session after the ACK.
7. **Record.** One CHANGELOG line rides the successor's next commit (`rotation: <role> <old id> → <new id>, <reason>`), never a commit of its own. A lane successor folds the `wip` commit into its single `feat(<WBS>)` commit on its own branch, so one commit per task still holds.

**Watchdog.** An hourly routine is bound to the live Master and created by the Master itself. On each tick it runs `list_sessions` on the `pg-eos:*` tags and, for every live session, reads `get_session` (status bucket, `updated_at`, context used). Then:
- a failed session, or one silent for more than 60 min in the working bucket, is interrupted and relaunched from its packet;
- a session at its ceiling is told, in one message, to rotate at its next rotation point;
- a Master at its own ceiling or time limit starts its own rotation;
- on a tick with nothing to do there is no message and no commit.

## Phase 2 (التدرّج)
- **Evaluation:** a one-shot routine opens a fresh evaluation session at 2026-09-30 08:00 UTC. It checks three conditions:
  - 48 h have passed since the Phase-1 activation line in the CHANGELOG;
  - one M-core merge happened without a lane conflict;
  - cost and context per session are compared with the baseline above.
  It reports to the GM and changes nothing. If 48 h have not passed, it re-arms itself for 24 h later.
- **Proposed for Phase 2, needs GM approval:**
  - Lane 1b (3.4 with the INV-C4-1 guard, migration 0042) as a sixth session, or in the first free slot.
  - A CI ① check that every `feat`/`fix` commit of a PR carries `Review: PASS(…)`.
  - GitHub rebase auto-merge for PRs without a migration, frozen path or lock change, once the GM sets four repository settings: required checks ①–⑦, up-to-date branches, allow auto-merge, delete head branches.
  - The Master keeps migration PRs (in number order, D-179), M-core PRs and lock PRs.
- **Stop condition:** if quota use at five sessions blocks a day's planned merges, return to three sessions and record the measurement.

## Alternatives rejected (البدائل المرفوضة)
| Alternative | Why rejected |
|---|---|
| Keep three sessions | The host-RAM reason does not exist in the cloud; 2.16 part 1a-5 and the first real screen wait for the Master's queue. |
| Six sessions and auto-merge now | Quota at five is not measured, and no CI check reads the Review trailer yet. |
| Rotate on the automatic context summary | It fires late and keeps no verified packet; the successor would re-derive state and repeat reviews. |
| A shared handover file for all roles | Two sessions on two branches would conflict; one file per role and the lane's own brief avoid that. |

## Consequences (الأثر)
- **Positive:**
  - 2.16 part 1a-5 starts without waiting for the Master.
  - Cloud lanes are held to their locks for the first time.
  - Every long-lived session, the Master included, has a ceiling and a verified handover.
  - Moving to the D-174 models funds part of the two added sessions.
- **Risks:**
  - More rebases after M-core merges.
  - A packet that is wrong or incomplete; mitigated by the successor's verification against git, sessions and routines before the ACK.
- **Unchanged:** the twelve-step loop, REVIEW CAP, migration numbering, forward-only migrations, one commit per task, the human-approval list.

## Status (الحالة)
Proposed — 2026-09-28 · Phase 1 Accepted — 2026-09-28 (D-196) · Phase 2 Proposed (evaluation 2026-09-30).
