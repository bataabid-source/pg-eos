---
description: Print PROJECT_STATE, LANE_LOCKS, the last 3 commits and the 7-day governance ratio. Read-only.
allowed-tools: Read, Bash(git log:*), Bash(git status:*), Bash(bash scripts/gov-ratio.sh:*)
model: sonnet
---
Print, with no commentary and no edits. Read ONLY `docs/PROJECT_STATE.md`, `tasks/LANE_LOCKS.md` and,
if the closing line names a next task, its module brief `.claude/briefs/<module>.brief.md` — no other
file (P3; CLAUDE.md · OPERATING RULES · START):

1. `docs/PROJECT_STATE.md` in full (it is ≤ 40 lines by rule).
2. `tasks/LANE_LOCKS.md` in full.
3. `git log --oneline -3` and `git status --short`.
4. The governance ratio (CLAUDE.md · OPERATING RULES · GOVERNANCE BUDGET): run `bash scripts/gov-ratio.sh`
   and print its output verbatim.
5. One closing line: current phase · current task · lanes in use · blockers · the next three runnable tasks, taken from PROJECT_STATE — not from reasoning.

Change nothing. Open no package document. If PROJECT_STATE.md exceeds 40 lines, say so — that is a defect for pg-scribe, not something to fix here.
