// @vitest-environment jsdom
//
// fix/domain-kit-browser — post-fix guard (pg-tester). Imports the package's actual browser
// entry (index.browser.ts -> dist/index.browser.js, wired via exports["."].browser) inside a
// jsdom environment and uses Money and Quantity — the two exports apps/admin and apps/pda
// actually need in the browser. This must succeed without ever touching node:crypto, since
// index.browser.ts re-exports only money, quantity and clock (never id-generator).
//
// `jsdom` is a devDependency of packages/domain-kit's own package.json, so this environment
// resolves hermetically from this package — no reliance on apps/admin, apps/pda or the root
// vitest install carrying it transitively.

import { describe, expect, it } from 'vitest';

import { Money } from '../index.browser.js';
import { Quantity } from '../index.browser.js';

describe('domain-kit browser barrel usage (jsdom)', () => {
  it('constructs and adds Money values via the public barrel in a browser-like environment', () => {
    const a = Money.of('12.500');
    const b = Money.of('3.000');

    expect(a.add(b).toString()).toBe('15.500');
  });

  it('constructs and adds Quantity values via the public barrel in a browser-like environment', () => {
    const a = Quantity.of('10.000');
    const b = Quantity.of('2.500');

    expect(a.add(b).toString()).toBe('12.500');
  });
});
