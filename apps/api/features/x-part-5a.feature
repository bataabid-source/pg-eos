Feature: X part 5a — one host serves every registered operation
  Background:
    Given the host is built from ALL_ROUTES at startup

  Scenario: the route table is complete and one-to-one
    Then every entry of ALL_ROUTES is mounted exactly once on its method and path
    And the entries mounted on a handler number 70 and each resolves to an exported handle* function
    And the 501 entries are exactly the 10 UNIMPLEMENTED_ROUTES plus the 2 NOT_MOUNTED_UNTIL_2_16_PART_1A_5 routes
    And a route whose handler cannot be resolved makes startup fail with the route in the error
    And a listed unimplemented route that has a handlers.js makes startup fail
    # (HEAD step deferred to X part 5a part 2 — the assertion must await app.ready())

  Scenario: a request without a session is refused
    When POST /wms/receive-inbound/approve-inbound is called without an Authorization header
    Then the reply is 401 with an RFC 9457 Problem body
    And no handler ran (a counting stub route's counter stays 0)

  Scenario: an invalid, malformed or expired token is refused the same way
    When the same route is called with "Authorization: Bearer <unknown token>", with "Basic x", with "Bearer" alone, with "bearer a b", with a token whose subject is user_type agent, and with a token whose subject is valid but carries no userId
    Then every reply is 401 with a Problem body identical in shape to the missing-token reply

  Scenario: an unauthenticated call to an unbuilt route is 401, not 501
    When POST /billing/post-journal/post-journal is called without a token
    Then the reply is 401

  Scenario: a valid internal session reaches the handler with exactly its ctx
    Given a user row (user_type internal, is_active true) and a session issued for it (issueSession)
    And a stub route injected through buildServer({ routes }) that captures request.ctx and the headers it received
    When the stub route is called with the Bearer token
    Then the captured ctx deep-equals { userId, clientId: null, isInternal: true, entityId: A } (the user holds exactly entity A)
    And the captured headers carry no authorization entry
    And a body and headers that carry ctx, userId, isInternal, userid or isinternal are ignored (the captured ctx is unchanged)
    And two interleaved requests with two different sessions each capture their own userId

  Scenario: a client-type or inactive user is refused
    Given a user with user_type client and a client_id, and another internal user with is_active false, each with a session
    When the stub route is called with each token
    Then both replies are 401 with a body deep-equal to the missing-token reply (UNAUTHORIZED_PROBLEM)

  Scenario: X-Entity-Id selects the active entity or is refused
    Given the internal user is a member of entity A (identity.user_entities) and not of entity B
    When the stub route is called with X-Entity-Id: A
    Then the captured ctx.entityId is A
    When it is called with X-Entity-Id: B
    Then the reply is 403 with a Problem body
    When it is called with X-Entity-Id: not-a-uuid
    Then the reply is 403 with a Problem body
    Given a second internal user who holds two entities
    When the stub route is called with that user's token and no X-Entity-Id
    Then the reply is 422 with a Problem body

  Scenario: a real POST handler runs with the caller's ctx
    When POST /wms/receive-inbound/approve-inbound is called with the Bearer token and no Idempotency-Key
    Then the reply is the handler's own 400 Problem for the missing Idempotency-Key

  Scenario: a GET route receives its query as the handler body
    Given a stub GET route injected through buildServer({ routes }) that captures request.body
    When the stub GET route is called with "?qty=1" and the Bearer token
    Then the captured body deep-equals { qty: "1" }
    When GET /wms/receive-inbound/suggest-location?qty=1 is called with the Bearer token
    Then the reply is PROBLEM_STATUS.BAD_REQUEST with the handler's own ZodError Problem (X part 11 recorded gap: GET query values arrive as strings)

  Scenario: an unbuilt route answers 501
    When POST /billing/post-journal/post-journal is called with a valid session
    Then the reply is 501 with a Problem body naming the route

  Scenario: the login routes are not mounted yet
    When POST /identity/otp-login/request-otp-code is called with a valid session
    Then the reply is 501 with a Problem body naming 2.16 part 1a-5

  Scenario: framework errors are Problems too
    When an authenticated route is called with an empty JSON body, with text/plain, with a body over the limit, and when an unknown path is called
    Then the replies are 400, 415, 413 and 404 Problem bodies respectively
    When an unauthenticated route is called with an empty body
    Then the reply is 401, not 400 (authentication runs in an onRequest hook, before body parsing)
    When the session verifier throws
    Then the reply is a 500 Problem with UNKNOWN_ERROR_DETAIL and no error message text

  Scenario: liveness
    When GET /health is called
    Then the reply is 200 { status: "ok" }
