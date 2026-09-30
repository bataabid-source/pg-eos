// tests/ops/tests/i18n-wms.test.ts — WBS X part 23 (pg-tester).
//
// Proves packages/i18n/<lang>/wms.json for the six locales against tests/ops/i18n-wms.feature.
// One `it` per Gherkin Scenario, titled verbatim. Read-only.
//
// No `any`, no eslint-disable, no console.*.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const LOCALES = ['ar', 'en', 'hi', 'ur', 'bn', 'am'] as const;
type Locale = (typeof LOCALES)[number];

const KEY = 'wms.receiveInbound.quarantineDecision.title';
const PLACEHOLDERS = ['{batch}', '{client}'] as const;
const EXACTLY_ONCE = 1;
const D211_AR_TEMPLATE = 'قرار حجر: الدفعة {batch} للعميل {client} — صلاحية أقل من الحد الأدنى';
const JSON_INDENT = 2;
const NEWLINE = '\n';
const BOM = '\uFEFF';

function filePath(lang: Locale): string {
  return path.join(ROOT, 'packages', 'i18n', lang, 'wms.json');
}

function valueOf(lang: Locale): unknown {
  const parsed = JSON.parse(readFileSync(filePath(lang), 'utf8')) as Record<string, unknown>;
  return parsed[KEY];
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

it('Each of the six locales has packages/i18n/<lang>/wms.json', () => {
  for (const lang of LOCALES) {
    expect(existsSync(filePath(lang)), `${lang} wms.json exists`).toBe(true);
  }
});

it('Every file holds exactly the key wms.receiveInbound.quarantineDecision.title with a non-empty string value', () => {
  for (const lang of LOCALES) {
    const parsed: unknown = JSON.parse(readFileSync(filePath(lang), 'utf8'));
    expect(typeof parsed, `${lang} is an object`).toBe('object');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
    const record = parsed as Record<string, unknown>;
    expect(Object.keys(record), `${lang} keys`).toEqual([KEY]);
    const value = record[KEY];
    expect(typeof value, `${lang} value type`).toBe('string');
    expect((value as string).length, `${lang} value non-empty`).toBeGreaterThan(0);
  }
});

it('Every value contains the {batch} and {client} placeholders exactly once', () => {
  for (const lang of LOCALES) {
    const value = valueOf(lang);
    expect(typeof value, `${lang} value type`).toBe('string');
    for (const placeholder of PLACEHOLDERS) {
      expect(occurrences(value as string, placeholder), `${lang} ${placeholder}`).toBe(
        EXACTLY_ONCE,
      );
    }
  }
});

it('The ar value equals the D-211 template byte-for-byte', () => {
  expect(valueOf('ar')).toBe(D211_AR_TEMPLATE);
});

it('Every file is 2-space JSON, UTF-8 without BOM, ending in exactly one newline', () => {
  for (const lang of LOCALES) {
    const content = readFileSync(filePath(lang), 'utf8');
    expect(content.startsWith(BOM), `${lang} has no BOM`).toBe(false);
    expect(content.endsWith(NEWLINE), `${lang} ends with newline`).toBe(true);
    expect(content.endsWith(NEWLINE + NEWLINE), `${lang} not double newline`).toBe(false);
    const parsed: unknown = JSON.parse(content);
    expect(content, `${lang} canonical format`).toBe(
      JSON.stringify(parsed, null, JSON_INDENT) + NEWLINE,
    );
  }
});
