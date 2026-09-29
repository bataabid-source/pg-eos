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
1. **New module `apps/api/src/host-routes.ts`.** It holds:
   - `isHostResult`, moved out of `server.ts` verbatim;
   - `export interface HostRouteRef { readonly method: HttpMethod; readonly path: string }`;
   - `mountedHostRoutes(table: RouteTable): HostRoute[]`, which is `server.ts:156-173` `tableEntries`'s mounted branch verbatim and never throws on a duplicate name. `server.ts` uses it, so host behaviour is unchanged;
   - `hostRoutesFrom(table: RouteTable): { routes: HostRoute[]; routeByHandlerName: ReadonlyMap<string, HostRouteRef> }`, which is `mountedHostRoutes` plus a handler-name index. It throws on a handler name mounted on two routes. That is the fixture's lookup rule, for external callers only: `handlerNamesFor`'s `handle<UseCase>` fallback makes a collision legal in the production table.
   `server.ts` imports from `host-routes.ts`. `host-routes.ts` takes the `HostRoute`/`HostResult` types from `server.ts` as type-only imports, so there is no runtime cycle.
2. **`apps/api/src/index.ts` is a pure barrel.**
   - Values: `buildServer`, `buildRouteTable`, `hostRoutesFrom`, `isHostResult`.
   - Types: `HostRoute`, `HostResult`, `HostRouteRef`, `BuildServerOptions`, `RouteTable`, `MountedRoute`, `BuildRouteTableOptions`, `DepsInput`.
   With these, PR #175's fixture keeps only `buildRouteTable`, `buildServer`, `hostRoutesFrom` and a 5-line `routeFor` over `routeByHandlerName`.
3. **Package shape.**
   - `apps/api/package.json` gains `main` `./dist/index.js`, `types` `./dist/index.d.ts`, and `exports` `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }` (the api-kit/wms convention). It also gains `build`: `tsc -p tsconfig.build.json`.
   - `apps/api/tsconfig.build.json`: `extends` `./tsconfig.json`, `compilerOptions` `{ rootDir: "src", outDir: "dist", noEmit: false, declaration: true }`, `include` `["src/**/*.ts"]`.
   - `dist/*.js` MUST sit at the same depth as `src/*.ts`, because `DEFAULT_MODULES_ROOT = new URL('../../../modules/', import.meta.url)` (`route-table.ts:82`) depends on it.
   - This diverges from api-kit/wms, which build with their own emitting tsconfig, because apps/api's tsconfig is `noEmit`. Record it in the CHANGELOG.
   - `pnpm start` and the Dockerfile CMD stay on tsx. The root `pnpm build` (Dockerfile:69) now also emits `apps/api/dist`, which is runtime-neutral.
   - `.gitignore:23` `dist/` covers it.
4. **No consumer rewiring here.** Tests import `../src/index.js`, which proves the public surface. Package-name resolution (`@pg-eos/api` via `exports` to `dist`) is proven in item (3), when `tests/scenarios` gains the dependency and ci.yml's `turbo run build --filter=@pg-eos/scenarios...` builds it through `^build`. No turbo.json change is needed.
5. **No new route, no contract change, no `ALL_ROUTES` change.** `server.test.ts` and `route-table.unit.test.ts` stay green unedited. They run on a DB with 0044 applied (`pgeos_x16`); the shared `pgeos` predates 0044.

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
- `apps/api/src/{index,host-routes,server}.ts`
- `apps/api/package.json`
- `apps/api/tsconfig.build.json`
- `apps/api/tests/**` and `apps/api/features/**`, pg-tester only

Never `apps/api/src/main.ts` or `route-table.ts`, `tests/scenarios/**`, `packages/**`, `.github/**`, `turbo.json` or CLAUDE.md.
Contract: none (no endpoint changes). Screen/Board spec: none. Migration number: none.

## RED tests
`apps/api/tests/public-entry.test.ts` (imports `../src/index.js`) · `apps/api/features/x-part-5d-p2-1.feature`

```gherkin
Feature: apps/api public entry (X part 5d part 2, item 1)
  Scenario: the public entry exports buildServer, buildRouteTable, hostRoutesFrom and isHostResult
  Scenario: isHostResult accepts { status: number, body } and refuses null, a string, { status: "200", body }, and { status } without body
  Scenario: hostRoutesFrom binds each mounted handler to its deps and returns its { status, body }
  Scenario: hostRoutesFrom throws when a handler returns no { status, body }
  Scenario: hostRoutesFrom indexes every mounted route by handler name (method + path) and throws on a duplicate handler name
  Scenario: buildServer({ routes: hostRoutesFrom(table).routes }) serves a mounted route with the stub handler's status and body
  Scenario: buildServer({ routes: mountedHostRoutes(table) }) with two routes sharing one handler name still starts and serves both
```

Deliver: the files above plus the RED file. Green:
- `apps/api` vitest on `PGDATABASE=pgeos_x16` (the existing `server.test.ts` and `route-table.unit.test.ts`, plus the new file);
- `pnpm --filter @pg-eos/api build`, emitting `dist/index.js` (not `dist/src/`);
- typecheck and root-level `pnpm exec eslint apps/api`;
- `bash scripts/check-locks.sh`.

Stop-and-ask if any of these happens:
- the package entry would need a change outside the Write ONLY list (root `.gitignore`, `turbo.json`, `tsconfig.base.json`);
- `server.ts` behaviour would change for any existing test.

Pre-build review round 1 (pg-reviewer opus): FAIL(4 blocking, 3 nits), all applied here:
- the build rootDir is `src`, keeping dist at src depth;
- tests import `../src/index.js`, not the package self-name;
- `mountedHostRoutes` and `hostRoutesFrom` are split so the host never throws on a duplicate;
- `apps/api/features/**` is in Write ONLY;
- `host-routes.ts` avoids a barrel cycle;
- `HostRouteRef` and the type exports are named;
- `exports` uses `default`.
