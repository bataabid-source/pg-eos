# Handover — Master (ADR-0007 Decision 5)

1. **Role** Master · outgoing session_01C6XMTnzeRmtyPDkCvZNuQ1 (M2) · 2026-09-28 02:05Z · reason: context ceiling (≈ 600k > 400k), GM handover D-196.
2. **Git** main @ e2826ff · Master branch `claude/inspiring-edison-1evygw` (= PR #166; after it merges, restart the branch from main with a merge commit, never force) · pushed yes · tree clean yes · set `git config --local pgeos.role master` in your clone before rebasing lane branches.
3. **Queue (in order)**
   - PR #165 `lane/2-4.1b-p2-r1` (lane 2, 4.1b part 2, rebased by M2, Review PASS(45,2)): rebase-merge when ①②③④⑤⑥ green (⑦ and `review` not required; `review` fails on every PR — bad token).
   - PR #166 (this branch): briefs 2.16-1a-5 / 2.9-p2, 4.19/4.20 Routes lines, migration 0042 → lane M, locks R3/R4/R5: squash-merge with its commit message (chore(X), Override: GM, GM-Directive "موافق و تابع مع الماستر وأبلغني بعد الدمج").
   - Then deliver briefs by one-shot `create_trigger` (persistent_session_id = the session, run_once_at = now + 1 min): R3 → `_slice-2.16-1a-5.brief.md`; R4 → `_slice-2.9-p2.brief.md`; R5 → `_slice-4.19.brief.md` (after #165). Each prompt: first command `git fetch origin && git checkout -B <branch> origin/main`, `/slice <wbs>`, report to the live `pg-eos:master` session. Then archive R1.
   - `lane/3-s3` @ 140efca (S3 RED, Review FAIL(6,2) → PASS subset, nits open → add row "S3 part 2"): rebase as `lane/3-s3-r1`, PR, merge.
   - X part 12 part 4 (apps/api auto-mount; patch = `git diff e2826ff 7fbebdc -- apps/api` in this branch's history; fix the test comment at route-table.unit.test.ts:176-181; new slice, own review): due BEFORE R5 ships 4.19 handlers — brief it to R3 after 1a-5 or build via an M-core step.
4. **Live sessions** (the GM opened them — never create_session for these roles)
   - R2 session_01FRQvkr2p6PB4csg4eAwbbL · pg-eos:integration · told 01:52Z (trig_015WzSGrSzSm97zL66NXxk67): clean drafts, report S3 state, then X part 5d on `lane/3-x5d`.
   - R3 session_013ED7uZ2HWuciKQU3KqfWY2 · pg-eos:core · waiting for its brief (2.16 part 1a-5).
   - R4 session_012JpnMyNrcJm4vRQfFhjCVx · pg-eos:lane-1 · waiting for its brief (2.9 part 2).
   - R5 session_013aUcxUgLt9g8EmcyQZLJsf · pg-eos:lane-2 · waiting for its brief (4.19, migration 0040).
   - R1 session_01DDe2RQYqPiF8uL6uSqHEEA · 4.1b part 2 done · archive after #165 merges.
   - Advisory session_01NEHjtPeVUkFVomND4hEaUX (not counted). Routines: none of M2's remain after rotation; Phase-2 evaluation trig_017LfHXmbpYm8gfn5mAhi3VB (2026-09-30 08:00Z, not ours). **Create your hourly watchdog** (ADR-0007 Decision 5) — M2 did not, since it rotates now (default recorded).
5. **Verified, not to redo** D6 dcf121b (⑤ 1.4 min) · S18 5d68b11 · docs/gov eb5e81f · wave-1 prep bba811c · billing lock a7f82eb · X part 5a p2/5b p3 eb8a96c · ADR-0007 d19e43c · X part 12 (b)+mark e2826ff (REVIEW CAP; part 2 /ready, part 3 server seam + lane briefs, part 4 apps/api auto-mount). Migrations: 0038 · 0040 · 0041 lane 2, 0042 lane M, next 0043.
6. **Open for the GM** CLAUDE_CODE_OAUTH_TOKEN invalid (review red on every PR) · ⑦ arm64 → nightly? (15–21 min per PR) · nightly never ran (G16 nine lines unproven) · delete stale branches docs/gov, lane/3-s18, lane/3-s18-r1, lane/2-4.1b-p2, lane/3-s3 after its -r1 merges · X part 12 token overrun (~745k vs 150k) · local `pgeos` leftover identity.users row (G16 platform red locally; row X part 4). Defaults: 2.9 p2 lock whole `wms` · squash merges for Master PRs (force-push denied) · lane-M lock rows show worktree `.` (scribe) — check against ADR-0007 (d).
7. **Next three actions** merge #165 → merge #166 → deliver briefs to R3/R4/R5, archive R1, create the watchdog, report to the GM in Arabic (≤ 15 lines) that steps 1–3 are done.
