Feature: apps/api public entry (X part 5d part 2, item 1)
  Scenario: the public entry exports buildServer, buildRouteTable, hostRoutesFrom and isHostResult
  Scenario: isHostResult accepts { status: number, body } and refuses null, a string, { status: "200", body }, and { status } without body
  Scenario: hostRoutesFrom binds each mounted handler to its deps and returns its { status, body }
  Scenario: hostRoutesFrom throws when a handler returns no { status, body }
  Scenario: hostRoutesFrom indexes every mounted route by handler name (method + path) and throws on a duplicate handler name
  Scenario: buildServer({ routes: hostRoutesFrom(table).routes }) serves a mounted route with the stub handler status and body
  Scenario: buildServer({ routes: mountedHostRoutes(table) }) with two routes sharing one handler name still starts and serves both
