Feature: lane database per lane letter (WBS X part 19)
  Lanes are named 1, 2, 3 or A, B, C (CLAUDE.md, check-locks). scripts/lane-db.sh gives each lane
  its own database pgeos_lane<id> and refuses every other id.

  Scenario: an accepted lane letter
    When I run "bash scripts/lane-db.sh <id>" for B, A, C and 1 with a PATH that has no psql
    Then it fails on "psql not found on PATH" and prints no usage line

  Scenario: the database name is derived from the id
    Given a stub psql that reports the database exists and a stub createdb that must not be called
    When I run "bash scripts/lane-db.sh B" from a fixture copy of the script
    Then stdout contains "target database 'pgeos_laneB'" and an "already exists" line
    And createdb is never called
    And infra/docker/.env contains "PGDATABASE=pgeos_laneB"

  Scenario: a refused lane id
    When I run "bash scripts/lane-db.sh M", "9", "b" or with no id, with a PATH that has no psql
    Then it exits 2 (exit code checked on M)
    And stderr contains a "usage:" line

  Scenario: the usage line lists the letters
    When I run "bash scripts/lane-db.sh 9" with a PATH that has no psql
    Then the captured stderr contains "usage: bash scripts/lane-db.sh <1|2|3|A|B|C>"
