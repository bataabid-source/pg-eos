# tests/ops/x-part-16.feature — X part 16 (pg-tester), RED fix round.
#
# D-198 (أ): G16/Stryker leaves the local guards (pre-commit and a local `pnpm guards:run`) and stays
# in CI gate 5 (scoped to changed domain/ modules), in deploy (PG_GUARDS_STRICT=1) and in the nightly
# run. The decision lives in g16_decide (scripts/lib/g16-scope.sh), which gains the output `local`.
# CI mode is exactly [ -n "${CI:-}" ] && [ "$CI" != false ] && [ "$CI" != 0 ]. There is no local
# opt-in variable. Executable spec behind tests/ops/tests/x-part-16.test.ts; guards-run scenarios run
# in a disposable fixture with stubbed pnpm and psql (no database, no real Stryker). The lane-guard
# scenario lives in tests/hooks/run.sh.

Feature: G16/Stryker out of local guards (X part 16, D-198 (أ))

  Scenario: g16_decide prints local when CI is unset, empty, "false" or "0" and not strict, whatever G16_MODULES is
    Given CI is unset, empty, "false" or "0", PG_GUARDS_STRICT is not 1
    When g16_decide runs with G16_MODULES unset, empty or set to modules
    Then it prints "local" every time

  Scenario: g16_decide keeps today's all/scoped rule when CI=true
    When g16_decide runs with CI=true
    Then it prints "all" with G16_MODULES unset, "scoped:" when empty, "scoped:wms fleet" when set to "wms fleet"

  Scenario: g16_decide prints all under PG_GUARDS_STRICT=1, CI or not
    When g16_decide runs with PG_GUARDS_STRICT=1, CI unset or true, G16_MODULES unset, empty or set
    Then it prints "all" every time

  Scenario: Locally, guards-run never invokes the mutation runner, prints G16 SKIPPED locally, and G16 is not NOT RUNNABLE or missing
    Given a guards-run fixture with two modules that have a valid stryker.config.json and a stubbed mutation runner
    When scripts/guards-run.sh runs with CI unset (also with G16_MODULES set)
    Then the mutation runner is never invoked
    And the G16 report row is "SKIPPED locally (D-198 (أ): CI gate ⑤ scoped + nightly govern)"
    And G16 is not reported NOT RUNNABLE and the exit code is 0

  Scenario: Locally, another red guard still makes guards-run exit 1 while G16 is SKIPPED
    Given the same fixture
    When the isolation suite fails, or a SQL guard returns a row, with CI unset
    Then the exit code is 1 and the output still has "G16 SKIPPED locally"

  Scenario: Locally, a stryker config with break != 75 is still reported red
    Given the same fixture where one stryker.config.json has thresholds.break 50
    When scripts/guards-run.sh runs with CI unset
    Then G16 is reported RED, the exit code is 1 and the mutation runner is never invoked

  Scenario: With CI=true, G16 runs scoped by G16_MODULES and a score below 75 blocks, exactly as before
    Given the same fixture
    When scripts/guards-run.sh runs with CI=true, G16_MODULES set to one module and the stub scoring 80
    Then the mutation runner is invoked for that module only and the exit code is 0
    When it runs again with the stub scoring 70
    Then G16 is RED and the exit code is 1

  Scenario: .githooks/pre-commit sets none of CI, PG_GUARDS_STRICT or G16_MODULES before calling guards:run
    Given the hook source without its comment lines
    Then it calls guards:run
    And it never assigns or exports CI, PG_GUARDS_STRICT or G16_MODULES

  Scenario: pnpm guards:deploy is the deploy entry point and pins PG_GUARDS_STRICT=1 (PR #209 finding 1)
    Given the root package.json script "guards:deploy"
    Then it sets PG_GUARDS_STRICT=1 and runs scripts/guards-run.sh
    When that script string runs in the guards-run fixture with CI unset and G16_MODULES set to one module
    Then the mutation runner is invoked once for every module (never scoped, never SKIPPED locally)
    And with the stub scoring 80 the G16 row is green (G15/G17 read NOT RUNNABLE under PG_GUARDS_STRICT=1 — no runner in the fixture, deploy fails closed)
    And with the stub scoring 70 G16 is RED and the exit code is 1

  Scenario: Under PG_GUARDS_STRICT=1 alone, guards-run is strict whatever CI is (deploy never skips G16)
    Given the same fixture
    When scripts/guards-run.sh runs with PG_GUARDS_STRICT=1 and CI unset, "false", "0" or "true"
    Then the mutation runner is invoked once for every module, the G16 row is green and never SKIPPED locally

  Scenario: lane M with the tooling row may write .githooks/pre-commit; lane M without it and lane 1 may not (tests/hooks/run.sh)
    Given the cloud lane-guard harness on a core/ branch
    Then with the tooling row the write is allowed (exit 0), without it refused (exit 2), and lane 1 is refused (exit 2)
