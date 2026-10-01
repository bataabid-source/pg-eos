// tests/ops/tests/i18n-tms.test.ts — WBS X part 26 (pg-tester).
//
// Proves packages/i18n/<lang>/tms.json for the six locales and the TSK prefix of the tms brief
// against tests/ops/i18n-tms.feature. One `it` per Gherkin Scenario, titled verbatim. Read-only.
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

const KEYS = [
  'tms.task.create.addressIncomplete',
  'tms.task.create.orderNotReady',
  'tms.task.create.alreadyExists',
  'tms.task.create.orderNotFound',
  'tms.task.create.staleVersion',
  'tms.task.create.missingActor',
] as const;
const AR_VALUES: Readonly<Record<(typeof KEYS)[number], string>> = {
  'tms.task.create.addressIncomplete':
    'لا يمكن إنشاء مهمة التوصيل: العنوان ناقص (المنطقة، القطعة، الشارع، هاتف المستلم مطلوبة)',
  'tms.task.create.orderNotReady': 'لا يمكن إنشاء مهمة التوصيل: حالة أمر الصرف لا تسمح بذلك',
  'tms.task.create.alreadyExists': 'لهذا الأمر مهمة توصيل بالفعل (مهمة واحدة لكل أمر)',
  'tms.task.create.orderNotFound': 'أمر الصرف غير موجود في كيانك',
  'tms.task.create.staleVersion': 'تغيّر أمر الصرف منذ قراءته — أعد التحميل ثم حاول مجددًا',
  'tms.task.create.missingActor': 'إنشاء مهمة التوصيل يتطلب مستخدمًا مسجَّل الدخول',
};
const PLACEHOLDER_CHARS = ['{', '}'] as const;
const MIN_ERROR_KEYS = 3;
const JSON_INDENT = 2;
const NEWLINE = '\n';
const BOM = '\uFEFF';
const ERRORS_FILE = path.join(ROOT, 'modules', 'tms', 'domain', 'create-delivery-task', 'errors.ts');
const BRIEF_FILE = path.join(ROOT, '.claude', 'briefs', 'tms.brief.md');
const I18N_KEY_LITERAL = /i18nKey\s*=\s*'([^']+)'/g;
const TSK_ROW = '| `TSK` | `PDL-TSK-` |';
const OLD_TSK_PREFIX = 'PCC-TSK-';
const RTE_ROW = '| `RTE` | `PCC-RT-` |';

function filePath(lang: Locale): string {
  return path.join(ROOT, 'packages', 'i18n', lang, 'tms.json');
}

it('Each of the six locales has packages/i18n/<lang>/tms.json', () => {
  for (const lang of LOCALES) {
    expect(existsSync(filePath(lang)), `${lang} tms.json exists`).toBe(true);
  }
});

it('Every tms.json holds exactly the six tms.task.create keys with non-empty string values and no placeholder', () => {
  for (const lang of LOCALES) {
    const parsed: unknown = JSON.parse(readFileSync(filePath(lang), 'utf8'));
    expect(typeof parsed, `${lang} is an object`).toBe('object');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed)).toBe(false);
    const record = parsed as Record<string, unknown>;
    expect(Object.keys(record), `${lang} keys`).toEqual([...KEYS]);
    for (const key of KEYS) {
      const value = record[key];
      expect(typeof value, `${lang} ${key} type`).toBe('string');
      expect((value as string).length, `${lang} ${key} non-empty`).toBeGreaterThan(0);
      for (const ch of PLACEHOLDER_CHARS) {
        expect((value as string).includes(ch), `${lang} ${key} has no ${ch}`).toBe(false);
      }
      if (lang === 'ar') {
        expect(value, `ar ${key} equals the brief string`).toBe(AR_VALUES[key]);
      }
    }
  }
});

it('The three i18nKeys carried by modules/tms create-delivery-task errors are among the six keys', () => {
  const text = readFileSync(ERRORS_FILE, 'utf8');
  const found = [...text.matchAll(I18N_KEY_LITERAL)].map((m) => m[1]);
  expect(found.length, 'i18nKey literals found').toBeGreaterThanOrEqual(MIN_ERROR_KEYS);
  const allowed: readonly (string | undefined)[] = KEYS;
  for (const key of found) {
    expect(allowed.includes(key), `${key} is one of the six keys`).toBe(true);
  }
});

it('Every tms.json is UTF-8 without BOM, 2-space indented, newline-terminated', () => {
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

it('tms.brief.md §4 gives the TSK series the prefix PDL-TSK- and keeps PCC-RT- for RTE', () => {
  const text = readFileSync(BRIEF_FILE, 'utf8');
  expect(text.includes(TSK_ROW), 'TSK row uses PDL-TSK-').toBe(true);
  expect(text.includes(OLD_TSK_PREFIX), 'no PCC-TSK- remains').toBe(false);
  expect(text.includes(RTE_ROW), 'RTE row keeps PCC-RT-').toBe(true);
});
