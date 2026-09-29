# Handover — Master (ADR-0007 Decision 5)

1. **Role** Master · M10 session_015VfJ1G9rQ4kL3ygksqPrds · 2026-09-29 (successor of M8 session_013Rys8YfUdhuXt6s8U7m8z4). Ground truth is `origin/main`, never a Master checkout. Owns state, merges, migration numbers (next free 0045), each wave's contracts; builds nothing.
2. **Working rules**
   - D-201 (GM «موافق», 05:45Z): no inline reads or reviews — every review, gate run or document read goes to a subagent returning ≤ 20 lines; fixes are pushed onto the same PR, never a replacement PR.
   - Fix-forward only: pushed history is never rewritten (no rebase, amend or force-push); a PR is updated by `git merge origin/main` or update-branch.
   - Multi-commit Master PRs are squash-merged into one commit; lane PRs keep rebase merge (linear history).
   - Enable auto-merge only after reading the actual verdict comment: the `review` check is green on any verdict until `X part 18` lands.
   - Lock, frozen-path and migration PRs stay manual, one at a time. No lock without its brief (#187/#189 precedent).
3. **Inbox #207** (permanent Advisory→Master channel; the Advisory cannot fire the Master's inbox routine): read it on every check-in (≤ 15 min) and hourly; react 👍 when a directive is applied; reply one line if blocked.
4. **Platform limit** This Master cannot send one-shot triggers to other sessions ("you can send only to sessions in this same channel"). Lanes learn through main (briefs, locks, backlog); the Advisory relays anything urgent.
5. **Watchdog** trig_01Nq56RftqBAMhFd1d9y6yKq, hourly at :06, bound to M10. A successor recreates it on itself with the same prompt, then deletes this one.
6. **Weekly goal (GM 07:20Z, #207)** S1 + S2 + S18 green (rows 2.16 + 2.18). Lane 1 → `2.16 part 2` (receive + put-away, lock `pda`), then `part 3` (pick → check → load). Integration lane 3 → 2.18, S1 to green as screens land (tests/ only, no lock). Lane 2 stays 4.19 → 4.20. Waiting: 1a-4c, 2.9 part 3, S9 part 2.
7. **Open PRs**
   - `master/weekly-goal-locks` — this packet, the `pda` lock, both briefs, rows X part 18 / X part 5b part 2 (d) / S9 part 2. Lock PR: manual merge.
   - #202 frozen path (D-198, D-200, D-202), PASS subset after REVIEW CAP — manual squash merge after CI ①–⑥ + `review` PASS.
   - #205 lane 2 feat(4.19), migration 0040 (supersedes #198): route-table change goes onto #205 now that `api | 2` is on main; migration PR, manual.
   - #204 integration S7 part 2 (test-only) — auto-merge eligible after PASS is read.
   - #198 superseded by #205 (close when #205 merges) · #185 superseded by 2.9 part 3 (hold) · #175 draft → X part 5d part 2.
8. **Sessions**
   - Lane 1 session_01LurRGWNNZEWuceRGGEaCPP (per M8; confirm with get_session) — switch to `2.16 part 2`; set the `pda` worktree cell to its `cloud:session_<id>`.
   - Lane 2 session_01WA2ZtmPUvF99WFr5ZKnMPo — #205.
   - Integration session_01SThLZenuNFMz5TD2dZVpNe — #204, then 2.18.
   - M-core session_011PL2MhC8UPwG79YDwDqjAK — X part 16 → X part 18 → X part 17 → X part 5d part 2.
   - Advisory (not counted) — relays GM on #207.
9. **Queue**
   1. Merge this lock PR (manual), then point lane 1 and the integration lane at their briefs through main / Advisory.
   2. #202 manual squash merge; #205 once its route-table change and CI are green; #204.
   3. After each 2.16 part merges: the integration lane rewires the S1 step; the Master adds S1 to `green.json` only in the commit that closes 2.18.
10. **Open GM questions**
    - S1 cannot turn fully green on 2.16 + 2.18 alone: its FEFO step needs 2.9 part 3 (now waiting), its billable events 4.3 and its delivery task 3.4 — confirm the weekly goal means "S1's 2.16/2.18 steps green" or release 2.9 part 3.
    - S2 (VA-08 VAS command, Lost Revenue view) and S18 (row 4.15) use no D4 screen — which rows turn them green this week?
    - When does the 7th session apply ("7 after the 30 September evaluation")?
    - The value of `identity.session.lifetime_minutes` (X part 5d part 2).
    - Auto-merge on lock and frozen-path PRs versus CLAUDE.md.
