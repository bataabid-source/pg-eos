# SLICE BRIEF — X part 16 · G16/Stryker out of local guards (D-198 (أ)) + lane-guard `.githooks/*`

Task: X part 16 (literal WBS `X`; check-locks D-185 refuses "X part 16" as a doc-38 id)      Lane: M (M-core, ADR-0007)      Lock: `tooling | M | X` (Master M8, PR #203 eff4468; merges after #202, the D-198 wording)
builder: pg-builder-core
Session: M-core (`pg-eos:core`, session_011PL2MhC8UPwG79YDwDqjAK), branch `core/X-part-16` from origin/main.
Model routing (ADR-0005 §5, D-200): pg-tester sonnet (RED) and pg-reviewer opus (pre-build) run in parallel → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance (D-198 (أ), verbatim GM directive: «(أ) Stryker خارج الفحص المحلي، يبقى في CI والليلي»)
"G16/Stryker removed from local pre-commit and local `pnpm guards:run`; stays in CI gate ⑤ (scoped to changed `domain/` modules, unchanged) and in the nightly run (all modules, unchanged)" (DECISION_LOG D-198 via PR #202; GM directive relayed to M5 2026-09-28). Plus the Master's add-on: `lane-guard.sh`'s lane-M `tooling` case also covers `.githooks/*`.

## Facts (verified by M-core on origin/main @ a885a99; unchanged at 426c315)
- `scripts/guards-run.sh:165-200` runs G16 = `pnpm mutation` over the modules chosen by `scripts/lib/g16-scope.sh` (`G16_MODULES` unset = every module; set = those; set-but-empty = none). `PG_GUARDS_STRICT=1` (deploy.sh) is never scoped.
- `.githooks/pre-commit:99-104` runs `pnpm -s guards:run` whenever `database/` is staged. With `G16_MODULES` unset that is Stryker on every module (≈ 45 min per commit last M-core tenure).
- CI gate ⑤ (`.github/workflows/ci.yml:224-240`) exports a scoped `G16_MODULES` and then runs guards on GitHub Actions, where `CI=true`. Nightly (`nightly.yml:62`) runs `pnpm -s mutation` directly, not guards-run.
- `.claude/hooks/lane-guard.sh:211`: `tooling) case "$REL" in .claude/*|scripts/*|.github/*) exit 0 ;;` does not cover `.githooks/*`.

## Decisions (defaults — one CHANGELOG line each)
1. **"Local" = `CI` unset or empty.** In `guards-run.sh`, G16 is not run locally unless `PG_GUARDS_STRICT=1` or `G16_LOCAL=1` (an explicit developer opt-in). Otherwise G16 prints one line, `G16 SKIPPED locally (D-198 (أ): CI gate ⑤ scoped + nightly govern)`, and is non-blocking. The exit code is decided by the other guards only. With `CI` set, behaviour is byte-identical to today (scoping via `G16_MODULES`, the 75 % break).
2. **Pre-commit:** no G16 logic of its own. It calls guards-run, so Decision 1 covers it. Its header comment (`:4,14-16`) is updated to say gate ③ runs G1–G15/G17/G18 locally and G16 in CI/nightly (D-198).
3. **Deploy is unchanged:** `PG_GUARDS_STRICT=1` always runs G16 (scripts/deploy.sh).
4. **`lane-guard.sh:211`:** the tooling case becomes `.claude/*|scripts/*|.github/*|.githooks/*`.
5. **D-199 agents copy is out of scope:** it moved to backlog row `X part 17` (Master M8, 05:47Z), where the CLAUDE.md line and the four `.claude/agents/*.md` copies land in one merge.
6. Nothing else in CI ⑤ or nightly.yml changes.

## Read ONLY (workers)
- `CLAUDE.md`
- `scripts/guards-run.sh`
- `scripts/lib/g16-scope.sh`
- `.githooks/pre-commit`
- `.claude/hooks/lane-guard.sh` lines 180-230
- `.github/workflows/ci.yml` lines 205-250
- `tests/ops/tests/x-part-6.test.ts`
- `tests/ops/x-part-6.feature`

Write ONLY: `scripts/guards-run.sh` · `.githooks/pre-commit` (comment only) · `.claude/hooks/lane-guard.sh` (line 211 only) · `tests/ops/**` (pg-tester only). Frozen paths are written with the Write/Edit tool only, never through Bash. Never CLAUDE.md, `.github/**`, `database/**` or `packages/**`.
Contract: none. Screen/Board spec: none. Migration number: none.

## RED tests
`tests/ops/x-part-16.feature` · `tests/ops/tests/x-part-16.test.ts`. These follow the x-part-6 pattern: the script is invoked with a stubbed `pnpm mutation` / env, and the DB-dependent SQL guards are stubbed or skipped the way x-part-6 does it.

```gherkin
Feature: G16/Stryker out of local guards (X part 16, D-198 (أ))
  Scenario: With CI unset, guards-run does not invoke the mutation runner and reports G16 SKIPPED locally, non-blocking
  Scenario: With CI unset and G16_LOCAL=1, guards-run runs G16 as before (scoped by G16_MODULES)
  Scenario: With CI=true, guards-run runs G16 scoped by G16_MODULES exactly as before (75 % break blocks)
  Scenario: With PG_GUARDS_STRICT=1, G16 always runs over every module, CI or not
  Scenario: The pre-commit hook no longer triggers Stryker when database/ is staged locally
  Scenario: lane-guard allows a lane-M tooling write to .githooks/pre-commit and still refuses .githooks for other lanes
```

Deliver: the edited files above plus the RED files. Green: `tests/ops` x-part-16 plus x-part-6 (regression), `bash scripts/check-locks.sh`, and a local `pnpm guards:run` on a fresh DB that finishes without Stryker.

Stop-and-ask if: a change is needed in `.github/**`, `nightly.yml` or `deploy.sh`, or any guard other than G16 would change behaviour — STOP and report.
