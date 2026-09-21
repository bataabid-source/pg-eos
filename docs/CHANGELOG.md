# CHANGELOG — PG-EOS repository

One entry per completed task, newest first (CLAUDE.md · GIT · DOCUMENTATION). Each entry: WBS ID · what changed · Model · Delegated · Review · tokens (estimate). History that leaves `docs/PROJECT_STATE.md` lands here.

---

## 0.4 — monorepo initialised: pnpm workspace · Turborepo · TypeScript strict · ESLint boundaries (2026-09-21)

- **Acceptance (doc 38 row 0.4): `pnpm build` green · cross-module import fails lint — both green**, and
  `bash scripts/check-boundaries.sh` is the executable form of it. It asserts six things, because the
  criterion's words are satisfiable without its intent: (A) `pnpm build`, `pnpm typecheck` and
  `pnpm lint` green on the committed tree; (B) cross-module import **by package name** fails;
  (C) **by resolvable relative path** fails; (D) **by unresolvable relative path** fails; (E) an
  `eslint-disable` comment does **not** rescue it; (F) a file at `modules/<m>/domain/` **is**
  type-checked. Each of B–F was proved by a negative control — reverting the fix makes that
  assertion fail again.
- **Layout** (doc 36 §8): `apps/` · `modules/` · `packages/` workspaces, plus `tests/{scenarios,load,guards}/`
  and `database/{migrations,seeds}/`. Two module shells only — `modules/platform`, `modules/identity`
  (`package.json` + `tsconfig.json` + `index.ts` = `export {}`). They are the pnpm workspace containers
  `scripts/new-slice.sh` presupposes, not a replicated slice: the generator only ever creates
  `modules/<m>/{domain,application,infrastructure,api,tests}/<use-case>` and stays a no-op until
  `.golden-slice-accepted` exists. Module tsconfigs are scoped to **that** layout (doc 36 §1-2), never
  to `src/` — a tsconfig scoped elsewhere makes `pnpm build` green over an empty file set from WBS 2.9 on.
- **Boundary enforcement is three-layered**, because a module border is crossed three ways and each
  resolves differently: `boundaries/dependencies` (v7 policies) classifies resolvable paths;
  per-module `no-restricted-imports` `paths`/`group` catches package names; a `regex` entry catches
  relative escapes that **do not resolve** — boundaries cannot classify what it cannot resolve and
  would allow them silently. `linterOptions.noInlineConfig` + `reportUnusedDisableDirectives` make
  `eslint-disable` itself an error (CLAUDE.md · AGENT CONSTRAINTS).
- **New libraries — written justification (doc 36 §5-4 point 8).** All seven are devDependencies; no
  runtime dependency was added (NestJS, Drizzle, Zod, XState, pg-boss arrive with their own WBS tasks).

  | library | why | named by |
  |---|---|---|
  | `turbo` ^2 | the monorepo task runner the task calls for | doc 38 row 0.4 · doc 36 §7 ("pnpm + Turborepo") |
  | `typescript` **>=5.7.0 <6.1.0** | "TypeScript strict" | doc 38 row 0.4 |
  | `eslint` ^10 | gate ① STATIC | doc 36 §4-3 |
  | `@eslint/js` ^10 | ESLint's own recommended set, shipped separately | — |
  | `typescript-eslint` ^8 | parser + rules; without it `.ts` cannot be linted at all | — |
  | `eslint-plugin-boundaries` ^7 | named verbatim as the boundary mechanism | CLAUDE.md · ARCHITECTURE |
  | `eslint-import-resolver-typescript` ^4 | resolves NodeNext `.js` specifiers back to `.ts`, so boundaries can classify relative imports | — |

- **TypeScript is held at 5.9.3 deliberately.** `7.0.2` is the published `latest`, but
  `typescript-eslint@8.70.0` declares peer `typescript >=4.8.4 <6.1.0`, and that stack *is* gate ①.
  The range is written as `>=5.7.0 <6.1.0` rather than `^5.7` so the ceiling is a stated constraint
  instead of an accident of caret semantics. Revisit when typescript-eslint supports TS 7.
  ESLint went to 10 and `eslint-plugin-boundaries` to 7 (ESLint 9 is deprecated upstream); the v5-era
  `rules`/`element-types`/`${...}` config forms were migrated to v7 `policies`/`dependencies`/`{{...}}`
  — the plugin had been warning that it could not parse one of the old policies.
- **Review: FAIL (9 findings) → all 9 closed.** 1 `eslint-disable` opt-out · 2 tsconfig scoped to
  `src/` instead of the doc 36 §1-2 layout · 3 libraries undocumented + TS ceiling unexpressed ·
  4 boundaries config in unparseable v5 syntax · 5 three files written outside the brief's
  "Write ONLY" · 6 tier deviation (below) · 7 the script tested only the lint half of its own
  scenario · 8 unresolvable relative imports silently allowed · 9 fixture could be left in the tree
  and committed (now `__check_*.ts` is git-ignored, `trap` covers INT/TERM, and a stale fixture is
  cleared on entry).
- **Process deviation, recorded not hidden:** built **Master-direct on opus**, not pg-backend (sonnet)
  as `docs/MODEL_ROUTING.md` §4 and PROJECT_STATE require. The session opened on `Desktop/New sys`,
  one level above the repo root, so Claude Code never registered `.claude/agents`, `.claude/commands`
  or the lane-guard hook and no worker agent existed. Not retro-fixable in-session. **Every later
  session starts inside `claude-kit/`** — the check is that `/resume` and `/slice` are offered.
- **Guards G1–G18 NOT RUN** — psql 16 still absent and no SQL in the diff, so none can have regressed;
  not recorded as green. `scripts/check-boundaries.sh` is wired to `pnpm lint:boundaries` only; WBS 0.6
  must call it from gate ①.
- Model: opus (Master direct — see deviation) · Delegated: pg-reviewer role on opus · Review: PASS(9 findings fixed) · tokens: ≈ 190k.

## BOOTSTRAP-001 — kit verified and completed per BOOTSTRAP-v5 §9 (2026-09-21)

- Verified, nothing re-derived: 5 agents (`opus` ×1 · `sonnet` ×3 · `haiku` ×1; `inherit` = 0; each has `tools:`, the AGENT CONSTRAINTS block and the REPORT format) · 6 commands (13–30 lines, all ≤ 40) · 15 module briefs + `_TEMPLATE` (max 94 lines, all ≤ 120 — pre-generated; **not regenerated from the live schema: psql absent**) · `settings.json` valid JSON · hooks and scripts pass `bash -n` · `scripts/new-slice.sh` prints "golden slice not accepted yet" · `.gitignore` carries the 7 v4 §9 patterns and does NOT ignore `.golden-slice-accepted` · `DECISION REQUIRED` = 0 · MASTER_BACKLOG has 2.9 with its doc-38 criterion · LANE_LOCKS empty · 4 tasks in `tasks/proposed/` WAITING_GM · MODEL_ROUTING carries the §4 table · no `.env`, no credentials · `scripts/check-setup.sh` → FILES READY.
- Recorded: SETUP-000 = `bab005a` in PROJECT_STATE (exactly one DONE with a hash).
- **NOT RUN (environment, not a code blocker):** `database/schema/apply.sh --recreate` — Docker Desktop and psql 16 absent on the GM machine; expected on first run: zero errors · 175 tables · G7 = 0 · G-SEED = 0. `pnpm lint` cross-module-import FAIL test — pnpm absent; it is the acceptance criterion of 0.4 (doc 38) and is delivered there, not duplicated here (default taken, per BOOTSTRAP-v5 §2 "state one default, record it, proceed").
- Unsupported aliases: none reported (aliases are declared in the agent files; they are exercised on first delegation).
- Model: session (claude-fable-5-1, Master direct — state files only) · Delegated: none · Review: n/a (no code) · tokens: ≈ 45k.

## SETUP-000 — repository initialised from package v4 (2026-09-21)

- `docs/package/` ← PG-EOS-v4: A-governing (9 md) · B-reference (26 md) · C-tools → `tools/` · D-blueprints (16 md + `diagrams/` 172 mmd + 153 svg + `tools/`) · root docs (00-README-v4 · AUDIT-REPORT-v4 · CHANGELOG-v4). PNG renders omitted (svg kept) to keep the repository light.
- `database/schema/` ← `01 · 13 · 13B · 019 · guards.sql · apply.sh` — the ONLY permitted schema (175 tables · 16 views · 14 schemas; expected `apply.sh --recreate`: zero errors · G1–G13 = 0 · G7 = 0 · G-SEED = 0).
- Kit at root (CLAUDE.md · `.claude/` · `scripts/` · `tasks/` · `docs/` · `infra/` · `.gitignore`) as shipped in `claude-kit/`.
- **Added by setup (were reported missing by the `/resume` pre-check):** `tasks/MASTER_BACKLOG.md` (132 rows generated from doc 38 by `scripts/gen-backlog.py`, statuses seeded: 0.1 DONE pre-build · lane A WAITING_GM · 0.4 READY · rest TODO) · `docs/DECISION_LOG.md` (seeded from EXECUTION-MASTER-v4 Part 1, zero open markers) · this file · `tasks/{backlog,active,completed,blocked}/` · `docs/notes/` · `scripts/check-setup.sh` · `scripts/gen-backlog.py`.
- Model: n/a (no agent session) · Delegated: none · Review: n/a · tokens: 0 (done outside Claude Code).
- Remaining before BOOTSTRAP-001: install pnpm / Docker Desktop / psql 16 on the GM machine (PROJECT-SETUP-GUIDE §1); run `bash scripts/check-setup.sh` → `docker compose … up -d postgres` → `database/schema/apply.sh --recreate` (§3) → the bootstrap prompt (§4).
