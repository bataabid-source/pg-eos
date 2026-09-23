PREMIUM GROUP — PG-EOS · CLAUDE CODE MASTER AGENT BOOTSTRAP (v5)
**Version 5.2 · 23 September 2026 · Supersedes BOOTSTRAP-v4 (operating instruction only — the rule sources are unchanged)**

> **What v5 adds over v4 (nothing else changes):**
> 1. **Conflict-free parallelism as a mechanism** — module ownership locks (`tasks/LANE_LOCKS.md`), Master-issued migration numbers, one merge queue, and a lane brief that lists the only paths a lane may write.
> 2. **Quota discipline as a mechanism** — domain briefs (`.claude/briefs/`) replace re-reading the package; workers get file lists, never documents; one task per session; compact/clear rules; a token budget per task type.
> 3. **Speed and quality as a mechanism** — the golden slice is a *generator* (`scripts/new-slice.sh`), tests are written RED first by pg-tester, pre-commit runs gates ①–③, CI runs ①–⑦, and every slice ends with the 10-point review on opus.
> 4. **The D-blueprints (system atlas) become build inputs** — work orders (SCR-WO-01), `platform.my_work` focus boards (SCR-FB-01), space indicators (13B-SP), sales commission (13B-SC) are already in 13B; their WBS tasks are staged in `tasks/proposed/` until the GM approves them.
> 5. **Five agents stay five.** Domain knowledge lives in briefs, not in more agents — extra agents cost tokens and create conflicting edits.

==================================================
0. OPERATOR INSTRUCTION (for the human, before every session)
==================================================
- Start every build session with `/model sonnet`. Switch to `/model opus` only for: the whole WBS 2.9 golden-slice session · an ADR · a security review · a task that failed twice on sonnet.
- **One WBS task (or one lane batch) per session.** When the task is DONE and committed, end the session. Do not "continue while we're here".
- Never paste package documents into the prompt. The package is in the repository; the agent reads paths.
- Use the commands in `.claude/commands/` (`/pg-resume`, `/slice`, `/lane`, `/gate`, `/pg-state`) instead of free-text instructions — they carry the exact brief format and cost fewer tokens. (D-121, GM 2026-09-23: `resume`/`state`/`review` renamed `pg-resume`/`pg-state`/`pg-review` to avoid a possible clash with Claude Code's own built-in commands; `slice`/`lane`/`gate` are unchanged.)

==================================================
1. SOURCE OF TRUTH — PRECEDENCE (unchanged from v4)
==================================================
1. docs/package/40-Build-Specification-EN.md       technical contract; governs on conflict
2. docs/package/36-Technical-Architecture-Audit.md architecture, stack, build method
3. docs/package/EXECUTION-MASTER-v4.md             GM decisions register (Tier A) · lane plan · commands
4. docs/package/42-Oracle-Cloud-Deployment.md      Tier-0 deployment target
5. docs/package/38-WBS.md                          the ONLY task sequence (132 tasks · eight phases 0–7 · 6 X-tasks)
6. docs/package/22-Master-Data-Governance.md       ownership, SoD, approval chains
7. database/schema/01 · 13 · 13B · 019             the ONLY permitted schema — always "01 / 13 / 13B / 019"
8. docs/package/BOOTSTRAP-v5.md                    this file — operating instructions only
9. docs/package/D-blueprints/*                     system atlas — **binding for screens, boards, KPIs and scenarios**; never overrides items 1–7
10. all other package documents                    reference

BOOTSTRAP-v5 is an operating instruction, not a source of rules; on conflict, items 1–7 govern.
Repository files and Git history are the source of truth. Never conversation history.
Code that is not committed does not exist. A task is DONE only with the commit hash of its passing acceptance test recorded in `docs/PROJECT_STATE.md`.

Retired — never uploaded, never cited: 08 · 16 · 20 · 21 · 24 · 37 · 39 · 43 · DECISIONS-ADDENDUM · BOOTSTRAP-v2/v3/v4 (v4 stays in `docs/package/` for history only; v5 governs).

==================================================
2. MASTER AGENT — ORCHESTRATOR, NOT LABOURER
==================================================
The main session is the Master Agent (session model). It decides, briefs, verifies, merges and commits. It does not write slice code except where the routing table says "Master, direct".

Before every task it reads, in this order and nothing more:
  CLAUDE.md → docs/PROJECT_STATE.md (≤ 60 lines) → tasks/LANE_LOCKS.md → the WBS row → the module brief in `.claude/briefs/<module>.brief.md`.
It reads the package document only when the brief points to a section it has not cached in the brief.

Per task (mandatory, in order):
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

A REAL BLOCKER is only: (a) the acceptance test cannot be run; (b) a needed decision is absent from EXECUTION-MASTER-v4 Part 1 AND touches money, permissions, or a legal/penalty rule; (c) a schema object is missing and G-01 (EXECUTION-MASTER-v4 §1.11) does not allow adding it. Everything else: state one default, record it in CHANGELOG, proceed.

==================================================
3. WORKER AGENTS — FIVE, PINNED BY TIER ALIAS (unchanged roles, tightened inputs)
==================================================
Create under `.claude/agents/`. `model:` uses tier aliases opus · sonnet · haiku. `inherit` is forbidden. If an alias is unsupported, REPORT it — never fall back silently.

  pg-reviewer   model: opus     10-point review (doc 36 §5-4) · RLS/SoD/secrets · routing-trailer check · PASS/FAIL with numbered findings. Called at slice close and before any schema / RLS / audit-chain migration is written. Never edits code. The only opus agent.
  pg-backend    model: sonnet   NestJS · Drizzle · XState · outbox · pg-boss · migrations. Replicates the golden slice via `scripts/new-slice.sh`. Reads only the brief's file list. Never edits a test file.
  pg-frontend   model: sonnet   React/TanStack/shadcn (admin, portal) · React Native/Expo (driver, decisions) · PWA (PDA). RTL default. Builds from the Zod contract and the D-blueprint screen spec named in the brief.
  pg-tester     model: sonnet   Gherkin → Playwright · property tests (fast-check) · guards G1–G18 · mutation. Writes tests FIRST and reports RED before build starts; verifies GREEN after the build. Writes test files only.
  pg-scribe     model: sonnet   PROJECT_STATE · MASTER_BACKLOG · CHANGELOG · LANE_LOCKS release · commit message · i18n files · renames. No logic, no schema.

Each agent file: role · **allowed inputs = "only the paths in the brief"** · forbidden actions · REPORT format (§5) · the AGENT CONSTRAINTS block of §6 verbatim · `tools:` limited to what the role needs (pg-reviewer and pg-scribe: no Bash except `git`/`pnpm test`; pg-tester: no Edit outside `tests/` and `*/tests/`).

==================================================
4. ROUTING TABLE (unchanged) + TOKEN BUDGET (new)
==================================================
| Work type                                   | Agent          | Tier    | Budget guide (input tokens per delegation) |
|---------------------------------------------|----------------|---------|--------------------------------------------|
| Golden slice 2.9 build                      | pg-backend     | sonnet  | ≤ 60k (brief + golden files only)          |
| Golden slice 2.9 review                     | pg-reviewer    | opus    | ≤ 40k                                      |
| Replicated backend slice                    | pg-backend     | sonnet  | ≤ 40k                                      |
| UI slice from contract + D-blueprint screen | pg-frontend    | sonnet  | ≤ 40k                                      |
| Tests, guards, mutation                     | pg-tester      | sonnet  | ≤ 30k                                      |
| Slice review                                | pg-reviewer    | opus    | ≤ 30k                                      |
| State/backlog/CHANGELOG/i18n/renames        | pg-scribe      | sonnet  | ≤ 10k                                      |
| Single-file edit ≤ 30 lines, no new logic   | Master, direct | session | —                                          |
| Planning, briefs, locks, merges, commits    | Master, direct | session | —                                          |
| ADR / architecture / security design        | Master on opus | opus    | —                                          |
| Task failed twice on sonnet                 | Master on opus | opus    | —                                          |

Budget is enforced by the brief: a brief whose "Read ONLY" list exceeds 12 files or 1,500 lines is split into two slices. pg-reviewer flags any delegation whose report shows reads outside the list.

==================================================
5. SLICE BRIEF AND REPORT — FIXED FORMATS
==================================================
BRIEF (Master → worker) — copy from `.claude/briefs/_TEMPLATE.brief.md`:
  Task: <WBS id + name>            Lane: <A|B|C|1|2|3|M>          Lock: <module(s) claimed>
  Read ONLY: CLAUDE.md · .claude/briefs/<module>.brief.md · <golden slice path> · <doc 40 §> · <schema tables> · <D-blueprint section for screens/KPIs>
  Write ONLY: <paths inside the locked module(s)> · tests/…
  Scenario: <Gherkin block, pasted>
  Contract: <packages/contracts/<module>/<usecase>.ts | "derive from tables: …">
  Screen/Board spec: <D-blueprint doc §… | none>
  Deliver: <exact file list, mirroring the golden slice>
  Migration number: <issued by Master | none>
  Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40.
REPORT (worker → Master):
  Files changed: <list>   Files read outside list: <none | list>   Tests: <unit x/y · integration x/y · scenario PASS/FAIL>
  Guards: <G-ids green/red>   Open questions: <none | one line each with the default taken>
  Model: <tier>   Delegated: <none | agent>   Tokens (approx): <n>

==================================================
6. CLAUDE.md — PERMANENT RULES (write verbatim; = BOOTSTRAP-v4 §6 + the three blocks below)
==================================================
Write BOOTSTRAP-v4 §6 verbatim (ARCHITECTURE · BUILD METHOD · AGENT CONSTRAINTS · TESTING · GIT · DOCUMENTATION · HUMAN APPROVAL · MODEL ROUTING · PARALLEL LANES · DEPLOYMENT PIPELINE · DEFINITION OF DONE), then append:

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
- SLICE SEQUENCE (fixed, GM 2026-09-23): pg-tester (RED) → pg-backend / pg-frontend (build) → pg-tester (verify GREEN) → pg-reviewer (opus) → pg-scribe → ONE `feat(<WBS>)` commit. pg-tester writes only test files (`tests/**`, `**/tests/**`, `*.test.*`, `*.spec.*`, `features/**`, `*.feature`); builders never touch a test file — a test defect goes back to pg-tester. pg-reviewer is also called BEFORE any migration touching the schema, RLS or the audit chain is written.
- Pre-commit (husky): gates ① lint+boundaries+types, ② domain unit tests of the touched module, ③ `pnpm guards:run --changed`. Commit is refused on red.
- CI on every PR: gates ①–⑦; nightly: Stryker mutation on `domain/` (≥ 75%), full Playwright S1–S20, `apply.sh --recreate` on an ephemeral database.
- Review checklist (doc 36 §5-4) is applied literally; "minor" findings are still findings. A slice with an open finding is not DONE.

==================================================
7. REPOSITORY STRUCTURE (v4 §7 unchanged) + v5 additions
==================================================
.claude/agents/ (5)  .claude/commands/ (resume · slice · lane · gate · state · review)  .claude/briefs/ (one per module + _TEMPLATE)  .claude/settings.json  .claude/hooks/
CLAUDE.md
docs/  PROJECT_STATE.md  DECISION_LOG.md  CHANGELOG.md  MODEL_ROUTING.md  AGENT_WORKFLOW.md  package/ (A + B + C + **D-blueprints**)  notes/
tasks/ MASTER_BACKLOG.md  LANE_LOCKS.md  backlog/ active/ completed/ blocked/ **proposed/** (2.20 work orders · 5.18 focus boards · 6.2b connectors · sales commission activation — WAITING_GM)
apps/  api/ admin/ portal/ driver/ pda/ decisions/
modules/ identity/ platform/ catalog/ sales/ wms/ tms/ cc/ billing/ hr/ fleet/ housing/ partners/ admin/ imile/ governance/   ← each: domain/ application/ infrastructure/ api/ tests/
packages/ contracts/ db/ events/ domain-kit/ ui/ i18n/
database/ schema/ (01 · 13 · 13B · 019 · guards.sql · apply.sh) migrations/ seeds/
scripts/ new-slice.sh  guards-run.sh  deploy.sh
infra/ docker/ nginx/ oci/ terraform/
tests/ scenarios/ guards/ load/

==================================================
8. LANE PLAN — DERIVED, NEVER AUTHORED
==================================================
The lane plan is the `Lane` column of `docs/package/38-WBS.md` (EXECUTION-MASTER-v4 §2.3 is its rendering). The Master never invents a lane. Phase 0 and the golden slice 2.9 are never parallelised. From Phase 2 onward, up to three lanes run on the modules the plan names; LANE_LOCKS enforces it.

Module → default lane owner (Phases 2–6, from 38 v4):
  Lane 1: wms (after 2.9) · billing (Phase 4 serial) · cc + housing (Phase 5) · portal (Phase 6)
  Lane 2: tms · imile (Phase 3) · hr (Phase 5) · decisions app (Phase 6)
  Lane 3: pda app (Phase 2, after 2.13) · driver app (Phase 3) · admin + fleet + governance (Phase 5) · client API (Phase 6)
  Master (M): platform · identity · packages/* · migrations · alerts/reports (5.13) · all merges

==================================================
9. BOOTSTRAP-001 — ACCEPTANCE CRITERIA (v4 §9 + v5 additions)
==================================================
- All v4 §9 criteria (structure, package imported incl. `docs/package/D-blueprints/`, four schema files + `guards.sql` + `apply.sh` in `database/schema/`, CLAUDE.md verbatim per §6, PROJECT_STATE/MASTER_BACKLOG/DECISION_LOG, pnpm/Turborepo/ESLint boundaries with a FAILING cross-module import test, .gitignore, first commit, no business code, no credentials).
- `.claude/agents/`: five files, `model:` aliases, zero `inherit`, each with a `tools:` list and the AGENT CONSTRAINTS block.
- `.claude/commands/`: resume · slice · lane · gate · state · review — each ≤ 40 lines and referencing files, not restating rules.
- `.claude/briefs/`: `_TEMPLATE.brief.md` + one brief per module (15), generated from the schema (tables, status columns from `information_schema` + check constraints) and from doc 40 Part C section pointers — ≤ 120 lines each.
- `.claude/settings.json`: permissions allow-list for `pnpm`, `git`, `psql`, `docker compose`; deny for `rm -rf`, `git push --force`, `curl | sh`; hooks: PreToolUse guard that blocks edits outside LANE_LOCKS for lane sessions; Stop hook that reminds to commit.
- `tasks/LANE_LOCKS.md` (empty table) · `tasks/proposed/` with the four staged tasks marked WAITING_GM.
- `scripts/new-slice.sh` exists and is a no-op until 2.9 is accepted (prints "golden slice not accepted yet").
- `database/schema/apply.sh --recreate` runs green on the local Docker Postgres (175 tables · G7 = 0 · G-SEED = 0).
- First commit trailers: `Model: <session tier>` `Delegated: none`.

==================================================
10. COMMANDS — "Resume Premium Development" and the others
==================================================
/pg-resume Read CLAUDE.md → PROJECT_STATE → LANE_LOCKS → pick the next runnable task → /slice. (D-121: renamed from /resume, 2026-09-23)
/slice <id>   Write the brief from the template → claim lock → pg-tester RED → build → review → scribe → commit → release. Stops at DONE.
/lane <id>    In a worktree session: load the lane's task list from 38 `Lane` column, run /slice for each in dependency order, never touch frozen paths, request migration numbers from the Master by writing `tasks/backlog/MIGRATION-REQUEST-<lane>.md`.
/gate      Run gates ①–⑤ locally and print a one-table verdict.
/pg-state  Print PROJECT_STATE + LANE_LOCKS + last 3 commits; no edits. (D-121: renamed from /state, 2026-09-23)
/pg-review <path>   Run pg-reviewer on a slice without a build (used after manual fixes). (D-121: renamed from /review, 2026-09-23)
🧑 and 🔧 tasks: produce the runbook/script, mark WAITING_GM, continue.

==================================================
11. FINAL RESPONSE AFTER BOOTSTRAP
==================================================
Report in Arabic, in one table: status · files created (count) · agents (5) with `model:` · unsupported aliases · lint boundary test result · `apply.sh` result (tables · G7 · G-SEED) · briefs generated (count) · git status · current phase/task · next task · notes. Then STOP. Do not start 0.4.
END
