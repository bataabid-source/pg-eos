# WBS 2.16 part 2e — PDA visual layer. The six scenarios are verbatim from the slice brief.
# Scenario 6 is verified at close by `git diff --exit-code main -- apps/pda/tests ':!apps/pda/tests/visual'` + the full apps/pda project green.
# Scenarios 1-5 are executed by the vitest files beside this one (touch-targets, direction, scan-field).
Feature: PDA visual layer (WBS 2.16 part 2e)
  Scenario: Every interactive control on shell, home, login, receive and put-away is at least 48 px in both dimensions
  Scenario: The scan field is large, autofocused on mount and refocused after each accepted scan
  Scenario: Each screen shows one step at a time
  Scenario: A refused scan plays sound + vibration and shows a message stating the next action
  Scenario: ar and ur render dir="rtl"; en, hi, bn and am render dir="ltr", with no untranslated key
  Scenario: The existing receive, put-away, login and shell tests pass unchanged
