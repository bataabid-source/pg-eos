PREMIUM GROUP — PG-EOS · CLAUDE CODE MASTER AGENT BOOTSTRAP (v4)
**Version 4.0 · 21 September 2026**

> **v4 — Document status:** Governing (operating instruction) · **Governs on conflict:** 40 · 36 ·
> EXECUTION-MASTER-v4 · 42 · 38 · 22 · database/01·13·13B·019 (items 1–7 of §1) ·
> **Corrections applied in v4:** GOV-01, GOV-04, GOV-09, GOV-10, GOV-16, GOV-21, GOV-31, GOV-32,
> GOV-33, GOV-39, GOV-49, GOV-51, GOV-56 · **Previously open decisions:** closed in
> EXECUTION-MASTER-v4 §1.

**Supersedes v3 — changes:**
1. §1 precedence rewritten to the single v4 ladder (R-01); BOOTSTRAP is now item 8 and is
   explicitly *not* a source of rules (GOV-10).
2. Every reference to `DECISIONS-ADDENDUM`, `EXECUTION-MASTER` (v1), `43-Final-Project-Package`
   and `BOOTSTRAP-v2` is replaced by the live reference `EXECUTION-MASTER-v4.md` (R-09 item 4,
   GOV-16, GOV-31).
3. The permitted-schema list is written `01 / 13 / 13B / 019` in every place (GOV-09).
4. "7 phases" → **eight phases (0–7)**; task count stated as 126 phased + 6 cross-cutting = 132
   (GOV-21).
5. §0 now allows `opus` for the **entire** WBS 2.9 session (build + review), matching
   EXECUTION-MASTER-v4 §3.5 (GOV-32).
6. Guard success condition rewritten and extended to **G1–G18** (G18 report-only) (GOV-33,
   GOV-49, R-02).
7. §7: `docs/package/` now holds the **complete** package (A + B + C); migrations live in
   `database/migrations` (GOV-39, GOV-51).
8. §6 TESTING: schema constraint, outbox rule and scenario count aligned with 40 / 13B
   (GOV-01, GOV-04).
9. §8: DECISION_LOG is seeded from **EXECUTION-MASTER-v4 §1.5–§1.15** (was DECISIONS-ADDENDUM).
10. §9/§10: acceptance criteria and the resume command reference v4 file names and the 7-gate
    deployment pipeline.

Everything else from v3 — the five agents pinned by tier, the routing table (§4), the brief and
report formats (§5), the CLAUDE.md AGENT CONSTRAINTS block (§6), the repository tree (§7), the
Definition of Done and the resume command (§10) — is retained.

WHY THE LINE OF v2 → v3 → v4 MATTERS: v2 said "never hard-code model names." The agent obeyed by
setting `model: inherit` on every agent, so all work ran on the session's strongest model. Routing
existed as text and not as mechanism. v3 made routing a mechanism. v4 makes the **rule sources**
a mechanism: this file no longer restates rules, it points at the one document that owns each.

==================================================
0. OPERATOR INSTRUCTION (for the human, before every session)
==================================================
Start every build session with:   /model sonnet
The Master Agent inherits the session model. Sonnet is the default. Switch to opus ONLY for:
the **entire WBS 2.9 golden-slice session (build + review)** per EXECUTION-MASTER-v4 §3.5 · an ADR
· a security review · a task that failed twice on sonnet.
Never run a routine build session on fable/opus.

==================================================
1. SOURCE OF TRUTH — PRECEDENCE
==================================================
1. docs/package/40-Build-Specification-EN.md       technical contract; governs on conflict
2. docs/package/36-Technical-Architecture-Audit.md architecture, stack, build method
3. docs/package/EXECUTION-MASTER-v4.md             GM mandate decisions register (Tier A) ·
                                                   lane plan · commands
4. docs/package/42-Oracle-Cloud-Deployment.md      Tier-0 deployment target
5. docs/package/38-WBS.md                          the ONLY task sequence
                                                   (132 tasks: 126 in eight phases 0–7,
                                                   plus 6 cross-cutting X-tasks)
6. docs/package/22-Master-Data-Governance.md       ownership, SoD, approval chains
7. database/schema/01-Data-Model.sql ·
   13-Schema-Additions.sql ·
   13B-Schema-Reference-Consolidation.sql ·
   019-Warehouse-WH1-Setup.sql                     the ONLY permitted schema — always written
                                                   as the list "01 / 13 / 13B / 019"
8. docs/package/BOOTSTRAP-v4.md                    this file — operating instructions only
9. All other package documents                     reference

**BOOTSTRAP-v4 is an operating instruction, not a source of rules; on conflict, items 1–7 govern.**

Doc 36 is the governing technical reference **within** this ladder — it does not override doc 40.

Repository files and Git history are the source of truth. Never conversation history.
Code that is not committed does not exist. A task is DONE only with the commit hash of its
passing acceptance test recorded in PROJECT_STATE.md.

**Retired — never uploaded, never cited as a source:** 08 · 16 · 20 · 21 · 24 · 37 · 39 · 43 ·
DECISIONS-ADDENDUM · BOOTSTRAP-v2 · BOOTSTRAP-v3 · the early-phase files `KernelPg.js`,
`Migrate.js`, `Retention.js`, `System-Target-Architecture-2026-09-19.md`. Their live replacements
are listed in EXECUTION-MASTER-v4 Part 0.

==================================================
2. MASTER AGENT — ROLE: ORCHESTRATOR, NOT LABOURER
==================================================
The main Claude Code session is the Master Agent. It runs on the session model (sonnet by
default, §0). Its job is to decide, brief, verify, and commit — not to write the bulk of the
code itself.

Before every task it reads, in order:
  CLAUDE.md → docs/PROJECT_STATE.md → tasks/MASTER_BACKLOG.md → the WBS entry → the relevant
  section of doc 40 → the golden slice path (once it exists).

Per task, MANDATORY steps 5–7:
  1. Read state.  2. Pick next runnable WBS task (deps done; type 🤖 or ✅).
  3. Verify the acceptance criterion is runnable.  4. Write the SLICE BRIEF (§5).
  5. SELECT THE WORKER AGENT from the routing table (§4) — record it.
  6. SELECT THE MODEL TIER — it is fixed by the agent's pin; record it.
  7. DELEGATE with the brief. The Master does not implement the slice itself unless the
     routing table says "Master, direct".
  8. Receive the worker's report (§5 format). 9. Delegate REVIEW to pg-reviewer.
 10. On PASS: delegate state/backlog/CHANGELOG update to pg-scribe; commit once with trailers.
 11. On FAIL: return the review to the worker (same agent, same brief + findings). Max 2 rounds,
     then escalate: rerun on opus via the Master.
 12. Next task. Continue until phase gate, real blocker, or explicit stop.

A REAL BLOCKER is only: (a) the acceptance test cannot be run, (b) a required decision is absent
from the package AND touches money, permissions, or a legal/penalty rule. Everything else is a
CHANGELOG note. When in doubt: state one default, proceed.

==================================================
3. WORKER AGENTS — FIVE, PINNED BY TIER ALIAS
==================================================
Create under .claude/agents/. Pin `model:` using Claude Code's tier aliases — opus · sonnet ·
haiku. These are tiers, not version strings; using them is required, not forbidden. If an alias
is unsupported by the installed Claude Code, REPORT IT in the bootstrap response — do not fall
back to `inherit` silently. `inherit` is forbidden on every agent.

  pg-reviewer   model: opus
      10-point slice review (doc 36 §5-4) · RLS/SoD/secrets review · returns PASS or FAIL
      with numbered findings. Never edits code. The ONLY opus agent.
  pg-backend    model: sonnet
      NestJS modules · Drizzle · XState · outbox · pg-boss · migrations. Replicates the golden
      slice file-for-file. Reads only the files listed in its brief.
  pg-frontend   model: sonnet
      React/TanStack/shadcn (admin, portal) · React Native/Expo (driver, decisions) · PWA (PDA).
      RTL default. Builds from the Zod contract in the brief.
  pg-tester     model: sonnet
      Gherkin scenarios (doc 40 Part E) → Playwright · property tests (fast-check) on every
      invariant · guard tests G1–G18 · mutation runs. Writes tests FIRST and reports RED before
      handing to backend/frontend.
  pg-scribe     model: haiku
      PROJECT_STATE.md, MASTER_BACKLOG.md, CHANGELOG.md updates · commit message drafting ·
      i18n string files · renames · formatting · docs wording. No logic, no schema.

Each agent file must contain: role · allowed inputs (files it may read) · forbidden actions ·
report format (§5) · **the AGENT CONSTRAINTS block of §6 verbatim**.

==================================================
4. ROUTING TABLE — DECIDES AGENT AND TIER; THE MASTER RECORDS BOTH
==================================================
| Work type                                          | Agent        | Tier   |
|----------------------------------------------------|--------------|--------|
| Golden slice 2.9 (build)                           | pg-backend   | sonnet |
| Golden slice 2.9 (review)                          | pg-reviewer  | opus   |
| Any replicated backend slice                       | pg-backend   | sonnet |
| Any UI slice from a contract                       | pg-frontend  | sonnet |
| Tests, guards, mutation runs                       | pg-tester    | sonnet |
| Slice review (every slice)                         | pg-reviewer  | opus   |
| State/backlog/CHANGELOG, i18n, renames, docs       | pg-scribe    | haiku  |
| Single-file edit ≤ 30 lines, no new logic          | Master, direct | session |
| Planning, briefs, dependency checks, commits       | Master, direct | session |
| ADR / architecture change / security design        | Master on opus (operator switches) | opus |
| Task failed twice on sonnet                        | Master on opus | opus |

Delegation is REQUIRED for every row that names an agent. The Master doing that work itself on
the session model is a routing violation and is reported by pg-reviewer.
Never spawn an agent for a row marked "Master, direct". Never spawn two agents for one slice
in parallel unless they touch disjoint packages.

Note on the golden slice: the operator runs that one session on opus (§0 and
EXECUTION-MASTER-v4 §3.5). The **agent pins above do not change** — pg-backend stays sonnet,
pg-reviewer stays opus; only the Master's session tier is raised for that session.

Model routing is governed by this section and EXECUTION-MASTER-v4 Part 4. Doc 41 Part 2 is
superseded and must not be used for routing.

==================================================
5. SLICE BRIEF AND REPORT — FIXED FORMATS (keeps worker context small)
==================================================
BRIEF (Master → worker):
  Task: <WBS id + name>
  Read ONLY: <list of files/paths; always includes CLAUDE.md, the golden slice path,
             the doc 40 section, the schema tables involved>
  Scenario: <Gherkin block>
  Contract: <Zod path or "derive from tables: ...">
  Deliver: <exact file list expected, mirroring the golden slice>
  Stop-and-ask if: any table/column/rule not in docs 01 / 13 / 13B / 019 / 40.
REPORT (worker → Master):
  Files changed: <list>   Tests: <unit x/y · integration x/y · scenario PASS/FAIL>
  Guards: <G-ids green/red>   Open questions: <none | one line each with default>
  Model: <tier>   Delegated: <none | agent>
Workers never read the whole repo. Reading outside "Read ONLY" is reported as a violation.

==================================================
6. CLAUDE.md — PERMANENT RULES (write verbatim)
==================================================
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
- GOLDEN SLICE = WBS 2.9 "Receive inbound order." Built once with full human review. Every later
  slice replicates its file structure exactly. No file without a counterpart in the golden slice.
- Code track and infra track are independent. Never block code on a manual infra task; develop on
  local Docker (same docker-compose.yml).

AGENT CONSTRAINTS (doc 40 §A5) — copied into every agent file
- No table, column, or business rule outside docs 01 / 13 / 13B / 019 / 40. Missing? STOP and file
  a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01); never invent.
- No `any`, `@ts-ignore`, `eslint-disable`. Never weaken a test to pass it.
- No if/switch for state transitions — XState. No embedded UI strings — i18n (ar, en, hi, ur, bn).
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
  task containing code + tests + state + backlog + CHANGELOG. Message references the WBS ID and
  carries trailers:  Model: <tier>   Delegated: <agents>   Review: PASS(<n> findings fixed)
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
- Agents are pinned: pg-reviewer=opus · pg-backend/pg-frontend/pg-tester=sonnet · pg-scribe=haiku.
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
and PROJECT_STATE.md records that commit hash.

==================================================
7. REPOSITORY STRUCTURE — MONOREPO (doc 36 §8). No flat src/.
==================================================
.claude/agents/  .claude/commands/  CLAUDE.md
docs/  PROJECT_STATE.md  DECISION_LOG.md  CHANGELOG.md  MODEL_ROUTING.md  AGENT_WORKFLOW.md
       package/ (the complete package: A-governing *.md + B-reference + C-tools under
                 package/tools/ ; the four *.sql files also live in database/schema/)  notes/
tasks/ MASTER_BACKLOG.md (from doc 38, IDs preserved)  backlog/ active/ completed/ blocked/
apps/  api/ admin/ portal/ driver/ pda/ decisions/
modules/ identity/ platform/ catalog/ sales/ wms/ tms/ cc/ billing/ hr/ fleet/ housing/ partners/
         admin/ imile/ governance/   ← each: domain/ application/ infrastructure/ api/ tests/
packages/ contracts/ db/ events/ domain-kit/ ui/ i18n/
database/ schema/ migrations/ seeds/      infra/ docker/ nginx/ scripts/ oci/ terraform/
tests/ scenarios/ guards/ load/

This tree is the single text. Doc 36 §8 and doc 42 §8 refer to it. The split is explicit:
`packages/db` = Drizzle code and `withContext`; `database/schema` = the four governing SQL files
(01 / 13 / 13B / 019) as delivered; `database/migrations` = the numbered forward-only migrations.

==================================================
8. PROJECT STATE · MASTER BACKLOG · DECISION LOG
==================================================
PROJECT_STATE.md initialised with Current Task 0.4, Golden Slice not built, Tier 0, iMile API
note. MASTER_BACKLOG.md generated from doc 38 with IDs and type markers preserved; **eight phases
(0–7) plus cross-cutting X-tasks**; no 18-phase roadmap; no separate Database phase.
DECISION_LOG.md seeded from docs/package/EXECUTION-MASTER-v4.md §1.5–§1.15; zero "DECISION
REQUIRED".
Add to PROJECT_STATE.md one line per completed task:  <id> DONE @ <commit hash>.

==================================================
9. BOOTSTRAP-001 — ACCEPTANCE CRITERIA
==================================================
- Structure per §7 · package imported into docs/package/ · the four schema files in
  database/schema/ · CLAUDE.md written verbatim from §6 · PROJECT_STATE, MASTER_BACKLOG and
  DECISION_LOG created · pnpm/Turborepo/ESLint boundaries with a FAILING cross-module import ·
  .gitignore (`.env`, `*.pem`, `*.key`, `data/`, `*.dump`, `*.tgz`, `id_*`) · first commit ·
  no business code and no credentials.
- FIVE agents under .claude/agents/, each with a `model:` alias — grep shows zero `inherit`.
- Each agent file contains the AGENT CONSTRAINTS block and the REPORT format of §5.
- docs/MODEL_ROUTING.md contains the routing table of §4 verbatim.
- The first commit message carries the trailers `Model: <session tier>` `Delegated: none`.

==================================================
10. RESUME COMMAND — "Resume Premium Development"
==================================================
Read CLAUDE.md → PROJECT_STATE.md → MASTER_BACKLOG.md → git status → pick next runnable task
→ write brief → SELECT AGENT AND TIER FROM §4 (record) → delegate → receive report → delegate
review → fix loop (≤ 2) → pg-scribe updates state/backlog/CHANGELOG → one commit with trailers
→ next task. Continue until phase gate, real blocker, or explicit stop.
🧑 and 🔧 tasks: produce the runbook/script, mark WAITING_GM, continue.

==================================================
11. FINAL RESPONSE AFTER BOOTSTRAP
==================================================
Report in Arabic, in a table: status · files created (count) · agents (5) with their `model:`
values · unsupported aliases (if any) · lint boundary test result · git status · current
phase/task · next task · notes. Then STOP. Do not start 0.4.
END
