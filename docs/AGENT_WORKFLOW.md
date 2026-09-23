# AGENT_WORKFLOW — the loop, the lane mechanism, the merge queue

The rules live in `CLAUDE.md`; this file is the shape of the work. It restates nothing that
`CLAUDE.md`, `docs/MODEL_ROUTING.md` or `tasks/LANE_LOCKS.md` already fixes.

## 1. The twelve-step loop (BOOTSTRAP-v5 §2 — mandatory, in order)

The Master reads, before every task and nothing more:
`CLAUDE.md` → `docs/PROJECT_STATE.md` (≤ 60 lines) → `tasks/LANE_LOCKS.md` → the WBS row →
`.claude/briefs/<module>.brief.md`. It opens a package document only where the brief points to a
section it does not already carry.

```
  1. Read state (above).           2. Pick the next runnable WBS task (deps done; type 🤖 or ✅).
  3. Verify the acceptance criterion is runnable (command exists, data seeded).
  4. Claim the module in LANE_LOCKS (§8). 5. Write the SLICE BRIEF (§5).
  6. Delegate to **pg-tester** first → RED tests (pg-tester writes test files only).
  7. Delegate build to pg-backend / pg-frontend (never edits a test; a test defect goes back to pg-tester).
  8. Receive REPORT (§5).           9. **pg-tester** verifies: suite GREEN, no test weakened or edited by the builder.
 10. Review by **pg-reviewer** (opus) — also called BEFORE writing any migration that touches the schema, RLS or the audit chain.
 11. PASS → pg-scribe updates state/backlog/CHANGELOG → **one `feat(<WBS>)` commit** with trailers → release the lock.
 12. FAIL → same worker, same brief + findings, max 2 rounds → then Master on opus.
 13. Next task, or stop at the phase gate / real blocker / explicit stop.
```

The Master orchestrates; it writes slice code only where `docs/MODEL_ROUTING.md` says
"Master, direct". One task per session: `/compact` after the review PASS, `/clear` before the next.

A REAL BLOCKER is only: (a) the acceptance test cannot be run; (b) a needed decision is absent from
EXECUTION-MASTER-v4 Part 1 **and** touches money, permissions, or a legal/penalty rule; (c) a schema
object is missing and G-01 (EXECUTION-MASTER-v4 §1.11) does not allow adding it. Everything else:
state one default, record it in `docs/CHANGELOG.md`, proceed.

## 2. The lane mechanism

- The lane plan is **derived, never authored**: it is the `Lane` column of `docs/package/38-WBS.md`
  (EXECUTION-MASTER-v4 §2.3 is its rendering). Where lane and dependencies disagree, deps govern.
- Phase 0 and the golden slice 2.9 are never parallelised. From Phase 2, at most **three** lanes.
- One worktree per lane: `git worktree add ../pg-eos-lane-<id> -b lane/<id>`; one Claude Code
  session per worktree; each session exports `PG_LANE=<id>` and runs `/lane <id>`.
- `tasks/LANE_LOCKS.md` is the single ownership table. A module appears at most once. A lane writes
  only inside its locked modules and `tests/`. The Master claims and releases; pg-scribe writes.
- `.claude/hooks/lane-guard.sh` enforces this at every Edit/Write: it blocks a write outside the
  lane's locked modules, and blocks `database/schema/*` in every session, Master included.
- Frozen during any parallel phase: `packages/*`, `database/schema/*`,
  `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*`. A change there is a single-lane Master
  task, merged before lanes resume.
- Contracts: a new shared type goes to `packages/contracts/<module>/` (lane-owned), never to
  `_shared/` during a parallel phase.
- Events: a lane may **publish** events of its own module; it **consumes** another module's events
  only through names already in `packages/events/catalog.ts` (frozen). A new cross-module event is
  a Master task.
- Migrations: the lane writes `tasks/backlog/MIGRATION-REQUEST-<lane>.md` and waits. The Master
  issues the next `NNNN`, records it in LANE_LOCKS, and the file is
  `database/migrations/NNNN_<lane>_<slug>.sql`. A lane never picks a number.

## 3. The merge queue

```
pg-reviewer PASS
  → git rebase main
  → gates ①–③ green locally (lint+boundaries+types · domain unit tests of the touched module · guards)
  → bash scripts/guards-run.sh green
  → the Master merges, fast-forward only
  → the next lane rebases before its own merge
```

Lanes never merge lanes. Migrations merge first, in number order. One commit per completed task —
code + tests + state + backlog + CHANGELOG together, with the trailers `Model:` `Delegated:`
`Review:`. No state-only commits; a task is DONE only with its commit hash in
`docs/PROJECT_STATE.md`.

## 4. Replication

Every slice after 2.9 starts from `scripts/new-slice.sh <module> <use-case>`, which copies the
golden slice tree and renames. It prints "golden slice not accepted yet" and does nothing until the
committed file `.golden-slice-accepted` exists. A hand-made file tree is a review FAIL.
