// packages/logger/tests/logger.test.ts — WBS 2.9 (golden slice): the shared logger package.
//
// One root pino instance for the workspace; every module adapter is a child of it (never its own
// root). These tests pin that contract so a copied slice cannot drift into creating its own root.

import { describe, expect, it, vi } from 'vitest';

import { childLogger, portLogger, rootLogger } from '../index.js';

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

  it('portLogger routes error and info to a child bound to the given fields (no second root)', () => {
    const written: Array<{ level: 'error' | 'info'; obj: object; msg: string }> = [];
    const fakeChild = {
      error: (obj: object, msg: string) => { written.push({ level: 'error', obj, msg }); },
      info: (obj: object, msg: string) => { written.push({ level: 'info', obj, msg }); },
    } as unknown as ReturnType<typeof rootLogger.child>;
    const childSpy = vi.spyOn(rootLogger, 'child').mockReturnValue(fakeChild);
    try {
      const port = portLogger(MODULE_BINDINGS);
      expect(childSpy).toHaveBeenCalledWith(MODULE_BINDINGS);
      expect(Object.keys(port).sort()).toEqual(['error', 'info']);

      port.error({ orderId: 'x' }, 'failed');
      port.info({ orderId: 'x' }, 'done');
      expect(written).toEqual([
        { level: 'error', obj: { orderId: 'x' }, msg: 'failed' },
        { level: 'info', obj: { orderId: 'x' }, msg: 'done' },
      ]);
    } finally {
      childSpy.mockRestore();
    }
  });
});
