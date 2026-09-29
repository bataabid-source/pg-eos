# ADR-0007 — Cloud sessions and roles: six concurrent sessions (D-198), M-core for frozen paths, session limits and rotation

**Status:** Accepted — Phase 1 (D-196, 2026-09-28) · Phase 2 rebase auto-merge item Accepted (D-197, 2026-09-28) · Phase 2 session-cap/auto-archive/local-guards items Accepted (D-198, 2026-09-28) · parallel roles on disjoint locks Accepted (D-200, 2026-09-29; wording deferred to X part 17) · Advisory session permanent until production Accepted (D-202, 2026-09-29) · rest of Phase 2 Proposed, evaluation scheduled 2026-09-30
**Date:** 2026-09-28
**Approved by:** GM — D-196: "موافق على المرحلة 1، ابدأ التنفيذ مع جدوله المرجله الثانيه مع وضع محدادت للجلسات بما فيها جلسه الماستر احلال وتجديد مع الحفاظ علي السياق باحترافيه" (drafted on the directive "نعم جهّز مسودة تقسيم الأدوار").
**Reviewed & accepted: opus** — pg-reviewer round 1 FAIL (6 blocking, 11 nits) → one fix round → round 2 FAIL (3 blocking, 3 nits, all separable; no regression against origin/main). REVIEW CAP: the whole content is the PASS subset; the six open findings are `X part 13` (hook, settings, tests, pg-reviewer.md) and `X part 14` (wording). The D-198/D-200 addendum is not a reviewed-and-accepted text: pg-reviewer (opus) FAILed round 2 on PR #201 and again on PR #202 (FAIL(8) at 37fd7b3); it is the PASS subset under REVIEW CAP, open findings in backlog row `X part 17`; CLAUDE.md carries none of its wording yet.
**References:** CLAUDE.md · AGENTS AND SESSIONS · `docs/RUNBOOK.md:74` (§2, memory rule) · `docs/GOVERNANCE-HISTORY.md:145` · D-171, D-174, D-179, D-180, D-192, D-195 (`docs/DECISION_LOG.md`) · `docs/STREAMS.md` · `tasks/MASTER_BACKLOG.md` rows 2.12, 3.1, 3.4, 3.14, 2.16 part 1a-5, 2.9 part 2 (fix), 6.4 · `docs/package/38-WBS.md` (Lane column) · `.claude/hooks/lane-guard.sh` · `.claude/settings.json` (deny `git push --force*`) · `scripts/check-locks.sh` · `scripts/scribe.mjs` · `tests/hooks/run.sh` · `.claude/hooks/session-start.sh` · the `create_session` tool schema (no environment-variable parameter) · `list_sessions` metadata read 2026-09-28 ≈ 00:25Z.

## Context (السياق)
- **Why three sessions.** The limit protected a local Windows host: the 2026-09-25 Docker/WSL outage was host memory starvation (`docs/RUNBOOK.md:74`, §2). The second reason is the shared quota (D-171, D-174).
- **The cloud removes the first reason, not the second.** Every cloud session is its own container, clone and PostgreSQL 16 (`session-start.sh`, `CLAUDE_CODE_REMOTE=true`). The quota is unchanged.
- **Cloud lanes were outside lane-guard.**
  - `lane-guard.sh` refused a lane write unless the directory was `pg-eos-lane-<id>`, and a cloud clone is `/home/user/pg-eos`.
  - `create_session` has no environment-variable parameter, so a cloud lane never had `PG_LANE`.
  - lane-guard therefore treated every cloud lane as the Master, and no lock was enforced for it.
- **Unblocked work outside wave 1:**
  - 3.4 depends on 2.12 (DONE @ `830bfaf`) and 3.1 (DONE @ `8d2ead9`), but needs the INV-C4-1 guard (a migration).
  - 6.4 is READY.
  - 3.14 is not available: parts 1–2 are DONE @ `e667821` and the remainder waits on D-149.
- **Bottlenecks:**
  - The frozen-path tasks wait for the Master. D-171(6): "the Master never builds while a build session is alive". This includes 2.16 part 1a-5, which gates `/login` (D-193).
  - The Master merges every PR by hand, one after another.
  - A lane can be silent for hours unnoticed (the integration lane on 2026-09-27).
- **Baseline for Phase 2** (`list_sessions` metadata, 2026-09-28 ≈ 00:25Z). Every live session reports `claude-opus-5-5`, effort high; D-174 sets sonnet for lanes and for the Master's merge work.

  | Session | Context used | Cost (USD) |
  |---|---|---|
  | Master M2 (`session_01C6XMTnzeRmtyPDkCvZNuQ1`) | 559k / 1M | 44.4 |
  | Lane B, one slice 4.1b part 2 (`session_01DDe2RQYqPiF8uL6uSqHEEA`) | 265k | 40.4 |
  | Integration (`session_01FRQvkr2p6PB4csg4eAwbbL`) | 190k | 19.5 |
  | The previous Master at stand-down (`session_014T64SoZ939e9irxo8U4nVH`) | 533k | 228.7 |

## Decision (القرار)
1. **Ceiling.**
   - Six concurrent cloud sessions (D-198): the Master, M-core, lane 1, lane 2, integration and one further slot, not yet assigned (its naming waits on a GM instruction recorded as a D-id, `X part 17`). Phase 1 (D-196) was five.
   - One advisory session for the GM's questions (tag `pg-eos:advisory`) is not counted: it builds nothing and commits only on a GM directive.
   - A local host keeps max three concurrent sessions and the RUNBOOK §2 memory rule.
   - A seventh only after the GM answers when «و7 بعد تقييم 30 سبتمبر» applies (open question, DECISION_LOG D-198).
2. **Roles, Phase 1.**
   - Tags: `pg-eos:master` · `pg-eos:core` · `pg-eos:lane-<id>` · `pg-eos:integration` · `pg-eos:advisory`.
   - A lane reports to the live session tagged `pg-eos:master`, found with `list_sessions`, never by a stored id.

   | Session | Role | Writes | Queue now | Model (D-174) |
   |---|---|---|---|---|
   | **Master** | Orchestrates only: briefs, migration numbers, wave contracts, merges, session launch, rotation, and the watchdog. Builds nothing; pg-reviewer checks the author of every slice. | `tasks/*`, `docs/state/*`, CHANGELOG, DECISION_LOG, CLAUDE.md | briefs for 2.16 part 1a-5 and 2.9 part 2 (fix) → launch M-core and lane 1 → relaunch lane 2 for 4.19 → replace the integration session | sonnet; opus only for ADR, security or RLS work |
   | **M-core** | Branch `core/<wbs>`, lane-`M` lock rows; merged first | `packages/<name>` rows → `packages/<name>/**`; the `tooling` row → `.claude/**` `scripts/**` `.github/**`; module rows as any lane. Never CLAUDE.md. | 2.16 part 1a-5 → SCR-IDENTITY-RLS-01 → SCR-AUDIT-CHAIN-01 1/4 → the Master batch | sonnet; pg-builder-core opus inside |
   | **Lane 1** (stream A) | S1, S2, S18 | `wms/receive-inbound`, then `pda` | 2.9 part 2 (fix) → 2.16 part 1a-4c → PDA screens on the real client after 1a-5 merges → 2.18 | sonnet; pg-builder |
   | **Lane 2** (stream B) | Finance | `billing` | 4.19 → 4.20 (0040 · 0041 issued) | sonnet; pg-builder-core |
   | **Integration** | Playwright and scenarios, no module lock | `tests/**`, its packet under `docs/notes/` | X part 5d → S1/S2 with lane 1 → S18 → S8/S11 RED | sonnet |

3. **Mechanisms, `lane-guard.sh`.** These prevent accidents. A session that switches its own branch or role config leaves them, so pg-reviewer checks the branch and the files of every slice.
   - (a) **Branch rule.** In a cloud session (`CLAUDE_CODE_REMOTE=true`) the branch replaces the D-179 directory rule: `lane/<id>-<wbs>` for a lane, `core/<wbs>` for M-core. Local sessions are unchanged.
   - (b) **Role from the branch.** With `PG_LANE` unset in a cloud session:
     - `lane/[123ABC]-<wbs>` is that lane;
     - `core/<wbs>` is lane M (M-core);
     - any other branch is the Master.
     - `PG_LANE`, when set, wins and must match the branch.
     - `git config --local pgeos.role master` keeps the Master in Master mode while it has a lane branch checked out for the merge queue.
   - (c) **M-core scope.** Lane M may write the frozen paths its lock rows name (`packages/<name>`, `tooling`) and never CLAUDE.md. Every other lane keeps the whole frozen list.
   - (d) **Cloud lock rows.** `check-locks.sh` and `scribe.mjs --claim <module> <lane> <task> [cloud:session_<id>]` use the same strict form, `^cloud:session_[A-Za-z0-9]+$`.
   - (e) **Tests.** `tests/hooks/run.sh` has 30 new cases (169 → 199 passing), hermetic against `CLAUDE_CODE_REMOTE` and the host git config. 8 of them fail on the guard on origin/main.
   - A lane holding two lock rows on different modules was already allowed (check-locks rule 1 is per module, rule 4 counts distinct lanes).
4. **Auto-merge and 3.4** are Phase 2, below.
5. **Session limits and rotation.**

   **Limits.** The context ceiling is `context_usage.used_tokens` from `get_session`. The numbers are defaults recorded under this ADR; the GM changes them in one CHANGELOG line. The context window is separate from the 150k per-slice token budget of CLAUDE.md · REVIEW.

   | Role | Unit of work | Context ceiling | Time ceiling | Rotation point |
   |---|---|---|---|---|
   | Master | the merge queue | 400k | 24 h from creation, and every wave boundary | after a completed merge, never mid-rebase |
   | M-core | one Master task (one WBS part) | 300k | — | a loop step boundary (brief · RED · build · review round) |
   | Build lane | one slice (unchanged) | 300k | — | a loop step boundary |
   | Integration | one batch of ≤ 3 scenarios | 300k | — | after a pushed scenario |
   | Advisory (D-202) | permanent until production | none | — | none: state kept across summarization in a private snapshot; hourly watchdog + daily GM report; it creates the Master successor at each rotation |

   The lane ceiling sits above the one-slice figure measured for lane B (265k), so a normal slice never rotates.

   **Handover packet.** The packet is the only carrier of context, so a successor never re-derives what its predecessor knew and never re-runs a spent review.
   - Location: `docs/notes/handover-<role>.md` for the Master, M-core and integration (≤ 40 lines, overwritten at each rotation, deleted when the role ends). A lane's packet is a `## Handover <n>` section of its slice brief, which the slice deletes in its own commit. Every role can write `docs/notes/`.
   - Contents, in this order:
     1. Role · outgoing session id · UTC time · reason (ceiling, time, wave, or GM).
     2. Git: main head, own branch and head, pushed yes/no, working tree clean yes/no. A lane or M-core adds its `wip(<WBS>)` commit.
     3. In flight: the loop step and review round, or, for the Master, each PR or branch in the queue with its state and next action.
     4. Master only: live sessions (id · tag · branch · slice · last report) and its routines (trigger ids).
     5. Verified, not to redo: gates run, reviews spent (round numbers), decisions taken with their CHANGELOG line.
     6. Open questions for the GM, and defaults recorded.
     7. Next three actions.

   **Sequence (one writer per role at every moment).**
   1. **Trigger.** The watchdog reads a session at its ceiling, or the session sees it in its own `get_session`, or the GM asks.
   2. **Clean point.** The outgoing session reaches its rotation point. It commits unfinished work as `wip(<WBS>)` on its own branch, pushes (never forced), and writes and pushes the packet. From then on it writes nothing.
   3. **Successor.** The Master launches the successor of a lane, M-core or integration session; the Advisory session creates the Master's successor (D-202). It calls `create_session` with:
      - the repository, `source_revision` = the outgoing branch;
      - the role tag and the D-174 model;
      - title `<role> <n+1>`;
      - prompt: the role's bootstrap line plus the packet verbatim.
   4. **Verification.** The successor reads CLAUDE.md, PROJECT_STATE, then the packet. It checks the packet against `git log`, against `get_session` for each listed session and against `get_trigger` for each routine, then sends ACK to the outgoing session.
   5. **Routines.** The successor creates its own routines, including the watchdog. The outgoing session deletes its own, because a routine cannot move to another session.
   6. **Archive.** The Master (or, for a Master rotation, the successor) archives the outgoing session after the ACK.
   7. **One commit per task, no force push.** A lane or M-core successor folds the `wip` commit into its single `feat(<WBS>)` commit on a fresh branch, `lane/<id>-<wbs>-r<n>` or `core/<wbs>-r<n>` (both pass the branch rule). The Master deletes the old branch in the merge step.
   8. **Record.** One CHANGELOG line rides the successor's next commit (`rotation: <role> <old id> → <new id>, <reason>`), never a commit of its own.

   **Watchdog.** An hourly routine is bound to the live Master and created by the Master itself. On each tick it runs `list_sessions` on the `pg-eos:*` tags and, for every live session, reads `get_session` (status bucket, `updated_at`, context used). Then:
   - a failed session, or one silent for more than 60 min in the working bucket, is interrupted and relaunched. The relaunch uses its last packet if one exists; otherwise it uses its brief plus its pushed branch head, and the successor re-runs only the step that has no commit;
   - a session at its ceiling is told, in one message, to rotate at its next rotation point;
   - a Master at its own ceiling or time limit starts its own rotation;
   - **(D-198) auto-archive:** a session whose handover was ACKed, or whose work merged, is archived without a further handover; one idle over 2 h with no open PR is archived the same way only if its tree is clean and its branch pushed (no commit ahead of `origin/<branch>`), otherwise it is relaunched from its packet;
   - on a tick with nothing to do there is no message and no commit.

## Phase 2 (التدرّج)
- **Evaluation:** routine `trig_017LfHXmbpYm8gfn5mAhi3VB` opens a fresh evaluation session at 2026-09-30 08:00 UTC. It checks three conditions:
  - 48 h have passed since the Phase-1 activation line in the CHANGELOG;
  - one M-core merge happened without a lane conflict;
  - cost and context per session are compared with the baseline above.
  It reports to the GM and changes nothing. If 48 h have not passed, it re-arms itself for 24 h later.
- **Accepted (D-197, 2026-09-28): GitHub rebase auto-merge**, for PRs without a migration, frozen-path or lock change. Native merge queue is unavailable (the repo owner is a GitHub User account, not an organization); the GM instead configured: allow auto-merge; a main ruleset requiring checks ①–⑥ + up-to-date branches, linear history, no force push. Gate ⑦ (arm64 image build + compose smoke) moves from per-PR CI to `nightly.yml` (+ `workflow_dispatch`) — a frozen-path change queued as M-core's (R3) first `tooling` slice, with its own pre-build/close review, so per-PR CI keeps only ①–⑥. Rule: the Master enables rebase auto-merge on a PR once `review` posts PASS and the PR touches no migration/frozen-path/lock file; the Master keeps manual, one-at-a-time merges for migration PRs (in number order, D-179), M-core PRs and lock PRs, and keeps behind-main PRs updated (rebase) before enabling auto-merge.
- **Accepted (D-198, 2026-09-28).** GM-Directive (verbatim): «موافق: (أ) Stryker خارج الفحص المحلي، يبقى في CI والليلي (ب) أرشفة تلقائية (ج) الحد 6 الآن و7 بعد تقييم 30 سبتمبر». (أ) G16/Stryker out of local pre-commit and local `pnpm guards:run`, kept in CI ⑤ and nightly — built by M-core under `tooling` (X part 16). (ب) auto-archive, §5. (ج) cap six (§1); the timing of seven is an open GM question.
- **Accepted (D-200, 2026-09-29; wording deferred to X part 17).** GM-Directive (verbatim): «إذا كان ممكن العمل المتوازي للجلسات طبقه علي كل المستويات». Applied as: every role live at once up to the cap on disjoint locks granted before it starts (`scripts/check-locks.sh`, `.claude/hooks/lane-guard.sh`), and rebase auto-merge (D-197) on every eligible PR at `review` PASS (main ruleset). In-session concurrency and next-slice RED are open (`X part 17`).
- **Still Proposed for Phase 2, needs GM approval:**
  - Lane 1b (3.4 with the INV-C4-1 guard, migration 0042) in the first free slot.
  - A CI ① check that every `feat`/`fix` commit of a PR carries `Review: PASS(…)`.
- **Stop condition:** if quota use at the cap blocks a day's planned merges, return to three sessions and record the measurement.

## Alternatives rejected (البدائل المرفوضة)
| Alternative | Why rejected |
|---|---|
| Keep three cloud sessions | The host-RAM reason does not exist in the cloud; 2.16 part 1a-5 and the first real screen wait for the Master's queue. |
| Six sessions and auto-merge now | Quota at five is not measured, and no CI check reads the Review trailer yet. |
| Lane id from `git config pgeos.lane` set by the lane | A lane that forgets the step, or unsets it, falls back to Master mode unnoticed (review round 1). The branch is set by the Master at launch and carried by every push. |
| Rotate on the automatic context summary | It fires late and keeps no verified packet; the successor would re-derive state and repeat reviews. |
| One shared handover file | Two sessions on two branches would conflict; one file per role and the lane's own brief avoid that. |

## Consequences (الأثر)
- **Positive:**
  - 2.16 part 1a-5 starts without waiting for the Master.
  - Cloud lanes and M-core are held to their locks by the hook.
  - Every long-lived session, the Master included, has a ceiling and a verified handover.
  - Moving to the D-174 models funds part of the two added sessions.
- **Risks:**
  - More rebases after M-core merges.
  - A wrong or incomplete packet; mitigated by the successor's verification before the ACK.
  - The hook modes can be left on purpose (above); pg-reviewer is the check.
- **Unchanged:** the twelve-step loop, REVIEW CAP, migration numbering, forward-only migrations, one commit per task, the human-approval list, and every local-session rule.

## Status (الحالة)
Proposed — 2026-09-28 · Phase 1 Accepted — 2026-09-28 (D-196) · Phase 2 rebase-auto-merge item Accepted — 2026-09-28 (D-197) · Phase 2 D-198 items Accepted — 2026-09-28 · D-200 parallel roles Accepted, wording deferred to X part 17 — 2026-09-29 · D-202 Advisory permanent until production Accepted — 2026-09-29 · rest of Phase 2 Proposed (evaluation 2026-09-30).
