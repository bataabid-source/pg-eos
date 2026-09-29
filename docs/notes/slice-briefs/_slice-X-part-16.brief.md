# SLICE BRIEF — X part 16 · G16/Stryker out of local guards (D-198 (أ)) + lane-guard `.githooks/*`

Task: X part 16 (literal WBS `X`; check-locks D-185 refuses "X part 16" as a doc-38 id)      Lane: M (M-core, ADR-0007)      Lock: `tooling | M | X` (Master M8, PR #203 eff4468; merges after #202, the D-198 wording)
builder: pg-builder-core
Session: M-core (`pg-eos:core`, session_011PL2MhC8UPwG79YDwDqjAK), branch `core/X-part-16-r1` (force-push denied after the rebase onto 4d35ed0) (rebased onto 4d35ed0, which carries the D-198 row, DECISION_LOG:321).
Model routing (ADR-0005 §5, D-200): pg-tester sonnet (RED) and pg-reviewer opus (pre-build) run in parallel → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance (MASTER_BACKLOG row X part 16, verbatim)
"local pre-commit and `pnpm guards:run` run no Stryker; CI ⑤ and nightly unchanged; tests/hooks case for `.githooks/*` under `tooling`". Source: D-198 (أ), verbatim GM directive «(أ) Stryker خارج الفحص المحلي، يبقى في CI والليلي» (DECISION_LOG:321).

## Facts (verified by M-core on origin/main @ 4d35ed0)
- `scripts/lib/g16-scope.sh` `g16_decide` prints `all` or `scoped:<mods>`: `G16_MODULES` set (and not strict) gives scoped, otherwise all. `scripts/guards-run.sh:165-200` acts on it: a config check (`thresholds.break` 75, `mutate` targets domain/), then `pnpm mutation`. `scoped:` with no modules takes the existing skipped path (`report_line G16 "-" …`, :194-195).
- `.githooks/pre-commit:99-104` runs `pnpm -s guards:run` whenever `database/` is staged, with `G16_MODULES` unset, which means Stryker on every module (≈ 45 min per commit, last M-core tenure).
- CI gate ⑤ runs `pnpm guards:run` on GitHub Actions (`ci.yml:253`), which sets `CI=true`, with a scoped `G16_MODULES`. Nightly (`nightly.yml:63`) calls `pnpm -s mutation` directly. `CI` is unset in the M-core cloud session (checked 2026-09-29).
- `scripts/deploy.sh` is not built yet (WBS 0.6b). `PG_GUARDS_STRICT=1` is the deploy mode it will use.
- `.claude/hooks/lane-guard.sh:211` maps `tooling` to `.claude/*|scripts/*|.github/*`, and its header (:31-32) repeats that mapping. The lane-guard harness is `tests/hooks/run.sh` (M-core tooling cases :77-85), which runs in CI gate ①.

## Decisions (defaults — one CHANGELOG line each)
1. **The decision lives in `g16_decide`.** It gains a third output, `local`. Order:
   - `PG_GUARDS_STRICT=1` → `all`.
   - CI mode → today's rule unchanged (`G16_MODULES` set → `scoped:`, else `all`).
   - otherwise → `local`.
   CI mode is exactly `[ -n "${CI:-}" ] && [ "$CI" != false ] && [ "$CI" != 0 ]`. `local` ignores `G16_MODULES`.
2. **guards-run maps `local` onto the existing skipped path.** It prints the report row `report_line G16 "-" "SKIPPED locally (D-198 (أ): CI gate ⑤ scoped + nightly govern)"`, and the result is not NOT RUNNABLE, not missing and not blocking. The exit code comes from the other guards only. The cheap config check (break 75, mutate domain/) still runs locally, because that is stricter at no cost. `verdict_nonsql`, the BLOCKING count and every other guard are untouched.
3. **No local opt-in variable.** D-198 has none, so `G16_LOCAL` is dropped. A developer who wants a score runs `pnpm mutation <module>` (scripts/mutation-all.sh).
4. **`.githooks/pre-commit`:** comment only (`:4,14-16`). Gate ③ runs G1–G15/G17/G18 locally, and G16 runs in CI ⑤ and nightly (D-198). There is no G16 logic in the hook.
5. **Deploy mode:** `PG_GUARDS_STRICT=1` always runs G16 over every module, CI or not.
6. **`lane-guard.sh`:** line 211's tooling case becomes `.claude/*|scripts/*|.github/*|.githooks/*`, and the header lines 31-32 say the same. ADR-0007:46 repeats the mapping but is outside the lock, so it is left for the Master (X part 17).
7. **Stale comments:** "G16_MODULES unset = all (… local merge queue)" at `g16-scope.sh:28` and `guards-run.sh:170` is reworded to the three-way rule.
8. **Out of scope:** D-198 (ب) auto-archive conditions and the D-199 agent-file copy both go to X part 17 (Master, 4d35ed0). Nothing in CI ⑤ or nightly.yml changes.

## Read ONLY (workers)
- `CLAUDE.md`
- `scripts/guards-run.sh`
- `scripts/lib/g16-scope.sh`
- `.githooks/pre-commit`
- `.claude/hooks/lane-guard.sh` lines 180-230
- `tests/hooks/run.sh` lines 1-100
- `tests/ops/tests/x-part-6.test.ts` lines 85-130 (the `runDecide` pattern)
- `tests/ops/tests/x-part-16.test.ts`

Write ONLY:
- `scripts/lib/g16-scope.sh`
- `scripts/guards-run.sh`
- `.githooks/pre-commit`, comment only
- `.claude/hooks/lane-guard.sh`, lines 31-32 and 211 only
- `tests/ops/**` and `tests/hooks/run.sh`, pg-tester only

Frozen paths are written with the Write/Edit tool only, never through Bash. Never CLAUDE.md, `.github/**`, `database/**` or `packages/**`.
Contract: none. Screen/Board spec: none. Migration number: none.

## RED tests
- `tests/ops/x-part-16.feature` and `tests/ops/tests/x-part-16.test.ts`:
  - `g16_decide` unit cases in x-part-6's `runDecide` style;
  - the guards-run fixture harness in x-part-16.test.ts (stub `pnpm`/`psql` on PATH);
  - a static pre-commit assertion.
- `tests/hooks/run.sh`: three `.githooks/pre-commit` cases.

```gherkin
Feature: G16/Stryker out of local guards (X part 16, D-198 (أ))
  Scenario: g16_decide prints local when CI is unset, empty, "false" or "0" and not strict, whatever G16_MODULES is
  Scenario: g16_decide keeps today's all/scoped rule when CI=true
  Scenario: g16_decide prints all under PG_GUARDS_STRICT=1, CI or not
  Scenario: Locally, guards-run never invokes the mutation runner, prints G16 SKIPPED locally, and G16 is not NOT RUNNABLE or missing
  Scenario: Locally, another red guard still makes guards-run exit 1 while G16 is SKIPPED
  Scenario: Locally, a stryker config with break != 75 is still reported red
  Scenario: With CI=true, G16 runs scoped by G16_MODULES and a score below 75 blocks, exactly as before
  Scenario: .githooks/pre-commit sets none of CI, PG_GUARDS_STRICT or G16_MODULES before calling guards:run
  Scenario (tests/hooks): lane M with the tooling row may write .githooks/pre-commit; lane M without it and lane 1 may not
```

Deliver: the edited files above plus the RED files. Green:
- `tests/ops` x-part-16 plus x-part-6 (regression)
- `bash tests/hooks/run.sh`
- `bash scripts/check-locks.sh`
- a local `pnpm guards:run` on a fresh DB, with `CI` unset, that finishes without Stryker and prints the SKIPPED line

Stop-and-ask if any of these happens:
- a change is needed in `.github/**` or `nightly.yml`;
- any guard other than G16 would change behaviour;
- the skip requires touching `verdict_nonsql` or the BLOCKING count;
- `CI` turns out set in the session running the local green check.

Pre-build review round 1 (pg-reviewer opus): FAIL(3 blocking, 8 nits), all applied here:
- the decision moves into g16_decide;
- the tests/hooks cases are added;
- G16_LOCAL is dropped;
- the header lines 31-32 are in scope;
- the stale comments are reworded;
- deploy.sh is marked unbuilt;
- the exact CI test is stated;
- the base is 4d35ed0, with (ب) out of scope;
- two stop-and-ask triggers are added;
- the RED gaps are filled;
- the config check is kept locally.
