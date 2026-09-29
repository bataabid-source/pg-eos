# X part 5d part 2, item 1 — the public entry of apps/api (src/index.ts) exports the host-route helpers,
# and the host can be built from a route table through hostRoutesFrom / mountedHostRoutes.
# Executed by apps/api/tests/public-entry.test.ts, one `it` per scenario, titled verbatim.
Feature: apps/api public entry (X part 5d part 2, item 1)
  Scenario: the public entry exports buildServer, buildRouteTable, hostRoutesFrom and isHostResult
    Given the barrel apps/api/src/index.ts is imported
    When the four named exports are inspected
    Then buildServer, buildRouteTable, hostRoutesFrom and isHostResult are each a function

  Scenario: isHostResult accepts { status: number, body } and refuses null, a string, { status: "200", body }, and { status } without body
    Given the isHostResult guard from the public entry
    When it is called with { status: 200, body: {} } and with { status: 201, body: undefined }
    Then both are accepted
    When it is called with null, a string, { status: "200", body: {} } and { status: 200 } without a body
    Then each is refused

  Scenario: hostRoutesFrom binds each mounted handler to its deps and returns its { status, body }
    Given a route table with two mounted entries, POST and GET, each with a handler that echoes its deps and its own distinct deps marker
    When hostRoutesFrom is called with the table
    Then it returns two routes carrying the method and path of each entry in order
    And calling the first route handler returns status 201 with the first entry deps marker
    And calling the second route handler returns status 201 with the second entry deps marker, never the first

  Scenario: hostRoutesFrom throws when a handler returns no { status, body }
    Given a route table with one mounted entry whose handler returns { status: "200" } without a body
    When hostRoutesFrom is called and the resulting route handler is invoked
    Then the invocation rejects with an error naming the handler name and the route path

  Scenario: hostRoutesFrom indexes every mounted route by handler name (method + path) and throws on a duplicate handler name
    Given a route table with a POST entry and a GET entry, each with its own handler name
    When hostRoutesFrom is called with the table
    Then routeByHandlerName holds two entries mapping each handler name to its { method, path }
    When hostRoutesFrom is called with a table whose second entry reuses the first entry handler name
    Then it throws an error naming that handler name

  Scenario: buildServer({ routes: hostRoutesFrom(table).routes }) serves a mounted route with the stub handler status and body
    Given a route table with one POST entry whose stub handler echoes its deps with status 201
    And a verifySubject stub returning a valid internal subject and a lookupEntities stub returning one entity
    When buildServer is built with routes from hostRoutesFrom and a bearer-authorised POST to the route path is injected
    Then the response status is 201
    And the response body is { deps } with the entry deps marker

  Scenario: buildServer({ routes: mountedHostRoutes(table) }) with two routes sharing one handler name still starts and serves both
    Given a route table with two POST entries on different paths sharing one handler name
    And a verifySubject stub returning a valid internal subject and a lookupEntities stub returning one entity
    When buildServer is built with routes from mountedHostRoutes
    Then the server starts without a duplicate-handler error
    And a bearer-authorised POST to each of the two paths returns status 201 with the deps marker body
