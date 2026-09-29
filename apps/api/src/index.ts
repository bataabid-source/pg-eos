// apps/api/src/index.ts — X part 5d part 2, item (1). The public entry of @pg-eos/api (pure barrel).

export { buildServer } from './server.js';
export type { BuildServerOptions, HostResult, HostRoute } from './server.js';
export { buildRouteTable } from './route-table.js';
export type { BuildRouteTableOptions, DepsInput, MountedRoute, RouteTable } from './route-table.js';
export { hostRoutesFrom, isHostResult } from './host-routes.js';
export type { HostRouteRef } from './host-routes.js';
