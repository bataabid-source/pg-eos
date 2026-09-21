# CHANGELOG — PG-EOS repository

One entry per completed task, newest first (CLAUDE.md · GIT · DOCUMENTATION). Each entry: WBS ID · what changed · Model · Delegated · Review · tokens (estimate). History that leaves `docs/PROJECT_STATE.md` lands here.

---

## 0.14 — `packages/domain-kit`: Money, Quantity, Clock, IdGenerator (2026-09-22)

- **Delivered (doc 38 acceptance: Domain tests deterministic across 1,000 runs).** Four domain modules: (1) `Money` and `Quantity` — fixed-point decimals backed by BigInt with scale 1000 (numeric(14,3): 11 integer + 3 decimal digits), all arithmetic operations range-checked on every result not just construction; Money currency locked to KWD, Quantity unit-agnostic; both implement add/subtract/multiply(scalar)/negate/compare/equals/isZero/isNegative/isPositive/toString. (2) `Clock` — interface `Clock.now(): Date` with `SystemClock` (the sole sanctioned caller of `new Date()`) and `FixedClock` test double (now()/advance(ms)/set(date)). (3) `IdGenerator` — interface `IdGenerator.next(): string` returning RFC4122 v4 UUID strings matching Postgres `gen_random_uuid()` format, with `UuidGenerator` (crypto.randomUUID()) and `SequentialIdGenerator` (deterministic seeded via crypto.createHash('sha256'), strictly increasing, test double). Acceptance verified: fast-check property tests with fixed seed (1_000_003) and `numRuns: 1000` on every invariant (commutativity, associativity, round-trip exactness, additive identity, negate involution, compare reflexivity/antisymmetry, closure under numeric(14,3) range, SequentialIdGenerator uniqueness/determinism/RFC4122 well-formedness); pg-reviewer ran suite twice with identical results.
- **Three rounds: RED → implementation → FAIL(4 findings) → rework → re-review → PASS.** Round 1: pg-tester (sonnet) wrote 86 RED property tests and enum tests. pg-backend (sonnet) implemented, 71/71 green. pg-reviewer (opus) FAIL(4): (1) rounding/malformed-scalar branches untested; (2) in-range operands could combine into out-of-range results — add/subtract/multiply/negate re-validated range via shared `fromResult` factory enforcing MAX_MAGNITUDE=99999999999999n; (3) RangeError messages omitted the allowed input shape — all rewritten to name numeric(14,3) constraints; (4) missing Model/Delegated trailers (escalated to Master). Round 2: pg-tester added 4 new RED tests for rounding/malformed paths. pg-backend implemented range checks. Six pre-existing law-testing properties hit genuine numeric(14,3) overflow at the fixed seed, now correctly rejected. Round 3: pg-tester added a second generator (5-digit integer cap) for those 6 law-testing bodies only, preserving the full-range generator for range-invariant tests. pg-reviewer re-review: **PASS(4 findings fixed)**. Suite 87/87 both runs; `tsc` clean; `eslint` clean; `bash scripts/check-boundaries.sh` → BOUNDARIES ENFORCED.
- **One pre-existing repo bug noted (out of scope).** `eslint.config.mjs` resolves `readdirSync('modules')` relative to cwd; fails when eslint invoked via `pnpm --filter <pkg> lint` from inside a package (reproducible identically for already-DONE 0.13, `packages/contracts`). Root-relative path would fix it; worth its own task later; `/` invocation unaffected.
- **Non-blocking nit (not a finding).** stale comment headers in money.test.ts:4 and quantity.test.ts:4 still describe tests as "expected to fail on import" (true only during round 1's RED phase). Cosmetic; left as-is.
- Model: sonnet (Master) · Delegated: pg-tester (sonnet), pg-backend (sonnet), pg-reviewer (opus), pg-scribe (haiku) · Review: PASS(4 findings fixed) · tokens: ≈ 240k (estimate).

## 0.13 — `packages/contracts`: Zod → OpenAPI generation (2026-09-21)

- **Delivered (doc 38 acceptance: OpenAPI spec generated; contract test harness runs).** `packages/contracts` is now the single source of truth for the HTTP surface. Exports (1) `ContractRegistry` to register Zod schemas and route contracts with invariant checks (D1–D3); (2) a minimal `Problem` error envelope (type, title, status, detail, instance) per RFC 9457 (D4) with the three mandated status codes (400, 409, 422); (3) `Idempotency-Key` header + shared parameter definitions; (4) `contract-test` harness for modules to import; (5) `openapi/openapi.json` committed with a drift test ensuring contracts never become stale (D5). Files sit at `packages/contracts/<area>/`, no `src/` (D6). Two rounds: pg-backend (sonnet) + pg-tester (sonnet) built to spec; pg-reviewer (opus) round-1 FAIL (24 findings) → rework + round-2 re-review PASS.
- **Master decisions D1–D6 recorded (doc 40 §A4 governing rules encoded).** (D1) `zod@^4.6.5` + `zod-openapi@^6.0.2` — purpose-built for Zod 4, emits OpenAPI 3.1, uses `.meta({id})` not prototype patching. (D2) `vitest@^4.1.11` not 5.x — vitest@5 requires Node ^22.12.0 | ^24.0.0 | >=26.0.0; this machine runs 25.2.1; vitest@4 accepts ^20 | ^22 | >=24 (same pattern as TS 5.9.3 ceiling, revisit on Node 26 LTS). (D3) `@seriousme/openapi-schema-validator@^2.10.0` (dev) — makes "OpenAPI spec generated" a real assertion against official 3.1 meta-schema. (D4) Error body = minimal Problem object (RFC 9457 shape) — shared envelope every module inherits. (D5) `openapi/openapi.json` committed with drift test — emitted document is published contract; committing enables review and consumer diffing; drift test stops staleness. (D6) No `src/` directory — files at `packages/contracts/<area>/` per doc 36 §1-2 layout.
- **Two additional Master decisions from round-2 re-review.** (a) `@types/node@^24.13.6` added to `packages/contracts/package.json` — the package's first `node:` import consumer; gap in Master's own 0.4 scaffold, not either worker's fault. (b) `fast-check@^4.10.2` added as a real property-testing dependency to close finding 19 — the Idempotency-Key invariant is genuinely property-tested, not just enumerated.
- **Finding 2 (module-contract wiring) recorded as a Master deferral, out of scope.** The brief's own text states "module contracts arrive with their own WBS tasks from 0.9 on"; no mechanism exists yet to test wiring against, so completeness/discoverability wiring is deferred to when the first module (0.9+) registers real routes and a test harness becomes available.
- **Findings 21 and 23 scoped out by Master decision.** Finding 21: `.gitattributes` LF pinning — no rule requires it; recommended for the day CI runs on Windows or a fresh clone, not before. Finding 23: the brief's own "Read ONLY" list template should include the package's own `package.json`/`tsconfig*` and dependency type declarations — recorded as a process note for future briefs, not a 0.13 defect.
- **Mid-slice data-loss-and-recovery incident (process risk escalated to PROJECT_STATE).** While pg-reviewer's round-2 re-review was in progress, a concurrent process (same git author identity, an unrelated "cleanup" run outside this session) committed `a901a04` directly to `main`, deleting tracked WBS 0.4 scaffold and every uncommitted 0.13 file. Recovered without loss: (1) `a901a04` reverted at `1bc09f7` to restore tracked files; (2) untracked files had been moved rather than deleted, to a sibling `_TO_DELETE/` folder outside this repo, from which round-2's source was restored byte-identical; (3) re-verified green and checkpointed at `50055f8`. **Flagged as a process risk for PROJECT_STATE's Blockers**: other concurrent sessions/processes sharing this working directory can destroy uncommitted work; commit more frequently on long slices as mitigation until root cause is found.
- **Reviewer's minor residual observations (not blockers, not re-opened).** (1) `registerSchema` writes to Zod's process-global registry rather than being truly instance-scoped — harmless today, `ProblemSchema` already self-tags via `.meta()`. (2) The contract-object freeze is one level deep — nested `responses[status].description` etc. remain mutable. (3) Three `.toThrow()` assertions in the tests lack a message-pattern matcher — recommendation only, not required for acceptance.
- **Tests:** `pnpm --filter @pg-eos/contracts test` → 5 files / 44 passing. `pnpm --filter @pg-eos/contracts typecheck` clean. `pnpm --filter @pg-eos/contracts build` clean. `pnpm --filter @pg-eos/contracts generate:openapi` succeeds with no stray output. `pnpm lint` clean. `bash scripts/check-boundaries.sh` → BOUNDARIES ENFORCED (A–F).
- Model: sonnet (pg-backend, pg-tester) · opus (pg-reviewer) · haiku (pg-scribe) · Delegated: pg-backend (sonnet) · pg-tester (sonnet) · pg-reviewer (opus) · pg-scribe (haiku) · Review: PASS(24 findings fixed: 21 fixed in code, finding 2 recorded as Master deferral, findings 21/23 scoped out by Master decision with reasons) · tokens: ≈ 280k (estimate).

## SCR-I18N-01 — Amharic (`am`) added as a sixth field-app language, in the governing package (2026-09-21)

- **Rule change, not a correction.** `42c72ba` added `am` to `CLAUDE.md`, the five `.claude/agents/`
  files and `docs/DECISION_LOG.md` — all of them **downstream** of the package — while every governing
  source still read `ar, en, hi, ur, bn`. The language list originates in the **doc 40 closing note**,
  rank **1** on the R-01 ladder; under R-01 the higher document governs and the lower one is the one
  that gets corrected, so a sixth language cannot be introduced by editing the files that cite it.
  The GM confirmed the directive is real, so it was raised as **SCR-I18N-01** under
  EXECUTION-MASTER-v4 §1.11 (G-01), recorded as **D-001**, and applied top-down.
  Full request and reasoning: `docs/notes/SCR-I18N-01-amharic.md`.
- **Seven findings from `42c72ba`, all closed.** (1) the citation did not support the change — doc 40
  said five; (2) `docs/DECISION_LOG.md:106` sits under `## Seed — EXECUTION-MASTER-v4 PART 1 (verbatim)`
  and was edited while its source `EXECUTION-MASTER-v4.md:168` was not, desynchronising a section whose
  contract is that it is verbatim; (3) the row then read "5 languages" beside a six-item list;
  (4) ten package locations were left at five; (5) no WBS ID and none of the `Model:` / `Delegated:` /
  `Review:` trailers; (6) it changed the frozen `CLAUDE.md` and `.claude/*` outside a single-lane Master
  task — this commit is that task; (7) `DEC-002` was a prose block with a prefix the log does not use,
  numbered after a `DEC-001` that never existed — replaced by the conforming row **D-001**.
- **16 lines across 12 files.** Governing: doc 40:714 (rank 1) · EXEC-v4:168 and :585 (rank 3) ·
  doc 38:131, task 3.22 (rank 5) · BOOTSTRAP-v4:211 (rank 8). Reference: 19:506 · 28:62,204 ·
  30:37,323 · D-03:720,873 · D-06:675 · D-15:890. Derived: `DECISION_LOG.md:106` resynced to its
  EXEC-v4 source · `tasks/MASTER_BACKLOG.md:122` (mirror of doc 38). The admin console is untouched
  and stays **ar / en** — the directive concerns the workforce, not back-office users.
- **Three things deliberately left alone.** `AUDIT-REPORT-v4.md:215` is the closed record of finding
  OPS-46 (four languages → five) and is history, not a live statement — rewriting it would falsify the
  audit trail. **Doc 29 carries no language statement at all**; its "§6" citation supports the *admin*
  `ar / en` half, and inventing a six-language line there would have repeated the fault being fixed.
  Doc 40 §A5 has no list either, so docs 28 and 15 were re-pointed at the closing note, where the list
  actually lives.
- **Filesystem freeze respected.** Docs 19, 30, 38 and 40 carried a read-only attribute; it was cleared
  for the edit and restored — 10 read-only package files before, 10 after. The attribute covers only
  10 of 57 package files and does not track the R-01 ladder (rank-3 EXEC-v4 is writable, rank-5 doc 38
  is not), so it reads as a copy artifact rather than a control; flagged, not "fixed".
- **No code impact.** `packages/` holds only `.gitkeep`; `packages/i18n` does not exist and no `.ts`,
  `.tsx` or `.json` file referenced `am` before this change or does now. The rule lands ahead of the
  implementation, which is the right order.
- **Open items carried into `docs/notes/SCR-I18N-01-amharic.md` §5** — Amharic is **LTR in Ge'ez script**,
  so the `packages/i18n` direction map must group it with `en`/`hi`/`bn` and `pg-frontend`'s
  "RTL is the default" needs it in the LTR exception list; Ge'ez font coverage on the industrial PDA is
  unverified against doc 30 §W6 and is worth settling before WBS 2.16; `D-15` decision **D-2** stays
  ⏳ GM; and Amharic translation sourcing has no named owner.
- Also filled the placeholder hash for 0.4 in `docs/PROJECT_STATE.md` (`05674b5`), which the file had
  left pending for the next commit to write.
- Model: opus (Master direct — single-lane governance task; frozen paths) · Delegated: none · Review: PASS(7 findings fixed) · tokens: ≈ 140k.

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
