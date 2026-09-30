Feature: the review check fails only on a security FAIL, a plain FAIL is report-only (X part 18, D-206)
  Scenario: a PASS verdict by claude[bot] after --since prints green and exits 0, also when the file holds --slurp pages
  Scenario: a FAIL verdict carrying [security] tags prints red:FAIL(<n> findings, <k> security) and exits 1
  Scenario: a FAIL verdict without a security tag prints report:FAIL(<n> findings), a ::warning annotation naming D-206 and exits 0
  Scenario: bare words such as no secrets or RLS in prose without the [security] tag do not turn a FAIL red
  Scenario: a FAIL whose only [security] mention is mid-line or inside backticks stays report-only and exits 0
  Scenario: pickVerdict also returns the security count of [security] tags in the verdict body
  Scenario: the newest verdict wins when an older PASS and a newer FAIL both exist, and vice versa
  Scenario: a verdict quoted inside a comment by another author, or a claude[bot] verdict before --since, is ignored and the result is red:no verdict
  Scenario: an unreadable file or a missing --since exits 2 with a usage line
  Scenario: claude-review.yml records the job start before the action, fetches the PR comments with gh api and runs review-verdict.mjs with --since after the action, all gated on the token
  Scenario: the claude-review.yml prompt tells the bot to mark each security finding (RLS, audit chain, secrets, permissions) with the tag [security]
  Scenario: the verdict gate is skipped on a PR that edits claude-review.yml itself: ::error + step summary + a `review: MANUAL` PR comment naming the head SHA, exit 1 (the review check is red on purpose — the action does not run on such a PR, manual review by the Master)
