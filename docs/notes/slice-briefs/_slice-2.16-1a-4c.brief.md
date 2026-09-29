# SLICE BRIEF — WBS 2.16 part 1a-4c · the language selector is constant across locales (PDA + admin shells)

Task: 2.16 part 1a-4c (MASTER_BACKLOG)      Lane: 1 (stream A, wave 1)      Lock: `pda` + `admin` (granted, PR #199)
builder: pg-builder
Session: R4 (`pg-eos:lane-1`), branch `lane/1-2.16-1a-4c` (from origin/main 8a68e79). Brief drafted by the lane at the Master's request (M4, 2026-09-28 18:40Z).
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance (backlog row 2.16 part 1a-4c, verbatim)
"Selector label and six option labels identical under ar/en/hi/ur/bn/am; i18n key-set test green; tab title decided"

GM directive 2026-09-27 (verbatim, relayed in the backlog row): "ثبت تعريف صندوق اللغات يعرف بالانجليزيه وثابت حتي بعد تغير الللغات".

## Facts (verified on main 8a68e79)
- PDA: the selector lives in the shell, `apps/pda/src/router.tsx:42-49` (`LOCALE_LABEL_KEY`) and `:128-145` (`<label>` with an `sr-only` span `t(locale, 'locale.select.label')`, `<select data-testid="locale-select">`, options `t(locale, LOCALE_LABEL_KEY[code])`).
- Admin: the same selector is duplicated in two screens — `features/customer-profile/customer-profile-screen.tsx:30-37, 96-111` and `features/decision-inbox/decision-inbox-screen.tsx:27-34, 112-127`.
- Keys `locale.select.label` + `locale.name.{ar,en,hi,ur,bn,am}` exist in all six `apps/pda/src/i18n/*.json` and all six `apps/admin/src/i18n/*.json`; `apps/pda/tests/i18n/keys.test.ts:53-59` lists them.
- Tab titles: `apps/pda/index.html:6` "Premium WH", `apps/admin/index.html:6` "PG-EOS Admin".
- No table, column, contract or migration involved.

## Decisions (defaults — one CHANGELOG line each)
1. One table per app, `apps/<app>/src/i18n/languages.ts` (apps may not import each other; `packages/*` is frozen): `LANGUAGE_SELECTOR_LABEL = 'Language'` and `LANGUAGE_OPTIONS: Readonly<Record<Locale, { label: string; lang: Locale; dir: 'rtl' | 'ltr' }>>`, `dir` from the existing `directionOf`. A header comment names it the documented exception to "no embedded UI strings" (D-199) and quotes the GM directive.
2. Option labels verbatim from the backlog row: "العربية · Arabic", "English", "हिन्दी · Hindi", "اردو · Urdu", "বাংলা · Bengali", "አማርኛ · Amharic"; each `<option>` carries its own `lang` and `dir`.
3. The label "Language" is VISIBLE (the `sr-only` class is dropped) — the directive concerns what the worker sees; the `<label>` keeps wrapping the `<select>` (accessible name unchanged in kind).
4. Remove `locale.select.label` and the six `locale.name.*` keys from all twelve locale files (mechanical scripted edit — the builder does not read the eleven other JSON files); key sets stay identical per app. `LOCALE_LABEL_KEY` is deleted from the three components.
5. Tab title: stays a brand constant in each `index.html` ("Premium WH", "PG-EOS Admin"), documented by an HTML comment citing this slice — a product name is not translated (same exception as Decision 1). No locale key added.
6. `<html lang/dir>` behaviour and the locale state (default `ar`, no persistence) unchanged.
7. Locks: `pda` + `admin` both granted to lane 1 by the Master (M8, PR #199) — one slice covering both apps; no `1a-4d` split.

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/admin.brief.md`
- `apps/pda/src/router.tsx` lines 20-60, 120-150
- `apps/pda/src/i18n/t.ts`
- `apps/pda/src/i18n/en.json`
- `apps/admin/src/features/customer-profile/customer-profile-screen.tsx` lines 20-120
- `apps/admin/src/features/decision-inbox/decision-inbox-screen.tsx` lines 20-135
- `apps/pda/tests/i18n/keys.test.ts` lines 40-80
Write ONLY: `apps/pda/src/**` · `apps/pda/index.html` · `apps/admin/src/**` · `apps/admin/index.html` · `apps/pda/tests/**` · `apps/admin/tests/**` (tests: pg-tester only). Frozen paths untouched.
Contract: none. Screen/Board spec: none (shell chrome only). Migration number: none.

## RED tests
`apps/pda/tests/i18n/language-selector.feature` · `apps/pda/tests/i18n/language-selector.test.tsx` · `apps/admin/tests/i18n/language-selector.test.tsx` · `apps/pda/tests/i18n/keys.test.ts` (key list updated) · the admin key-set check (no admin key-set test exists today) is a scenario inside `apps/admin/tests/i18n/language-selector.test.tsx`

```gherkin
Feature: The language selector reads the same in every language (WBS 2.16 part 1a-4c)
  Scenario Outline: The selector label is "Language" under every UI locale
    Given the <app> shell is shown in <locale>
    Then the selector's visible label text is exactly "Language"
  Scenario Outline: The six option labels are byte-identical under every UI locale
    Given the <app> shell is shown in <locale>
    Then the options read "العربية · Arabic", "English", "हिन्दी · Hindi", "اردو · Urdu", "বাংলা · Bengali", "አማርኛ · Amharic" in that order
    And each option carries its own lang and dir
  Scenario: Switching the language leaves the selector unchanged
    Given the shell is shown in ar
    When the worker selects hi
    Then the label and the six option labels are unchanged
  Scenario: The locale files hold no language-name keys and the key sets stay identical
    Then no locale file has "locale.select.label" or "locale.name.*" and all six key sets are equal
```
Examples: app ∈ {pda shell, admin customer-profile, admin decision-inbox}; locale ∈ {ar, en, hi, ur, bn, am}.

Deliver: `apps/{pda,admin}/src/i18n/languages.ts` (new) · `apps/pda/src/router.tsx` · the two admin screens · twelve locale JSON files (keys removed) · two `index.html` (comment only) + the RED files; `pnpm --filter @pg-eos/pda test` and `--filter @pg-eos/admin test`, typecheck, eslint green; `pnpm guards:run` unaffected (no DB change).

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01).

## Handover 1 (R4 → successor, 2026-09-29, ADR-0007 Decision 5)
1. Reason: R4's context passed the 300k lane ceiling (≈ 306k, GM relay 01:21Z). Nothing of this slice was built.
2. Git: main head at handover = 783acd3; this branch `lane/1-2.16-1a-4c` = wip `04a6cd0` (this brief) + the wip commit carrying this section; pushed; tree clean. The successor works on `lane/1-2.16-1a-4c-r1` from main and folds both wip commits into its single `feat(2.16)` commit.
3. State of the loop: step 5 done (brief, brief-check OK 8 files / 530 lines). NOT started: pg-tester RED, pre-build review — review rounds unspent (2 left).
4. Locks: resolved — `pda` + `admin` rows for lane 1 land with this brief (PR #199, M8); the stale `wms` row is released. No write under `apps/*` until #199 is on main.
5. Decided, not to redo: Decision 3 (visible "Language" label) confirmed by the Master (M5, 19:39Z) as a recorded DEFAULT. Other decisions 1–7 stand as written; pre-build review may still challenge them.
6. First commands: `git fetch origin && git checkout -B lane/1-2.16-1a-4c-r1 origin/main` (this brief is on main via #199 — no cherry-pick); `bash scripts/check-locks.sh`; `bash scripts/brief-check.sh docs/notes/slice-briefs/_slice-2.16-1a-4c.brief.md`; then /slice step 6 (pg-tester).
