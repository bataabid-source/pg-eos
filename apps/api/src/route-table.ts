// apps/api/src/route-table.ts — X part 5a (ADR-0006 §1, §4). ALL_ROUTES → handlers, one-to-one,
// from the registry itself (no second routing table).
//
// Convention: `/<module>/<use-case>/<operation>` is served by
// `modules/<module>/api/<use-case>/handlers` exporting `handle<Operation>` — or `handle<UseCase>`
// for the verb-prefix operations — with deps from `composition`'s `create<UseCase>Deps`, built once
// here and holding no request state. Every inconsistency is a startup error, never a silent skip.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { problem, type ApiFailure, type ApiRequest } from '@pg-eos/api-kit';
import type { HttpMethod } from '@pg-eos/contracts';
import { SystemClock, UuidGenerator, type Clock, type IdGenerator } from '@pg-eos/domain-kit';

import { HTTP_STATUS_NOT_IMPLEMENTED } from './http-status.js';

/** ADR-0006 §4: registered without a handler — 501 until their rows are built. The mark belongs in
 *  the registry (`packages/contracts`, frozen for this part); it lives here until the Master moves it. */
export const UNIMPLEMENTED_ROUTES = [
  '/billing/dimensions/create-dimension-value',
  '/billing/dimensions/deactivate-dimension-value',
] as const;

/** ADR-0006 consequences: the login endpoints are not mounted until 2.16 part 1a-5 (G-16a limits)
 *  is DONE (modules/identity/api/otp-login/handlers.ts "NOT FOR MOUNTING YET"). */
export const NOT_MOUNTED_UNTIL_2_16_PART_1A_5 = [
  '/identity/otp-login/request-otp-code',
  '/identity/otp-login/verify-otp-code',
] as const;

/** The route shape the table reads — a subset of `RouteContract`. */
export interface RouteInput {
  readonly method: HttpMethod;
  readonly path: string;
}

export interface RouteSegments {
  readonly module: string;
  readonly useCase: string;
  readonly operation: string;
}

export interface DepsInput {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type ModuleHandler = (request: ApiRequest<unknown>, deps: unknown) => Promise<unknown>;
type DepsFactory = (input: DepsInput) => unknown;

export interface MountedRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handlerName: string;
  readonly handler: ModuleHandler;
  readonly deps: unknown;
}

export interface UnimplementedRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly problem: ApiFailure;
}

export interface RouteTable {
  readonly mounted: MountedRoute[];
  readonly unimplemented: UnimplementedRoute[];
}

export interface BuildRouteTableOptions {
  /** Root of the `modules/` tree (a directory URL ending in `/`). */
  readonly modulesRoot?: URL;
  /** Composition inputs; default: one SystemClock and one UuidGenerator for the whole host. */
  readonly depsInput?: DepsInput;
}

/** apps/api/src → the repository's `modules/` tree. */
export const DEFAULT_MODULES_ROOT = new URL('../../../modules/', import.meta.url);

const PATH_SEGMENT_COUNT = 3;
const HANDLER_PREFIX = 'handle';
const DEPS_FACTORY_PREFIX = 'create';
const DEPS_FACTORY_SUFFIX = 'Deps';
/** Source first (tsx / vitest run from source), then emitted JavaScript. */
const MODULE_FILE_EXTENSIONS = ['.ts', '.js'] as const;

export function segmentsOf(path: string): RouteSegments {
  const parts = path.split('/').filter((part) => part.length > 0);
  const [module, useCase, operation] = parts;
  if (parts.length !== PATH_SEGMENT_COUNT || !module || !useCase || !operation) {
    throw new Error(`route ${path}: expected /<module>/<use-case>/<operation>`);
  }
  return { module, useCase, operation };
}

function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** `handle<Operation>` first, then `handle<UseCase>` (the verb-prefix operations). */
export function handlerNamesFor(segments: RouteSegments): readonly string[] {
  const names = [`${HANDLER_PREFIX}${pascalCase(segments.operation)}`, `${HANDLER_PREFIX}${pascalCase(segments.useCase)}`];
  return [...new Set(names)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isModuleHandler(value: unknown): value is ModuleHandler {
  return typeof value === 'function';
}

function isDepsFactory(value: unknown): value is DepsFactory {
  return typeof value === 'function';
}

function includesPath(list: readonly string[], path: string): boolean {
  return list.includes(path);
}

/** The existing source file `<dir><base>.ts|.js`, or undefined. */
function findModuleFile(dir: URL, base: string): URL | undefined {
  for (const extension of MODULE_FILE_EXTENSIONS) {
    const candidate = new URL(`${base}${extension}`, dir);
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return undefined;
}

async function importModule(file: URL, route: RouteInput): Promise<Record<string, unknown>> {
  let loaded: unknown;
  try {
    loaded = await import(file.href);
  } catch (error) {
    throw new Error(`route ${route.method} ${route.path}: cannot load ${file.href}`, { cause: error });
  }
  if (!isRecord(loaded)) {
    throw new Error(`route ${route.method} ${route.path}: ${file.href} is not a module namespace`);
  }
  return loaded;
}

function unimplementedProblem(route: RouteInput): ApiFailure {
  return problem(
    HTTP_STATUS_NOT_IMPLEMENTED,
    'Not Implemented',
    `${route.method} ${route.path} is registered but its handler is not built yet (ADR-0006 §4).`,
  );
}

function notMountedProblem(route: RouteInput): ApiFailure {
  return problem(
    HTTP_STATUS_NOT_IMPLEMENTED,
    'Not Implemented',
    `${route.method} ${route.path} is not mounted until 2.16 part 1a-5 (G-16a limits) is done.`,
  );
}

/**
 * Resolves every route to its handler or to a 501. Throws (startup fails) when a route outside
 * UNIMPLEMENTED_ROUTES has no handlers file, when a listed route HAS one, when a handlers or
 * composition file fails to load, when `create<UseCase>Deps` is missing, or when no handler name
 * resolves — the route is always named in the error.
 */
export async function buildRouteTable(
  routes: readonly RouteInput[],
  options: BuildRouteTableOptions = {},
): Promise<RouteTable> {
  const modulesRoot = options.modulesRoot ?? DEFAULT_MODULES_ROOT;
  const depsInput = options.depsInput ?? { clock: new SystemClock(), ids: new UuidGenerator() };
  const depsByUseCase = new Map<string, unknown>();
  const mounted: MountedRoute[] = [];
  const unimplemented: UnimplementedRoute[] = [];

  for (const route of routes) {
    const segments = segmentsOf(route.path);

    if (includesPath(NOT_MOUNTED_UNTIL_2_16_PART_1A_5, route.path)) {
      unimplemented.push({ method: route.method, path: route.path, problem: notMountedProblem(route) });
      continue;
    }

    const useCaseDir = new URL(`${segments.module}/api/${segments.useCase}/`, modulesRoot);
    const handlersFile = findModuleFile(useCaseDir, 'handlers');

    if (includesPath(UNIMPLEMENTED_ROUTES, route.path)) {
      if (handlersFile) {
        throw new Error(
          `route ${route.method} ${route.path} is listed in UNIMPLEMENTED_ROUTES but ${handlersFile.href} exists — remove it from the list`,
        );
      }
      unimplemented.push({ method: route.method, path: route.path, problem: unimplementedProblem(route) });
      continue;
    }

    if (!handlersFile) {
      throw new Error(`route ${route.method} ${route.path}: no handlers file under ${useCaseDir.href}`);
    }
    const handlers = await importModule(handlersFile, route);
    const candidates = handlerNamesFor(segments);
    const handlerName = candidates.find((name) => isModuleHandler(handlers[name]));
    const handler = handlerName === undefined ? undefined : handlers[handlerName];
    if (handlerName === undefined || !isModuleHandler(handler)) {
      throw new Error(
        `route ${route.method} ${route.path}: ${handlersFile.href} exports none of ${candidates.join(', ')}`,
      );
    }

    const depsKey = `${segments.module}/${segments.useCase}`;
    if (!depsByUseCase.has(depsKey)) {
      depsByUseCase.set(depsKey, await createDeps(useCaseDir, segments, route, depsInput));
    }
    mounted.push({ method: route.method, path: route.path, handlerName, handler, deps: depsByUseCase.get(depsKey) });
  }

  return { mounted, unimplemented };
}

async function createDeps(
  useCaseDir: URL,
  segments: RouteSegments,
  route: RouteInput,
  depsInput: DepsInput,
): Promise<unknown> {
  const compositionFile = findModuleFile(useCaseDir, 'composition');
  if (!compositionFile) {
    throw new Error(`route ${route.method} ${route.path}: no composition file under ${useCaseDir.href}`);
  }
  const composition = await importModule(compositionFile, route);
  const factoryName = `${DEPS_FACTORY_PREFIX}${pascalCase(segments.useCase)}${DEPS_FACTORY_SUFFIX}`;
  const factory = composition[factoryName];
  if (!isDepsFactory(factory)) {
    throw new Error(`route ${route.method} ${route.path}: ${compositionFile.href} does not export ${factoryName}`);
  }
  return factory(depsInput);
}
