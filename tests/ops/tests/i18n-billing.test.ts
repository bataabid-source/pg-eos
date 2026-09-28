// tests/ops/tests/i18n-billing.test.ts — WBS 4.19 i18n prerequisite (pg-tester).
//
// Proves packages/i18n/<lang>/billing.json for the six locales against
// tests/ops/i18n-billing.feature. One `it` per Gherkin Scenario, titled verbatim; each scenario
// loops over the six locales. Read-only: nothing here writes to the repository.
//
// No `any`, no eslint-disable, no console.*.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// tests/ops/tests/i18n-billing.test.ts -> tests/ops/tests -> tests/ops -> tests -> repo root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const LOCALES = ['ar', 'en', 'hi', 'ur', 'bn', 'am'] as const;
type Locale = (typeof LOCALES)[number];

const KEY = 'billing.accountingPeriods.reopenDecision.title';
const JSON_INDENT = 2;
const NEWLINE = '\n';
const BOM = '\uFEFF';

// sha256 of each file's raw bytes, published by R5 on PR #170 (issuecomment-5875924622).
const R5_SHA256: Readonly<Record<Locale, string>> = {
  ar: '856284e748f82660a7a1df266bc5543c33d123c42952a66d874261c186e96d56',
  en: 'd190e63fca9887b7a7e2bda67cd18a40babe92b6915857f2db0b4c423a982653',
  hi: '16d6224796cbce3c0a03998453d6ee9405da48458ebf12788c8b634eb8be3a8a',
  ur: '7f67fe1ae8ab82c7b99740e0bbd98ff7c134b57e95cc9767ef6c6bc9c6b9e66f',
  bn: '29dff9772f38a5ec61a320a659be300a34cc7c39339ad51bda834202aa8c0645',
  am: 'd7cb8ca9baef7e3d908a14abe40ce51e3139ff207d6405b20bd4f6c9cd3bcf42',
};

function filePath(lang: Locale): string {
  return path.join(ROOT, 'packages', 'i18n', lang, 'billing.json');
}

it('Each of the six locales has packages/i18n/<lang>/billing.json', () => {
  for (const lang of LOCALES) {
    expect(existsSync(filePath(lang)), `${lang} billing.json exists`).toBe(true);
  }
});

it('Every file holds exactly the key billing.accountingPeriods.reopenDecision.title with a non-empty string value', () => {
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

it('Every file is byte-identical to the sha256 R5 published on PR #170', () => {
  for (const lang of LOCALES) {
    const digest = createHash('sha256').update(readFileSync(filePath(lang))).digest('hex');
    expect(digest, `${lang} sha256`).toBe(R5_SHA256[lang]);
  }
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
