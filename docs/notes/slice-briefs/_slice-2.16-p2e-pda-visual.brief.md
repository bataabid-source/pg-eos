# SLICE BRIEF — WBS 2.16 part 2e · PDA visual layer (shadcn/Tailwind on the shell + receive, put-away, login, home)

Task: 2.16 part 2e (MASTER_BACKLOG)      Lane: 1 (stream A)      Lock: `pda` (whole module → `apps/pda/**`) — NOT held now: lane 1 holds `wms | 1 | 2.9` for 2.9 part 3; `pda` is re-claimed for lane 1 when 2.9 part 3 closes and kept for 2.16 part 3, then this part
builder: pg-builder
Source: GM directive "[GM directive 2026-09-29 17:50Z] «موافق»" (relayed by the Advisory session on issue #207 at 17:38Z — the directive time is later than the relay post time; recorded as relayed).
Sequencing: lane 1 order = 2.9 part 3 (`wms`) → 2.16 part 3 (`pda`) → **2.16 part 2e** (`pda`); runs right after 2.16 part 3 and before any real-user demo.
Session: lane 1, branch `lane/1-2.16-p2e` (first command: `git fetch origin && git checkout -B lane/1-2.16-p2e origin/main`).
Model routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder sonnet → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds.

## Acceptance
Backlog row 2.16 part 2e criterion (verbatim): "Shell + receive, put-away, login, home restyled; touch targets ≥ 48 px asserted; RTL and LTR render; six locales; existing `apps/pda` tests green unchanged; `pnpm guards:run` green".
doc 40 §D4 (lines 420-423, verbatim extract, line 422): "Scan is the input; one step per screen; error prevented with sound+vibration and a message stating the next action; … kiosk mode; keyboard-wedge scanner; **scan response ≤ 1.0 s**."
Stack (CLAUDE.md · ARCHITECTURE): "React/TanStack/shadcn". RTL/LTR: EXECUTION-MASTER-v4 L624 "The screen renders correctly RTL and LTR".

## Facts (verified by the Master on main 66cfccc; re-verify at slice start)
- `apps/pda` has no Tailwind/shadcn: `apps/pda/package.json` lists no tailwindcss/postcss; `apps/pda/src/styles/tokens.css` (24 lines) is the only stylesheet. `apps/admin` already carries `tailwindcss ^3.4.19`, `postcss ^8.5.28`, `autoprefixer ^10.6.1` (devDependencies), `tailwind.config.ts`, and shadcn components under `apps/admin/src/components/ui/`.
- `apps/pda/src/i18n/t.ts:17-20`: `RTL_LOCALES` = ar, ur; `directionOf(locale)`. `/home` is `makePlaceholderRouteComponent('screen.home')` (router.tsx L227-231). Error sound + vibration exist in `features/receive/scan-signal.ts`.
- No table, column or migration.

## Decisions (defaults — one CHANGELOG line each)
1. No logic change: machines, clients, mock clients, `scan-queue.ts`, `offline-queue.ts`, routes and i18n keys' meaning untouched; only markup classes, styling and presentational components change. Existing `apps/pda/tests/**` pass without edits to their assertions.
2. Dependencies = the admin's versions (tailwindcss ^3.4.19, postcss ^8.5.28, autoprefixer ^10.6.1); the `apps/pda/package.json` + root `pnpm-lock.yaml` change is made by M-core under `tooling` (or granted by the Master) before pg-builder starts — the #211 xstate precedent. Absent → STOP and report.
3. Touch target minimum 48 px and the scan field size are named constants in one `apps/pda/src/ui/` token file (no magic numbers); 48 px is the GM-approved scope (17:50Z), not a doc 40 figure.
4. RTL/LTR via the existing `directionOf`; logical Tailwind properties (`ms-`/`me-`/`ps-`/`pe-`), no left/right utilities.
5. Sound + vibration + next-action message on error reuse `scan-signal.ts` on receive/put-away; login and home gain the visual error state only (no new behaviour — Decision 1).

## Read ONLY (workers)
- `CLAUDE.md`
- `apps/pda/src/router.tsx` lines 1-240
- `apps/pda/src/features/receive/receive-screen.tsx`
- `apps/pda/src/features/put-away/put-away-screen.tsx`
- `apps/pda/src/features/otp-login/otp-login-screen.tsx`
- `apps/pda/src/features/placeholder-screen/placeholder-screen.tsx`
- `apps/pda/src/features/receive/scan-signal.ts`
- `apps/admin/tailwind.config.ts`

Write ONLY: `apps/pda/src/**` except `features/**/*-machine.ts`, `features/**/client.ts`, `features/**/mock-client.ts`, `features/receive/scan-queue.ts`, `offline-queue.ts` · `apps/pda/{tailwind.config.ts,postcss.config.js,index.html}` · `apps/pda/tests/**` (pg-tester only). Frozen paths untouched.
Contract: none. Screen spec: doc 40 §D4 lines 420-423.

## RED tests
`apps/pda/tests/visual/pda-visual.feature` · `apps/pda/tests/visual/touch-targets.test.tsx` · `apps/pda/tests/visual/direction.test.tsx` · `apps/pda/tests/visual/scan-field.test.tsx`

```gherkin
Feature: PDA visual layer (WBS 2.16 part 2e)
  Scenario: Every interactive control on shell, home, login, receive and put-away is at least 48 px in both dimensions
  Scenario: The scan field is large, autofocused on mount and refocused after each accepted scan
  Scenario: Each screen shows one step at a time
  Scenario: A refused scan plays sound + vibration and shows a message stating the next action
  Scenario: ar and ur render dir="rtl"; en, hi, bn and am render dir="ltr", with no untranslated key
  Scenario: The existing receive, put-away, login and shell tests pass unchanged
```

Deliver: the styled shell + four screens + RED files; `apps/pda` tests + `pnpm guards:run` green.
Migration number: none. The slice's commit deletes this brief.

Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — STOP and report (G-01); a change would alter a machine, client or queue — STOP and report; a needed file outside `pda` — STOP and report.
