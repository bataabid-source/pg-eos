# SLICE BRIEF — WBS 2.16 part 1a · PDA PWA shell (routing, kiosk mode, nine-screen skeleton, i18n)

Task: 2.16 part 1a — the PDA app's own scaffold: Vite PWA project, TanStack Router with the nine
D-blueprint screens as routes (placeholder content — each screen's real feature is a LATER slice,
once 2.9-2.13's own backend use cases are wired to it), kiosk mode, i18n in all six languages
(RTL default). **NOT this part** (D-190, split before pg-tester per the size of the combined ask):
the 72-h offline queue (IndexedDB) and OTP login — both filed as `2.16 part 1a-2`/`1a-3`,
same `pda` lock, next tasks. PIN login is `2.16 part 1b` (after SCR-IDN-01, Master's own instruction).
**Also deferred (round-1 review finding 7):** the actual PWA manifest (`manifest.webmanifest`) and
service worker — a Vite PWA plugin is meaningless without the offline queue it exists to support, so
both land together in `2.16 part 1a-2`. This slice's own "Vite PWA project" phrase in this line refers
to the eventual destination, not a claim that the manifest/service-worker exist yet — recorded here,
one CHANGELOG line, not a G-01 (no schema/business-rule gap, a pure slice-sizing default).
Lane: 1      Lock: `pda` (whole-module — `apps/pda`, `modules/pda` only if a later part needs one)
Owner: WH_MGR      Deps: none (first-ever PDA slice, same standing as WBS 0.19 was for `apps/admin`)
Worktree: `../pg-eos-lane-1`, branch `lane/1-2.16p1a` (from `origin/main`)
Model routing: pg-tester sonnet → pg-frontend sonnet → pg-reviewer opus, two-round cap (P7). Lane
session sonnet, effort medium — orchestrates only.
No `scripts/new-slice.sh` run (that scaffolds a BACKEND use case tree; this is a new frontend app,
same precedent as `apps/admin`'s own WBS 0.19 bootstrap — hand-authored, following `apps/admin`'s own
file shape exactly, substituting names).

## Scope (doc 40 §D4, verbatim below — THIS part builds only the shell/routing/chrome, not the
## screens' own real behavior)
- **Nine routes**, one per D4 screen: home · receive · put-away · pick · check · load · count ·
  transfer/return · lookup. Each renders a SHARED generic placeholder component (screen title only,
  from i18n) — no data, no scan input, no API call this part. A later slice replaces each
  placeholder with its real feature once the matching backend use case (2.9-2.13, already built) is
  wired to it.
- **Kiosk mode**: on mount, request the Fullscreen API (a user-gesture-gated button when the browser
  requires one — Fullscreen API cannot be requested from a bare `useEffect` in most browsers);
  suppress the context menu (`contextmenu` event, `preventDefault`) and text-selection callout, the
  minimum "shared industrial device" hardening doc 40 names — no OS-level kiosk lockdown (out of a
  web app's own reach, Scope default).
- **i18n**: exactly `apps/admin/src/i18n/`'s own mechanism copied verbatim (six JSON files + `t.ts`'s
  typed lookup, `ar` as both the first-authored file and the missing-key fallback), a NEW key set for
  this app (`app.name`, the nine screen titles, one kiosk-mode label) — never imported cross-app
  (each app owns its own i18n files, same as `apps/admin`'s own precedent; no shared i18n package
  exists yet, Scope default, matches SCR-I18N-01 §1's own recorded gap).
- **RTL default**: `ar`/`ur` render `dir="rtl"`, the other four `dir="ltr"` — identical
  `directionOf()` logic to `apps/admin/src/i18n/t.ts`, copied verbatim.

## Read ONLY (workers) — kept under the 8-file / 1,000-line budget (P7)
1. `CLAUDE.md`
2. `docs/package/40-Build-Specification-EN.md` lines 420-423 (verbatim — doc 40 §D4, the nine screens
   + kiosk-mode/scan requirements this slice is scoped against; scan/offline/PIN requirements in this
   same block are OUT of this part, named above)
3. `apps/admin/src/router.tsx` (full file — the EXACT router/root-shell/locale-context pattern to
   replicate: `createRouter(initialPath?)` for test-friendly `createMemoryHistory`, a root route
   whose own component is the app shell, `LocaleContext` owned by the shell, one route per screen)
4. `apps/admin/src/App.tsx` (full file, short — the entry-mount pattern)
5. `apps/admin/src/main.tsx` (full file, short — the entry-point pattern)
6. `apps/admin/src/i18n/t.ts` (full file — the exact typed-lookup/fallback/RTL-set mechanism to copy
   verbatim, substituting the key set)
7. `apps/admin/package.json` (short — the exact dependency/script shape to mirror, substituting the
   app name)
8. `apps/admin/vite.config.ts` (short — the exact Vitest-in-Vite-config pattern to mirror)

## Not separately read (viewed directly when editing)
`apps/admin/tsconfig.json`/`tsconfig.test.json`/`index.html` (trivial boilerplate, mirrored directly
substituting the app name — no design decision), `apps/admin/src/test-setup.ts` (the exact
Vitest/Testing-Library wiring, three lines, copied directly), `apps/admin/src/i18n/{en,hi,ur,bn,am}.json`
(same shape as `ar.json`, viewed directly for the JSON structure — only key NAMES matter, not the
admin app's own Arabic/English/etc strings), `apps/admin/src/styles/tokens.css` (reused as-is or a
minimal PDA-specific copy, viewed directly, not a design decision this brief makes).

## Write ONLY
- pg-tester: `apps/pda/tests/**` (component tests: each of the 9 routes renders its own title;
  kiosk-mode suppresses `contextmenu`; locale switch changes both `dir` and the rendered text;
  `ar`/`ur` default to `dir="rtl"`, the other four to `dir="ltr"`).
- pg-frontend: `apps/pda/{package.json, vite.config.ts, tsconfig.json, tsconfig.test.json,
  index.html}` · `apps/pda/src/{main.tsx, App.tsx, router.tsx, test-setup.ts, kiosk.ts,
  features/placeholder-screen/placeholder-screen.tsx, i18n/{t.ts, ar.json, en.json, hi.json,
  ur.json, bn.json, am.json}, styles/tokens.css}`.
- Lane session only: this brief.
Forbidden for every worker: `apps/admin/**` (read-only precedent, never edited), `modules/**`,
`packages/**`, `database/**`, `docs/**` other than this brief, `scripts/**`, `CLAUDE.md`, `.claude/**`.
No offline queue (IndexedDB), no login screen, no API call of any kind this part.

## Master decisions the workers copy (not re-derive)
1. **Nine routes**, path segments matching the D4 screen names verbatim (English, kebab-case):
   `/home` (also the `/` redirect target, same "index redirects to the real home" pattern as
   `apps/admin`'s own `/` → `/inbox`), `/receive`, `/put-away`, `/pick`, `/check`, `/load`, `/count`,
   `/transfer-return`, `/lookup`. Every route renders the SAME `PlaceholderScreen` component,
   parameterized by an i18n key for its own title (`screen.home`, `screen.receive`, … one key per
   screen) — nine near-identical route declarations sharing one component, not nine separate files
   (this IS the "skeleton" the task name promises; a later slice replaces one route's own component
   at a time as its real feature is built, never touching the other eight).
2. **Kiosk mode** (`kiosk.ts`, a small pure-ish utility + one hook): `document.documentElement.requestFullscreen()`
   called from a click handler on a one-time "Enter kiosk mode" button rendered in the app shell (NOT
   auto-called on mount — browsers reject `requestFullscreen()` outside a user gesture); a
   `contextmenu` listener on `document` calling `preventDefault()`, registered once in the app shell's
   own effect, removed on unmount. No fullscreen-state polyfill, no vendor-prefix handling beyond the
   standard API (evergreen browsers only, Scope default — industrial PDA browsers are Chromium-based).
3. **i18n key set** (new, this app's own — never shared with `apps/admin`'s): `app.name` ("Premium WH"
   or the app's own display name — same string in every locale's OWN language, translated, not copied
   English into every file), `screen.home`/`screen.receive`/`screen.putAway`/`screen.pick`/
   `screen.check`/`screen.load`/`screen.count`/`screen.transferReturn`/`screen.lookup` (nine screen
   titles), `kiosk.enter` (the one-time button's own label). Eleven keys total (corrected —
   `app.name` + nine `screen.*` + `kiosk.enter`), six locale files.
4. **RTL default**: byte-identical `directionOf()`/`RTL_LOCALES`/`isLocale()`/`SUPPORTED_LOCALES`
   logic to `apps/admin/src/i18n/t.ts` — `ar`/`ur` RTL, `en`/`hi`/`bn`/`am` LTR. `index.html`'s
   static `dir`/`lang` attributes default to `ar`/`rtl` (same as `apps/admin`'s own `index.html`),
   overridden at runtime once the shell mounts and a locale is chosen (no persisted locale preference
   this part — always starts at `ar`, matching `apps/admin`'s own `useState<Locale>('ar')` default).
5. **No auth, no data, no queue this part** — every route is reachable with no login gate (a later
   slice, `2.16 part 1a-3`, adds the OTP screen and gates the shell behind it). This is a deliberate,
   recorded scope narrowing (CHANGELOG line, not a G-01 — no schema/business-rule gap here, purely a
   slice-sizing decision under D-179's SPLIT BEFORE rule).

## Acceptance criterion (doc 38 row 2.16 — this part is a step toward it, not the row's own full
## acceptance; "scan response ≤ 1.0 s" and "shift cannot close with queue > 0" are unreachable until
## scan/queue exist in a later part)
Gates: `pnpm --filter @pg-eos/pda typecheck && lint` green · `pnpm --filter @pg-eos/pda test` green ·
pg-reviewer PASS, two rounds max (P7). No `pnpm guards:run` this part (no DB/schema touched — a pure
frontend scaffold, same precedent as WBS 0.19's own admin bootstrap).
