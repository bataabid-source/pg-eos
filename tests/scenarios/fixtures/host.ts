// tests/scenarios/fixtures/host.ts — X part 5d (ADR-0006 Decision 2: "S1 and S2 are rewired to call
// the host over HTTP in the same slice"). Builds the REAL Fastify host S1/S2 call through
// `app.inject(...)` — mounted from `ALL_ROUTES` against the SAME `FixedClock` + seeded ids S1
// already used in-process (S1's expiry arithmetic is anchored to the fixed clock; DEFAULT taken —
// injected routes instead of the SystemClock `buildServer()` default, recorded in the slice brief).
// Authentication, entity scope and the handler contract still run through the host — nothing here
// re-implements them.
//
// Everything comes from the public entry of `@pg-eos/api` (buildServer, buildRouteTable,
// hostRoutesFrom): no relative import into apps/api/src, no duplicated result guard or route map.
//
// `routeFor` takes the imported handler FUNCTION ITSELF (e.g. `handleApproveInbound`), never a
// hand-typed path — it is looked up by the function's own `.name` against the handler-name index
// `hostRoutesFrom` builds (the same string route-table.ts resolved the export by).

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import { ALL_ROUTES, type HttpMethod } from '@pg-eos/contracts';
import { buildRouteTable, buildServer, hostRoutesFrom } from '@pg-eos/api';

/** Any exported handler function (`handleApproveInbound`, `handleReceiveLine`, ...) — only its
 *  `.name` is read, so a concretely-typed handler is always structurally accepted here. */
export interface NamedHandler {
  readonly name: string;
}

export interface ScenarioRoute {
  readonly method: HttpMethod;
  readonly path: string;
}

export interface ScenarioHost {
  /** The live Fastify instance — call `app.inject(...)`, then `await app.close()` in afterAll. */
  readonly app: ReturnType<typeof buildServer>;
  /** The `ALL_ROUTES` method + path this exact handler function is mounted on. */
  readonly routeFor: (handler: NamedHandler) => ScenarioRoute;
}

/** One host per spec file, built once in `beforeAll` — same FixedClock and S1's seeded ids. */
export async function buildScenarioHost(clock: Clock, ids: IdGenerator): Promise<ScenarioHost> {
  const table = await buildRouteTable(ALL_ROUTES, { depsInput: { clock, ids } });
  const { routes, routeByHandlerName } = hostRoutesFrom(table);

  const app = buildServer({ routes });
  await app.ready();

  const routeFor = (handler: NamedHandler): ScenarioRoute => {
    const found = routeByHandlerName.get(handler.name);
    if (!found) {
      throw new Error(`buildScenarioHost: no mounted route found for handler "${handler.name}" — check the imported handler function`);
    }
    return found;
  };

  return { app, routeFor };
}
