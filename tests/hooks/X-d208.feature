Feature: test scope rule D-208 in the agent files (X, M-core)

  Scenario: pg-tester carries the TEST SCOPE rule verbatim
    Given the file .claude/agents/pg-tester.md
    Then it has the heading "TEST SCOPE (D-208)"
    And it carries the whole rule line verbatim
    And the D-208 heading is before AGENT CONSTRAINTS

  Scenario: pg-reviewer blocks scope violations in the pre-build review
    Given the file .claude/agents/pg-reviewer.md
    Then it has the heading "PRE-BUILD BLOCKING (D-206, D-208)"
    And it carries the whole blocking sentence verbatim
    And the D-206/D-208 heading is before AGENT CONSTRAINTS
