// WBS 2.16 part 1a — property tests for the PDA app's own i18n direction logic (brief Master
// decision 4: byte-identical `directionOf()`/`RTL_LOCALES`/`isLocale()`/`SUPPORTED_LOCALES` logic
// to apps/admin/src/i18n/t.ts — `ar`/`ur` RTL, `en`/`hi`/`bn`/`am` LTR).
//
// NOTE for pg-frontend: this test file requires `fast-check` as a devDependency of
// apps/pda/package.json (already a devDependency of several modules/* packages, e.g.
// modules/wms/package.json — `"fast-check": "^4.10.2"`); it is not yet listed in the brief's
// Write ONLY list for apps/pda/package.json, so add it there.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { directionOf, isLocale, SUPPORTED_LOCALES } from '../../src/i18n/t';
import type { Locale } from '../../src/i18n/t';

const RTL_LOCALES: ReadonlySet<Locale> = new Set(['ar', 'ur']);

describe('PDA i18n — directionOf() invariant', () => {
  it('SUPPORTED_LOCALES is exactly the six platform locales, ar first', () => {
    expect(SUPPORTED_LOCALES).toEqual(['ar', 'en', 'hi', 'ur', 'bn', 'am']);
  });

  it('property: directionOf(locale) is "rtl" if and only if locale is "ar" or "ur", for every supported locale', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SUPPORTED_LOCALES), (locale) => {
        const expected = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
        expect(directionOf(locale)).toBe(expected);
      }),
    );
  });

  it('property: directionOf() only ever returns "rtl" or "ltr" for any supported locale', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SUPPORTED_LOCALES), (locale) => {
        expect(['rtl', 'ltr']).toContain(directionOf(locale));
      }),
    );
  });

  it('ar and ur render rtl; en, hi, bn, am render ltr (explicit per-locale assertions)', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('ur')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(directionOf('hi')).toBe('ltr');
    expect(directionOf('bn')).toBe('ltr');
    expect(directionOf('am')).toBe('ltr');
  });

  it('property: isLocale() accepts every SUPPORTED_LOCALES member and rejects arbitrary strings not in that set', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(isLocale(value)).toBe((SUPPORTED_LOCALES as readonly string[]).includes(value));
      }),
    );
    for (const locale of SUPPORTED_LOCALES) {
      expect(isLocale(locale)).toBe(true);
    }
  });
});
