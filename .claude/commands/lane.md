---
description: Run one parallel lane in its own worktree — its doc-38 task list, in dependency order, inside its locks.
argument-hint: "<lane-id>  e.g. 1 | 2 | 3"
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
model: sonnet
---
You are lane $1 in worktree `../pg-eos-lane-$1` on branch `lane/$1`. Export `PG_LANE=$1` so `.claude/hooks/lane-guard.sh` enforces the lock at every Edit/Write. The hook refuses every write unless the checkout's directory name is `pg-eos-lane-$1` (D-179) — a lane never runs in the shared `claude-kit`.

1. Load this lane's task list from the `Lane` column of `docs/package/38-WBS.md` (rendered in `docs/package/EXECUTION-MASTER-v4.md` §2.3 and `docs/package/_changelog/LANE-PLAN.md`). Deps govern where lane and deps disagree.
2. Confirm every module you will touch is claimed to lane $1 in `tasks/LANE_LOCKS.md`. If a module is missing or held by another lane, STOP and report — never widen a lock yourself.
3. Run `/slice <id>` for each task in dependency order.
4. Migration numbers are issued by the Master only. At lane start, list EVERY migration your whole task list needs in `tasks/backlog/MIGRATION-REQUEST-$1.md` — one row per migration: module, slug, one line of purpose, and the RED test paths (`modules/<m>/tests/<uc>/*.feature|*.test.ts`) — so the Master issues the numbers in one batch (D-179). Never pick a number. The migration file is refused by `lane-guard.sh` until the RED tests named in its row exist on disk.
   Locks: a lock may be a module (`wms`) or a module/use-case pair (`wms/put-away`) so two lanes build two use cases of one module concurrently; a use-case lock never writes a module-wide file (index.ts, package.json, router, i18n) — STOP and ask the Master for the whole-module lock.
5. Never touch the frozen paths (`packages/*`, `database/schema/*`, `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*`) — see CLAUDE.md · PARALLEL LANES.
6. Publish only your own module's events; consume another module's only through names already in `packages/events/catalog.ts` (frozen).
7. After pg-reviewer PASS: `git rebase main`, gates ①–③ green locally, `pnpm guards:run` green — then STOP. The Master merges; lanes never merge lanes.

8. No `AskUserQuestion` inside a slice (D-191 amendment, GM 2026-09-26): DEFAULT, RECORD, PROCEED — every open question is
   batched in the closing report to the Master. A rebase that stops on a commit whose content is already on main is resolved
   with `git rebase --skip` after `git diff` against main shows it empty — no question.
9. Self-relaunch after clearing (D-191 amendment, GM 2026-09-26): after the slice's commit is pushed and reported, end the report
   to the Master with a ≤ 3-line "lane $1 handoff" and the exact line `cleared, relaunch needed: /lane $1 — next <WBS>`, then run
   `clear_session("self")`. The Master relaunches with `/lane $1` by session message as soon as that line arrives. Never clear
   mid-slice.

When the list is finished, report the lane's tasks with their commit hashes and stop.
