// apps/api/src/host-routes.ts — X part 5d part 2, item (1). The route-table → HostRoute builder.
//
// `mountedHostRoutes` is the host's own map (server.ts uses it; it never throws on a duplicate
// handler name, because `handlerNamesFor`'s `handle<UseCase>` fallback makes a collision legal in
// the production table). `hostRoutesFrom` is for external callers only: the same routes plus a
// handler-name index, and it throws on a handler name mounted on two routes.
// The HostRoute/HostResult types come from server.ts as type-only imports — no runtime cycle.

import type { HttpMethod } from '@pg-eos/contracts';

import type { RouteTable } from './route-table.js';
import type { HostResult, HostRoute } from './server.js';

/** Where one handler is mounted. */
export interface HostRouteRef {
  readonly method: HttpMethod;
  readonly path: string;
}

export function isHostResult(value: unknown): value is HostResult {
  return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'number' && 'body' in value;
}

/** Every mounted entry as a HostRoute: the handler bound to its deps, its result checked. */
export function mountedHostRoutes(table: RouteTable): HostRoute[] {
  return table.mounted.map((entry): HostRoute => ({
    method: entry.method,
    path: entry.path,
    handler: async (request) => {
      const result = await entry.handler(request, entry.deps);
      if (!isHostResult(result)) {
        throw new Error(`handler ${entry.handlerName} for ${entry.path} returned no { status, body }`);
      }
      return result;
    },
  }));
}

/** `mountedHostRoutes` plus a handler-name → route index. Throws on a handler name mounted twice. */
export function hostRoutesFrom(table: RouteTable): {
  routes: HostRoute[];
  routeByHandlerName: ReadonlyMap<string, HostRouteRef>;
} {
  const routeByHandlerName = new Map<string, HostRouteRef>();
  for (const entry of table.mounted) {
    const existing = routeByHandlerName.get(entry.handlerName);
    if (existing) {
      throw new Error(
        `handler ${entry.handlerName} is mounted on both ${existing.method} ${existing.path} and ${entry.method} ${entry.path}`,
      );
    }
    routeByHandlerName.set(entry.handlerName, { method: entry.method, path: entry.path });
  }
  return { routes: mountedHostRoutes(table), routeByHandlerName };
}
