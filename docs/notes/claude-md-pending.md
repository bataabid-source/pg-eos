# CLAUDE.md lines pending the GM's placement (CLAUDE.md is GM-only — the harness refuses a Master edit, `[Self-Modification]`)

Written by the Master M15 on 2026-09-30 on the GM's first-hand in-session order. Each block is the exact text to place; the source decision is in docs/DECISION_LOG.md. Until the GM places a line, CLAUDE.md as written governs.

## 1. REVIEW — replace the first line (D-206, #207 04:37Z)
```
- Two reviews per slice, no more (D-206): (1) PRE-BUILD — one pg-reviewer pass over the brief + the RED tests + the migration if any (RLS, SoD, secrets, audit chain are checked here; no separate pre-migration or RED review); (2) CLOSE — one pg-reviewer pass over the slice. Findings are `blocking` or `nit`; nits are fixed in the same fix round. REVIEW CAP per review: round 1 → one fix round → round 2. Round 2 FAIL → commit the PASS subset; every open finding becomes a `<WBS> part n+1` row in tasks/MASTER_BACKLOG.md; no round 3. The claude[bot] PR review is REPORT-ONLY: its findings become backlog rows, it never starts a fix round, and the `review` check blocks a merge only on a security finding (RLS, audit chain, secrets, permissions). The Master merges on green ①–⑥ plus the close-review PASS; no manual Master review.
```

## 2. TESTING — replace "property tests on every invariant (fast-check)" (D-208, #207 05:22Z)
```
Property tests (fast-check) ONLY on invariants of stock (wms ledger/balances), money (billing journals/amounts) and security (RLS, permissions, audit chain); every other rule gets an ordinary unit test. No behaviour is tested twice across layers: one assertion per rule at the lowest layer that can prove it (domain unit > application integration > scenario); the scenario asserts only the doc 40 Part E step text. Coverage ≥ 90% on domain/ and the guards G1–G17 are unchanged.
```

## 3. AGENTS AND SESSIONS · Merge queue — replace the Merge-queue bullet (D-209, #207 05:33Z)
```
- Auto-merge (rebase) is enabled by the Master THE MOMENT a PR is opened, not when it turns green: every PR merges on its own once CI ①–⑥ is green and the close-review PASS is in the commit trailer (D-206: the claude[bot] verdict blocks only a security finding). Eligible: lane PRs AND M-core frozen-path PRs (packages/*, tooling, api, .github/workflows). Manual, one at a time, only: a migration PR (in number order), a lock-file PR (tasks/LANE_LOCKS.md) and a CLAUDE.md change. A behind-main PR is updated with update_pull_request_branch (or `git merge origin/main` by its lane), never rebased by hand. After each merge the Master runs `resolve-hashes --check` on main.
```

## 4. D-210 items 1–3 (#207 05:41Z)
- AGENTS AND SESSIONS · Session limits — replace the ceilings sentence: `Context ceilings (models with 1M context): Master 600k · M-core and build lanes 500k · integration 500k. Handover at the next clean point after the ceiling; the successor is created by the Advisory (D-207).`
- REVIEW · Budget line — replace: `Budget in every brief: ≤ 16 files / 2,000 lines read (brief-check.sh), ≤ 300k tokens per slice; adjacent parts of one row are ONE slice when they share a lock; a slice splits only above 2× the budget.` (brief-check.sh numbers: M-core `tooling`, row X part 17 part 2 — same commit or the CLAUDE.md line first.)
- BUILD METHOD — append: `Brief-ahead: every build lane always has its NEXT row briefed and locked on main before its current slice closes; the Master commits the wave's contracts and catalog entries for all queued rows in one PR, never per row. A lane that finishes with no next brief is a Master defect, reported on #207.`

## 5. AGENTS AND SESSIONS — D-205 C and D-207 wording (#207 2026-09-29 20:31Z, 2026-09-30 05:10Z)
- "Two build lanes (one stream each)" → "Three build lanes (D-205 C)"; "max five concurrent cloud sessions (Master, M-core, two build lanes, integration)" → "max seven (Master, M-core, three build lanes, integration; the Advisory not counted)".
- Sessions are created and managed (rotation, archiving, assignment) by the Advisory session (D-207, replaces D-205 A).

## 6. From X part 17 (#226, M-core 04:57Z) — lines 19 and 28, TESTING append, Session-limits append
See the #226 body / #207 04:57Z: the D-199 language-box exception on line 19 (same edit in the four agent files, one commit), `bash scripts/merge-step.sh` in the Merge-queue step, the local `guards:run` G16 note, and the auto-archive rule (`scripts/lib/session-archive.sh`, `ARCHIVE_IDLE_MINUTES = 120`).

## 7. Lane-M lock scope (#241 review, Master M15 13:30Z)
AGENTS AND SESSIONS, the M-core sentence: "built by M-core under its lane-M lock rows (`packages/<name>`, `tooling`)" → "(`packages/<name>`, `tooling`, and `apps/<name>` — `api`, `worker` — since apps/* is written by no lane)".
