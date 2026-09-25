---
description: Print PROJECT_STATE, LANE_LOCKS, the last 3 commits and the 7-day governance ratio. Read-only.
allowed-tools: Read, Bash(git log:*), Bash(git status:*)
model: sonnet
---
Print, with no commentary and no edits:

1. `docs/PROJECT_STATE.md` in full (it is ≤ 40 lines by rule).
2. `tasks/LANE_LOCKS.md` in full.
3. `git log --oneline -3` and `git status --short`.
4. The governance ratio (CLAUDE.md · OPERATING RULES · GOVERNANCE BUDGET): run
   `git log origin/main --since="7 days ago" --format=%s`, count the lines starting `feat(` or `fix(` against the
   total, and print "gov-ratio: <n>/<m> = <p>% feat/fix (target ≥ 60%)". (P3 adds `scripts/gov-ratio.sh`, which also
   prints the average review rounds; once it exists, print its output instead.)
5. One closing line: current phase · current task · lanes in use · blockers · the next three runnable tasks, taken from PROJECT_STATE — not from reasoning.

Change nothing. Open no package document. If PROJECT_STATE.md exceeds 40 lines, say so — that is a defect for pg-scribe, not something to fix here.
