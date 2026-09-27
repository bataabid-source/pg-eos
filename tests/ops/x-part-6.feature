# tests/ops/x-part-6.feature — X part 6 (pg-tester).
#
# scripts/lib/g16-scope.sh decides which modules G16 (Stryker, doc 40 Part F) scores on a PR, and
# scripts/mutation-all.sh fails closed on an unknown module name (X part 6, D-193 D6). This is the
# executable spec behind tests/ops/tests/x-part-6.test.ts. Scenario wording follows the Master's
# slice contract for X part 6.

Feature: X part 6 — G16 scope (Stryker only on the modules that changed)

  Scenario: g16_changed_modules reports no modules for a docs-only change
    Given a git repository with a base commit and a docs-only change committed on top of it
    When g16_changed_modules is run with the base commit as its argument
    Then it prints an empty line

  Scenario: g16_changed_modules names each module whose domain, tests or vitest config changed, never a module without stryker.config.json
    Given a git repository with a base commit and, on top of it, a change under modules/wms/domain/, a change under modules/fleet/tests/, a change to modules/hr/vitest.config.ts, and a change under modules/nocfg/domain/ (nocfg has no stryker.config.json)
    When g16_changed_modules is run with the base commit as its argument
    Then it prints "fleet hr wms" and never lists nocfg

  Scenario: a git mv still counts the source module, including a move into another module's domain
    Given a git repository with a base commit containing modules/wms/domain/x.ts and modules/wms/domain/y.ts, both modules/wms and modules/fleet carrying a stryker.config.json
    When modules/wms/domain/x.ts is moved with git mv to modules/wms/application/x.ts and committed, and g16_changed_modules is run with the pre-move commit as its argument
    Then it prints "wms"
    When modules/wms/domain/y.ts is moved with git mv to modules/fleet/domain/y.ts and committed, and g16_changed_modules is run with the pre-move commit as its argument
    Then it prints "fleet wms", sorted

  Scenario: an empty or all-zero base widens to every module
    Given a git repository with at least one commit
    When g16_changed_modules is run with an empty string as its argument
    Then it prints "ALL"
    When g16_changed_modules is run with the all-zero SHA as its argument
    Then it prints "ALL"

  Scenario: g16_decide honors G16_MODULES and PG_GUARDS_STRICT
    When g16_decide runs with G16_MODULES unset
    Then it prints "all"
    When g16_decide runs with G16_MODULES set to the empty string
    Then it prints "scoped:"
    When g16_decide runs with G16_MODULES set to "wms fleet"
    Then it prints "scoped:wms fleet"
    When g16_decide runs with G16_MODULES set to the empty string and PG_GUARDS_STRICT=1
    Then it prints "all"

  Scenario: mutation-all.sh refuses an unknown module before building packages
    When scripts/mutation-all.sh is run with the module name "nosuch"
    Then it exits 1
    And stderr names modules/nosuch
    And stdout does not contain "building packages"
