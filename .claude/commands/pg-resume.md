---
description: Resume Premium Development — read state, pick the next runnable WBS task, hand it to /slice.
argument-hint: "[phase, e.g. 0 or 2 — optional]"
allowed-tools: Read, Bash(git status:*), Bash(git log:*)
model: sonnet
---
Resume Premium Development$ARGUMENTS.

Read, in this order and nothing more (BOOTSTRAP-v5 §2; P3 narrows this to PROJECT_STATE + LANE_LOCKS
+ the one module brief — CLAUDE.md is already loaded as project instructions and tasks/MASTER_BACKLOG.md
is not opened here, per CLAUDE.md · OPERATING RULES · START/BRIEFS):
1. `docs/PROJECT_STATE.md`
2. `tasks/LANE_LOCKS.md`
3. the module brief `.claude/briefs/<module>.brief.md` for the task picked below
4. `git status` and the last 3 commits (not a file read — live state, not package prose)

Then:
- Pick the next runnable task from PROJECT_STATE's "Next 3 tasks" line whose lane/module lock is free
  in LANE_LOCKS. PROJECT_STATE already carries dependency/status/lane information (CLAUDE.md ·
  OPERATING RULES · BRIEFS) — do not re-derive it from tasks/MASTER_BACKLOG.md.
- A 🧑 or 🔧 task: produce the runbook or script, mark it WAITING_GM, continue to the next runnable task.
- Verify the acceptance criterion is runnable before claiming anything (command exists, data seeded). If it is not, that is a REAL BLOCKER — report it and stop.
- Then run `/slice <id>` for that task and nothing else.

Do not start a second task in this session. Do not restate the rules — they are in CLAUDE.md.
