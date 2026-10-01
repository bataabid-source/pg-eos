# tests/ops/i18n-tms.feature — WBS X part 26 (pg-tester).
#
# Executable spec behind tests/ops/tests/i18n-tms.test.ts.

Feature: X part 26 — tms.task.create.* keys in six locales and the TSK counter prefix of the tms brief

  Scenario: Each of the six locales has packages/i18n/<lang>/tms.json
    Given the locales ar, en, hi, ur, bn and am
    When the repository is inspected at packages/i18n/<lang>/tms.json
    Then each of the six files exists

  Scenario: Every tms.json holds exactly the six tms.task.create keys with non-empty string values and no placeholder
    Given the six tms.json files
    When each file is parsed as JSON
    Then it is an object whose keys are exactly the six tms.task.create keys in the brief's order
    And every value is a non-empty string containing no { or } placeholder
    And every ar value equals the brief's Arabic string byte-for-byte

  Scenario: The three i18nKeys carried by modules/tms create-delivery-task errors are among the six keys
    Given modules/tms/domain/create-delivery-task/errors.ts
    When every i18nKey literal is extracted
    Then at least three are found
    And each is one of the six keys

  Scenario: Every tms.json is UTF-8 without BOM, 2-space indented, newline-terminated
    Given the six tms.json files
    When each file's raw content is inspected
    Then it has no UTF-8 byte order mark
    And it ends with exactly one newline
    And it equals JSON.stringify of its parsed value with 2-space indentation plus a newline

  Scenario: tms.brief.md §4 gives the TSK series the prefix PDL-TSK- and keeps PCC-RT- for RTE
    Given .claude/briefs/tms.brief.md
    When its series table is inspected
    Then the TSK row has the prefix PDL-TSK-
    And no PCC-TSK- remains
    And the RTE row still has the prefix PCC-RT-
