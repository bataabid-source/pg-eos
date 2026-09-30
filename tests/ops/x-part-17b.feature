# tests/ops/x-part-17b.feature — X part 17 part 2 + part 3 (pg-tester).
#
# scripts/check-master-reads.sh (wrapper) -> scripts/check-master-reads.mjs reports, from a Claude
# Code session transcript (JSON Lines), the inline reads of governed content made on the MAIN
# thread (D-210 item 4). Governed: docs/CHANGELOG.md, tasks/MASTER_BACKLOG.md,
# docs/notes/handover-*.md (path suffix, absolute or relative), `gh pr view` without --json or with
# --json body, mcp__github__pull_request_read method "get", Grep content mode.
# Sidechain (subagent) reads never count. Executable spec behind
# tests/ops/tests/x-part-17b.test.ts.

Feature: X part 17b — the Master's inline reads, reported from the session transcript

  Scenario: a main-thread Read of docs/CHANGELOG.md is counted
    Given a transcript with a main-thread Read tool_use of docs/CHANGELOG.md
    When check-master-reads is run on it
    Then it reports 1 inline read naming the Read tool and that path

  Scenario: a sidechain Read of docs/CHANGELOG.md is not counted
    Given a transcript with a Read tool_use of docs/CHANGELOG.md flagged isSidechain true
    When check-master-reads is run on it
    Then it reports 0 inline reads in 0 main-thread tool calls

  Scenario: an absolute-path Read of /home/user/pg-eos/docs/CHANGELOG.md is counted
    Given a transcript with a main-thread Read of /home/user/pg-eos/docs/CHANGELOG.md
    When check-master-reads is run on it
    Then it reports 1 inline read

  Scenario: Bash cat of tasks/MASTER_BACKLOG.md is counted and Bash pnpm test is not
    Given a transcript with a main-thread Bash "cat tasks/MASTER_BACKLOG.md" and a main-thread Bash "pnpm test"
    When check-master-reads is run on it
    Then it reports 1 inline read in 2 main-thread tool calls

  Scenario: Bash cat of an absolute /home/user/pg-eos/tasks/MASTER_BACKLOG.md is counted
    Given a transcript with a main-thread Bash "cat /home/user/pg-eos/tasks/MASTER_BACKLOG.md"
    When check-master-reads is run on it
    Then it reports 1 inline read

  Scenario: a Read of docs/notes/handover-core.md is counted
    Given a transcript with a main-thread Read of docs/notes/handover-core.md
    When check-master-reads is run on it
    Then it reports 1 inline read

  Scenario: Grep with output_mode content on a governed file is counted and files_with_matches is not
    Given two main-thread Grep calls on docs/CHANGELOG.md, one with output_mode content and one with files_with_matches
    When check-master-reads is run on it
    Then it reports 1 inline read in 2 main-thread tool calls

  Scenario: Bash grep, git show, git diff, sed, head, tail and less on governed paths are counted
    Given seven main-thread Bash commands: grep -n, git show origin/main:, git diff --, sed -n, head, tail and less, each naming a governed path
    When check-master-reads is run on it
    Then it reports 7 inline reads in 7 main-thread tool calls

  Scenario: Bash gh pr view 228 --json body is counted
    Given a transcript with a main-thread Bash "gh pr view 228 --json body"
    When check-master-reads is run on it
    Then it reports 1 inline read

  Scenario: gh pr view 228 is counted, with --json body,title is counted, with --json state,mergeable,statusCheckRollup is not
    Given three main-thread Bash gh pr view 228 calls: plain, --json body,title and --json state,mergeable,statusCheckRollup
    When check-master-reads is run on it
    Then it reports 2 inline reads in 3 main-thread tool calls

  Scenario: mcp__github__pull_request_read with method get is counted and get_files is not
    Given a transcript with two main-thread mcp__github__pull_request_read calls, one with method "get" and one with method "get_files"
    When check-master-reads is run on it
    Then it reports 1 inline read in 2 main-thread tool calls

  Scenario: a Read of modules/wms/domain/x.ts is not counted
    Given a transcript with a main-thread Read of modules/wms/domain/x.ts
    When check-master-reads is run on it
    Then it reports 0 inline reads in 1 main-thread tool calls

  Scenario: a tool_result over the line limit is paired to its counted read by tool_use_id
    Given a counted main-thread read whose tool_result has 25 lines, and another whose tool_result has 20 lines
    When check-master-reads is run with --max-lines 20
    Then exactly one result is reported over 20 lines

  Scenario: an Agent or Task tool_result over the line limit is counted in m and one at the limit is not
    Given main-thread Agent and Task tool_use calls whose results have 25, 20 and 25 lines
    When check-master-reads is run with --max-lines 20
    Then it reports 0 inline reads and 2 results over 20 lines

  Scenario: the report exits 0 and line 1 has the fixed format
    Given a transcript with one counted read
    When check-master-reads is run without --strict
    Then it exits 0 and line 1 matches "master-reads: <n> inline read(s) of governed content in <k> main-thread tool calls; <m> result(s) over <N> lines"

  Scenario: --strict exits 1 when there is a finding and 0 when there is none
    Given one transcript with a counted read and one without
    When check-master-reads is run with --strict on each
    Then the first exits 1 and the second exits 0

  Scenario: a file that is not JSONL exits 2 with a usage line
    Given a file whose content is not JSON Lines
    When check-master-reads is run on it
    Then it exits 2 and prints a line starting with "usage:"

  Scenario: no argument at all exits 2 with a usage line
    Given no transcript argument
    When check-master-reads is run
    Then it exits 2 and prints a line starting with "usage:"

  Scenario: an unreadable or missing path exits 2 with a usage line
    Given a path that does not exist
    When check-master-reads is run on it
    Then it exits 2 and prints a line starting with "usage:"

  Scenario: the .sh wrapper forwards its arguments and the exit code
    Given a transcript with a counted read
    When bash scripts/check-master-reads.sh is run on it with --strict
    Then it exits 1 and prints the same line 1

  Scenario: 300 seeded generated cases agree with an independent oracle
    Given 300 seeded transcripts mixing main and sidechain, governed and other paths, and absolute and relative paths, and the tool kinds Read, Bash cat, Grep content and files_with_matches, Bash pnpm, gh pr view plain, --json body and --json state, pull_request_read get and get_files, Agent and Task with results of 0 to 30 lines
    When countMasterReads is applied to each
    Then reads.length, mainCalls and overLimit equal the oracle n, k and m

  Scenario: a governed path followed by ; | ) < > or & is still counted
    Given six main-thread Bash commands: "head -40 docs/CHANGELOG.md; git status", "cat tasks/MASTER_BACKLOG.md|head", "x=$(cat docs/CHANGELOG.md)", "head <docs/CHANGELOG.md", "cat docs/CHANGELOG.md>out" and "cat docs/CHANGELOG.md&"
    When check-master-reads is run on it
    Then it reports 6 inline reads in 6 main-thread tool calls

  Scenario: a read counts only when a read verb takes the governed path as its argument
    Given main-thread Bash "git add docs/CHANGELOG.md && git commit" with a heredoc using cat, "sed -i 's/a/b/' docs/CHANGELOG.md" and "sed -n 1,40p docs/CHANGELOG.md"
    When check-master-reads is run on it
    Then it reports 1 inline read in 3 main-thread tool calls

  Scenario: a governed read after a newline or inside backticks is counted
    Given main-thread Bash "git status" newline "cat docs/CHANGELOG.md", and "x=`cat docs/CHANGELOG.md`"
    When check-master-reads is run on it
    Then it reports 2 inline reads in 2 main-thread tool calls

  Scenario: sed counts unless -i or --in-place is an option, not text inside the script
    Given main-thread Bash "sed -n '/x-id/p' docs/CHANGELOG.md" and "sed --in-place 's/a/b/' docs/CHANGELOG.md"
    When check-master-reads is run on it
    Then it reports 1 inline read in 2 main-thread tool calls

  Scenario: a read verb must be a whole word and may follow an env assignment
    Given main-thread Bash "category docs/CHANGELOG.md", "unless docs/CHANGELOG.md" and "LC_ALL=C grep -n x docs/CHANGELOG.md"
    When check-master-reads is run on it
    Then it reports 1 inline read in 3 main-thread tool calls

  Scenario: a trailing newline does not count as a line of a result
    Given a counted read whose result has 20 lines ending with a trailing newline, and another whose result has 21 lines
    When check-master-reads is run with --max-lines 20
    Then exactly one result is reported over 20 lines

  Scenario: --json is parsed per gh pr view command
    Given main-thread Bash "gh pr view 1 --json state && gh pr view 2", "gh pr view 3 --json 'state, body'" and "gh pr view 4 --json state,title"
    When check-master-reads is run on it
    Then it reports 2 inline reads in 3 main-thread tool calls

  Scenario: git -C <dir> show and git --no-pager diff on governed paths are counted
    Given main-thread Bash "git -C /home/user/pg-eos show origin/main:docs/CHANGELOG.md" and "git --no-pager diff -- tasks/MASTER_BACKLOG.md"
    When check-master-reads is run on it
    Then it reports 2 inline reads in 2 main-thread tool calls

  Scenario: an empty --max-lines value exits 2 with a usage line
    Given a valid transcript
    When check-master-reads is run with --max-lines ''
    Then it exits 2 and prints a line starting with "usage:"

  Scenario: a JSONL line that is valid JSON but not an object exits 2 with a usage line
    Given a file whose only line is [1]
    When check-master-reads is run on it
    Then it exits 2 and prints a line starting with "usage:"

  Scenario: a tool_use without id never pairs with a result without tool_use_id
    Given a counted main-thread read with no id and a 30-line tool_result with no tool_use_id
    When check-master-reads is run
    Then it reports 1 inline read and 0 results over 20 lines

  Scenario: a redirect target is never a read
    Given main-thread Bash "cat >> docs/CHANGELOG.md <<'EOF'" with heredoc body "line", and "grep x a.ts > tasks/MASTER_BACKLOG.md"
    When check-master-reads is run on it
    Then it reports 0 inline reads in 2 main-thread tool calls
    And a separate transcript with Bash "cat docs/CHANGELOG.md>out" reports 1 inline read

  Scenario: sed in-place is detected on every option token
    Given main-thread Bash "sed -e 's/a/b/' -i docs/CHANGELOG.md"
    When check-master-reads is run on it
    Then it reports 0 inline reads
    And a separate transcript with Bash "sed -n '/x-id/p' docs/CHANGELOG.md" reports 1 inline read

  Scenario: text inside heredocs and quoted messages is not a command
    Given main-thread Bash git commit -m "$(cat <<'EOF' ... cat docs/CHANGELOG.md was read / gh pr view 228 ... EOF)"
    When check-master-reads is run on it
    Then it reports 0 inline reads
    And a separate transcript with Bash "gh pr view 228" reports 1 inline read
