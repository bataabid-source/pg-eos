// modules/billing/tests/accounting-periods/reopen-title.unit.test.ts — WBS 4.19 (lane 2).
//
// PR #170 pg-reviewer finding 2: modules/billing/infrastructure/accounting-periods/repository.ts
// exports `loadReopenDecisionTitleAr(startDir?)` and `ReopenDecisionTitleMissingError` — the
// reopen decision's title_ar (platform.decisions.title_ar NOT NULL, 13B:444) is read from
// packages/i18n/ar/billing.json (CLAUDE.md "No embedded UI strings — i18n"), loaded EAGERLY by
// ../../api/accounting-periods/composition.ts at deps-construction time so a missing/invalid i18n
// file fails host startup, never a request with an unmapped 500.
//
// Pure unit test — no DB, no I/O beyond this file's OWN throwaway fixtures under
// fs.mkdtempSync(path.join(os.tmpdir(), ...)), removed in afterAll via fs.rmSync on ONLY the
// directories this file itself created (D-183: never touch anything outside its own fixtures).
//
// `loadReopenDecisionTitleAr` walks UP from `startDir`, at each ancestor `dir` checking whether
// `dir/packages/i18n/ar/billing.json` exists (not `dir/billing.json` — the full relative path is
// re-checked at every level) — so "a valid file two levels above startDir" means the file sits at
// `dirname(dirname(startDir))/packages/i18n/ar/billing.json`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadReopenDecisionTitleAr, ReopenDecisionTitleMissingError } from '../../infrastructure/accounting-periods/repository.js';

const REOPEN_DECISION_TITLE_KEY = 'billing.accountingPeriods.reopenDecision.title';
const TMP_PREFIX = 'pgeos-reopen-title-';
// The real packages/i18n/ar/billing.json value (this file's own copy, staged for local/CI runs —
// see the slice's closing report for where it lives when not committed).
const REAL_AR_TITLE = 'طلب إعادة فتح فترة محاسبية';

const createdTmpDirs: string[] = [];

/** A fresh, empty tmp directory this file owns exclusively — tracked for afterAll cleanup. */
function freshTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  createdTmpDirs.push(dir);
  return dir;
}

/** Writes packages/i18n/ar/billing.json directly UNDER `root` (i.e. at `root` itself as an
 *  ancestor level the walk-up will check), with the given raw file content. */
function writeI18nFileAt(root: string, rawContent: string): void {
  const dir = join(root, 'packages', 'i18n', 'ar');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'billing.json'), rawContent, 'utf8');
}

function nestedStartDir(root: string, ...segments: readonly string[]): string {
  const dir = join(root, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadReopenDecisionTitleAr — walks up to packages/i18n/ar/billing.json, throws ReopenDecisionTitleMissingError otherwise', () => {
  it('(a) no packages/i18n/ar/billing.json above startDir -> ReopenDecisionTitleMissingError, message contains "Allowed:"', () => {
    const root = freshTmpRoot();
    const startDir = nestedStartDir(root, 'a', 'b', 'c');

    let caught: unknown;
    try {
      loadReopenDecisionTitleAr(startDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReopenDecisionTitleMissingError);
    const asError = caught as ReopenDecisionTitleMissingError;
    expect(asError.name).toBe('ReopenDecisionTitleMissingError');
    expect(asError.message).toContain('Allowed:');
  });

  it('(b) the file exists but is invalid JSON -> ReopenDecisionTitleMissingError, message contains "Allowed:"', () => {
    const root = freshTmpRoot();
    writeI18nFileAt(root, '{ this is not valid json');

    let caught: unknown;
    try {
      loadReopenDecisionTitleAr(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReopenDecisionTitleMissingError);
    expect((caught as ReopenDecisionTitleMissingError).message).toContain('Allowed:');
  });

  it('(c) the key is missing -> ReopenDecisionTitleMissingError, message contains "Allowed:"', () => {
    const root = freshTmpRoot();
    writeI18nFileAt(root, JSON.stringify({ 'some.other.key': 'قيمة غير ذات صلة' }));

    let caught: unknown;
    try {
      loadReopenDecisionTitleAr(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReopenDecisionTitleMissingError);
    expect((caught as ReopenDecisionTitleMissingError).message).toContain('Allowed:');
  });

  it('(d) the key is an empty string -> ReopenDecisionTitleMissingError, message contains "Allowed:"', () => {
    const root = freshTmpRoot();
    writeI18nFileAt(root, JSON.stringify({ [REOPEN_DECISION_TITLE_KEY]: '' }));

    let caught: unknown;
    try {
      loadReopenDecisionTitleAr(root);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReopenDecisionTitleMissingError);
    expect((caught as ReopenDecisionTitleMissingError).message).toContain('Allowed:');
  });

  it('(e) a valid file two levels above startDir -> returns the title, equal to the fixture\'s own ar value', () => {
    const root = freshTmpRoot();
    const fixtureTitle = 'عنوان اختبار وحدة إعادة الفتح';
    writeI18nFileAt(root, JSON.stringify({ [REOPEN_DECISION_TITLE_KEY]: fixtureTitle }));
    // startDir = root/a/b — two levels below root, so dirname(dirname(startDir)) === root.
    const startDir = nestedStartDir(root, 'a', 'b');

    expect(loadReopenDecisionTitleAr(startDir)).toBe(fixtureTitle);
  });

  it('(f) no argument -> resolves the real repo file (packages/i18n/ar/billing.json), returns its own ar value', () => {
    // Not skipped per the brief: if packages/i18n/ar/billing.json is absent (frozen-path files not
    // yet landed by the Master in this checkout), this case is EXPECTED to fail — acceptable.
    expect(loadReopenDecisionTitleAr()).toBe(REAL_AR_TITLE);
  });
});
