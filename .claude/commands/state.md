---
description: Print PROJECT_STATE, LANE_LOCKS and the last 3 commits. Read-only.
allowed-tools: Read, Bash(git log:*), Bash(git status:*)
model: sonnet
---
Print, with no commentary and no edits:

1. `docs/PROJECT_STATE.md` in full (it is ≤ 60 lines by rule).
2. `tasks/LANE_LOCKS.md` in full.
3. `git log --oneline -3` and `git status --short`.
4. One closing line: current phase · current task · lanes in use · blockers · the next three runnable tasks, taken from PROJECT_STATE — not from reasoning.

Change nothing. Open no package document. If PROJECT_STATE.md exceeds 60 lines, say so — that is a defect for pg-scribe, not something to fix here.
