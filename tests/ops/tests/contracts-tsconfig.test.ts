// tests/ops/tests/contracts-tsconfig.test.ts — WBS X part 23 (pg-tester).
//
// Proves packages/contracts/tsconfig.json includes every contract module, against
// tests/ops/contracts-tsconfig.feature. One `it` per Gherkin Scenario, titled verbatim. Read-only.
//
// No `any`, no eslint-disable, no console.*.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTRACTS = path.join(ROOT, 'packages', 'contracts');

const TMS_ENTRY = 'tms/**/*.ts';
const NOT_MODULES: readonly string[] = [
  '_harness',
  'scripts',
  'tests',
  'openapi',
  'node_modules',
  'dist',
];
const TS_EXT = '.ts';

function readInclude(): string[] {
  const cfg = JSON.parse(readFileSync(path.join(CONTRACTS, 'tsconfig.json'), 'utf8')) as {
    include?: string[];
  };
  return cfg.include ?? [];
}

function holdsTs(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? entry.name !== 'node_modules' && holdsTs(path.join(dir, entry.name))
      : entry.name.endsWith(TS_EXT),
  );
}

it('The include list contains tms/**/*.ts', () => {
  expect(readInclude()).toContain(TMS_ENTRY);
});

it('Every contract directory holding .ts files has a matching include entry', () => {
  const include = readInclude();
  const modules = readdirSync(CONTRACTS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !NOT_MODULES.includes(e.name))
    .map((e) => e.name)
    .filter((name) => holdsTs(path.join(CONTRACTS, name)));
  expect(modules.length).toBeGreaterThan(0);
  for (const name of modules) {
    expect(include, `${name} has ${name}/**/*.ts`).toContain(`${name}/**/*.ts`);
  }
});
