Feature: ADR-0007 addendum gates (WBS X part 17)
  Scenario: The AGENT CONSTRAINTS block of CLAUDE.md and the four agent files are byte-identical, and stay identical when the D-199 exception line is added to CLAUDE.md and the four copies together
    Given CLAUDE.md holds an AGENT CONSTRAINTS block, from its heading line to the first blank line
    When scripts/check-agent-constraints.sh compares it with .claude/agents/pg-tester.md, pg-builder.md, pg-builder-core.md and pg-reviewer.md
    Then it exits 0 when all four blocks are byte-identical, also after the D-199 exception line is added to CLAUDE.md and the four copies together
    And it exits 1 and names the file when a copy differs, lacks the block, or CLAUDE.md lacks the block

  Scenario: check-locks.sh refuses a lock table with a fourth lane (max three lanes, unchanged)
    Given lanes 1, 2, 3 and A each hold a lock
    When scripts/check-locks.sh validates the table
    Then it exits 1
    And lanes 1, 2, 3 plus a Master row (lane M, not counted) exit 0

  Scenario: The watchdog archives an ACKed or merged session and a clean, pushed session idle over the named constant, and never a dirty idle one
    Given scripts/lib/session-archive.sh declares ARCHIVE_IDLE_MINUTES=120 (Master proposal, D-198 (ب))
    When archive_decide is called with acked, merged, open PR, idle minutes, tree clean, commits ahead and stash count
    Then it prints archive for acked or merged, or for idle over 120 with no open PR, a clean tree, no commit ahead and no stash
    And it prints keep in every other case, and exits 2 on a non-numeric or missing argument

  Scenario: The Master's merge step runs pnpm guards:run with PG_GUARDS_STRICT=1, and losing strict mode fails the test
    Given scripts/merge-step.sh sits next to scripts/guards-run.sh
    When the merge step runs
    Then guards-run.sh sees PG_GUARDS_STRICT=1
    And the merge step exits non-zero when guards-run.sh exits non-zero
