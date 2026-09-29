# tests/ops/x-part-16.feature — X part 16 (pg-tester).
#
# D-198 (أ): G16/Stryker leaves the local guards (pre-commit and a local `pnpm guards:run`) and stays
# in CI gate 5 (scoped to changed domain/ modules) and in the nightly run (every module). "Local" =
# CI unset or empty. Plus the Master's add-on: lane-guard.sh's lane-M `tooling` case also covers
# .githooks/*. Executable spec behind tests/ops/tests/x-part-16.test.ts; every scenario runs in a
# disposable fixture with a stubbed pnpm and psql (no database, no real Stryker).

Feature: G16/Stryker out of local guards (X part 16, D-198 (أ))

  Scenario: With CI unset, guards-run does not invoke the mutation runner and reports G16 SKIPPED locally, non-blocking
    Given a guards-run fixture with two modules that have a stryker.config.json and a stubbed mutation runner
    And CI, G16_LOCAL, G16_MODULES and PG_GUARDS_STRICT are unset
    When scripts/guards-run.sh runs
    Then the mutation runner is never invoked
    And the output has a line "G16 SKIPPED locally (D-198 (أ): CI gate ⑤ scoped + nightly govern)"
    And the exit code is 0

  Scenario: With CI unset and G16_LOCAL=1, guards-run runs G16 as before (scoped by G16_MODULES)
    Given the same fixture with CI unset
    When scripts/guards-run.sh runs with G16_LOCAL=1 and G16_MODULES set to one module
    Then the mutation runner is invoked once, for that module only
    And the output has no "G16 SKIPPED locally" line

  Scenario: With CI=true, guards-run runs G16 scoped by G16_MODULES exactly as before (75 % break blocks)
    Given the same fixture
    When scripts/guards-run.sh runs with CI=true and G16_MODULES set to one module and the stub scores 80
    Then the mutation runner is invoked for that module only and the exit code is 0
    When it runs again with the stub scoring 70
    Then G16 is RED and the exit code is 1

  Scenario: With PG_GUARDS_STRICT=1, G16 always runs over every module, CI or not
    Given the same fixture with CI unset and G16_MODULES set to one module
    When scripts/guards-run.sh runs with PG_GUARDS_STRICT=1
    Then the mutation runner is invoked once with no module argument (every module)

  Scenario: The pre-commit hook no longer triggers Stryker when database/ is staged locally
    Given a git fixture with a file under database/ staged, CI unset, and pnpm guards:run wired to the guards-run fixture
    When .githooks/pre-commit runs
    Then guards:run is invoked without CI, G16_LOCAL or PG_GUARDS_STRICT
    And the mutation runner is never invoked
    And the hook exits 0

  Scenario: lane-guard allows a lane-M tooling write to .githooks/pre-commit and still refuses .githooks for other lanes
    Given a LANE_LOCKS fixture where lane M holds "tooling" and lane A holds a module
    When lane-guard.sh receives a Write to .githooks/pre-commit as lane M
    Then it exits 0
    When lane-guard.sh receives the same Write as lane A
    Then it exits 2
