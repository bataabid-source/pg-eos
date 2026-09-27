# SLICE BRIEF — X part 12 (a)+(b) · contract-first mark in the registry (auto-mount when built) · host statuses in OpenAPI — revision 2

Task: X part 12 (MASTER_BACKLOG, Master cross-cutting, ADR-0006 §4) — parts (a) and (b) only      Lane: M      Lock: none (Master; `packages/contracts/*` and `apps/api` are Master paths)
builder: pg-builder
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief rev 2 + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus close. Budget: ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.
Split (pre-build review round 1, finding 8): part (c) `/ready` + `packages/db` `ping()` (withContext preflight, ADR-0005 §7) is **X part 12 part 2**, `builder: pg-builder-core`, a separate slice.
Lane coordination (finding 11): lane 2 (billing lock) never edits `packages/contracts` or `apps/api`; this slice changes only the `contractFirst` mark in its three frozen contract files. Lane 2 keeps building and rebases after this merges; the "Routes:" lines of the `_slice-4.1b-p2` / `_slice-4.19` / `_slice-4.20` briefs are updated in this commit (no Master edit on lane branches any more).

## Acceptance (backlog row X part 12, parts a–b)
"`openapi.json` lists the host statuses; `ALL_ROUTES` carries the unimplemented mark" — (c) "`/ready` 200 only with a live database" moves to X part 12 part 2.

ADR-0006 §4 (quoted): "Every route the registry lists without a handler (10 operations today: accounting periods, post-journal, dimension values) is marked unimplemented in the registry and answers 501 until its row is built; `ALL_ROUTES` never mounts a route whose handler does not exist."

## Decisions (Master defaults — one CHANGELOG line each)
1. **Mark:** `RouteDefinitionInput` / `RouteContract` gain optional `contractFirst?: true`. The 10 billing routes (`billing/{accounting-periods,dimensions,post-journal}.ts`) carry it. `UNIMPLEMENTED_ROUTES` is deleted from `apps/api/src/route-table.ts`. `NOT_MOUNTED_UNTIL_2_16_PART_1A_5` stays in apps/api (a security hold, not a build state).
2. **Host rule:** a `contractFirst` route is mounted exactly like any other when `modules/<m>/api/<use-case>/handlers` exists — same strict resolution (a missing export or composition is a startup error: a handlers file serves a whole use case, so a partial build must export every operation of it or stay unbuilt) — and answers 501 when it does not. An unmarked route without a handlers file stays a startup error (ADR-0006 §4 unchanged: no silent 501). A marked route that is built is served and produces exactly one pino `warn` per such route at startup through a new `BuildRouteTableOptions.logger` seam ("contract-first mark can be removed"); the Master removes stale marks at merge.
3. **Host statuses, where ALL_ROUTES is built (finding 4):** `packages/contracts/_shared/route-responses.ts` exports `withHostResponses(route)`; `packages/contracts/routes.ts` applies it once while building `ALL_ROUTES`, so `ALL_ROUTES`, every registered contract and `openapi.json` agree; the registry stays generic. Statuses (all `ProblemSchema`, each emitted by `apps/api/src/server.ts` today — none invented): every operation 401, 403, 422, 500; body-carrying methods (POST/PUT/PATCH/DELETE) also 400, 413, 415 (Fastify treats GET as bodyless — no 413/415 on GET); 501 on `contractFirst` routes and on the two `identity/otp-login` routes (held until 2.16 part 1a-5 — `withHostResponses` adds 501 for `contractFirst`; `identity/otp-login.ts` declares its 501 itself). Collision rule: a status the route already declares is kept as declared (same `ProblemSchema` body) — never duplicated, never overridden. No blanket 404 (the host's 404 is only the unknown-path handler) — deviation from backlog row (b), recorded.
4. **One source for the numbers (finding 18):** `apps/api/src/http-status.ts` keeps its constants; a host test asserts every status the table/host can emit for a route is declared in that route's `responses`.
5. **Tests derive, never pin (finding 5):** route-table test: 501 set = {contractFirst routes with no handlers file} ∪ NOT_MOUNTED; mounted = |ALL_ROUTES| − |501 set|; no literal 10 / 12 / 70 / 82. `server.test.ts` and `x-part-5a.feature` stop using the real `/billing/post-journal/post-journal` as "the unbuilt route": the 501 and 401-before-501 cases use a fixture modulesRoot with a fixture contract-first route.

Contract: `packages/contracts/_shared/route-responses.ts` (`withHostResponses`) · `packages/contracts/routes.ts` · the `contractFirst` mark in the three billing files · 501 in `identity/otp-login.ts`.
Screen/Board spec: none (host + contracts only).

Quoted facts (so workers need not open these files): host status constants, quoted from `apps/api/src/http-status.ts`: 401 UNAUTHORIZED · 404 NOT_FOUND · 413 PAYLOAD_TOO_LARGE · 415 UNSUPPORTED_MEDIA_TYPE · 501 NOT_IMPLEMENTED; 400/403/409/422 come from `PROBLEM_STATUS`, 500 from api-kit. Route shape, quoted from `billing/accounting-periods.ts`: `{ method, path, summary, request: { headers, body }, responses: { 200: OK_RESPONSE, ...writeErrorResponses({ forbidden: true }) } }` — the mark is one added property `contractFirst: true`.

## Read ONLY (workers) — 8 files, within the 8-file / 1,000-line budget
- `CLAUDE.md`
- `apps/api/src/route-table.ts`
- `apps/api/src/server.ts` lines 88-135, 176-258
- `apps/api/tests/route-table.unit.test.ts` lines 1-120
- `apps/api/tests/server.test.ts` lines 40-70, 180-200, 260-310
- `apps/api/features/x-part-5a.feature`
- `packages/contracts/routes.ts`
- `packages/contracts/_shared/route-responses.ts`


Write ONLY: `packages/contracts/_shared/{registry.ts,route-responses.ts}` · `packages/contracts/routes.ts` · `packages/contracts/billing/{accounting-periods,dimensions,post-journal}.ts` (mark only) · `packages/contracts/identity/otp-login.ts` (501 only) · `packages/contracts/openapi/openapi.json` (generated by `pnpm --filter @pg-eos/contracts generate:openapi`, never by hand) · `packages/contracts/tests/**` · `apps/api/src/**` · `apps/api/tests/**` · `apps/api/features/**` · `apps/api/README.md` (lines naming UNIMPLEMENTED_ROUTES) · `docs/notes/slice-briefs/_slice-{4.1b-p2,4.19,4.20}.brief.md` ("Routes:" lines only, Master). pg-tester writes only test/feature files; the builder never touches a test.

## RED tests
`apps/api/features/x-part-12.feature` · `apps/api/tests/route-table.unit.test.ts` (derived) · `apps/api/tests/server.test.ts` (fixture unbuilt route) · `apps/api/features/x-part-5a.feature` (fixture unbuilt route) · `packages/contracts/tests/host-responses.test.ts`

```gherkin
Feature: Contract-first routes and host statuses (X part 12 a–b)
  Scenario: A contract-first route without a handler answers 501 to a valid session
    Given a fixture modules root where route "POST /fixture/unbuilt/do-thing" is contractFirst and has no handlers file
    When a request with a valid internal session calls it
    Then the host answers 501 problem+json naming the route
  Scenario: A contract-first route whose handler exists is mounted and served, with one startup warning
    Given the same fixture route with a handlers file exporting its handler and composition
    When the route table is built with a capturing logger
    Then the route is mounted and exactly one warn names it
  Scenario: An unmarked route without a handler makes startup fail, naming the route
  Scenario: The real ALL_ROUTES builds with no startup error, and every 501 route is contractFirst or held until 2.16 part 1a-5
  Scenario: The 501 set and the mounted count are derived from the registry and the file system, never pinned
  Scenario: Every operation declares 401, 403, 422 and 500; body-carrying operations also declare 400, 413 and 415; GET operations declare no 413/415
  Scenario: Exactly the contract-first and held otp-login operations declare 501 in openapi.json
  Scenario: Every status the host can emit for a route is declared in that route's responses
```

Deliver: `packages/contracts/_shared/route-responses.ts` · `packages/contracts/_shared/registry.ts` (type field only) · `packages/contracts/routes.ts` · `packages/contracts/billing/accounting-periods.ts` · `packages/contracts/billing/dimensions.ts` · `packages/contracts/billing/post-journal.ts` · `packages/contracts/identity/otp-login.ts` · `packages/contracts/openapi/openapi.json` · `apps/api/src/route-table.ts` · `apps/api/src/server.ts` (only if the logger seam needs it) · `apps/api/README.md` · the RED files above · the three lane briefs' "Routes:" lines.
Migration number: none.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40, or any status, path or field not named here or in ADR-0006 — STOP and report; never invent a status for a route.
