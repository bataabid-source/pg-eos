// packages/logger/tests/logger.test.ts — WBS 2.9 (golden slice): the shared logger package.
//
// One root pino instance for the workspace; every module adapter is a child of it (never its own
// root). These tests pin that contract so a copied slice cannot drift into creating its own root.

import { describe, expect, it } from 'vitest';

import { childLogger, rootLogger } from '../index.js';

const MODULE_BINDINGS = { module: 'wms', useCase: 'receive-inbound' } as const;

describe('@pg-eos/logger', () => {
  it('childLogger carries its bindings on every line it writes', () => {
    const child = childLogger(MODULE_BINDINGS);
    expect(child.bindings()).toMatchObject(MODULE_BINDINGS);
  });

  it('a child logger inherits the root logger level, so one setting governs every module', () => {
    const child = childLogger(MODULE_BINDINGS);
    expect(child.level).toBe(rootLogger.level);
  });

  it('two children are distinct loggers over the same root (no second root instance)', () => {
    const a = childLogger({ module: 'wms' });
    const b = childLogger({ module: 'tms' });
    expect(a).not.toBe(b);
    expect(a.bindings()).toMatchObject({ module: 'wms' });
    expect(b.bindings()).toMatchObject({ module: 'tms' });
  });
});
