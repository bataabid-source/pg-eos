# tests/ops/contracts-tsconfig.feature — WBS X part 23 (pg-tester).
#
# Executable spec behind tests/ops/tests/contracts-tsconfig.test.ts.

Feature: packages/contracts/tsconfig.json type-checks every contract module (WBS X part 23)

  Scenario: The include list contains tms/**/*.ts
    Given packages/contracts/tsconfig.json
    When its include list is read
    Then it contains tms/**/*.ts

  Scenario: Every contract directory holding .ts files has a matching include entry
    Given the directories directly under packages/contracts except _harness, scripts, tests, openapi, node_modules and dist
    When those holding at least one .ts file are listed
    Then each has a <dir>/**/*.ts entry in the include list
