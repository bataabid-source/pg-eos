---
description: Resume Premium Development — read state, pick the next runnable WBS task, hand it to /slice.
argument-hint: "[phase, e.g. 0 or 2 — optional]"
allowed-tools: Read, Grep, Glob, Bash(git status:*), Bash(git log:*)
model: sonnet
---
Resume Premium Development$ARGUMENTS.

Read, in this order and nothing more (BOOTSTRAP-v5 §2):
1. `CLAUDE.md`
2. `docs/PROJECT_STATE.md`
3. `tasks/LANE_LOCKS.md`
4. the next rows of `tasks/MASTER_BACKLOG.md` (IDs from `docs/package/38-WBS.md`)
5. `git status` and the last 3 commits

Then:
- Pick the next runnable task: every dependency DONE with a hash, type 🤖 or ✅, and its lane free in LANE_LOCKS. The lane comes from the `Lane` column of doc 38 (`docs/package/EXECUTION-MASTER-v4.md` §2.3 is its rendering) — never invent one.
- A 🧑 or 🔧 task: produce the runbook or script, mark it WAITING_GM, continue to the next runnable task.
- Verify the acceptance criterion is runnable before claiming anything (command exists, data seeded). If it is not, that is a REAL BLOCKER — report it and stop.
- Then run `/slice <id>` for that task and nothing else.

Do not start a second task in this session. Do not restate the rules — they are in CLAUDE.md.
