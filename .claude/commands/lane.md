---
description: Run one parallel lane in its own worktree — its doc-38 task list, in dependency order, inside its locks.
argument-hint: "<lane-id>  e.g. 1 | 2 | 3"
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
model: sonnet
---
You are lane $1 in worktree `../pg-eos-lane-$1` on branch `lane/$1`. Export `PG_LANE=$1` so `.claude/hooks/lane-guard.sh` enforces the lock at every Edit/Write.

1. Load this lane's task list from the `Lane` column of `docs/package/38-WBS.md` (rendered in `docs/package/EXECUTION-MASTER-v4.md` §2.3 and `docs/package/_changelog/LANE-PLAN.md`). Deps govern where lane and deps disagree.
2. Confirm every module you will touch is claimed to lane $1 in `tasks/LANE_LOCKS.md`. If a module is missing or held by another lane, STOP and report — never widen a lock yourself.
3. Run `/slice <id>` for each task in dependency order.
4. Migration numbers are issued by the Master only: write `tasks/backlog/MIGRATION-REQUEST-$1.md` with the module, the slug and one line of purpose, then wait. Never pick a number.
5. Never touch the frozen paths (`packages/*`, `database/schema/*`, `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*`) — see CLAUDE.md · PARALLEL LANES — CONFLICT-FREE MECHANISM (v5).
6. Publish only your own module's events; consume another module's only through names already in `packages/events/catalog.ts` (frozen).
7. After pg-reviewer PASS: `git rebase main`, gates ①–③ green locally, `pnpm guards:run` green — then STOP. The Master merges; lanes never merge lanes.

When the list is finished, report the lane's tasks with their commit hashes and stop.
