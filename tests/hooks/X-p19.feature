Feature: lane database per lane letter (WBS X part 19)
  Lanes are named 1, 2, 3 or A, B, C (CLAUDE.md, check-locks). scripts/lane-db.sh gives each lane
  its own database pgeos_lane<id> and refuses every other id.

  Scenario: an accepted lane letter
    When I run "bash scripts/lane-db.sh B"
    Then the id is accepted and no usage line is printed
    And LANE_DB is derived as pgeos_lane<id>

  Scenario: a refused lane id
    When I run "bash scripts/lane-db.sh M", "9", "b" or with no id
    Then it exits 2
    And stderr contains a "usage:" line

  Scenario: the usage line lists the letters
    When I read the usage line of scripts/lane-db.sh
    Then it lists "<1|2|3|A|B|C>"
