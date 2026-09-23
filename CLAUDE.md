ARCHITECTURE (non-negotiable)
- Modular monolith; hexagonal per module; cross-module imports fail lint (eslint-plugin-boundaries).
- NestJS (Fastify adapter) · Drizzle · Zod→OpenAPI · XState v5 · pg-boss · React/TanStack/shadcn
  · React Native/Expo · PWA for PDA · Docker Compose (Tier 0 Oracle) · Terraform-ready (Tier 2 GCP).
- Domain events are written to platform.outbox IN THE SAME TRANSACTION as the state change.
  `platform.outbox` is the governing event table (doc 40 §B3, doc 36 §3-1); it is created in 13B,
  carries `entity_id`, and is under RLS. `platform.domain_events` is retired — never write to it.
- Every write endpoint requires an Idempotency-Key. Every mutable aggregate has a version column.
- All DB access goes through withContext(ctx, fn), which sets RLS session variables. A lint rule
  fails the build on any db.* call outside it. RLS is enabled on every operational table.
- Every column is classified in identity.column_classification; deploy fails otherwise.

BUILD METHOD (doc 36 §5) — every slice, in order, never skipping:
  scenario (Gherkin) → Zod contract → SQL migration with RLS → tests first (RED) → domain until
  unit green → application until integration green → UI until acceptance green → 10-point review.
- ADRs live in docs/adr/ (template + numbering in docs/adr/README.md). ADR-0001 authorises WBS 1.5 as a proof slice
  (data model + seed) ahead of the golden slice. Proof/mechanism slices before 2.9 (0.9, 0.17, 0.18, 2.1, 2.8) follow the
  standing substitute recorded in CHANGELOG 0.16 / 2.1; every use-case slice replicates 2.9.
- SLICE SEQUENCE (fixed, GM 2026-09-23): pg-tester (RED) → pg-backend / pg-frontend (build) → pg-tester (verify GREEN)
  → pg-reviewer (opus) → pg-scribe → ONE `feat(<WBS>)` commit. pg-tester writes only test files (`tests/**`, `**/tests/**`,
  `*.test.*`, `*.spec.*`, `features/**`, `*.feature`); builders never touch a test file — a test defect goes back to
  pg-tester. pg-reviewer is also called BEFORE any migration touching the schema, RLS or the audit chain is written.
- GOLDEN SLICE = WBS 2.9 "Receive inbound order." Built once with full human review. Every later
  slice replicates its file structure exactly. No file without a counterpart in the golden slice.
- Code track and infra track are independent. Never block code on a manual infra task; develop on
  local Docker (same docker-compose.yml).

AGENT CONSTRAINTS (doc 40 §A5) — copied into every agent file
- No table, column, or business rule outside docs 01 / 13 / 13B / 019 / 40. Missing? STOP and file
  a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01); never invent.
- No `any`, `@ts-ignore`, `eslint-disable`. Never weaken a test to pass it.
- No if/switch for state transitions — XState. No embedded UI strings — i18n (ar, en, hi, ur, bn, am).
- No magic numbers — constants or platform.thresholds. No console.log — pino.
- No Math.random() / new Date() in domain/ — inject generator and clock.
- Never fabricate a number, name, or decision. Numbers come from the system.
- Never soften a rule ("unless the pattern is clear" is a violation). Rules are copied verbatim.

TESTING (doc 36 §5-5)
- domain/ unit coverage ≥ 90% · property tests on every invariant · contract tests from OpenAPI
  · all acceptance scenarios of doc 40 Part E green (20/20 — S1–S20; the count in doc 40
  Part E governs) · mutation score ≥ 75% on domain/ · guard tests G1–G18 (doc 40 Part F).
- **Guard pass condition:** Guards G1–G18 must each return zero rows **or the stated pass
  condition** (G13 100 unique · G15 all scenarios pass · G16 ≥ 75% · G17 ≤ 2 s); G18
  (`billing.verify_unpriced_events()`) is **report-only and does not block**. A single failure of
  G1–G17 blocks merge and deploy.

GIT
- Conventional commits. Never commit secrets, .env, keys, dumps, backups. ONE commit per completed
  task containing code + tests + state + backlog + CHANGELOG. The first line of the message is
  exactly `type(WBS): description` — WBS is an ID present in docs/package/38-WBS.md, or `X` for
  cross-cutting/governance work — and the body carries trailers:
  Model: <tier>   Delegated: <agents>   Review: PASS(<n> findings fixed)
- Task ↔ code link (GM 2026-09-23, B3): the ONLY link between a task and its code is `git log` with
  the `type(WBS):` message. The standalone "record the verified hash" commit is abolished. The
  previous task's commit hash is recorded in PROJECT_STATE inside the NEXT task's commit.
- commit-msg hook (GM 2026-09-23, B4): `.githooks/commit-msg` is versioned and activated by
  `git config core.hooksPath .githooks` (run by `scripts/install-hooks.mjs` from the root `prepare`
  script on every `pnpm install`). It refuses any message whose first line does not match
  `type(WBS): description` with a WBS ID from 38-WBS or `X`. Types: feat fix docs chore test
  refactor perf build ci style revert wip.
- Migrations are forward-only. No state-only commits.

DOCUMENTATION
- ADR only for a decision that CHANGES the architecture. Everything else → CHANGELOG.md.
- The package is the documentation. Working notes go in docs/notes/. Never create a new numbered
  document.

HUMAN APPROVAL REQUIRED BEFORE
- production deploy · destructive production migration · production data deletion · credential
  rotation in prod · any financial transaction · enabling any feature flag in prod.
Development and test activities are autonomous. Do not ask permission for routine work
(git housekeeping, running tests, temp files, declared dependencies).

MODEL ROUTING (mechanism, not policy)
- Agents are pinned: pg-reviewer=opus · pg-backend/pg-frontend/pg-tester/pg-scribe=sonnet (GM 2026-09-23: no haiku).
  `inherit` is forbidden.
- The Master runs on the session model (sonnet by default) and delegates per the routing table (§4).
- Escalation is upward only (sonnet → opus) and only after two failures, for ADR/security, or for
  the WBS 2.9 session.
- Every commit and CHANGELOG entry records Model and Delegated. pg-reviewer flags any slice
  whose trailer is missing or whose tier contradicts the routing table.

PARALLEL LANES (EXECUTION-MASTER-v4 Part 2)
- Up to three lanes on separate git worktrees (lane/<id>); each lane touches only the modules in
  its brief. A lane never edits packages/*, database/schema/*, or another lane's module.
- Migrations are serialised through the Master (numbers issued in order, merged first) and are
  written to `database/migrations`.
- Merge order: pg-reviewer PASS → rebase on main → guards green → merge. Lanes never merge lanes.
- The golden slice 2.9 is never parallelised.

DEPLOYMENT PIPELINE (doc 36 §4-3 — seven named gates ①–⑦)
  ① lint + module boundaries + strict types
  ② unit tests (domain)
  ③ integration tests on an ephemeral database
  ④ acceptance tests — the doc 40 Part E scenarios
  ⑤ guard tests (doc 40 Part F, G1–G18) — must return zero rows or the stated pass condition
  ⑥ security scan: dependencies · leaked secrets · SBOM
  ⑦ build images + migrations
  → automatic deploy to staging → smoke test + system-owner approval → blue/green deploy to prod.
  Any red step stops the pipeline. `scripts/deploy.sh` runs `pnpm guards:run` covering G1–G18.

DEFINITION OF DONE — a WBS task is DONE only when its acceptance criterion (doc 38) passes, the
10-point review is PASS, guards are green, state/backlog/CHANGELOG are updated in the SAME commit,
and PROJECT_STATE.md records that commit hash (inside the next task's commit — GIT rule).

PARALLEL LANES — CONFLICT-FREE MECHANISM (v5)
- `tasks/LANE_LOCKS.md` is the single ownership table: `module | lane | task | claimed_at | worktree`. A module appears at most once. A lane writes only inside its locked modules and `tests/`. Claiming and releasing is done by the Master (pg-scribe writes the file). A worker that needs a file outside its lock STOPS and reports.
- Frozen during any parallel phase: `packages/*`, `database/schema/*`, `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*`. Changes to frozen paths are single-lane Master tasks merged before lanes resume.
- Migrations: a lane requests a number; the Master issues the next `NNNN` and records it in LANE_LOCKS; file name `database/migrations/NNNN_<lane>_<slug>.sql`; migrations merge first, in number order.
- Contracts: a new shared type goes to `packages/contracts/<module>/` (lane-owned) never to `_shared/` during a parallel phase.
- Events: a lane may **publish** new events of its own module; it may **consume** another module's events only through the event names already listed in `packages/events/catalog.ts` (frozen). New cross-module events are a Master task.
- Merge queue: pg-reviewer PASS → `git rebase main` → gates ①–③ green locally → `pnpm guards:run` green → Master merges (fast-forward only) → next lane rebases before its own merge. Lanes never merge lanes. Max three lanes.
- Worktrees: `git worktree add ../pg-eos-lane-<id> -b lane/<id>`; one Claude Code session per worktree; each session runs `/lane <id>`.

QUOTA DISCIPLINE (v5)
- Domain briefs (`.claude/briefs/<module>.brief.md`, ≤ 120 lines each) hold: the module's tables (names + status columns + check lists), its events, its doc 40 section pointers, its D-blueprint pointers, its golden-slice counterpart paths. Workers read the brief, not the package. The Master updates a brief only via pg-scribe when a slice changes the module's surface.
- One task per session. `/compact` after the review PASS; `/clear` before the next task. Never carry a slice across sessions.
- PROJECT_STATE.md ≤ 60 lines: current task · lane table · last 5 DONE with hashes · blockers · next 3 tasks. Older history lives in CHANGELOG.md.
- Never re-run a full `pnpm test`; run the module's test project and the guards. Full suite runs in CI.
- Workers report token estimates; the Master records them in CHANGELOG per task. A task that exceeds 2× its budget is split.

SPEED AND QUALITY (v5)
- `scripts/new-slice.sh <module> <use-case>` copies the golden-slice tree (domain/ application/ infrastructure/ api/ tests/ + contract + i18n keys) with names substituted; every replicated slice starts from it. Hand-made file trees are a review FAIL.
- pg-tester writes the Gherkin scenario, the property tests for the invariants in the brief, and the guard additions **before** any implementation; the build brief includes the failing test names.
- Git hooks live in .githooks/ (versioned; core.hooksPath set by scripts/install-hooks.mjs from the root prepare script on every pnpm install). Today: commit-msg (type(WBS): description). Planned pre-commit gates, same mechanism, no husky: ① lint+boundaries+types, ② domain unit tests of the touched module, ③ pnpm guards:run --changed. Commit is refused on red.
- CI on every PR: gates ①–⑦; nightly: Stryker mutation on `domain/` (≥ 75%), full Playwright S1–S20, `apply.sh --recreate` on an ephemeral database.
- Review checklist (doc 36 §5-4) is applied literally; "minor" findings are still findings. A slice with an open finding is not DONE.
