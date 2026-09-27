// apps/api/tests/route-table.unit.test.ts — X part 5a (brief
// `docs/notes/slice-briefs/_slice-X-part-5a.brief.md`, "Tests" section).
//
// RED, and why it is the right RED: `apps/api/src/route-table.ts` does not exist yet — the import
// below fails to resolve, which is the same class of RED WBS 0.11/0.12/2.9 already established in
// this repo (see packages/identity/tests/session.test.ts's own header).
//
// `ALL_ROUTES` is imported from `@pg-eos/contracts` (exported by the Master pre-task of X part 5a).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

// The real, frozen contract — proves module-path resolution against the actual `modules/` tree.
import { ALL_ROUTES } from '@pg-eos/contracts';
// The module under test — does not exist yet. This is the RED.
import {
  buildRouteTable,
  handlerNamesFor,
  NOT_MOUNTED_UNTIL_2_16_PART_1A_5,
  segmentsOf,
  UNIMPLEMENTED_ROUTES,
} from '../src/route-table.js';

// apps/api/src -> ../../../modules/ resolves to the repo-root modules/ tree (brief, "Run mode").
// apps/api/tests is the same depth under apps/api/, so the identical relative literal reaches the
// same directory from this file.
const DEFAULT_MODULES_ROOT = new URL('../../../modules/', import.meta.url);

const EXPECTED_UNIMPLEMENTED_ROUTES = [
  '/billing/accounting-periods/create-fiscal-year',
  '/billing/accounting-periods/open-period',
  '/billing/accounting-periods/close-period',
  '/billing/accounting-periods/lock-period',
  '/billing/accounting-periods/reopen-period',
  '/billing/dimensions/create-dimension-value',
  '/billing/dimensions/deactivate-dimension-value',
  '/billing/post-journal/post-journal',
  '/billing/post-journal/reverse-journal',
  '/billing/post-journal/adjust-journal',
] as const;

const EXPECTED_NOT_MOUNTED_ROUTES = [
  '/identity/otp-login/request-otp-code',
  '/identity/otp-login/verify-otp-code',
] as const;

// Route counts fixed by the brief's "Facts the Master verified": 82 total (78 POST + 4 GET), 10 +
// 2 = 12 answer 501, so 70 are mounted on a real handler.
const EXPECTED_TOTAL_ROUTE_COUNT = 82;
const EXPECTED_UNIMPLEMENTED_COUNT = 12;
const EXPECTED_MOUNTED_COUNT = 70;

const tempDirsToClean: string[] = [];

afterAll(() => {
  for (const dir of tempDirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Feature: X part 5a — one host serves every registered operation', () => {
  it('the route table is complete and one-to-one', async () => {
    // The real ALL_ROUTES fixture itself matches the brief's verified facts — asserted first so a
    // failure here points at a drifted contracts package, not at buildRouteTable.
    expect(ALL_ROUTES).toHaveLength(EXPECTED_TOTAL_ROUTE_COUNT);

    const table = await buildRouteTable(ALL_ROUTES, { modulesRoot: DEFAULT_MODULES_ROOT });

    // "every entry of ALL_ROUTES is mounted exactly once on its method and path"
    expect(table.mounted.length + table.unimplemented.length).toBe(EXPECTED_TOTAL_ROUTE_COUNT);
    const seenKeys = new Set<string>();
    for (const entry of [...table.mounted, ...table.unimplemented]) {
      const key = `${entry.method} ${entry.path}`;
      expect(seenKeys.has(key)).toBe(false);
      seenKeys.add(key);
    }
    for (const route of ALL_ROUTES) {
      expect(seenKeys.has(`${route.method} ${route.path}`)).toBe(true);
    }

    // "the entries mounted on a handler number 70 and each resolves to an exported handle* function"
    expect(table.mounted).toHaveLength(EXPECTED_MOUNTED_COUNT);
    for (const entry of table.mounted) {
      expect(entry.handlerName).toMatch(/^handle[A-Z]/);
      expect(typeof entry.handler).toBe('function');
    }

    // "the 501 entries are exactly the 10 UNIMPLEMENTED_ROUTES plus the 2
    // NOT_MOUNTED_UNTIL_2_16_PART_1A_5 routes"
    expect(UNIMPLEMENTED_ROUTES).toHaveLength(10);
    expect([...UNIMPLEMENTED_ROUTES].sort()).toEqual([...EXPECTED_UNIMPLEMENTED_ROUTES].sort());
    expect(NOT_MOUNTED_UNTIL_2_16_PART_1A_5).toHaveLength(2);
    expect([...NOT_MOUNTED_UNTIL_2_16_PART_1A_5].sort()).toEqual([...EXPECTED_NOT_MOUNTED_ROUTES].sort());
    expect(table.unimplemented).toHaveLength(EXPECTED_UNIMPLEMENTED_COUNT);
    const unimplementedPaths = table.unimplemented.map((entry) => entry.path).sort();
    const expectedPaths = [...EXPECTED_UNIMPLEMENTED_ROUTES, ...EXPECTED_NOT_MOUNTED_ROUTES].sort();
    expect(unimplementedPaths).toEqual(expectedPaths);

    // "a route whose handler cannot be resolved makes startup fail with the route in the error"
    const fakeRoute = {
      method: 'POST' as const,
      path: '/nope/not-a-real-module/thing',
      summary: 'fixture: a route with no matching modules/ tree entry',
      responses: { 200: { description: 'ok' } },
    };
    await expect(buildRouteTable([fakeRoute], { modulesRoot: DEFAULT_MODULES_ROOT })).rejects.toThrow(
      /\/nope\/not-a-real-module\/thing/,
    );

    // "a listed unimplemented route that has a handlers.js makes startup fail"
    const fixtureModulesRoot = writeListedUnimplementedWithHandlerFixture();
    const listedUnimplementedRoute = {
      method: 'POST' as const,
      path: '/billing/accounting-periods/create-fiscal-year',
      summary: 'fixture: a route the real UNIMPLEMENTED_ROUTES constant lists, given a handlers.js',
      responses: { 200: { description: 'ok' } },
    };
    await expect(
      buildRouteTable([listedUnimplementedRoute], { modulesRoot: fixtureModulesRoot }),
    ).rejects.toThrow(/\/billing\/accounting-periods\/create-fiscal-year/);

    // HEAD-route assertion (exposeHeadRoutes: false) deferred to backlog row `X part 5a part 2`:
    // as written in round 2 it ran before app.ready(), so it could not fail (close review, nit 1).
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

/** A temporary modulesRoot fixture: `billing/api/accounting-periods/handlers.js` (+
 *  `composition.js`) present on disk, even though `/billing/accounting-periods/create-fiscal-year`
 *  is one of the real, frozen `UNIMPLEMENTED_ROUTES` — exactly the contradiction the brief's
 *  startup rule rejects ("a listed route HAS a handlers.js"). Written to an OS temp dir (never
 *  under `modules/**`, out of pg-tester's write scope) and cleaned up in `afterAll`. */
function writeListedUnimplementedWithHandlerFixture(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'pg-eos-route-table-fixture-'));
  tempDirsToClean.push(dir);
  const useCaseDir = join(dir, 'billing', 'api', 'accounting-periods');
  mkdirSync(useCaseDir, { recursive: true });
  const handlersSource = [
    'export async function handleCreateFiscalYear() {',
    '  return { status: 200, body: {} };',
    '}',
    '',
  ].join('\n');
  const compositionSource = ['export function createAccountingPeriodsDeps() {', '  return {};', '}', ''].join('\n');
  writeFileSync(join(useCaseDir, 'handlers.ts'), handlersSource, 'utf8');
  writeFileSync(join(useCaseDir, 'composition.ts'), compositionSource, 'utf8');
  return pathToFileURL(`${dir}/`);
}
