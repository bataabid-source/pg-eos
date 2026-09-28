// tests/scenarios/fixtures/host.ts — X part 5d (ADR-0006 Decision 2: "S1 and S2 are rewired to call
// the host over HTTP in the same slice"). Builds the REAL Fastify host S1 now calls through
// `app.inject(...)` — mounted from `ALL_ROUTES` against the SAME `FixedClock` + seeded ids S1
// already used in-process (S1's expiry arithmetic is anchored to the fixed clock; DEFAULT taken —
// injected routes instead of the SystemClock `buildServer()` default, recorded in the slice brief).
// Authentication, entity scope and the handler contract still run through the host (apps/api/src/
// server.ts's onRequest pipeline) — nothing here re-implements them.
//
// Relative import of apps/api/src (same convention S18.spec.ts uses for modules/wms — a workspace
// package imported by its own file path, not through a tests/scenarios/package.json dependency).
//
// `routeFor` takes the imported handler FUNCTION ITSELF (e.g. `handleApproveInbound`), never a
// hand-typed path — it is looked up by the function's own `.name` against `MountedRoute.handlerName`
// (the same string route-table.ts resolved the export by). Keying by name, not by function identity,
// avoids requiring every concretely-typed module handler (its own specific body/deps types) to be
// structurally assignable to one generic `ModuleHandler` shape at the call site — the concrete
// handler is only ever called through the host's own wiring, never re-typed as `ModuleHandler` by a
// caller outside this file.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import { ALL_ROUTES, type HttpMethod } from '@pg-eos/contracts';

import { buildRouteTable } from '../../../apps/api/src/route-table.js';
import { buildServer, type HostResult, type HostRoute } from '../../../apps/api/src/server.js';

/** Identical to apps/api/src/server.ts:143-145's own `isHostResult` — a mounted handler's return
 *  is `unknown` until narrowed; the host itself never trusts a handler blindly, and neither do we. */
function isHostResult(value: unknown): value is HostResult {
  return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'number' && 'body' in value;
}

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
  /** The `ALL_ROUTES` method + path this exact handler function is mounted on — looked up from the
   *  route table itself, never a hand-typed string (brief: "Paths come from ALL_ROUTES ... looked
   *  up by the handler's route"). */
  readonly routeFor: (handler: NamedHandler) => ScenarioRoute;
}

/** One host per spec file, built once in `beforeAll` — same FixedClock and S1's seeded ids (the
 *  former process-outbound seed 91012 is folded into the single host generator — ADR-0006, one
 *  deps build per host), so the rewire changes only HOW the handler is invoked, never its inputs. */
export async function buildScenarioHost(clock: Clock, ids: IdGenerator): Promise<ScenarioHost> {
  const table = await buildRouteTable(ALL_ROUTES, { depsInput: { clock, ids } });

  const routeByHandlerName = new Map<string, ScenarioRoute>();
  const routes: HostRoute[] = table.mounted.map((entry) => {
    if (routeByHandlerName.has(entry.handlerName)) {
      throw new Error(`buildScenarioHost: handler name "${entry.handlerName}" is mounted on more than one route`);
    }
    routeByHandlerName.set(entry.handlerName, { method: entry.method, path: entry.path });
    return {
      method: entry.method,
      path: entry.path,
      handler: async (request) => {
        const result = await entry.handler(request, entry.deps);
        if (!isHostResult(result)) {
          throw new Error(`handler ${entry.handlerName} for ${entry.path} returned no { status, body }`);
        }
        return result;
      },
    };
  });

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
