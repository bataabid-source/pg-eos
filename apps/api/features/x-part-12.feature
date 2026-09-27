# apps/api/features/x-part-12.feature — X part 12 (a)+(b), revision 3
# (docs/notes/slice-briefs/_slice-X-part-12.brief.md).
#
# Scenarios 3-7 of the brief's Gherkin only (revision 3 scope: the round-2 PASS subset).
# Scenarios 1, 2 and 8 are deferred to X part 12 part 3 (a `BuildServerOptions.contractRoutes`
# seam in server.ts does not exist in this slice) and are NOT pasted here.
#
# Executed by:
#   - Scenario "An unmarked route without a handler makes startup fail, naming the route"
#     -> apps/api/tests/route-table.unit.test.ts, describe "Scenario: An unmarked route without a
#        handler makes startup fail, naming the route (fixture c)"
#   - Scenario "The real ALL_ROUTES builds with no startup error, and every 501 route is
#     contractFirst or held until 2.16 part 1a-5"
#     -> apps/api/tests/route-table.unit.test.ts, describe "Feature: X part 12 (a)+(b) — the 501
#        set and the mounted count are derived, never pinned"
#   - Scenario "The 501 set and the mounted count are derived from the registry and the file
#     system, never pinned"
#     -> apps/api/tests/route-table.unit.test.ts (same describe as above)
#   - Scenario "Every operation declares 401, 403, 422 and 500; body-carrying operations also
#     declare 400, 413 and 415; GET operations declare no 413/415"
#     -> packages/contracts/tests/host-responses.test.ts
#   - Scenario "Exactly the contract-first and held otp-login operations declare 501 in
#     openapi.json"
#     -> packages/contracts/tests/host-responses.test.ts

Feature: Contract-first routes and host statuses (X part 12 a-b)

  Scenario: An unmarked route without a handler makes startup fail, naming the route
    Given a fixture modules root where route "POST /fixture/unbuilt/do-thing" is unmarked (no contractFirst) and has no handlers file
    When the route table is built against that fixture modules root
    Then the build rejects, and the error names the route

  Scenario: The real ALL_ROUTES builds with no startup error, and every 501 route is contractFirst or held until 2.16 part 1a-5
    Given the real ALL_ROUTES from @pg-eos/contracts and the real modules/ tree
    When the route table is built
    Then every entry of ALL_ROUTES is mounted exactly once on its method and path
    And every 501 (unimplemented) entry is either a contractFirst route with no handlers file, or one of the two routes held until 2.16 part 1a-5

  Scenario: The 501 set and the mounted count are derived from the registry and the file system, never pinned
    Given the real ALL_ROUTES from @pg-eos/contracts and the real modules/ tree
    When the route table is built
    Then the 501 set equals {contractFirst routes of ALL_ROUTES with no handlers file} union NOT_MOUNTED_UNTIL_2_16_PART_1A_5
    And the mounted count equals the length of ALL_ROUTES minus the length of that 501 set
    And no test literal 10, 12, 70 or 82 is used to state either of these facts

  Scenario: Every operation declares 401, 403, 422 and 500; body-carrying operations also declare 400, 413 and 415; GET operations declare no 413/415
    Given every route of ALL_ROUTES after withHostResponses is applied
    Then every operation's responses include 401, 403, 422 and 500, each with a ProblemSchema body
    And every POST, PUT, PATCH and DELETE operation's responses also include 400, 413 and 415, each with a ProblemSchema body
    And no GET operation's responses include 413 or 415

  Scenario: Exactly the contract-first and held otp-login operations declare 501 in openapi.json
    Given the generated packages/contracts/openapi/openapi.json
    When the set of operations declaring 501 is read from it
    Then that set equals exactly the 10 contractFirst operations of ALL_ROUTES plus the 2 identity/otp-login operations, derived from ALL_ROUTES, never hardcoded as 12
