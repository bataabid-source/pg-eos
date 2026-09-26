// fix/domain-kit-browser — pg-tester. Design (Master): packages/domain-kit/package.json has a
// `browser` condition in `exports["."]` pointing at a browser entry (index.browser.ts ->
// dist/index.browser.js) that re-exports everything EXCEPT id-generator.ts; the server keeps the
// full dist/index.js (Money, Quantity, Clock AND IdGenerator). No importer changes; Vite resolves
// the `browser` condition for apps/admin and apps/pda.
//
// This test walks TypeScript SOURCE files, never `dist/`: turbo's test step does not build the
// package first, so a fresh clone has no dist/ and reading it there would ENOENT (and locally it
// would silently pass against a stale, previously-built dist). The browser entry's *specifier*
// is still taken from package.json's `exports["."].browser` (the single source of truth for
// which file is the browser entry) and mapped from its dist/…js form back to the .ts source.
//
// This test:
//   1. reads exports["."].browser from package.json — it must exist;
//   2. maps that dist-relative specifier to its .ts source file and walks its transitive
//      relative imports (also mapped dist-style './x.js' -> source './x.ts') within the package;
//   3. asserts none of those source files contain a `node:` specifier;
//   4. asserts the browser entry's transitive closure never declares UuidGenerator or
//      SequentialIdGenerator as an export (id-generator.ts must not be reachable from it);
//   5. asserts the node entry (exports["."].default / index.ts) DOES still declare both — the
//      server surface is unchanged.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(currentDir, '..');

const readPackageJson = (): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;

// A root export condition's value is either a plain specifier string (e.g. "./dist/index.js")
// or a nested conditions object (e.g. { types: "...", default: "./dist/index.browser.js" }) —
// package.json's exports map supports both shapes; this resolves either to the JS specifier.
const getExportsRootCondition = (
  pkg: Record<string, unknown>,
  condition: 'browser' | 'default',
): string | undefined => {
  const exportsField = pkg.exports as Record<string, unknown> | undefined;
  const rootExport = exportsField?.['.'] as Record<string, unknown> | undefined;
  const value = rootExport?.[condition];

  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    const nestedDefault = (value as Record<string, unknown>).default;
    return typeof nestedDefault === 'string' ? nestedDefault : undefined;
  }
  return undefined;
};

// Maps a dist-relative build specifier (e.g. "./dist/index.browser.js") to the absolute path of
// its .ts SOURCE file (e.g. "<packageDir>/index.browser.ts"). Source files live directly in the
// package root, mirroring dist/'s flat layout.
const distSpecifierToSourcePath = (distRelativeSpecifier: string): string => {
  const withoutDistPrefix = distRelativeSpecifier.replace(/^\.\/dist\//, './');
  const asSource = withoutDistPrefix.replace(/\.js$/, '.ts');
  return resolve(packageDir, asSource);
};

// Matches `from 'node:xxx'`, `from "node:xxx"`, and `require('node:xxx')` / `require("node:xxx")`.
const NODE_IMPORT_RE = /(?:from\s+|require\()\s*['"]node:[^'"]+['"]/;

// Matches relative ESM import/export specifiers as written in TypeScript SOURCE under this
// project's NodeNext convention — sources still use a trailing `.js` in the specifier (e.g.
// `export * from './money.js'`) even though the file on disk is `./money.ts`.
const RELATIVE_SPECIFIER_RE = /(?:from|export\s+\*\s+from)\s+['"](\.[^'"]+)['"]/g;

// Matches a named export declaration for one of id-generator.ts's two public classes.
const idGeneratorExportRe = (name: 'UuidGenerator' | 'SequentialIdGenerator'): RegExp =>
  new RegExp(`export\\s+class\\s+${name}\\b`);

/**
 * Follows relative import/export specifiers starting at `entryPath` (a .ts source file),
 * mapping each dist-style './x.js' specifier to its './x.ts' source sibling, within `baseDir`
 * only (never leaves the package root), and returns the transitive closure of source files
 * reached, keyed by absolute path.
 */
const collectTransitiveSourceModules = (entryPath: string, baseDir: string): Map<string, string> => {
  const visited = new Map<string, string>();
  const queue: string[] = [entryPath];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;

    const source = readFileSync(current, 'utf8');
    visited.set(current, source);

    for (const match of source.matchAll(RELATIVE_SPECIFIER_RE)) {
      const specifier = match[1];
      if (specifier === undefined) continue;

      const sourceSpecifier = specifier.replace(/\.js$/, '.ts');
      const resolved = resolve(dirname(current), sourceSpecifier);
      if (!resolved.startsWith(baseDir)) continue;
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  return visited;
};

describe('domain-kit package.json exports a browser entry', () => {
  it('exports["."].browser is declared and its source file exists', () => {
    const pkg = readPackageJson();
    const browserEntrySpecifier = getExportsRootCondition(pkg, 'browser');

    expect(browserEntrySpecifier).toBeDefined();

    const browserEntrySourcePath = distSpecifierToSourcePath(browserEntrySpecifier as string);
    expect(() => readFileSync(browserEntrySourcePath, 'utf8')).not.toThrow();
  });
});

describe('domain-kit browser entry — no node: imports', () => {
  it('the browser entry and every module it transitively imports contain no `node:` specifier', () => {
    const pkg = readPackageJson();
    const browserEntrySpecifier = getExportsRootCondition(pkg, 'browser');
    expect(browserEntrySpecifier).toBeDefined();

    const browserEntrySourcePath = distSpecifierToSourcePath(browserEntrySpecifier as string);
    const modules = collectTransitiveSourceModules(browserEntrySourcePath, packageDir);

    const offenders: string[] = [];
    for (const [filePath, source] of modules) {
      if (NODE_IMPORT_RE.test(source)) {
        offenders.push(filePath);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('domain-kit browser entry — no IdGenerator surface', () => {
  it('the browser entry never declares UuidGenerator or SequentialIdGenerator as an export', () => {
    const pkg = readPackageJson();
    const browserEntrySpecifier = getExportsRootCondition(pkg, 'browser');
    expect(browserEntrySpecifier).toBeDefined();

    const browserEntrySourcePath = distSpecifierToSourcePath(browserEntrySpecifier as string);
    const modules = collectTransitiveSourceModules(browserEntrySourcePath, packageDir);

    let exportsUuidGenerator = false;
    let exportsSequentialIdGenerator = false;
    for (const source of modules.values()) {
      if (idGeneratorExportRe('UuidGenerator').test(source)) exportsUuidGenerator = true;
      if (idGeneratorExportRe('SequentialIdGenerator').test(source)) exportsSequentialIdGenerator = true;
    }

    expect(exportsUuidGenerator).toBe(false);
    expect(exportsSequentialIdGenerator).toBe(false);
  });
});

describe('domain-kit node entry — IdGenerator surface unchanged', () => {
  it('the node entry (exports["."].default) still declares UuidGenerator and SequentialIdGenerator', () => {
    const pkg = readPackageJson();
    const nodeEntrySpecifier = getExportsRootCondition(pkg, 'default');
    expect(nodeEntrySpecifier).toBeDefined();

    const nodeEntrySourcePath = distSpecifierToSourcePath(nodeEntrySpecifier as string);
    const modules = collectTransitiveSourceModules(nodeEntrySourcePath, packageDir);

    let exportsUuidGenerator = false;
    let exportsSequentialIdGenerator = false;
    for (const source of modules.values()) {
      if (idGeneratorExportRe('UuidGenerator').test(source)) exportsUuidGenerator = true;
      if (idGeneratorExportRe('SequentialIdGenerator').test(source)) exportsSequentialIdGenerator = true;
    }

    expect(exportsUuidGenerator).toBe(true);
    expect(exportsSequentialIdGenerator).toBe(true);
  });
});

describe('domain-kit exports drift guard — node vs browser entry', () => {
  it('the browser entry exports exactly the node entry keys minus the IdGenerator classes', async () => {
    const nodeEntry: Record<string, unknown> = await import('../index.js');
    const browserEntry: Record<string, unknown> = await import('../index.browser.js');

    const idGeneratorRuntimeKeys = new Set(['UuidGenerator', 'SequentialIdGenerator']);
    const expectedBrowserKeys = Object.keys(nodeEntry)
      .filter((key) => !idGeneratorRuntimeKeys.has(key))
      .sort();
    const actualBrowserKeys = Object.keys(browserEntry).sort();

    expect(actualBrowserKeys).toEqual(expectedBrowserKeys);
  });
});
