# tests/ops/i18n-billing.feature — WBS 4.19 i18n prerequisite (pg-tester).
#
# Executable spec behind tests/ops/tests/i18n-billing.test.ts. Values and sha256 pins are R5's
# (PR #170 issuecomment-5875924622).

Feature: billing i18n files for the reopen decision title (WBS 4.19 prerequisite)

  Scenario: Each of the six locales has packages/i18n/<lang>/billing.json
    Given the locales ar, en, hi, ur, bn and am
    When the repository is inspected at packages/i18n/<lang>/billing.json
    Then each of the six files exists

  Scenario: Every file holds exactly the key billing.accountingPeriods.reopenDecision.title with a non-empty string value
    Given the six billing.json files
    When each file is parsed as JSON
    Then it is an object whose only key is billing.accountingPeriods.reopenDecision.title
    And that key's value is a non-empty string

  Scenario: Every file is byte-identical to the sha256 R5 published on PR #170
    Given the six billing.json files
    When the sha256 of each file's raw bytes is computed
    Then it equals the hash R5 published for that locale

  Scenario: Every file is 2-space JSON, UTF-8 without BOM, ending in exactly one newline
    Given the six billing.json files
    When each file's raw content is inspected
    Then it has no UTF-8 byte order mark
    And it ends with exactly one newline
    And it equals JSON.stringify of its parsed value with 2-space indentation plus a newline
