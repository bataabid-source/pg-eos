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
  Model: <tier>   Delegated: <agents>   Review: PASS(<n> findings, <r> rounds)  (the old `PASS(<n> findings fixed)` is still accepted, P7)
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
- Agents are pinned (routing v2, D-191, GM 2026-09-26 — supersedes "no haiku"): pg-reviewer=opus · pg-backend-core=opus (slices carrying a migration, RLS, permissions or platform/identity/billing core) · pg-backend/pg-frontend/pg-tester/pg-scribe=sonnet (pg-scribe back from haiku by the D-191 amendment, GM 2026-09-26). The brief names its builder on a `builder:` line (pg-backend, pg-backend-core or pg-frontend) before pg-tester starts; `scripts/brief-check.sh` refuses a brief without it.
  `inherit` is forbidden.
- The Master runs on the session model (sonnet by default) and delegates per the routing table (§4).
- Escalation is upward only (sonnet → opus) and only after two failures, for ADR/security, or for
  the WBS 2.9 session — the "after two failures" case is narrowed by REVIEW CAP (D-186/P7): only a finding that cannot be split (security, audit chain, RLS), and it is the last round.
- Every commit and CHANGELOG entry records Model and Delegated. pg-reviewer flags any slice
  whose trailer is missing or whose tier contradicts the routing table.

PARALLEL LANES (EXECUTION-MASTER-v4 Part 2 · conflict-free mechanism v5 · D-179)
- Up to three lanes, each in its own worktree `../pg-eos-lane-<id>` (`git worktree add ../pg-eos-lane-<id> -b lane/<id>`), one Claude Code session per worktree, each running `/lane <id>`; each lane touches only the modules in its brief. A lane writes ONLY from its own worktree — `lane-guard.sh` refuses any other checkout and `check-locks.sh` refuses a lane row naming another worktree (the shared `claude-kit` checkout and `../pg-eos-gov` are the Master's, D-180). All three lanes run concurrently whenever three locks are free — subject to the MEMORY rule under OPERATING RULES.
- `tasks/LANE_LOCKS.md` is the single ownership table: `module | lane | task | claimed_at | worktree`. A lock is a module (`wms`) or a module/use-case pair (`wms/put-away`); each appears at most once, a whole-module row and a use-case row of the same module never coexist for two lanes, and its `task` is a doc-38 row ID or `X` (D-185). A whole-module lock writes `modules/<m>/**` and `apps/<m>/**`; a use-case lock writes only `modules/<m>/{domain,application,infrastructure,api,tests}/<uc>/**`, `apps/<m>/src/features/<uc>/**`, `apps/<m>/tests/<uc>/**` and the additive `modules/<m>/tsconfig.test.json`; a module-wide file (index.ts, package.json, router, i18n) needs the whole-module lock. Every lane also writes `tests/`. The Master claims and releases (pg-scribe writes the file); `scripts/check-locks.sh` validates it (pre-commit, CI, check-setup). A worker needing a file outside its lock STOPS and reports. A lane never edits packages/*, database/schema/*, or another lane's module.
- Frozen during any parallel phase: `packages/*`, `database/schema/*`, `packages/contracts/_shared/*`, `CLAUDE.md`, `.claude/*`. Changes there are single-lane Master tasks merged before lanes resume.
- Migrations: serialised through the Master (numbers issued in order, merged first, in number order), forward-only, in `database/migrations/NNNN_<lane>_<slug>.sql` (register: `database/migrations/README.md`). A lane lists every migration of its whole task list in ONE `MIGRATION-REQUEST-<lane>.md` table at lane start; the Master issues the numbers in one batch and records them in LANE_LOCKS. The request row names the RED test files (`modules/<m>/tests/<uc>/*.feature|*.test.ts`) that already exist; `lane-guard.sh` refuses the migration file until they do.
- Contracts: a new shared type goes to `packages/contracts/<module>/` (lane-owned), never to `_shared/` during a parallel phase.
- Events: a lane may **publish** new events of its own module; it may **consume** another module's events only through the event names already listed in `packages/events/catalog.ts` (frozen). New catalog entries and cross-module events are a Master task.
- Merge queue: pg-reviewer PASS → `git rebase main` → gates ①–③ green locally → `pnpm guards:run` green → the Master merges (linear history — rebase merge, D-173) → the next lane rebases before its own merge. Lanes never merge lanes. Max three lanes. The golden slice 2.9 is never parallelised.

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

OPERATING RULES (quota discipline v5 · speed and quality v5 · session operating directive v6 — GM 2026-09-23: finish the pilot fast, finish it well)
- GOAL: the pilot system on seed 019 + synthetic data (D-127). Critical path, in this order and nothing
  else: 0.8 → 0.6a → 2.3 → 2.4 → 2.9 (golden slice, full human review) → `.golden-slice-accepted` →
  up to three lanes per the doc 38 `Lane` column (v4.6, 154 rows). Progress is measured in `feat(<WBS>)` commits.
- START: every session opens with `/pg-resume` and reads only the files it names plus the module brief.
  A package document is opened only at the section the brief points to. Docs 40 / 36 / 38 are never
  re-read in full; the brief and PROJECT_STATE already carry what the slice needs. One task per session:
  `/compact` after the review PASS; `/clear` before the next task; never carry a slice across sessions.
- BRIEFS: domain briefs (`.claude/briefs/<module>.brief.md`, ≤ 120 lines) hold the module's tables (names + status columns + check lists), its events, its doc 40 and D-blueprint pointers and its golden-slice counterpart paths; workers read the brief, not the package; the Master updates a brief only via pg-scribe when a slice changes the module's surface. PROJECT_STATE.md ≤ 40 lines (P1; was 60): current task · lanes · last 5 DONE with hashes · blockers · next 3 tasks; older history lives in CHANGELOG.md.
- BUILD, DON'T GOVERN: a session that ends without a `feat(<WBS>)` commit has failed unless it stopped on a REAL BLOCKER (AGENT_WORKFLOW §1). A `docs(X)` commit happens only on a GM directive quoted verbatim. A decision already in DECISION_LOG is never re-verified, re-argued or re-recorded.
- DEFAULT, RECORD, PROCEED: anything that is not a REAL BLOCKER gets one stated default, one CHANGELOG line, and the work continues. Zero questions to the GM inside a slice; open questions are batched in the closing report. GM directives arrive between sessions, never mid-slice.
- NO NEW PROSE: no new notes, drafts, pre-reads, candidate lists, summaries or status files unless a GM directive asks for one by name. Outside CHANGELOG and the brief, the closing report is the only prose.
- SPLIT BEFORE, NOT AFTER: a brief whose Read ONLY list exceeds 8 files / 1,000 lines (P7; was 12 / 1,500) is split by
  the Master into part 1 / part 2 with disjoint acceptance subsets before pg-tester starts, never after a failed
  round. `bash scripts/brief-check.sh <brief>` runs before pg-tester is delegated and again in pre-commit; an OVER
  BUDGET brief never reaches a worker (D-179). A task that exceeds 2× its token budget is split at the next review.
- REPLICATE: `scripts/new-slice.sh <module> <use-case>` copies the golden-slice tree (domain/ application/ infrastructure/ api/ tests/ + contract + i18n keys) with names substituted; every replicated slice starts from it. Hand-made file trees are a review FAIL.
- RED FIRST: pg-tester writes the Gherkin scenario, the property tests for the invariants in the brief and the guard additions **before** any implementation; the build brief includes the failing test names.
- CONCURRENCY INSIDE THE LOOP: pg-backend and pg-frontend run concurrently in step 7 against the same committed contract; the Master writes the migration request and the i18n key list while pg-tester writes RED tests. Nothing else in the twelve-step loop is reordered or skipped.
- QUALITY IS THE SPEED: RED → GREEN → pg-reviewer → one commit, every slice, no exception. A weakened
  test, a softened rule, a skipped guard or a hand-made tree is redone, not argued. The review checklist (doc 36 §5-4)
  is applied literally; "minor" findings are still findings; a slice with an open finding is not DONE.
- REVIEW CAP (D-186 / P7 — supersedes "fix rounds are bounded: two on the same worker, then the Master on opus"): round 1
  FAIL → one fix round → round 2. Round 2 FAIL → STOP: commit and merge only the GREEN, PASS-reviewed subset; every
  open finding becomes a `<WBS> part n+1` row in MASTER_BACKLOG; no round 3. A defect the lane finds itself before
  submitting belongs to the fix round. D-117 opus escalation remains only for a finding that cannot be split
  (security, audit chain, RLS) and is itself the last round. Trailer `Review: PASS(<n> findings, <r> rounds)`
  (commit-msg also accepts the old `PASS(<n> findings fixed)`).
- TESTS AND TOKENS: never re-run a full `pnpm test`; run the module's test project and the guards; the full suite runs
  in CI. Every worker reports a token estimate in its closing line; pg-scribe records them in CHANGELOG per task.
- HOOKS: `.githooks/` (versioned; `core.hooksPath` set by `scripts/install-hooks.mjs` from the root `prepare` script on every `pnpm install`), no husky. commit-msg: `type(WBS): description`; `docs(X)` needs `GM-Directive: "<verbatim>"` or `Decision: D-NNN` (D-179); feat/fix(<WBS>) needs the Review trailer (P7); GOVERNANCE BUDGET below — a second chore(X)/docs(X) on the same day is refused unless the body carries `Override: GM` together with a verbatim `GM-Directive: "…"` line (P2). pre-commit: ⓐ `scripts/check-locks.sh` when `tasks/LANE_LOCKS.md` is staged · ⓑ `scripts/brief-check.sh` when a `docs/notes/slice-briefs/*.brief.md` is staged · ① lint+boundaries+types · ② domain unit tests of the touched module · ③ `pnpm guards:run` when database/ is staged. PreToolUse: `lane-guard.sh` (writes), `db-guard.sh` (no psql DELETE/DROP/TRUNCATE on the shared `pgeos`, D-183; Master exception with its marker, D-188). Commit is refused on red. `tests/hooks/run.sh` (`pnpm test:hooks`, CI gate ①) is the regression suite of every hook rule; a hook change without its case is a review FAIL.
- CI on every PR: gates ①–⑦; nightly: Stryker mutation on `domain/` (≥ 75%), full Playwright S1–S20, `apply.sh --recreate` on an ephemeral database.
- MEMORY (P7 · GM-delegated plan 2026-09-26; docs/RUNBOOK.md §1, until P4a — narrows "all three lanes run concurrently"): with free RAM below 1 GB, at most two lane sessions run concurrently with the Master; the third lane waits.
- GOVERNANCE BUDGET (GM 2026-09-25): at most one chore(X)/docs(X) commit per calendar day on main; all bookkeeping is batched into it. Weekly target ≥ 60% feat/fix(<WBS>) commits; /pg-state prints the ratio.
- DECISIONS (GM 2026-09-25): an operational default is one CHANGELOG line, never a D-id. A D-id is issued only for a verbatim GM directive or an architecture change (ADR).
- NOTES (GM 2026-09-25): docs/notes/ holds only SCR-* files with an open G-01 item, GM-named files, and briefs of ACTIVE slices. pg-scribe deletes the brief and every SCR applied by the slice in the slice's own commit.
- BRANCHES (GM 2026-09-25): a branch is deleted from origin in the same step that merges it.
- CLOSE: the task's single commit lands in the same session; push per D-120; the working tree is clean at session end. Closing report to the GM in Arabic, ≤ 15 lines: commit hash · gates · findings fixed · defaults taken · batched questions · next task. Code, commits, tests and docs stay in English.
