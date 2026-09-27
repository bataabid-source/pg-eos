// apps/api/tests/route-table.unit.test.ts — X part 12 (a)+(b), revision 3
// (docs/notes/slice-briefs/_slice-X-part-12.brief.md, decision 5 "tests derive, never pin").
//
// RED, and why it is the right RED (three, and only three, reasons — brief revision 3):
//   1. `BuildRouteTableOptions` does not yet accept a `logger` option — the mounted-with-warning
//      fixture case below either fails typechecking (tsc, run separately) or, at runtime, never
//      calls the logger (its `calls` array stays empty) because `buildRouteTable` does not read it.
//   2. A `contractFirst` route with no handlers file is not yet resolved to a 501 by mark: today
//      `buildRouteTable` only special-cases the hardcoded `UNIMPLEMENTED_ROUTES` list, so a fixture
//      route that is `contractFirst` but NOT in that list throws "no handlers file" instead of
//      producing a 501 `unimplemented` entry.
//   3. `UNIMPLEMENTED_ROUTES` still exists and still drives the real ALL_ROUTES 501 set today (it
//      happens to coincide with the derived contractFirst-based set for the current billing
//      routes) — this file no longer imports it; once the builder deletes it, only the mark +
//      filesystem rule remains, and every assertion below stays true unchanged.
//
// Every expectation below is DERIVED from `ALL_ROUTES` (the real, frozen registry) and the real
// `modules/` file system — never a literal 10 / 12 / 70 / 82 (brief decision 5).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

// The real, frozen contract — proves module-path resolution against the actual `modules/` tree.
import { ALL_ROUTES, type RouteDefinitionInput } from '@pg-eos/contracts';
// The module under test. `UNIMPLEMENTED_ROUTES` is deliberately NOT imported: the builder deletes
// it (brief decision 1) — a test that still imported it would silently keep it alive.
import { buildRouteTable, handlerNamesFor, NOT_MOUNTED_UNTIL_2_16_PART_1A_5, segmentsOf } from '../src/route-table.js';
// buildServer is the real Fastify host (server.ts) — needed only for the HEAD-route assertion
// below, which exercises the actual `exposeHeadRoutes: false` option, not the pure route table.
import { buildServer } from '../src/server.js';

// apps/api/src -> ../../../modules/ resolves to the repo-root modules/ tree (brief, "Run mode").
// apps/api/tests is the same depth under apps/api/, so the identical relative literal reaches the
// same directory from this file.
const DEFAULT_MODULES_ROOT = new URL('../../../modules/', import.meta.url);

// The two extensions `buildRouteTable`'s own `findModuleFile` looks for, source first (route-
// table.ts's own header comment) — used here only to DERIVE which routes have a handlers file on
// disk right now, never to pin a count.
const HANDLER_FILE_EXTENSIONS = ['ts', 'js'] as const;

// The GET route the HEAD-route assertion below probes (apps/api/features/x-part-5a.feature,
// "the route table is complete and one-to-one"; ADR-0006 one-to-one).
const SUGGEST_LOCATION_PATH = '/wms/receive-inbound/suggest-location';

// The fixture path used by every temp-modules-root case below — outside the real modules/ tree,
// so it can never collide with a real, contract-fixed path.
const FIXTURE_ROUTE_PATH = '/fixture/unbuilt/do-thing';

const tempDirsToClean: string[] = [];

afterAll(() => {
  for (const dir of tempDirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** True when `modules/<module>/api/<use-case>/handlers.(ts|js)` exists under `modulesRoot`, the
 * same resolution `buildRouteTable` itself performs — read independently here (never imported
 * from `../src/route-table.ts`) so this is a genuine derivation from the file system, not a
 * restatement of the implementation under test. */
function hasHandlersFile(path: string, modulesRoot: URL): boolean {
  const { module, useCase } = segmentsOf(path);
  return HANDLER_FILE_EXTENSIONS.some((extension) =>
    existsSync(fileURLToPath(new URL(`${module}/api/${useCase}/handlers.${extension}`, modulesRoot))),
  );
}

/** The 501 set (brief decision 5): every `contractFirst` route of `routes` with no handlers file
 * on disk, plus the fixed `NOT_MOUNTED_UNTIL_2_16_PART_1A_5` list (held regardless of any
 * handlers file — the real `identity/otp-login` use case already has one). */
function expectedUnimplementedPaths(routes: readonly RouteDefinitionInput[], modulesRoot: URL): string[] {
  const contractFirstMissingHandler = routes
    .filter((route) => route.contractFirst === true && !hasHandlersFile(route.path, modulesRoot))
    .map((route) => route.path);
  return [...contractFirstMissingHandler, ...NOT_MOUNTED_UNTIL_2_16_PART_1A_5];
}

/** A pino-compatible capturing logger (`BuildRouteTableOptions.logger`, brief decision 2) — records
 * every call's arguments so a test can assert on how many warnings fired and what they named,
 * without pinning pino's own call shape. */
interface CapturingLogger {
  readonly calls: readonly unknown[][];
  warn(...args: unknown[]): void;
}

function createCapturingLogger(): CapturingLogger {
  const calls: unknown[][] = [];
  return {
    calls,
    warn(...args: unknown[]) {
      calls.push(args);
    },
  };
}

/** A fresh, empty temp `modules/` root — no `fixture/api/unbuilt/` directory at all, so
 * `FIXTURE_ROUTE_PATH` resolves to "no handlers file" no matter how it is marked. */
function emptyFixtureModulesRoot(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'pg-eos-route-table-x-part-12-empty-'));
  tempDirsToClean.push(dir);
  return pathToFileURL(`${dir}/`);
}

/** A temp `modules/` root with `fixture/api/unbuilt/{handlers,composition}.ts` present, exporting
 * exactly what `FIXTURE_ROUTE_PATH` resolves to via `handlerNamesFor`/`createDeps`'s own naming
 * rule (`handle<Operation>`, `create<UseCase>Deps`). */
function fixtureModulesRootWithHandlers(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'pg-eos-route-table-x-part-12-built-'));
  tempDirsToClean.push(dir);
  const useCaseDir = join(dir, 'fixture', 'api', 'unbuilt');
  mkdirSync(useCaseDir, { recursive: true });
  writeFileSync(
    join(useCaseDir, 'handlers.ts'),
    ['export async function handleDoThing() {', '  return { status: 200, body: {} };', '}', ''].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(useCaseDir, 'composition.ts'),
    ['export function createUnbuiltDeps() {', '  return {};', '}', ''].join('\n'),
    'utf8',
  );
  return pathToFileURL(`${dir}/`);
}

describe('Feature: X part 12 (a)+(b) — the 501 set and the mounted count are derived, never pinned', () => {
  it('the real ALL_ROUTES builds with no startup error, and every 501 route is contractFirst-without-handler or held until 2.16 part 1a-5', async () => {
    const table = await buildRouteTable(ALL_ROUTES, { modulesRoot: DEFAULT_MODULES_ROOT });

    // "every entry of ALL_ROUTES is mounted exactly once on its method and path"
    expect(table.mounted.length + table.unimplemented.length).toBe(ALL_ROUTES.length);
    const seenKeys = new Set<string>();
    for (const entry of [...table.mounted, ...table.unimplemented]) {
      const key = `${entry.method} ${entry.path}`;
      expect(seenKeys.has(key)).toBe(false);
      seenKeys.add(key);
    }
    for (const route of ALL_ROUTES) {
      expect(seenKeys.has(`${route.method} ${route.path}`)).toBe(true);
    }

    // "the entries mounted on a handler ... each resolves to an exported handle* function" — the
    // mounted count itself is derived (|ALL_ROUTES| minus the derived 501 set), never a literal.
    const expectedUnimplemented = expectedUnimplementedPaths(ALL_ROUTES, DEFAULT_MODULES_ROOT);
    expect(table.mounted.length).toBe(ALL_ROUTES.length - expectedUnimplemented.length);
    for (const entry of table.mounted) {
      expect(entry.handlerName).toMatch(/^handle[A-Z]/);
      expect(typeof entry.handler).toBe('function');
    }

    // "the 501 set ... is derived from the registry and the file system, never pinned"
    const unimplementedPaths = table.unimplemented.map((entry) => entry.path).sort();
    expect(unimplementedPaths).toEqual([...expectedUnimplemented].sort());

    // Every entry the host answers 501 for is either a contractFirst route with no handlers file,
    // or one of the two held otp-login routes — ADR-0006 §4 / brief decision 2, checked entry by
    // entry (not just as an aggregate count).
    const routesByPath = new Map(ALL_ROUTES.map((route) => [route.path, route]));
    for (const path of unimplementedPaths) {
      const isHeld = includesHeldPath(path);
      const route = routesByPath.get(path);
      const isContractFirstWithoutHandler =
        route !== undefined && route.contractFirst === true && !hasHandlersFile(path, DEFAULT_MODULES_ROOT);
      expect(isHeld || isContractFirstWithoutHandler).toBe(true);
    }
  });

  it('a route whose handler cannot be resolved makes startup fail with the route in the error', async () => {
    const fakeRoute = {
      method: 'POST' as const,
      path: '/nope/not-a-real-module/thing',
      summary: 'fixture: a route with no matching modules/ tree entry',
      responses: { 200: { description: 'ok' } },
    };
    await expect(buildRouteTable([fakeRoute], { modulesRoot: DEFAULT_MODULES_ROOT })).rejects.toThrow(
      /\/nope\/not-a-real-module\/thing/,
    );
  });

  // "a GET route's HEAD counterpart is never auto-exposed" (exposeHeadRoutes: false, server.ts —
  // ADR-0006 one-to-one). Built through the real buildServer host (not buildRouteTable directly)
  // because exposeHeadRoutes is a Fastify constructor option, not something the pure route table
  // can express. app.ready() is required first: the route table mounts inside an async
  // `app.register(...)` plugin (server.ts), so hasRoute() reports every route — including the
  // control GET below — as absent until the plugin has actually run. The GET control assertion
  // runs first so a regression that reintroduces the "runs before app.ready()" bug fails loudly
  // here (both assertions false) instead of the HEAD assertion trivially passing on its own.
  it("a GET route's HEAD counterpart is never auto-exposed", async () => {
    const headProbeApp = buildServer({ modulesRoot: DEFAULT_MODULES_ROOT });
    await headProbeApp.ready();
    expect(headProbeApp.hasRoute({ method: 'GET', url: SUGGEST_LOCATION_PATH })).toBe(true);
    expect(headProbeApp.hasRoute({ method: 'HEAD', url: SUGGEST_LOCATION_PATH })).toBe(false);
  });
});

/** `path` is one of the two fixed, always-held otp-login paths (brief decision 1 — held
 * regardless of any handlers file that already exists for them). */
function includesHeldPath(path: string): boolean {
  return NOT_MOUNTED_UNTIL_2_16_PART_1A_5.includes(path as (typeof NOT_MOUNTED_UNTIL_2_16_PART_1A_5)[number]);
}

describe('Scenario: A contract-first route without a handler answers 501 to a valid session (fixture a)', () => {
  it('a contractFirst route with no handlers file on disk produces a 501 unimplemented entry naming the route', async () => {
    const modulesRoot = emptyFixtureModulesRoot();
    const route: RouteDefinitionInput = {
      method: 'POST',
      path: FIXTURE_ROUTE_PATH,
      summary: 'fixture: contractFirst, no handlers file',
      contractFirst: true,
      responses: { 200: { description: 'OK' } },
    };

    const table = await buildRouteTable([route], { modulesRoot });

    expect(table.mounted).toHaveLength(0);
    expect(table.unimplemented).toHaveLength(1);
    expect(table.unimplemented[0]?.path).toBe(FIXTURE_ROUTE_PATH);
    expect(table.unimplemented[0]?.problem.body.detail).toContain(FIXTURE_ROUTE_PATH);
  });
});

describe('Scenario: A contract-first route whose handler exists is mounted and served, with one startup warning (fixture b)', () => {
  it('a contractFirst route with a handlers file is mounted, and the logger receives exactly one warn naming it', async () => {
    const modulesRoot = fixtureModulesRootWithHandlers();
    const route: RouteDefinitionInput = {
      method: 'POST',
      path: FIXTURE_ROUTE_PATH,
      summary: 'fixture: contractFirst, handlers file present',
      contractFirst: true,
      responses: { 200: { description: 'OK' } },
    };
    const logger = createCapturingLogger();

    const table = await buildRouteTable([route], { modulesRoot, logger });

    expect(table.unimplemented).toHaveLength(0);
    expect(table.mounted).toHaveLength(1);
    expect(table.mounted[0]?.path).toBe(FIXTURE_ROUTE_PATH);
    expect(logger.calls).toHaveLength(1);
    expect(JSON.stringify(logger.calls[0])).toContain(FIXTURE_ROUTE_PATH);
  });
});

describe('Scenario: An unmarked route without a handler makes startup fail, naming the route (fixture c)', () => {
  it('an unmarked route with no handlers file on disk rejects, naming the route', async () => {
    const modulesRoot = emptyFixtureModulesRoot();
    const route: RouteDefinitionInput = {
      method: 'POST',
      path: FIXTURE_ROUTE_PATH,
      summary: 'fixture: unmarked, no handlers file',
      responses: { 200: { description: 'OK' } },
    };

    await expect(buildRouteTable([route], { modulesRoot })).rejects.toThrow(
      new RegExp(FIXTURE_ROUTE_PATH.replace(/\//g, '\\/')),
    );
  });
});

describe('segmentsOf — pure path parsing (apps/api/src/route-table.ts deliverable)', () => {
  it('splits a three-segment path into module, use case and operation', () => {
    expect(segmentsOf('/wms/receive-inbound/approve-inbound')).toEqual({
      module: 'wms',
      useCase: 'receive-inbound',
      operation: 'approve-inbound',
    });
    expect(segmentsOf('/billing/post-journal/post-journal')).toEqual({
      module: 'billing',
      useCase: 'post-journal',
      operation: 'post-journal',
    });
  });
});

describe('handlerNamesFor — the handle<Operation> then handle<UseCase> naming rule (brief, "Facts the Master verified")', () => {
  it('tries handle<Operation> first for an ordinary route', () => {
    const names = handlerNamesFor(segmentsOf('/wms/receive-inbound/approve-inbound'));
    expect(names[0]).toBe('handleApproveInbound');
  });

  it('offers handle<UseCase> as the fallback candidate for the 5 verb-prefix operations named in the brief', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/imile/assign-driver-id/assign', 'handleAssignDriverId'],
      ['/imile/evaluate-dtl-problem/evaluate', 'handleEvaluateDtlProblem'],
      ['/imile/pull-shipments/pull', 'handlePullShipments'],
      ['/imile/report-agent-health/report', 'handleReportAgentHealth'],
      ['/wms/schedule-inbound/schedule', 'handleScheduleInbound'],
    ];
    for (const [path, expectedFallback] of cases) {
      const names = handlerNamesFor(segmentsOf(path));
      expect(names).toContain(expectedFallback);
    }
  });
});
