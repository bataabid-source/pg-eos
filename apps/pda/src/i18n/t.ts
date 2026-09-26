// WBS 2.16 part 1a — minimal i18n lookup helper, byte-identical mechanism to
// apps/admin/src/i18n/t.ts (brief Master decision 4): a typed lookup over the `ar` file's key
// set, `ar` authored first and used as the fallback for a missing key in any other locale (never
// a blank string).
import ar from './ar.json';
import en from './en.json';
import hi from './hi.json';
import ur from './ur.json';
import bn from './bn.json';
import am from './am.json';

export const SUPPORTED_LOCALES = ['ar', 'en', 'hi', 'ur', 'bn', 'am'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// Locales whose script reads right-to-left (Unicode CLDR) — UI-only default, not a G-01 rule
// (brief scope default 15).
const RTL_LOCALES: ReadonlySet<Locale> = new Set(['ar', 'ur']);

export function directionOf(locale: Locale): 'rtl' | 'ltr' {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

// Type guard for a raw string value (fix round 1, finding 10 precedent): avoids an unchecked
// `as Locale` assertion at the call site.
export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

const RESOURCES: Record<Locale, Record<string, string>> = { ar, en, hi, ur, bn, am };

export type TranslationKey = keyof typeof ar;

export type TranslationParams = Record<string, string | number>;

function interpolate(template: string, params?: TranslationParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const value = params[token];
    return value === undefined ? match : String(value);
  });
}

export function t(locale: Locale, key: TranslationKey, params?: TranslationParams): string {
  const table = RESOURCES[locale];
  const template = table[key] ?? RESOURCES.ar[key];
  if (template === undefined) {
    throw new RangeError(`t(): missing i18n key "${key}" in both "${locale}" and the "ar" fallback`);
  }
  return interpolate(template, params);
}
