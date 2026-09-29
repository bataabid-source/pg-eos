Feature: the review check fails on a FAIL verdict (X part 18)
  Scenario: a PASS verdict by claude[bot] after --since prints green and exits 0, also when the file holds --slurp pages
  Scenario: a FAIL verdict by claude[bot] after --since prints red with the count and exits 1
  Scenario: the newest verdict wins when an older PASS and a newer FAIL both exist, and vice versa
  Scenario: a verdict quoted inside a comment by another author, or a claude[bot] verdict before --since, is ignored and the result is red:no verdict
  Scenario: an unreadable file or a missing --since exits 2 with a usage line
  Scenario: claude-review.yml records the job start before the action, fetches the PR comments with gh api and runs review-verdict.mjs with --since after the action, all gated on the token
  Scenario: the verdict gate is skipped on a PR that edits claude-review.yml itself: ::warning + step summary + a `review: MANUAL` PR comment, exit 0 (the action does not run on such a PR — manual review by the Master)
