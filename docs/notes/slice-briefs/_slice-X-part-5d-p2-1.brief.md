# SLICE BRIEF — X part 5d part 2 (1) · `apps/api` exports its route-table→HostRoute builder and `isHostResult`

Task: X part 5d part 2, item (1) (MASTER_BACKLOG row 116; literal WBS `X`)      Lane: M (M-core, ADR-0007)      Lock: `api | M | X` (Master M11, 4ef42a1, M-core order: X part 16 → X part 5 → X part 17 → X part 18)
builder: pg-builder-core
Session: M-core (`pg-eos:core`, session_011PL2MhC8UPwG79YDwDqjAK), branch `core/X-part-5` from origin/main `4ef42a1`.
Model routing (ADR-0005 §5, D-200): pg-tester sonnet (RED) and pg-reviewer opus (pre-build) run in parallel → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance (row X part 5d part 2, item (1), verbatim)
"`apps/api` exports its route-table→HostRoute builder and `isHostResult` so `tests/scenarios/fixtures/host.ts` imports them instead of reaching into `apps/api/src`". The row's overall acceptance is "S1/S2 call the host over HTTP with no import into `apps/api/src`". Items (2) (the lifetime seed, a GM value), (3) (the re-land of `lane/3-x5d-r1`, integration lane) and (4) (ci.yml wording, which is true only after (3) lands) are NOT this slice.

## Facts (verified by M-core on origin/main @ 4ef42a1)
- `apps/api/src/server.ts:156-173` `tableEntries(table)` maps `RouteTable.mounted` to `HostRoute`: each handler is bound to its deps and its result is checked with `isHostResult`, which is private at `:143-145`. `HostRoute`, `HostResult` and `BuildServerOptions` are exported. `buildServer` is exported (`:176`). `buildRouteTable` is exported from `route-table.ts:173`.
- PR #175's fixture (`origin/lane/3-x5d-r1:tests/scenarios/fixtures/host.ts:20-24, 26-29, 60-80`) imports `buildRouteTable` from `../../../apps/api/src/route-table.js` and `buildServer`/`HostResult`/`HostRoute` from `../../../apps/api/src/server.js`. It copies `isHostResult` byte for byte and re-implements the table→HostRoute map, adding a handler-name → route index (`routeFor`).
- `apps/api/package.json` (`@pg-eos/api`) has no `main`/`types`/`exports` and no `build`; `tsconfig.json` is `noEmit`. Workspace packages that others import (`packages/api-kit`, `modules/wms`) publish `./dist/index.js` + `./dist/index.d.ts` through `main`/`types`/`exports`. `tests/scenarios` resolves them via turbo `build --filter=@pg-eos/scenarios...` (ci.yml ④).

## Decisions (defaults — one CHANGELOG line each)
1. **One public entry, `apps/api/src/index.ts`.** It exports:
   - `buildServer` and its option/route types;
   - `buildRouteTable` and its types;
   - `isHostResult`, moved out of `server.ts` and exported;
   - a new `hostRoutesFrom(table: RouteTable): { routes: HostRoute[]; routeByHandlerName: ReadonlyMap<string, { method; path }> }`.
   `hostRoutesFrom` is the `tableEntries` mounted-branch logic moved verbatim, plus the handler-name index. A handler name mounted on two routes throws, which is the fixture's rule. `server.ts` uses `hostRoutesFrom` internally, so there is one implementation and host behaviour is unchanged. `main.ts` is untouched.
2. **Package shape follows the workspace convention.** `apps/api/package.json` gains:
   - `main` `./dist/index.js` and `types` `./dist/index.d.ts`;
   - `exports` `{ ".": { types, import } }`;
   - a `build` script that emits only `src/**`, via a `tsconfig.build.json` that `extends` `tsconfig.json` with `noEmit: false`, `outDir: dist`, `declaration: true`.
   `pnpm start` (tsx) is unchanged. `dist/` is git-ignored; the root `.gitignore:23` `dist/` already covers it.
3. **No consumer rewiring here.** `tests/scenarios` (the fixture, `package.json` dependency) belongs to the integration lane's item (3). A consumer smoke test in `apps/api/tests/` imports `@pg-eos/api` by package name after `pnpm --filter @pg-eos/api build`.
4. **No new route, no contract change, no `ALL_ROUTES` change.** `server.test.ts` (existing) must stay green unedited.

## Read ONLY (workers)
- `CLAUDE.md`
- `apps/api/src/server.ts`
- `apps/api/src/route-table.ts` lines 36-90
- `apps/api/src/route-table.ts` lines 165-244
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `packages/api-kit/package.json`
- `apps/api/tests/route-table.unit.test.ts` lines 1-60

Write ONLY:
- `apps/api/src/{index,server}.ts`
- `apps/api/package.json`
- `apps/api/tsconfig.build.json`
- `apps/api/tests/**`, pg-tester only

Never `apps/api/src/main.ts` or `route-table.ts` logic, `tests/scenarios/**`, `packages/**`, `.github/**` or CLAUDE.md.
Contract: none (no endpoint changes). Screen/Board spec: none. Migration number: none.

## RED tests
`apps/api/tests/public-entry.test.ts`, plus `apps/api/tests/public-entry.feature` if the package keeps features beside its tests (follow `apps/api/tests/` convention).

```gherkin
Feature: apps/api public entry (X part 5d part 2, item 1)
  Scenario: @pg-eos/api resolves by package name after build and exports buildServer, buildRouteTable, hostRoutesFrom and isHostResult
  Scenario: isHostResult accepts { status: number, body } and refuses null, a string, { status: "200", body }, and { status } without body
  Scenario: hostRoutesFrom binds each mounted handler to its deps and returns its { status, body }
  Scenario: hostRoutesFrom throws when a handler returns no { status, body }
  Scenario: hostRoutesFrom indexes every mounted route by handler name and throws on a duplicate handler name
  Scenario: buildServer({ routes: hostRoutesFrom(table).routes }) serves a mounted route exactly as buildServer() does for the same table
```

Deliver: the files above plus the RED file. Green:
- `apps/api` vitest (the existing `server.test.ts` and `route-table.unit.test.ts`, plus the new file);
- `pnpm --filter @pg-eos/api build`, then typecheck and lint;
- `bash scripts/check-locks.sh`.

Stop-and-ask if any of these happens:
- the package entry would need a change outside the Write ONLY list (root `.gitignore`, `turbo.json`, `tsconfig.base.json`);
- `server.ts` behaviour would change for any existing test.
