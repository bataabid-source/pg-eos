# tests/ops/i18n-wms.feature — WBS X part 23 (pg-tester).
#
# Executable spec behind tests/ops/tests/i18n-wms.test.ts. The ar value is the D-211 template.

Feature: wms i18n files for the quarantine decision title (WBS X part 23)

  Scenario: Each of the six locales has packages/i18n/<lang>/wms.json
    Given the locales ar, en, hi, ur, bn and am
    When the repository is inspected at packages/i18n/<lang>/wms.json
    Then each of the six files exists

  Scenario: Every file holds exactly the key wms.receiveInbound.quarantineDecision.title with a non-empty string value
    Given the six wms.json files
    When each file is parsed as JSON
    Then it is an object whose only key is wms.receiveInbound.quarantineDecision.title
    And that key's value is a non-empty string

  Scenario: Every value contains the {batch} and {client} placeholders exactly once
    Given the six wms.json files
    When each value is inspected
    Then it contains {batch} exactly once
    And it contains {client} exactly once

  Scenario: The ar value equals the D-211 template byte-for-byte
    Given packages/i18n/ar/wms.json
    When its value is compared with the D-211 template
    Then they are identical

  Scenario: Every file is 2-space JSON, UTF-8 without BOM, ending in exactly one newline
    Given the six wms.json files
    When each file's raw content is inspected
    Then it has no UTF-8 byte order mark
    And it ends with exactly one newline
    And it equals JSON.stringify of its parsed value with 2-space indentation plus a newline
