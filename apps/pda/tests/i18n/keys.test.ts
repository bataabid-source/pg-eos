// WBS 2.16 part 1a — unit tests for the PDA app's own i18n key set (brief Master decision 3,
// as amended by round-1 review finding 1/5: eighteen keys total — `app.name`, nine `screen.*`
// titles, `kiosk.enter` (eleven original) + `locale.select.label` and six `locale.name.<code>`
// keys added for the round-1 fix's locale selector — six locale files, `ar` authored first and
// used as the fallback for a missing key in any other locale, identical mechanism to
// apps/admin/src/i18n/t.ts).
//
// Fix round 2, finding 5: the "non-empty in every locale" check below now asserts directly
// against each locale's own raw JSON module (never through `t()`, which silently falls back to
// `ar` on a missing key and therefore cannot detect a key missing from a non-ar file), and the
// key-SET completeness check compares each locale's own `Object.keys()` to `ar`'s, rather than a
// hardcoded list that could drift from the real file contents.

import { describe, it, expect } from 'vitest';

import { t, SUPPORTED_LOCALES } from '../../src/i18n/t';
import ar from '../../src/i18n/ar.json';
import en from '../../src/i18n/en.json';
import hi from '../../src/i18n/hi.json';
import ur from '../../src/i18n/ur.json';
import bn from '../../src/i18n/bn.json';
import am from '../../src/i18n/am.json';

const RAW_LOCALE_FILES: Record<(typeof SUPPORTED_LOCALES)[number], Record<string, string>> = {
  ar,
  en,
  hi,
  ur,
  bn,
  am,
};

const EXPECTED_KEYS = [
  'app.name',
  'screen.home',
  'screen.receive',
  'screen.putAway',
  'screen.pick',
  'screen.check',
  'screen.load',
  'screen.count',
  'screen.transferReturn',
  'screen.lookup',
  'kiosk.enter',
  'locale.select.label',
  'locale.name.ar',
  'locale.name.en',
  'locale.name.hi',
  'locale.name.ur',
  'locale.name.bn',
  'locale.name.am',
] as const;

describe('PDA i18n — key set (Master decision 3, round-1 fix: eighteen keys)', () => {
  it('the ar.json fallback file declares exactly these keys (order-independent)', () => {
    expect(Object.keys(ar).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(Object.keys(ar)).toHaveLength(18);
  });

  it.each(SUPPORTED_LOCALES.filter((locale) => locale !== 'ar'))(
    'the %s.json file declares EXACTLY the same key set as ar.json (real completeness check, no t() fallback)',
    (locale) => {
      const localeKeys = Object.keys(RAW_LOCALE_FILES[locale]).sort();
      const arKeys = Object.keys(ar).sort();
      expect(localeKeys).toEqual(arKeys);
    },
  );

  it('every key is a non-empty string directly on each raw locale file (t() fallback bypassed — catches a key genuinely missing from a locale)', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const rawTable = RAW_LOCALE_FILES[locale];
      for (const key of EXPECTED_KEYS) {
        const value = rawTable[key];
        expect(typeof value).toBe('string');
        expect((value ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('every key still resolves to a non-empty string through t() in every supported locale (never throws)', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of EXPECTED_KEYS) {
        const value = t(locale, key);
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  it('each locale translates app.name into its OWN language, not a copy of the Arabic or English string', () => {
    const appNames = SUPPORTED_LOCALES.map((locale) => t(locale, 'app.name'));
    // Every locale must produce a distinct string — a copy-pasted identical string across two
    // locales would mean the translation work was skipped for one of them.
    expect(new Set(appNames).size).toBe(SUPPORTED_LOCALES.length);
  });

  it('t() throws a RangeError for a key genuinely absent from both the requested locale and the ar fallback', () => {
    expect(() => t('ar', 'screen.doesNotExist' as unknown as Parameters<typeof t>[1])).toThrow(
      RangeError,
    );
  });
});
